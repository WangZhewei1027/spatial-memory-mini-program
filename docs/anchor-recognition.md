# 本机 MediaPipe 图像匹配

正式链路：GPS 获取附近参考图 → Worker 计算图像特征 → 余弦相似度与连续确认 → 请求关联内容 → 在当前 SLAM 会话内放置并锁定。相机图像留在设备，不上传到 Web 或 SAGE；管理端的匹配点、参考图、关联投放与地图识别方式保持原有接口。

## 运行方式

- 地图配置 `retrieval_mode: anchor` 使用本机图像匹配；`gps` 仍直接显示附近素材。进入前必须选择具体地图，配置失败可重试。
- 两种模式都从一开始使用一个 VisionKit v2 SLAM 会话。识别只读取像素，不等空间定位完成；命中后也不切换相机会话。需要放置内容时才等待有效的米制位姿。
- 模型沿用实验中固定的 MediaPipe MobileNet V3 Small float32/1，输出 1024 维 L2 归一化特征。**生产运行器是 CPU TFLite Worker，实验页仍保留 MediaPipe Tasks Vision SDK 作基线。**微信 Worker 没有 Canvas/wx API，无法原样搬入依赖 WebGL 输入的浏览器 SDK，因此直接执行同一模型并核对特征一致性。
- 固定 `@tensorflow/tfjs-tflite@0.0.1-alpha.10` 的无 SIMD、单线程解释器；只打包 CPU 运行器，不引入 TensorFlow.js 张量框架。构建适配把 Emscripten 动态函数生成改成闭包，并保留已验证的 WASM `memory.copy` 优化。模型权重、网络结构不变。
- 模型元数据为 224×224 RGB、mean=0、std=255，即 `RGB / 255`；不能套用其他 MobileNet 常见的 [-1,1] 归一化。参考图和相机都缩放整张图片至 224×224；透明参考图铺白。参考图短边至少 224 像素。
- WASM、模型两段和 Worker 均从小程序代码分包载入，无本机模型服务器、Google 下载域名或新增后端接口依赖。模型与运行器哈希、输入输出形状和分包路径由构建脚本写入 `lib/image-matcher/build-info.js`；每包小于 2 MiB。

## 代码结构

| 位置 | 职责 |
| --- | --- |
| `lib/image-matcher/spec.js` | 从 `build-info.js` 派生输入边长、RGBA 字节数、特征维度和分包路径；其他代码不写死 224 / 1024 / 包路径 |
| `lib/image-matcher/policy.js` | 纯函数：相似度、匹配判断、连续确认、取帧间隔、像素有效性、GPS 移动判断 |
| `lib/image-matcher/client.js` | 分包载入、Worker 生命周期、单请求通道与超时 |
| `lib/image-matcher/errors.js` | 错误码（`code`）；`message` 仍是面向用户的中文提示 |
| `workers/image-matcher/` | Worker 内推理；形状由初始化消息传入，错误回传相同的 `code` |
| `components/xr-start/matching/index.js` | 识别流程编排：候选 → 参考特征 → 相机匹配 → 内容 → 放置 |
| `matching/state.js` | 识别阶段（`PHASES`）、合法切换表，以及每轮扫描字段的唯一初始值 |
| `matching/candidates.js` / `location.js` / `reference-cache.js` | 接口请求体与响应校验、识别定位、按版本复用的参考特征 LRU |

`_cancelRetrieval` 用 `scanState()` 整体恢复每轮字段，`buildInitialState()` 也从同一处初始化，新增字段不会只在一侧生效。阶段切换经过 `_setMatchPhase`，不合法的切换记录 `非法识别状态切换` 错误日志。场景素材清理 `_clearRemoteAssets` 属于 `assets/index.js`。

## 调度与释放

参数统一在 `components/xr-start/matching/config.js`：

- 默认每秒取一帧；依据上一帧端到端耗时自动延长至 1–3 秒。整个客户端只允许一项 Worker 请求在途，忙时跳过相机帧，不排队。
- `VKFrame.getCameraBuffer(边长, 边长)`（边长来自 `spec.INPUT_EDGE`，当前 224）和自有 RGBA 副本在原生帧回调中同步完成；帧回调结束后再发送约 196 KiB 的像素给 Worker。预处理归一化和模型推理在 Worker 内；主线程用同一份相机特征计算全部候选的向量内积，每张相机画面只运行一次模型。
- 黑暗/空白画面不参与确认；超过 2.5 秒返回的帧结果丢弃。余弦分数至少 0.4，领先第二候选至少 0.08，同一目标连续 3 次、跨度至少 1.8 秒，相邻观察不超过 4.5 秒后确认。**0.4（2026-11-10 由 0.5 下调）是用于验证命中后空间内容显示的试验阈值，真实建筑的误匹配率和阈值仍需实景校准；通用特征相似不等于精确建筑定位。**
- 一个目标可有 1–5 张识别图（不同角度或光线）。每张图都计算特征，目标得分取其中最高的一张；同一目标的多张图不互相计算领先差，只与其他目标比较。任意一张图无法准备时，该目标视为未就绪。
- 沿用旧 SAGE 的全候选比较思路：一次获取当前范围内全部目标，逐张准备特征后，每次相机推理与全部参考特征比较，不分批轮换。任何竞争参考图未就绪时暂不接受匹配，避免遗漏第二名造成误命中；重扫时只重试尚未缓存的参考特征。
- 每 5 秒检查 GPS，优先读取已有持续定位流；相对上次候选查询位置的距离达到 `max(20 米, 两次定位 accuracy 之和)` 才刷新附近目标。定位检查、单次定位等待不暂停正在进行的图像匹配。位置稳定时不重复拉取候选，空候选也保持到移动或手动重扫；后台修改的目标可通过重扫刷新。
- 参考特征按团队/地图作用域、目标 ID 与 `reference_version` 缓存在内存，采用最多 200 个目标的 LRU（每张图约 4 KiB 特征，单个目标最多 5 张）。`reference_version` 覆盖全部识别图及顺序，增删任意一张都会让该目标整体重新计算。移动、命中和手动重扫保留缓存；新目标或版本变化才下载并计算。新区域之外的旧向量保留至 LRU 淘汰，走回时可以复用；不把相机每帧结果作为可复用参考特征。
- 每次位置明显变化会取消旧推理和内容请求、重置连续确认并刷新候选；已锁定的内容也会清理，开始新区域的识别，SLAM 会话继续复用。参考图准备与相机推理串行，不抢同一个 Worker。
- 初始化总时限 30 秒，单次推理 10 秒；超时或 Worker 被系统终止会关闭进程并给出重新扫描入口，不回退主线程同步推理。
- 命中后立即停止 Worker。内容读取完成且当前 SLAM 位姿有效时才放置；内容在世界坐标中锁定，目标离开镜头不清场。特征不提供三维位姿，因此不会自动贴合建筑表面。
- 重新扫描清理内容与旧 Worker，重新获取候选元数据并复用同版本的向量缓存和当前 SLAM 会话。隐藏/退出/模式切换取消全部异步任务，释放向量缓存并销毁 Worker；页面恢复先读新地图配置，再开始新会话。旧下载、旧推理、旧内容响应不能覆盖新扫描。
- 参考图片临时文件解码后即删除，Canvas 随即释放；相机帧不编码 JPEG，不存盘，不写 Storage。

## 接口与访问范围

统一经过 `utils/backend.ts`，地址规则见[本地开发](local-development.md)。完整服务端契约见 Web 仓库 `docs/miniapp-api.md`。

| 接口 | 用途 |
| --- | --- |
| POST `/api/miniapp/anchors/candidates` | workspace_id、latitude、longitude、accuracy、gps_timestamp、coordinate_system=wgs84；返回 id、name、image_urls（全部识别图，1–5 张）、image_url（第一张，兼容旧客户端；缺少 image_urls 时客户端只用它）、reference_version、distance_meters |
| POST `/api/miniapp/anchors/content` | 同样 GPS 字段，加 anchor_id、reference_version；返回 anchor 与 assets |
| POST `/api/miniapp/anchors/recognize` | 旧图片上传入口返回 410，本客户端不调用 |

优先用 10 秒内持续 GPS，否则用 5 秒内单次缓存或重新定位。服务端仍校验地图、范围、状态与参考图版本；范围最多 200 米、最多 200 个候选，暂停/移除目标返回 404，参考图改变返回 409。内容失败保持错误，等待用户重新扫描。附近无目标时，移动超过上述 GPS 阈值或手动重扫后重新查询。

匿名设备限流沿用 `anchorMatchClientId` 与 `X-Client-Id`；客户端识别结果不作为打卡凭证。域名配置仍只需原有后端 request、参考图 downloadFile 白名单；本次修改不会停止已部署的 SAGE 服务或取消计费。

## 验证与维护

`npm run build:image-matcher` 生成生产 CPU 适配器、WASM 与模型分包；升级运行器或模型前重新验证哈希、预处理、数值、包大小与目标手机。`npm run build:image-match-lab` 只生成实验基线，默认无 SIMD。SIMD 调查已暂停，见[诊断记录](simd-investigation.md)。

`npm test` 覆盖真实标量 TFLite 与上游逐图数值一致性、包完整性、单任务调度、降频、迟到结果、超时、进程退出、参考图释放、全量候选排名、GPS 移动与抖动过滤、慢定位不阻塞推理、LRU 缓存换版、内容锁定、SLAM 前取帧与位姿就绪后放置。`labs/image-match/index?worker=1` 在微信运行同图 SDK/Worker 数值对照与主线程定时器响应检查，报告不包含相机图像。

2026-11-09 模拟器中，两张同图特征余弦相似度分别 0.999999999997 / 0.999999999998；12 次 Worker 推理 22–32ms。证据见[Worker 模拟器报告](benchmarks/image-match-worker-simulator-2026-11-09.json)。这不是手机性能或真实建筑准确率结果。历史手机 SDK 测量与输入有效性说明见[实验记录](image-match-lab.md)。

真机需验证：iOS/Android 的 Worker 初始化与数值、真实相机匹配耗时及方向、边扫描边移动时画面响应、多栋相似建筑误命中、命中后视差与锁定、连续重扫、后台恢复、慢网络、空候选、参考图变更，以及音视频与退出释放。日志筛选 `[ImageMatch]` 和 `[SLAM]`，不输出签名图片 URL、相机图片或精确坐标。

### 自动扫描诊断

进入识别地图后由相机帧自动启动，无需点重新扫描。`附近目标` 只代表候选接口返回，不能证明相机已经完成推理。启动链路依次记录 `识别启动`、`识别模型就绪`、`参考图就绪`、`扫描开始`；页面准备好后显示“自动识别中”。

未命中也记录 `匹配结果`，包含 `topScore` / `minimumScore`、与第二候选的 `margin`、确认次数、取帧和推理耗时。`reason` 为 `score_below_threshold`（低于阈值）、`ambiguous_targets`（两个目标太相似）、`invalid_pixels`（画面缺少有效细节）、`stale_result`（返回过晚）、`confirming` 或 `confirmed`。相同判断不逐帧刷日志，最新数值合并进摘要；页面状态未变时不重复触发更新。`扫描开始` 记录本轮 `cacheHits` / `cacheMisses`；`移动后刷新目标` 只记录移动距离和刷新门槛，不记录坐标。

扫描期间每 3 秒输出一次 `扫描摘要`，不依赖相机或 Worker 回调。失败日志带 `code`（如 `TIMEOUT`、`WORKER_KILLED`、`INFERENCE_FAILED`），按错误码区分超时、进程退出与推理失败，不依赖提示文案。`stage` / `stageMs` 指出等待相机、定位、候选接口、Worker 初始化、参考图或扫描的阶段；`cameraFrames` / `captured` / `inferred` 区分相机帧到达、采样与推理完成，`workerBusy` / `inFlightMs` 区分等待结果，`lastResult` 保留最近一次判断。隐藏、退出、命中或错误后取消摘要定时器。真机未命中时先比较这些字段，再决定修复取帧、模型初始化或校准阈值，不凭候选日志推断扫描没有启动。

依据（2026-11-09 核对）：[微信 Worker](https://developers.weixin.qq.com/miniprogram/dev/framework/workers.html)、[WXWebAssembly](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html)、[MediaPipe Image Embedder](https://ai.google.dev/edge/mediapipe/solutions/vision/image_embedder)、[TFLite Web 运行器](https://github.com/tensorflow/tfjs/tree/master/tfjs-tflite)、[模型元数据规范](https://github.com/tensorflow/tflite-support/blob/master/tensorflow_lite_support/metadata/metadata_schema.fbs)。

### Worker 真机结果（2026-11-09）

同一台 iPhone 15 Pro / iOS 26.6.2 / 微信 8.0.80 / 基础库 3.17.6，用户确认「后台识别验证完成」。两张同图 SDK/Worker 特征余弦相似度为 **0.999999999997 / 0.999999999998**；不同图为 0.300219。12 次合成图 Worker 推理 **149–156ms，P50 151ms**；主线程 16ms 定时器回调 135 次，最大间隔 **51ms**。证据：[完整手机报告](benchmarks/image-match-worker-iphone15pro-2026-11-09.json)。

该报告验证数值和 Worker 推理期间的 JS 响应，没有采集真实相机或渲染 FPS。51ms 不是零卡顿承诺；149–156ms 不能当作相机端到端耗时，也不能直接与先前 SDK 的 480×640 相机实验做百分比性能承诺。真实地点正负样本、拍摄方向、识别阈值和完整 AR 媒体流畅度仍需现场验收。
