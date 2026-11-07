# Spatial Memory · 微信小程序

扫描团队、地图合集或场景二维码，在手机上体验地图内容、活动与 AR 场景。Web 后端位于相邻的 `spatial-memory` 仓库，小程序统一通过 `miniprogram/utils/backend.ts` 调用匿名 `/api/miniapp/*` 接口。

## 开始开发

1. 在项目根目录执行 `npm ci`，安装依赖并生成本机开发地址。
2. 按[本地开发说明](docs/local-development.md)启动 Web 与开发数据库，并在微信开发者工具打开本项目根目录。
3. 启用自定义处理命令，编译或预览前自动同步电脑的局域网地址。模拟器开发版使用 `127.0.0.1:3000`，真机开发版使用电脑局域网地址；体验版与正式版使用线上域名。
4. 从首页进入地图 AR 或独立 Scene。VisionKit 相机与真实放置需要手机验证；电脑场景联调见[自动联调](docs/scene-auto-debug.md)。

地址选择失败不回退线上。网络、域名白名单和旧包更新的处理统一见本地开发说明；环境配置以当前源码为准。

## 运行结构

| 入口 | 职责 |
| --- | --- |
| `miniprogram/pages/index/` | 扫码参数、最近入口和历史切换 |
| `miniprogram/pages/ar/`、`components/xr-start/` | 地图 GPS/匹配发现、素材放置与活动展示 |
| `miniprogram/pages/scene/` | 独立场景预览、手动放置与播放控制 |
| `miniprogram/lib/three-runtime/` | VisionKit OSD / SLAM、Three.js、模型/纹理和原生媒体适配 |
| `miniprogram/lib/scene-runtime/` | 共享 Scene Core 与实际场景播放器 |
| `miniprogram/labs/xr-three/` | 独立实验、历史桥接与无相机场景联调 |

正式 AR 使用 VisionKit OSD 识别、v2 SLAM 空间展示与 WebGL2 + Three.js；xr-frame 只用于桥接实验和参考示例。团队素材与独立活动分别读取；活动记录不作为普通素材写入。

## 检查与构建

```sh
npm test
npm run test:scene-memory
```

`npm test` 使用本地 fixture 和微信 API 替身，不替代真机网络、相机、原生视频解码与音画同步验收。完整脚本以 `package.json` 为准。

修改 Three bundle 后运行 `npm run build:xr-three-lab`；更新共享 Core 按相邻 Web 仓库的 `packages/scene-core/README.md` 更新 npm pack 快照，再运行 `npm run build:scene-core`。生成 bundle 提交在仓库中，开发者工具无需再次构建 npm。

文档入口见[文档索引](docs/README.md)。`xr-frame-demo-master/` 是上游参考工程，不属于正式小程序。
