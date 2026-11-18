# 小程序与 Web 共用本地后端

小程序通过 `wx.getAccountInfoSync().miniProgram.envVersion` 选择后端，在模块初始化时固定。环境规则入口：`miniprogram/utils/backend-environment.ts`；真机开发 IP 由电脑在编译／预览前自动检测。

| 小程序环境 | 后端地址 |
|---|---|
| develop：微信开发者工具模拟器 | `http://127.0.0.1:3000`（不依赖 Wi-Fi IP） |
| develop：真机预览／开发版 | `http://<电脑当前局域网 IP>:3000` |
| trial：体验版 | `https://www.spatialmemory.online` |
| release：正式版 | `https://www.spatialmemory.online` |

普通数据接口与匹配识别上传共用所选地址，路径仍为 `/api/miniapp/*`。本地连接失败不会回退线上；环境无法确定时停止初始化。

## 启动与连接

1. 启动 Web 使用的本地数据库。在相邻 `spatial-memory` 仓库确认 `.env.local` 的 `DATABASE_URL`。已有开发环境可能仍使用 `localhost:55432` 的 `sanlin` 数据库；这是保留数据的历史部署标识，本次项目改名不会重命名数据库，以实际配置为准。
2. 在 Web 仓库运行 `npm run dev -- --hostname 0.0.0.0 --port 3000`。若 3000 已有开发服务，不要另起一个自动换端口的实例。
3. 首次拉取代码后在小程序仓库执行 `npm install`，自动生成本机地址文件。在微信开发者工具“设置 → 项目设置 → 本地设置”勾选“启用自定义处理命令”（本机已启用），确认编译／预览命令为 `sh scripts/sync-dev-backend.sh`，上传命令为 `sh scripts/before-upload.sh`，然后重新编译。保留“不校验合法域名”；当前 `project.private.config.json` 已设置 `urlCheck: false`。
4. 真机预览使用开发版，手机与电脑连接同一可互访的 Wi-Fi，打开小程序调试，并允许电脑防火墙的 3000 端口访问。VisionKit AR 仍需真机验证。

### 在 Mac 上调试 AR 页的 UI

在微信开发者工具模拟器里，从首页选择地图并点击「开启旅程」。地图页顶部调试栏显示「相机 模拟画面」，真实的地图设置、定位和活动接口驱动页面上的控件。要看打卡或弹幕，选择已投放相应活动的地图，并在开发者工具里设置测试位置。独立 Scene 入口也使用这个固定视角，可以调试放置和播放控件。

相机由运行环境自动选择。只有开发版（`develop`）且设备平台是 `devtools` 时才使用模拟背景和固定视角；图像识别需要真机相机帧。手机扫码预览、真机调试、体验版和正式版都使用 VisionKit。无需修改编译、预览或上传脚本，也无需在换设备前切换开关。

### 真机开发地址自动更新

`project.config.json` 已配置 `beforeCompile`、`beforePreview` 执行 `sh scripts/sync-dev-backend.sh`；`beforeUpload` 执行 `sh scripts/before-upload.sh`，先刷新地址，再检查主项目的上传内容（见[上传体验版／正式版](#上传体验版正式版)）。`scripts/node.sh` 从 PATH、用户目录的 `~/.local/bin/node`、常见 Homebrew 安装位置或 nvm 默认版本查找 Node.js，解决从桌面启动开发者工具时缺少终端 PATH 的问题，再运行 `scripts/sync-dev-backend.cjs`。当前开发者工具另有自身保存的“启用自定义处理命令”开关，单改文件里的 `setting.scriptsEnable` 不足以启用，新电脑需要在界面勾选一次。

脚本在电脑上枚举网卡，优先使用默认路由对应的局域网 IPv4，排除 VPN、Docker 等虚拟网卡；默认路由不可用时，仅在剩余地址唯一时自动选择。输出 `miniprogram/utils/backend-development-local.js`，运行时再按版本选用该地址。已在本机开发者工具实际编译验证：无需终端预先执行命令，编译钩子成功重新生成地址文件。

**换 Wi-Fi 后，直接重新编译／预览并让手机扫码新包，无需手改 IP。** 已在手机运行的旧包不会自动发现电脑新地址。Web 仍需监听 `0.0.0.0:3000`，手机与电脑需要网络互通。

### 换网后真机仍请求旧地址

先检查 `miniprogram/utils/backend-development-local.js` 的 `apiBaseUrl` 是否与电脑当前局域网地址一致。仅查看 JSON 中的 `scriptsEnable: true` 不能证明开发者工具实际启用了钩子：必须在“设置 → 项目设置 → 本地设置”确认“启用自定义处理命令”已勾选，下方出现编译、预览和上传三项预处理命令。

勾选后用“工具 → 编译”执行完整编译，再检查生成文件中的地址，并让手机重新连接真机调试／扫码加载新包。地址未变时脚本不会重写文件，因此应核对地址，不能只看修改时间。`npm run dev:sync` 可单独验证地址检测脚本，但不能证明 IDE 钩子已执行；自动化工具的刷新成功也不能代替此验证。

若预览或真机调试报“执行自定义预览前预处理命令失败”，先在项目根目录运行 `env PATH=/usr/bin:/bin:/usr/sbin:/sbin sh scripts/sync-dev-backend.sh`，用桌面应用的精简 PATH 复现钩子。2026-11-17 的失败源于 Node 安装在 `~/.local/bin/node`，旧脚本只检查 PATH、Homebrew 和 nvm；现已补上用户目录查找。macOS 回归会以精简 PATH 执行真实 `beforePreview` 命令，并检查生成的地址，避免只验证脚本声明而漏掉启动失败。

2026-11-16 实测（开发者工具 2.02.2609250）：两个配置文件均声明启用脚本，界面开关却未勾选，生成文件保留了旧网络地址，旧地址请求超时。启用界面开关后，CLI `simulator_refresh` 未更新该文件，而“工具 → 编译”自动生成了当前网卡地址；从电脑请求新地址的 `/api/miniapp/organizations` 返回 200。该结果验证了钩子、API 和数据库链路；用户随后确认真机首页数据已恢复正常。配置回归只验证钩子声明，不代表界面开关状态。

地址文件和可选覆盖文件均已加入 `.gitignore`。地址没变时不重写文件，避免重复触发热重载。断网或网卡选择有歧义时会清空旧地址并提示；此时模拟器、体验版和正式版仍可正常选择后端，真机开发会明确报错，不会沿用旧地址或回退线上。当前启动脚本用于 macOS/Linux；Windows 可将编译、预览命令改成 `node scripts/sync-dev-backend.cjs`，上传命令改成 `node scripts/sync-dev-backend.cjs && node scripts/check-upload-package.cjs`，并确保 Node.js 在开发者工具 PATH 中。

多网卡／VPN 环境可在小程序仓库根目录创建 `.miniapp-dev.local.json`，指定固定网卡，之后该网卡的 IP 仍会自动更新：

```json
{ "interface": "en0" }
```

特殊情况也可以写 `{ "host": "192.168.1.8" }` 固定局域网 IP（`host` 优先）。通常无需创建这个文件。需要排查检测结果时运行 `npm run dev:sync`，控制台会输出选中的网卡和地址。

模拟器根据 `wx.getDeviceInfo().platform === "devtools"` 自动使用 `127.0.0.1`；真机上的 localhost 指手机自身，不能用于连接电脑。体验版和正式版始终按环境选择线上配置。所有回归使用固定测试地址，不再依赖开发者当前 IP。

选择本地 Web 数据库里存在的组织与工作区，可使用本地管理端生成的入口参数。原有默认 ID 和扫码历史保持不变；若本地没有对应记录，改用本地 ID，不会自动复制线上数据。普通素材的下载仍使用本地数据库记录的 file_url，识别模型也仍按 Web 的服务端配置运行。

## 上传体验版／正式版

在微信开发者工具打开当前项目根目录，直接点击「上传」。命令行上传同样把项目路径指向当前仓库根目录。

`miniprogramRoot` 固定为 `miniprogram/`。实验页、旧参考工程、闲置资源和临时产物集中在同级的 `ignore/`，不属于小程序编译、预览或上传范围。`app.json` 只注册正式页面、四个识别资源分包（WASM 与三段模型）与 `packages/audio-assets` 音频标记资源分包；耳机模型通过 `require.async` 在放置音频时下载，不进入主包。`packOptions.include` 保留正式 WASM、模型和许可证，包括耳机 GLB，避免无依赖文件过滤漏掉运行时读取的资源。目录清单见 [ignore/README.md](../ignore/README.md)。

上传前可运行：

```sh
npm run check:upload
```

`beforeUpload` 也会执行这项检查，确认页面文件、Worker 目录和强制打包资源存在，正式源码未引用实验目录，并要求主包及各分包的源文件总量小于 1.5 MB，提前阻止体积回涨。当前开发者工具 2.02.2609250 的「代码质量 → 主包大小」检查实际遍历所有普通分包，并把 Worker 文件计入主包；脚本同时检查主包与 Worker 的合计。识别模型拆为三段，每段约 1.31 MiB；Worker 编码库省略不用的传统字符集索引表。这些预算是源码侧的保守检查，不能替代开发者工具对实际编译包的质量扫描。启用自定义处理命令后钩子才会自动执行；目录隔离本身始终有效。

开发地址继续由同步脚本生成；体验版与正式版通过运行环境选择线上地址。`npm run test:package` 验证主项目可直接上传、目录隔离和缺失资源检查。

## 线上配置

`ONLINE_API_BASE_URL` 使用 `https://www.spatialmemory.online`。体验版／正式版不会使用开发地址。不要改回公网 IP：即使浏览器或 curl 能访问，也不能将公网 IP 配置成微信合法服务器域名。裸域名 `https://spatialmemory.online` 会 301 跳转到 `www`，因此接口直接使用最终域名，避免 POST 重定向。

在微信公众平台「开发管理 → 开发设置 → 服务器域名」核对以下配置：

| 类型 | 当前部署所需域名 | 用途 |
|---|---|---|
| request 合法域名 | `https://www.spatialmemory.online` | 场景、地图、活动等接口 |
| request 合法域名 | `https://spatial-memory-media.oss-cn-shanghai.aliyuncs.com` | 视频播放器的 Range 请求 |
| uploadFile 合法域名 | `https://www.spatialmemory.online` | 识别图片上传 |
| downloadFile 合法域名 | `https://spatial-memory-media.oss-cn-shanghai.aliyuncs.com` | 模型、图片等素材下载 |

若场景引用其他存储域名，还需按实际资源 URL 配置。修改本地代码不会自动更新微信后台白名单；修改地址后需要重新上传并发布小程序。验收时使用体验版／正式版并关闭手机调试，开发工具的 `urlCheck: false` 只用于本地开发，不能证明线上请求可用。

2026-11-03 排查记录：旧 IP 与 `www` 域名的 HTTPS 场景接口均能返回业务 JSON，裸域名返回 301；真实场景加载代码在传输替身拒绝公网 IP 时复现“场景加载失败”，切换到 `www` 后回归通过。该回归覆盖地址选择与场景请求链路，不替代微信后台域名名单及真机验收。

回归：`npm run typecheck` 使用项目固定的 TypeScript 5.9.3 执行全量静态检查；`npm run test:backend` 验证网络变化、网卡筛选、覆盖、离线清理，以及各环境的全部数据 API、识别地址和失败不回退线上；`npm test` 先执行类型检查，再运行项目全部本地回归。测试使用微信 API 替身，真机网络与 AR 需另行验证。

## Web → 小程序的场景自动联调

当前场景预览入口使用正式页面 `pages/scene/scene`；旧模拟相机实验与历史记录见 [场景联调说明](scene-auto-debug.md)。本文负责后端地址与本机环境配置。

在 Web 保存至少包含一个实例的 scene 后，在小程序仓库执行：

```sh
npm run scene:preview -- <sceneId> <organizationId>
```

然后在微信开发者工具选择「Scene 本地预览」并完整编译。入口指向正式场景页面；在手机上启动 AR 相机、放置场景并验证播放。Web 保存后重新进入页面加载最新内容。

准备命令只检查接口和配置入口；GPU、画面和播放按钮需在小程序页面验证。相机追踪、平面检测、GPS／识别触发与手机性能仍需真机验收。
