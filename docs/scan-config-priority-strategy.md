# 扫码参数与真机调试恢复

地图合集和 Scene 共用最近入口与浏览记录。Scene 入口使用
`organizationId + sceneId`，地图合集使用 `organizationId + workspaceId`；
同一个当前入口不会同时包含 `sceneId` 和 `workspaceId`。

无参数启动进入「主页」的公共场景目录。点击场景进入独立 AR 预览；「我」显示
保存在当前设备上的场景与地图浏览记录，点击记录可再次进入。

## 真机调试

1. 带参数打开一次首页：扫码，或将开发者工具的编译条件设为
   `pages/index/index`，启动参数设为 `organizationId=<团队 UUID>&sceneId=<场景 UUID>`。
2. 首页在跳转 Scene **之前**同步写入本地缓存和历史，无需等待网络请求成功。
3. 后续可在「我」重新打开最近浏览的 Scene。调试时直接无参数启动
   `pages/scene/scene` 也会读取最近选中的 Scene。
4. Scene 使用顶部系统返回键回到原标签页。

缓存保存在各自的微信运行环境中；开发者工具与手机不共享 Storage。
需要在用于真机调试的环境中带参数进入一次。清除小程序数据后也需要重新设置。
旧版未保存过的 Scene 参数无法从已有地图缓存推断出来。

## 优先级与职责

```text
当次首页 query > Storage 上次入口 > DEFAULT_CONFIG
```

- `utils/backend.ts` 加载时用 Storage 初始化模块级单例 `CONFIG`。
- 首页 `onLoad` 调用 `setConfig(options)`；空参数保持原选择。
- 有效 Scene 参数必须同时包含 Scene 和团队 UUID，不能借用上个入口的团队。
- 选择 Scene 会清除旧 `workspaceId`；选择地图或仅团队会清除旧 `sceneId`。
  仅提供团队时同时清除旧 `workspaceId`，防止跨团队错配。
- 有效参数先更新内存，再写当前入口与历史，最后跳转或请求名称。
- 无效 Scene query 不覆盖缓存，进入 Scene 页显示参数错误，不回退到另一场景。
- 主页使用 `navigateTo` 打开二维码指定的 Scene 或地图入口；返回后显示公共场景目录。
  `pages/index/index?select=1` 可用于按缓存直接调试入口页。
- 地图入口的 `goToAR()` 根据当前目标进入 Scene 或地图 AR 页。
- 仅团队入口（含旧“全部地图”历史）从 `/api/miniapp/workspaces?organization_id=…` 获取未归档地图，先选择一个具体合集才显示“开启旅程”。不自动选择唯一地图；列表失败可重试，空列表显示无可用地图。无具体地图的 AR 旧入口返回地图入口选择。
- 地图入口水印取当前地图配置；AR 每次进入或从后台返回时重读识别方式、文本样式、彩带和水印。配置不沿用旧组织缓存，详见[正式运行时](visionkit-three-migration.md)。
- AR、Scene 等子页面不持久化自己的 URL，避免旧页面参数覆盖较新的扫码选择。

## Storage 与历史

沿用现有 Storage key 和地图记录，无需清理已有数据。

| Key | 内容 |
| --- | --- |
| `config:scan:v1` | `{ organizationId, workspaceId?, sceneId? }` |
| `config:scan:history:v1` | 最近使用的入口数组，附带 `orgName?`、`workspaceName?`、`sceneName?`、`ts` |

历史按团队、目标类型、目标 ID 去重：

- Scene：`organizationId|scene:sceneId`
- 地图合集：`organizationId|map:workspaceId`

最多保留 20 条，最近使用置顶。地图和 Scene 即使 UUID 相同也不会互相覆盖。
每条记录显示「场景」或「地图」标签、内容名称、团队名称与最近浏览时间。
Scene 名称通过 `/api/miniapp/scenes?ids=…&organization_id=…` 按团队批量查询，
与地图名称一样缓存并刷新。没有名称缓存且请求失败时显示「场景名称暂不可用」。
未获取到名称时保留已缓存的名称。

「我」会批量刷新团队、地图与 Scene 名称。请求完成时以最新历史合并名称，避免慢请求覆盖
期间新加入的 Scene。当前标题刷新也会校验目标，避免快速切换时显示旧目标名称。

## 容错

- Storage 读写失败不阻塞本次入口；写入失败时不能保证下次启动恢复。
- 非法缓存回退到默认值；非法 Scene 不进入历史。
- JSON 会丢弃 `undefined`。读取有效缓存时必须显式返回 `workspaceId: undefined`
  （Scene 或仅团队入口），覆盖默认地图 ID，防止默认地图混入缓存的入口。

## 回归验证

`npm run test:scan-config` 使用真实页面和后端模块，在独立 JS runtime 间保留
JSON 序列化的 Storage，验证公共场景分页与重试、二维码路由、从浏览记录再次打开、
历史去重、异步名称刷新、团队入口选图、地图水印和 Storage 故障。`npm run test:map-config` 验证配置加载前不启动相机、直接按模式启动、失败重试、后台重读和迟到响应隔离；原生相机仅使用替身。这些测试也包含在 `npm test` 中。
