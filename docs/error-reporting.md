# 错误上报

小程序复用 Web 平台公开的 `POST /api/errors`（`spatial-memory/app/api/errors/route.ts`），写入 `error_log`：`scope = client`，`method` 以 `miniprogram:` 开头，`path` 为当前页面路由。实现位于 `miniprogram/utils/report-error.ts`，上报地址与业务接口相同（开发版走本地 Web，体验版／正式版走线上域名），无需额外配置合法域名。

## 规则

- 尽力而为：从不抛出、不重试；上报请求自身失败不再上报。
- 同一条消息 60 秒内只上报一次（同一个网络失败常被多处 catch 重复报告）；单次启动最多 50 条。
- 每条同时写入微信实时日志（`wx.getRealtimeLogManager`），可在小程序后台按机型和时间检索；开发版无局域网地址时只写实时日志。
- `context` 只放排查字段：素材/场景/实例 ID、接口路径、识别事件字段，以及机型、系统、微信版本、基础库、小程序版本。不放图片、请求体、定位或参与者标识。

## 接入点

| source | 来源 |
| --- | --- |
| `app.onError`、`app.unhandledRejection` | 全局未捕获异常与未处理的 Promise 拒绝 |
| `backend.request`、`storage` | `backend.ts` 网络失败与 Storage 读写失败 |
| `asset` | `xr-start` 的 `reportAssetError`（素材加载、放置、场景播放失败与媒体降级） |
| `scene.preview` | 扫码场景页的场景播放失败 |
| `scene.soundtrack_recover` | 视频音轨一步原生操作失败后重建解码器（未影响播放，用于定位卡在哪一步） |
| `recognition` | 识别流程中 `error` 级别的 `matchLog`（Worker 失败、超时、参考图或内容读取失败） |
| `activities.*`、`checkin.*`、`index.*` | 活动、打卡与首页名称加载失败 |

排查时在 `error_log` 中按 `method LIKE 'miniprogram:%'` 过滤，`context` 中的 `model`、`system`、`wechat` 用于区分机型与微信版本。
