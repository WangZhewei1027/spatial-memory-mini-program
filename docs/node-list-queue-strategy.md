# 素材容量、去重与释放

当前实现使用单一 `nodeList` 加独立容量桶。`assets/registry.js` 声明类型所属桶，`config.js` 配置容量与驱逐方式，`assets/queue.js` 负责注册和释放。原 `gen=new/old/danmaku` 三队列及 `maxNewNodeCount`、`maxOldNodeCount` 已退出运行时。

## 容量桶

| 桶 | 类型 | 当前容量 | 驱逐 |
| --- | --- | --- | --- |
| scene | 整个 Scene | 1 | XZ 距离最远优先，整场释放 |
| heavy | model、video | 6 | XZ 距离最远优先 |
| light | text、image | 20 | XZ 距离最远优先 |
| audio | audio | 6 | XZ 距离最远优先 |
| transient | 本地即时弹幕动画 | 8 | FIFO，最早注册优先 |

各桶独立限容。Scene 的容量指地图中同时保留的整场数量，场景内部实例数量不设业务上限；巨型模型使用单独的 `_hugeNodeList`。类型扩展时同步放置器、registry 和桶配置。

注册时保护刚加入的节点；旧节点优先在停留超过 `minLifetimeMs`（当前 1500ms）的候选中驱逐。没有已过保护期的候选时放宽到其他节点，以保持容量硬上限。距离取相机与节点的 XZ 位置，不随原地转头改变。异步模型/视频在昂贵实例化前通过 `_wouldSurvive` 判断是否有保留空间。

## 身份与去重

普通内容的 `entry.assetId` 虽保留旧字段名，值是发现 API 的 **Placement ID**。活动留言使用 `activity:<recordId>`，本地飞入弹幕使用 null。一个素材在两个地图中的投放不能按基础 Asset ID 合并。

`displayAssets()` 同时检查在场节点、待放置队列与正在加载的 ID，再应用重复冷却。文字和图片离场后冷却 60 秒；未配置冷却的类型不受此窗口限制。待渲染内容和加载结果还要通过内容代次及允许 ID 集合检查，模式切换后的旧回调不能恢复内容。

## 分批出现

首轮最多揭示 20 条，后续每次最多 10 条；首轮空结果不消耗加量机会。候选先区分 heavy 与其他类型，再各自洗牌并截取，避免固定排序导致一直展示同一批内容。未入选内容不进入冷却，下轮可再次参与。

实际放置通过[串行队列](asset-place-queue-strategy.md)完成。新一轮拉取不会按 new/old 分代整体替换在场节点；容量与距离决定逐步淘汰。活动则单独刷新，并主动清理已隐藏、停用或离开范围的记录，见[活动](activities.md)。

## 清理与验证

`_destroyNode()` 幂等隐藏并移除节点，调用实例 dispose、清理 Three 对象及音频索引，再按类型记录冷却或清理即时动画。Scene 的 dispose 同时释放整场模型、媒体与订阅。暂停检索、切换模式、进入后台和卸载时取消队列，晚到资源也必须释放。

`npm test` 覆盖实际队列、异步取消、场景整场释放与活动刷新。`npm run test:scene-memory` 验证反复装载的对象和堆回收；结果不能推导手机 GPU 或原生解码器的内存上限。参数以 `config.js`、`registry.js` 为准。
