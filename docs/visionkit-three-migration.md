# 正式 AR 运行时：VisionKit OSD / SLAM + Three.js

正式 `pages/ar/ar` 与独立 Scene 预览使用 VisionKit 和 Three.js 单画布。匹配模式先用 v1 OSD 识别，读取内容后销毁 OSD 会话，切换到 v2 SLAM；GPS 与独立 Scene 直接使用 v2。内容显示在会话的米制世界空间中，手机移动时同步相机位姿。识别流程见[本机 OSD 识别](anchor-recognition.md)。

## 架构

```text
pages/ar/ar（模式切换、状态、重新扫描）
  └─ components/xr-start（保留组件路径与业务队列）
       ├─ GPS / OSD / 素材容量与清场
       └─ lib/three-runtime/ARRuntime
            ├─ 单个 VisionKit 会话：v1 OSD 扫描 / v2 SLAM 展示
            └─ 单个 WebGL2 Canvas
                 ├─ 原生 YUV 相机纹理背景
                 └─ Three 原生位姿相机与世界空间内容
```

背景直接借用当前 VKFrame 的 GPU 纹理，原生帧立即消费，不跨 tick 保留。SLAM 阶段每帧同步 `viewMatrix` 与原生投影，禁止 Three 自动覆盖相机矩阵；远裁剪面按内容范围更新。OSD 阶段只扫描，不放置内容；其屏幕框不包含深度或世界位姿。空间内容按 SLAM 就绪后的观看位置放置，不自动贴合识别物体或地面，也不跨会话保存定位。

微信公开接口通过 `version: "v2", track: { plane: { mode: 1, force: true } }` 启用米制追踪，没有已文档化的仅 SLAM、禁用底层平面检测的配置。生产模式保留该入口，但不订阅平面 anchor，不使用 hitTest、平面光标或点击种树；不能声称底层平面计算完全关闭。若 SDK 回退 v1，则报错，避免将非米制视角误当成 SLAM。依据：[createVKSession](https://developers.weixin.qq.com/miniprogram/dev/api/ai/visionkit/wx.createVKSession.html)、[VKSession 状态](https://developers.weixin.qq.com/miniprogram/dev/api/ai/visionkit/VKSession.html)。

原生 `state === 1` 且相机矩阵有效后才放置内容。初始化提示左右平移手机；短暂丢失追踪只显示相机背景、保留已有世界内容，恢复后继续展示。定位超过 30 秒报错并提供重试。`[SLAM] 相机会话` 只在启动、定位状态变化和错误时输出，包含 SDK 实际版本与状态。

正式会话的渲染采样上限为 30 FPS，原生识别事件单独消费。原生绘制与 Three 共用 GL 上下文，绘制边界重置状态缓存。历史 `labs/xr-three/index` 保留 v2 平面实验，`bridge` 保留 xr-frame 桥接实验；生产页与实验页不会同时启动会话。

## 内容实现

| 内容 | 实现 |
| --- | --- |
| 文字、气泡、头像 | 原生 Canvas 字形 RGBA、DataTexture 与程序化几何；中文、换行和 emoji 布局，保留组织样式 |
| 图片 | 原生下载与 Canvas.createImage 解码，按原比例展示 |
| 模型 | GLTFLoader、SkeletonUtils 克隆、AnimationMixer；普通模型归一化，Scene 保留保存的局部变换 |
| 音频 | 原生渐进播放与耳机模型；按 SLAM 相机位置计算距离衰减与近距离聚焦 |
| 视频 | 原生 VideoDecoder、RGBA DataTexture；支持 TBB 与普通视频 |
| Scene | 共享 Core 时间轴、观看位置、媒体预加载与回收；空间音频使用 SLAM 相机位置 |

文字每条最多 2000 个 UTF-16 单元、32 行，溢出省略；旧 profile/bubble/confetti 位图已从打包排除。模型、音视频格式及 Scene 协议见[场景播放](scene-asset.md)。

普通素材继续使用串行放置、分批揭示、容量桶与去重，按相机前向散布；识别模式停止斥力，保留内容世界位置。GPS 模式定期刷新内容，巨大模型仍使用 GPS/罗盘估算。

## 生命周期与兼容边界

- 隐藏/退出停止原生会话，取消识别，释放参考图、动态内容、媒体与迟到加载；显示页面建立新会话。
- `ModelCache` 引用计数与 LRU 管理共享模板；实例只释放自己的 handle，模板由缓存物理释放。
- WebGL 上下文丢失需重新进入；扫描需要 OSD、空间展示需要支持 v2 的设备，不自动回退云端推理或固定视角。
- 画面、模型、文字与媒体仍依赖设备 WebGL2、原生解码器及微信权限。开发者工具不能证明相机识别或真机 VideoDecoder 播放通过。
- `[ThreeAR][timings]` 默认关闭，通过 `XR_CONFIG.debugLog` 开启；它是 JS/API 调用耗时与窗口帧率，不是 GPU 完成时间。识别排查使用 `[OSD]` 日志，见识别流程。

## 构建与验收

运行 `npm run build:xr-three-lab` 与 `npm test`。构建名保留历史名称，生成生产共享 Three bundle 与实验页代理；测试清单以 package.json 为准。

识别测试覆盖确认、锁定、重扫、换批、取消与清理；运行时测试使用实际 Three、GLB、文字和素材队列，验证 OSD → SLAM 初始化、相机平移/旋转产生视差而内容世界坐标不变、追踪恢复与重扫释放。实验测试单独覆盖平面工具。

真机检查按[识别流程验收](anchor-recognition.md#验证)与[媒体边界](scene-asset.md#流式播放的验证边界)执行。OSD API 替身、开发者工具编译、实际手机识别分别报告。
