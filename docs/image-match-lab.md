# MediaPipe 本地图像相似度实验

> 归档说明（2026-11-12）：实验源码已集中到 `ignore/labs/`，主项目不再注册实验页面。下文页面路径与设备操作是历史验证记录，不能直接在当前主项目打开；构建和诊断脚本位于 `ignore/scripts/`。

实验页：`labs/image-match/index`，仅 `develop` 环境启用。使用 MediaPipe Image Embedder 的原始 MobileNet V3 Small 模型输出 1024 维特征，对预设参考图做余弦相似度排序。参考特征在载入时计算一次；相机帧按需计算。识别算法在客户端执行，不向后端上传相机图片。

这是独立实验页，正式 AR 页面仍使用现行识别流程。实验页通过已有 VisionKit v2 会话取图，因而相机接入仍依赖微信；MediaPipe 特征计算不依赖 OSD。取图不会等待 `session.state === 1`，也不会创建第二个 OSD 会话。

## 运行

1. `npm ci`，随后运行 `npm run image-match:serve`。脚本下载并校验固定模型，监听电脑的 8787 端口。首次下载需要能访问 Google Storage。
2. 在开发者工具打开 `labs/image-match/index`。附加 `fixture=1` 会自动运行合成图片基准，真机使用 `camera=1` 自动运行相机基准并停止相机。
3. 真机与电脑连接同一可互访 Wi-Fi，开启小程序开发调试，使用开发版预览。本机地址沿用 [本地开发](local-development.md) 的自动同步配置，模型端口为 8787。
4. 等待模型加载后，选择参考图，或通过「当前地图目标」取得当前合集附近最多 10 个目标。后者需要先在首页选择合集，且本地后端 3000 端口可访问。
5. 「启动相机」后可运行「开始匹配」或「相机耗时对照」。匹配循环串行执行，每次完成后等 400 ms 再取下一帧。

不选参考图也能运行耗时对照，此时用首帧作为唯一参考，报告标记 `firstFrameReference: true`。此模式不能证明识别准确率，单一候选的 Top-1 一致率也没有区分意义。

页面先用两张不同合成图做输入自检，相似度超过 0.99 时阻止测试，避免把失效的推理计入性能结果。该检查只能发现明显的特征塌缩，不能证明建筑识别准确率。

完成报告自动保存到本机 `ignore/cache/image-match/report-*.json`，也可点击「复制完整报告」。初始化阶段和错误回传到 `events-*.jsonl`，用于定位仅真机出现的兼容问题。回传内容为设备信息、计时、特征相似度、像素统计摘要和参考图名称/ID，不包含图片像素或 GPS。服务器仅提供固定模型、报告和初始化诊断接口；关闭终端即可停止。测试需要保持前台；切后台会取消测试并释放模型和相机。

## 对照口径

参考旧 SAGE 的取帧实现 `91a1e16^:miniprogram/components/xr-start/matching/capture.js`。三条路径在同一个原生帧回调内同步取出并复制自己的缓冲区，避免把 `VKFrame` 或纹理留到异步阶段。

| 路径 | 输入准备 |
| --- | --- |
| `rgba-full` | `getCameraBuffer(720, 960)` → RGBA Canvas → MediaPipe |
| `rgba-small` | `getCameraBuffer(480, 640)` → RGBA Canvas → MediaPipe |
| `jpeg-small` | 优先 `getCameraJpgBuffer(480, 640, 80)` → 临时文件 → JPEG 解码 → MediaPipe；不可用时用缩小 RGBA 经 Canvas 编码再解码 |

“原尺寸”指本实验请求的 720×960 缓冲区，不是传感器原始分辨率。合成图片基准的源图为 720×1280，缩小后为 352×626（沿用 SAGE 的宽度 16 对齐约束）。

每次先预热 3 组，再测量 18 组；每组轮换三条路径的顺序，降低缓存和固定次序的影响。报告保留全部 63 行数据，汇总排除预热，给出 P50/P95。

- `captureMs`：原生取缓冲区、缩放/转换与复制。原生 JPEG 编码也计入这里。
- `prepareMs`：创建/复用 Canvas、写入 RGBA。
- `encodeMs`：原生 JPEG 路径为文件写入；回退路径为 Canvas JPEG 导出。
- `decodeMs`：文件解码和绘制到 Canvas。
- `inferMs`：MediaPipe 同步调用，包括内部图像预处理与特征复制。
- `rankMs`：与参考图计算余弦相似度并排序。
- `totalMs`：上述阶段相加；不包含公共的等待下一帧、`getVKFrame`/相机背景绘制，以及一次性的模型/参考图加载。
- `embeddingCosineToRaw`：同一帧该路径的向量与原尺寸路径的余弦相似度，不是建筑识别概率。

计时复用一个 `wx.getPerformance()` 实例，并对开发者工具亚毫秒级的倒退抖动做单调约束；小于计时精度的阶段可能记为 0。

## 2026-11-09 真机初始化与输入正确性

iPhone 15 Pro / iOS 26.6.2 / 微信 8.0.80 / 基础库 3.17.6。证据：[设备阶段日志](benchmarks/image-match-initialization-2026-11-09.json)。以下计时来自设备 `wx.getPerformance()`，不是服务器收到日志的间隔；初始化包括分包、模型下载和引擎创建，不包括后续两张图片自检。

| 版本 | 首轮引擎就绪 | WASM 构造函数 | 不同图片的相似度 |
| --- | ---: | ---: | ---: |
| 上游 SIMD + 微信加载环境适配 | 136.57 s | 79.02 s | 未测 |
| SIMD + WASM 内部内存复制 | 1.53 s | 65.86 ms | 约 1，未通过 |
| 官方无 SIMD + WASM 内部内存复制（当前默认） | 1.64 s | 65.72 ms | 0.285722，通过 |

当前默认版本返回前台后的另一次初始化为 **0.53 s**。这是实验观察值，并非所有设备或首次网络下载的保证。

初始化瓶颈是 Emscripten 的 `__emscripten_memcpy_js`：构造过程中多次从 WASM 调回 JS 做内存复制。构建脚本将该导入替换成等价的 WASM `memory.copy`。固定时钟后，Node 执行两份真实 WASM，初始化整个内存的 SHA-256 一致，409 次 JS 复制回调降为 0；SIMD 与无 SIMD 两份二进制均通过此回归。真机初始化的量级下降也在 SIMD 对 SIMD 的比较中成立。

随后发现 SIMD 版在此 iPhone/微信组合中产生错误特征：建筑图案与黑白棋盘的余弦相似度为 **0.999999662**，模拟器约 **0.285751**。原图与 WebGL 读回像素统计均正常，限制 WebGL 读回缓冲区也没有修复特征；更换官方配套的无 SIMD 二进制和加载器后，真机为 **0.285722**，与模拟器一致。目前证据指向这份 SIMD 运行组合的兼容问题，尚未定位到具体指令。

此前 SIMD 真机报告中的约 112/104/122 ms **作废，不能作为有效识别性能结论**。最终相机耗时应使用通过输入检查的无 SIMD 报告。

第一轮无 SIMD [相机报告](benchmarks/image-match-camera-dark-2026-11-09.json)测得 188.61/183.26/202.97 ms，但首帧 RGB 范围仅 0–1，用户确认镜头被遮挡或环境很暗。保留该报告作诊断证据，不作为正常图像验收。现已增加相机画面检查：RGB 范围大于 8 且标准差大于 3 后才进入计时，每组保存像素统计；等待超过 10 秒会提示检查镜头。该门槛用于排除明显空白/过暗输入，不是图像质量或识别准确率评分。

## 2026-11-09 真机相机实测（有效输入）

同一台 iPhone 15 Pro，官方无 SIMD + 内存复制优化，预热 3 组、测量 18 组。用户保持前台并扫过不同物体；[完整 63 行报告](benchmarks/image-match-camera-iphone15pro-2026-11-09.json)保存每组的相机像素统计。这次引擎初始化 **563.48 ms**，不同合成图自检相似度 **0.285722**。

| 路径 | 总耗时 P50 | 总耗时 P95 | 推理 P50 | 预处理/编解码 P50 | 与原图向量相似度 P50 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原尺寸 RGBA（720×960） | 210.43 ms | 216.18 ms | 204.10 ms | 0.35 ms | 1.0000 |
| 缩小 RGBA（480×640） | 197.49 ms | 207.20 ms | 192.71 ms | 0.13 ms | 0.9948 |
| 缩小后 JPEG（480×640，质量 80） | 218.99 ms | 228.22 ms | 191.74 ms | 19.09 ms | 0.9860 |

JPEG 使用原生 `getCameraJpgBuffer`，没有走 Canvas JPEG 回退。正式测量组像素标准差在约 52–78 之间；原尺寸图与首帧参考的相似度随镜头变化，范围约 **0.248–0.523**，不再是全黑画面或恒定特征。所有组均通过画面内容检查。

结论：**连续匹配使用缩小 RGBA，省去 JPEG 编解码**。本轮相对原尺寸快约 6.1%，JPEG 相对缩小 RGBA 慢约 10.9%。缩小 RGBA 约 193 ms 用于同步 CPU 推理，约占其总耗时的 98%；单纯继续调整 JPEG 质量不能消除这个瓶颈。初始化的大幅延迟已经解决，但此配置单次匹配仍约 200 ms，只适合低频识别，尚不适合流畅的逐帧匹配。

这是单台设备的一轮端到端管线计时，未控制温度或进行长时间稳定性测试。参考图是首帧，不能证明建筑识别准确率；实际建筑仍需多目标、视角与光照数据验证。

## 2026-11-09 模拟器实测（无 SIMD）

Apple M1 Pro，微信开发者工具，基础库 3.17.4；实际执行 MediaPipe WASM、Canvas 和 JPEG 编解码，输入为合成建筑图案，**不是原生相机，也不是手机性能数据**。

证据：[完整 63 行报告](benchmarks/image-match-fixture-2026-11-09.json)。与当前真机使用相同无 SIMD 构建，包含内存复制优化及编码/WebGL 适配；不同图片自检相似度为 0.285750。

| 路径 | 总耗时 P50 | 总耗时 P95 | 推理 P50 | 预处理/编解码 P50 | 与原图向量相似度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原尺寸 RGBA | 40.94 ms | 50.86 ms | 35.88 ms | 0.93 ms | 1.0000 |
| 缩小 RGBA | 34.02 ms | 37.85 ms | 30.83 ms | 0.00 ms | 0.9955 |
| 缩小后 JPEG | 42.57 ms | 56.90 ms | 28.92 ms | 10.85 ms | 0.9952 |

这一轮缩小 RGBA 的总耗时较原尺寸低约 17%，JPEG 编解码抵消了推理端的收益。真机的同方向结果见上一节；两者不能互相代替，也不能推断不同建筑、光照、视角下的命中率。

## 微信官方文档核对

2026-11-09 读取官方页面（搜索工具无法读取时使用 HTTPS 直接获取页面）：

- [WXWebAssembly](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html)：从代码包路径实例化，支持 `.wasm.br`，支持 Memory/Table；iOS 暂不支持导出的 Global。微信 8.0.25 起支持 SIMD，基础库 2.15.0 起支持 Worker 中的 WASM。本实验二进制没有 Global 导出，使用包内 Brotli 分包。
- [小程序运行环境](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/env.html)：iOS 逻辑层是不能开启 JIT 的 JavaScriptCore，开发者工具使用 NWJS/Electron，性能和 API 支持需要真机验证。这并不直接说明某一次 WASM 构造变慢的具体原因。
- [Canvas.getContext](https://developers.weixin.qq.com/miniprogram/dev/api/canvas/Canvas.getContext.html)：从基础库 2.24.0 支持 `webgl2` 上下文；该接口没有承诺提供浏览器全部全局构造器。此次缺失的类型来自上游 Emscripten 加载器中的 `instanceof WebGLRenderingContext`。
- [运行机制](https://developers.weixin.qq.com/miniprogram/dev/framework/runtime/operating-mechanism.html)：小程序切后台后可能挂起 JS，回调会等回到前台再触发。因此耗时对照需要保持前台。

## 构建与适配

- 固定 `@mediapipe/tasks-vision@0.10.21`。新版本 WASM 的压缩体积超过本实验独立分包预算，不能直接替换版本。
- `npm run build:image-match-lab` 默认生成无 SIMD 版本，并把 JS 内存复制导入替换为 WASM `memory.copy`；图结构、模型和推理数学使用上游实现。生成物与许可证随实验代码保存。
- `npm run build:image-match-lab:upstream` 保留原始无 SIMD WASM，用于复制优化的 A/B；`npm run build:image-match-lab:simd` 仅用于兼容性诊断。重现最初版本可运行 `node ignore/scripts/build-image-match-lab.cjs --simd --upstream`，验证后应重新运行默认构建。
- 使用 `WXWebAssembly.instantiate` 加载包内 `vision.wasm.br`；通过 `require.async` 加载独立 WASM 分包。当前 Brotli 文件 2,029,605 字节，解压 9,448,649 字节。测试验证上游与适配后的 WASM SHA-256 和分包体积。
- MediaPipe 使用页面 `webgl2` Canvas 做输入处理，推理 delegate 为 CPU。微信离屏 `webgl` Canvas 不能替代这里的页面 WebGL2 Canvas。
- Emscripten 中缺失的 `WebGLRenderingContext` 类型仅在适配器作用域补齐，用于上游 WebGL1 类型判断；页面实际要求 WebGL2。带偏移的 `readPixels` 先读到限定尺寸的缓冲区，再写入 WASM 内存；这不是修复 SIMD 特征异常的措施。
- `text-encoding@0.7.0` 为实验提供有完整 UTF-8/UTF-16LE 行为的兼容层，限定在适配器作用域，不修改小程序全局对象。该上游已停止维护；后续正式接入应精简到实际所需编码并重新验证。
- 固定模型 4,117,670 字节，SHA-256 为 `bbbb4c51a55a53905af1daec995ca1aae355046f8839bb8c9f5ce9271394bc40`。由本地服务器下载并校验，不塞进小程序代码包。
- 页面隐藏/销毁时停止相机会话、关闭推理图、释放 Canvas 和临时文件；异步阶段按代次检查是否已取消。原生相册返回的文件可以交给重建后的引擎，仍需真机验证相册选图交互。
- 异步超时可以捕获未完成的 Promise，但不能中断已经进入同步 WASM 的构造函数或推理。

验证：`npm test`，含 `npm run test:image-match` 的编解码缺失环境、帧缓冲区所有权、取消、相册跨前后台、计时口径、WASM 体积及真实初始化内存一致性回归。Node 替身不替代真机相机验收；附近目标载入和多建筑准确率尚未验收。

官方参考：[Image Embedder](https://developers.google.com/edge/mediapipe/solutions/vision/image_embedder?tab=Web)、[MediaPipe 源码](https://github.com/google-ai-edge/mediapipe)、[固定模型](https://storage.googleapis.com/mediapipe-models/image_embedder/mobilenet_v3_small/float32/1/mobilenet_v3_small.tflite)、[编码兼容库](https://github.com/inexorabletash/text-encoding)。

## 2026-11-09 接入现有匹配流程

用户决定暂停 SIMD 调查，先采用无 SIMD。实验页仍保留原 MediaPipe Tasks Vision SDK，正式页改为同一个 MobileNet 模型的 CPU TFLite Worker 运行器；理由是微信 Worker 无 Canvas/wx API，SDK 浏览器图像输入不能直接在该线程运行。具体实现、配置与验收见[正式识别流程](anchor-recognition.md)。

迁移中按模型 metadata 核实输入归一化为 RGB/255（mean=0、std=255）。最初试用其他 MobileNet 常见的 [-1,1] 预处理，模拟器同图向量相似度仅 0.5016 / 0.0856；修正后与原 SDK 对同一份 224×224 像素的特征相似度为 0.999999999997 / 0.999999999998。这个校验防止将“能运行”误认为“模型输入正确”。

`labs/image-match/index?worker=1` 自动做同图 SDK/Worker 对照、两张不同图片检查、12 次 Worker 推理与主线程 16ms 定时器探针。模拟器推理 22–32ms，探针记录 55 次、最大间隔 43ms；[完整报告](benchmarks/image-match-worker-simulator-2026-11-09.json)。定时器用于观察 JS 响应，不是实际渲染 FPS；模拟器结果不能当作手机或相机实测。新流程直接读取 224×224 RGBA，与前述 480×640 SDK 测试属于不同运行链路，耗时不能拼接比较。

生产默认每秒一帧、单任务在途、慢帧自适应降频、旧帧丢弃、命中后终止 Worker。单个 SLAM 会话同时提供扫描像素与展示位姿，取消 OSD→SLAM 重启。代码分包提供模型与 WASM，只有实验报告仍依赖本机 8787 服务。构建生产路径：`npm run build:image-matcher`；数值与生命周期回归：`npm run test:image-matcher`。

### Worker 真机结果（2026-11-09）

同一台 iPhone 15 Pro / iOS 26.6.2 / 微信 8.0.80 / 基础库 3.17.6，用户确认「后台识别验证完成」。两张同图 SDK/Worker 特征余弦相似度为 **0.999999999997 / 0.999999999998**；不同图为 0.300219。12 次合成图 Worker 推理 **149–156ms，P50 151ms**；主线程 16ms 定时器回调 135 次，最大间隔 **51ms**。证据：[完整手机报告](benchmarks/image-match-worker-iphone15pro-2026-11-09.json)。

该报告验证数值和 Worker 推理期间的 JS 响应，没有采集真实相机或渲染 FPS。51ms 不是零卡顿承诺；149–156ms 不能当作相机端到端耗时，也不能直接与先前 SDK 的 480×640 相机实验做百分比性能承诺。真实地点正负样本、拍摄方向、识别阈值和完整 AR 媒体流畅度仍需现场验收。
