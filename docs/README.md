# 小程序文档索引

本目录的现行说明以 VisionKit OSD / SLAM + Three.js 运行时为准。安装与入口见[项目 README](../README.md)，Web 的接口契约维护在相邻 `spatial-memory/docs/miniapp-api.md`。

## 开发与播放

| 文档 | 用途 |
| --- | --- |
| [本地开发](local-development.md) | 后端环境、自动同步开发地址与线上域名配置 |
| [扫码参数](scan-config-priority-strategy.md) | 团队/地图/场景入口优先级、Storage 与历史 |
| [正式 AR 运行时](visionkit-three-migration.md) | VisionKit 与 Three 的职责、资源生命周期和兼容边界 |
| [场景播放](scene-asset.md) | 当前播放协议、观看位置、媒体同步与跨端验证 |
| [场景自动联调](scene-auto-debug.md) | 本地 Web 到小程序的准备、自动检查与画面取证 |
| [活动](activities.md) | 店铺打卡、弹幕、参与记录与刷新清理 |
| [识别流程](anchor-recognition.md) | 本机识别、参考图、内容锁定与重新扫描 |

## 素材与性能

- [拉取触发](fetch-trigger-strategy.md)：GPS 定时刷新与匹配锁定。
- [巨大模型查询](get-huge-assets-params.md)：团队/地图范围、接口校验与投放身份。
- [串行放置](asset-place-queue-strategy.md)：加载完成、错峰放置与取消。
- [容量与去重](node-list-queue-strategy.md)：当前容量桶、揭示、冷却与释放。
- [模型尺寸](model-normalization-rendering.md)：普通素材归一化及 Scene 米制尺寸的区别。
- [性能与资源管理](performance-optimization.md)：当前缓存、调度、媒体窗口与验证方法。

## 实验与历史参考

- [MediaPipe 图像相似度实验](image-match-lab.md)：客户端匹配、SAGE 取帧复用与原图/缩小/JPEG 耗时对照。
- [VisionKit / xr-frame 调研](xr-frame-threejs-research.md)：实验页与早期方案记录。
- [XR-Frame 坐标](xr-frame-coordinates.md)、[交互示例](xr-3d-interaction-summary.md)：仅适用于 xr-frame 实验页和上游 demo。

带日期的验收结果只代表当时版本与环境；旧协议、测试数量和截图不能作为当前版本已验收的证据。
