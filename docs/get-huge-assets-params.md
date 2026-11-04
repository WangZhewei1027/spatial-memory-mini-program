# 巨大模型查询的范围与身份

小程序的 `backendRpc("get_huge_assets", …)` 是 HTTP 路由映射，调用 `POST /api/miniapp/assets/huge`。当前后端使用 Kysely 查询地图投放；不再执行旧 Supabase RPC。

## 参数与响应

| 参数 | 规则 |
| --- | --- |
| `p_organization_id` | 必填团队 UUID；缺失或非法返回 HTTP 400 |
| `p_workspace_id` | 可选地图合集 UUID；省略、null 或空字符串表示团队全部地图；其他非法值返回 HTTP 400 |

```js
backendRpc("get_huge_assets", {
  p_organization_id: CONFIG.organizationId,
  p_workspace_id: CONFIG.workspaceId ?? null,
});
```

服务端同时按提供的团队与地图 ID 过滤，只返回未归档团队、未归档地图中的 active 模型投放；投放须有位置且有效展示配置 `is_huge` 为 true。地图不属于指定团队时返回空数组。文件解析当前素材资源，返回记录的 `id` 是 **Placement ID**，用于同一模型多处投放的独立管理。

成功响应为 JSON 数组，含 `id`、`file_type`、`file_url`、`text_content`、`metadata`、`config`、`latitude`、`longitude`。客户端另过滤缺失文件或无效经纬度；这些检查不代替服务端范围校验。

## 调用时机

`components/xr-start/assets/huge.js` 的 `fetchHugeAssets()` 要求 GPS、团队 ID 已就绪且处于未暂停的 GPS 模式；已有请求进行中时跳过。团队 ID 未知时客户端不发请求，绕过客户端直接漏传该字段会得到 400，不能当作正常空结果。

返回后校验模式代次；异步放置再校验内容代次。巨大模型使用单独的 `_hugeNodeList` 与模型缓存，按 GPS/罗盘确定方向，靠近 30 米时隐藏，显示距离上限 100 米。尺寸处理见[模型尺寸](model-normalization-rendering.md)。

普通附近发现 `/assets/nearby` 可提供团队或地图范围；巨大模型接口明确要求团队参数，不能把两个接口的参数要求互换。服务端实现见相邻 Web 仓库 `app/api/miniapp/assets/huge/route.ts` 与 `lib/placements/runtime.server.ts`。
