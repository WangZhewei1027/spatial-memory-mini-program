# 本机 OSD 识别

正式链路为：GPS 获取附近参考图 → 下载并转换本地 JPEG → VisionKit OSD 识别 → 根据命中 ID 请求关联素材 → 切换 SLAM → 空间定位就绪后展示。相机图像留在设备上，不上传到 Web 或 SAGE。管理端继续维护匹配点、参考图和关联投放，保存图片不再生成云端特征。

## 模式与锁定

- 默认 GPS 模式继续显示附近素材；切换「匹配点识别」后，清理原有内容并开始 OSD。
- 扫描使用 `version: "v1", track: { OSD: true }`，展示使用 v2 SLAM，始终只有一个原生会话。生产不使用平面结果、光标或点击种树；底层 SLAM 入口仍需平面配置，限制见[正式运行时](visionkit-three-migration.md)。
- 候选按距离排序，每批最多注册 5 张，扫描 12 秒后检查下一批，直到覆盖服务端返回的全部候选；一轮结束重新读取 GPS 与候选。下一批的目标 ID 与参考图版本均未变化时，保留原生标记、本地图片及确认进度，持续扫描；只有换目标、版本更新或取消才移除标记，避免单批目标每 12 秒重复下载和注册。刷新候选期间仍可确认命中，迟到的刷新结果不能覆盖命中状态。5 张是应用负载策略，不是微信 API 的上限。
- 同一目标连续至少 3 次有效观察、跨度至少 700ms，且相邻观察间隔不超过 1500ms，才请求内容。多个目标同时出现时重新累计确认。OSD 的屏幕矩形不转换为世界位姿。
- 回调按当前会话、当前批次注册的 `markerId` 关联参考图。原生回调的 `path` 仅用于诊断：iOS 真机可能返回空字符串，SDK 内部路径也可能与微信临时路径不同，不能要求字符串相等。回调中的 `id` 也可能随更新变化，不用它累计目标确认。已移除的 markerId、旧会话回调仍会被忽略。
- 命中并成功读取内容后移除所有识别标记，销毁 OSD 并启动 SLAM。提示左右平移手机，等有效空间位姿后放置并锁定内容；目标离开镜头、手机移动或转动均不会清场或自动重新识别。内容留在世界位置，会随视角变化移出屏幕。OSD 无法提供目标的三维位置，因此内容按 SLAM 就绪后的观看位置放置，不自动贴合识别物体。
- 「重新扫描」清理现有内容、参考图和标记，销毁当前会话并重新启动 OSD，即使已经处于 OSD 模式也重建会话；等新相机帧就绪后重新获取附近目标。该操作提供检测无响应时的手动恢复入口，不自动按超时反复重启。SLAM 初始化期间也可取消并重扫。内容读取失败保留错误，等待手动重新扫描；附近无目标和准备失败按配置退避。
- 切换模式、隐藏页面、重试相机及退出会取消本轮。隐藏时清场并销毁会话，回到页面重新建会话和扫描；锁定不跨后台会话保存。
- 下载、参考图转换、接口响应与素材放置均检查当前代次；旧回调和临时文件不能覆盖新扫描。

## 参考图

沿用匹配点已保存的参考图片。客户端下载后检查最短边至少 240 像素、长短边比不超过 16:9，最长边缩至 1080，透明背景铺白并输出 JPEG。图片临时文件在换批、命中、取消或失败时删除，不写入 Storage。

参考图应让目标占主要画面、背景简单、特征清晰。格式转换不能保证识别效果；过小或狭长图片会显示错误，需要在管理端更换。真实地点的远景照片与 OSD 单目标图片识别的效果差异应在目标手机实测，不能直接沿用 SAGE 相似度阈值。

## 接口与访问范围

统一经过 `utils/backend.ts`，地址规则见[本地开发](local-development.md)，完整契约见 Web 仓库 `docs/miniapp-api.md`。

| 接口 | 用途 |
| --- | --- |
| POST `/api/miniapp/anchors/candidates` | JSON：workspace_id、latitude、longitude、accuracy、gps_timestamp、coordinate_system=wgs84。返回 candidates：id、name、image_url、reference_version、distance_meters |
| POST `/api/miniapp/anchors/content` | 同样 GPS 字段，再加 anchor_id、reference_version；返回 anchor 与关联 assets |
| POST `/api/miniapp/anchors/recognize` | 旧图片上传入口返回 410，不再调用 SAGE |

GPS 优先使用 10 秒内持续定位，否则使用 5 秒内单次定位缓存或新定位。服务端校验精度、时间与坐标，候选仅来自当前地图及未归档团队/地图的有效匹配点，范围最多 200 米、最多 200 个候选（超出报错）。内容请求重新检查范围和参考图版本；移除/暂停目标返回 404，参考图变更返回 409。

匿名设备限流沿用 `anchorMatchClientId` 和 `X-Client-Id`，仅用于限流。候选与内容查询合计每设备每分钟 60 次、每地图 3000 次；设备 ID 不是登录身份。客户端命中也不是服务端打卡凭证。

正式域名配置需要后端 request 与参考图 downloadFile 白名单。前后端需配套发布：新小程序依赖两个 OSD 接口，旧小程序调用上传入口会收到升级提示。此次代码变更本身不会停止已部署的 SAGE 实例或取消其计费。

## 验证

`matching/config.js` 是批次、确认与重试参数的唯一来源。日志统一筛选 `[OSD]`，`debugLogs` 控制识别信息；错误/警告保留。Three 帧率与 WebGL 能力日志默认关闭，只有 `XR_CONFIG.debugLog` 开启时输出。素材就绪计时仍保留；已删除上传预览、相似度与位移重启代码。

日志按 `run`（本轮扫描）与 `batch`（参考图批次）关联。`相机会话` 记录设备、微信/基础库、请求版本和 SDK 实际版本；`附近目标` 记录数量、GPS 精度、搜索半径和首批目标。`参考图处理` 记录下载、原图尺寸/格式/方向、转换后的 JPEG 尺寸；`标记已注册` 记录目标 ID 与 markerId。只输出路径类别和文件名，不输出签名 URL 参数、相机图片、登录凭证或精确坐标。

扫描期间每 3 秒输出一次 `扫描摘要`，换批、命中和取消时额外输出一次。包括相机帧年龄、SDK 内部标记数量/ID、原生回调数量、通过校验数量、过滤与确认重置次数。候选未变化时输出 `继续扫描`，保留批次及累计时间/计数。`native.sessionGeneration` 区分会话，`native.anchorListeners` 列出已注册事件，`native.anchorEvents` 统计本会话监听器入口收到的事件，便于与业务批次的 `callbacks` 区分；重新扫描会改变会话编号并重新计数。`原生回调` 每种事件每批只打印首个样例，`回调被过滤` 每种原因只打印一次；连续确认进度最多每秒一次，最终命中单独记录。

| 摘要 result / 过滤 reason | 含义 |
| --- | --- |
| `no_native_events` | 尚未收到任何原生 anchor 回调；结合 cameraFrameAgeMs 与 nativeMarkerCount 判断相机/标记状态，不能据此断言参考图不相似 |
| `no_observations` | 有回调但没有检测对象（空列表或移除事件） |
| `observations_ignored` | 有对象，但回调发生在准备阶段等未进入确认的状态；查看 ignored |
| `all_observations_rejected` | 收到对象，但全部被过滤；查看 rejected 与首个样例 |
| `not_osd_type` / `unknown_marker` | 类型不是 OSD，或 markerId 不属于当前注册列表 |
| `invalid_rect` | 屏幕矩形无效 |
| `awaiting_confirmation` | 有有效目标，仍在等待连续确认；查看 bestObservations、bestDurationMs、resets |
| `confirmed` | 确认通过，随后查看内容接口与内容锁定日志 |

真机排查时从 `准备扫描` 开始保留一个完整批次的 `[OSD]` 日志即可。`getAllOSDMarker` 不可用或失败会标记为未知/读取失败，不当作零目标；这些诊断不会修改识别配置或放宽确认条件。

命中后继续查看 `切换空间追踪` → `[SLAM] 相机会话` 的 `trackingready` → `内容已锁定`（`space: world`）→ 素材就绪。`tracking` 表示尚在初始化或追踪丢失，`trackingrestored` 表示恢复；不会每帧刷日志。

本地执行 `npm run build:xr-three-lab` 和 `npm test`，覆盖锁定、重扫重建会话、连续一分钟无回调时保留同批标记、候选/版本变更、刷新期间命中、批次轮换、迟到响应、参考图释放、单会话切换与世界空间相机。原生 API 替身不证明手机识别成功，也不能复现 SDK 内部未产生回调的原因。

真机验收：iOS/Android 相机启动与方向；多张真实参考图命中与误命中；命中后 SLAM 初始化；左右走动/转头时内容留在空间并产生视差，转回后仍可见；追踪丢失与恢复；重新扫描与快速连续点击；下载和定位初始化中切换/退出；后台恢复；低网速、无目标、不合格参考图；音视频播放和退出释放。记录实际识别/定位耗时、帧率和机型。

API 依据：[微信 OSD](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/visionkit/osd.html)、[addOSDMarker](https://developers.weixin.qq.com/miniprogram/dev/api/ai/visionkit/VKSession.addOSDMarker.html)、[VKOSDAnchor](https://developers.weixin.qq.com/miniprogram/dev/api/ai/visionkit/VKOSDAnchor.html)。
