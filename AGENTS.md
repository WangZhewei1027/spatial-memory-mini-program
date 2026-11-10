# 小程序 Agent 指南

本文件是 Codex 与 Claude Code 共用的项目指令；`CLAUDE.md` 只保留一行 `@AGENTS.md` 导入。项目入口与现行文档目录见 [README](README.md) 和 [文档索引](docs/README.md)。

## 修改前阅读

| 改动 | 文档 |
| --- | --- |
| 后端地址、开发工具、真机连接与上传 | [本地开发](docs/local-development.md) |
| 扫码、页面入口、Storage | [扫码参数](docs/scan-config-priority-strategy.md)、[持久化规则](.github/instructions/miniprogram-storage-persistence.instructions.md) |
| AR 会话、相机、资源加载 | [正式运行时](docs/visionkit-three-migration.md)、[性能与资源管理](docs/performance-optimization.md) |
| 素材队列、容量与释放 | [串行放置](docs/asset-place-queue-strategy.md)、[容量与去重](docs/node-list-queue-strategy.md) |
| 场景协议、媒体与观看位置 | [场景播放](docs/scene-asset.md)、[自动联调](docs/scene-auto-debug.md) |
| 活动与参与记录 | [活动](docs/activities.md) |
| MediaPipe 识别、Worker 与重新扫描 | [识别流程](docs/anchor-recognition.md) |

## 实现边界

- 后端请求经过 `miniprogram/utils/backend.ts`。团队与地图由扫码上下文提供；普通发现记录的 `id` 是 Placement ID，独立场景预览使用 Scene ID。
- 生产识别使用固定 MediaPipe 模型的无 SIMD CPU Worker；相机、识别与展示共用一个 VisionKit v2 SLAM 会话。取帧不等待空间位姿，内容放置等待有效位姿；重扫复用会话。Worker 生命周期与取帧调度见识别流程，平面交互留在实验页。Three 相机前方是 -Z。
- `components/xr-start` 的方法由各模块组合，每实例状态通过 `buildInitialState()` 初始化；异步加载完成后检查当前内容代次，退出时释放晚到资源。
- 模型模板由 `ModelCache` 引用计数管理，实例清理调用 handle 的 `release()`；共享模板的物理释放由缓存负责。
- Scene 使用保存的米制变换和共享 Core；普通地图模型归一化策略不适用于 Scene 内实例。
- 活动参与记录由服务端保存；本地 Storage 保留入口历史与匿名参与标识，不作为打卡完成的权威来源。
- `miniprogram/labs/` 只用于开发者工具和预览；生产代码不引用实验页。体验版／正式版从 `npm run release:stage` 生成的副本上传。

## 验证

检查命令以 `package.json` 为准。运行受影响回归；运行时或播放改动完成后运行 `npm test`，共享包变更同时验证 Web 的跨端脚本。

Node 替身、模拟相机、开发者工具画面和真机 AR 分别记录结果；类型转译或接口成功不能替代实际相机、视频和音画同步验收。操作开发者工具时读取当前安装的 `wechatide-skill` 与对应工具帮助。
