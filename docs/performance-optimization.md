# 小程序性能与资源管理

本文对应当前 MediaPipe Worker + VisionKit SLAM + Three.js 运行时。旧 xr-frame 的 `loadAsset` ID、`setData` 实例化、包围盒缓存、轮转 tick 和 Storage 媒体缓存方案已移除；历史实现可从 Git 历史查阅。运行结构见[正式 AR 运行时](visionkit-three-migration.md)。

## 模型缓存

`lib/three-runtime/resources.js` 的 `ModelCache` 按 URL 共享加载 Promise，为每次 acquire 返回独立骨骼/节点克隆及 release handle。普通模型缓存目标为 8 个 URL，巨型模型为 3 个；LRU 只回收引用数为零的模板，活跃引用可能使缓存暂时超过目标。

实例 dispose 归还 handle；取消加载时也要释放晚到的对象和引用。`disposeTree` 跳过带共享标记的模型子树，模板资源由缓存拥有，不能由某个实例直接销毁。退出页面时释放缓存。

普通模型通过 `instantiateModel` 计算包围盒并归一化；Scene 使用共享 pivot 与保存的米制变换，见[模型尺寸](model-normalization-rendering.md)。当前普通素材队列没有已接入的并行模型 prefetch，不能将旧 xr-frame 的预下载收益当作现状。

## 获取与放置调度

- 首批普通素材等待 GPS 与 AR 就绪，再等待 `firstFetchDelayMs`；后续按 GPS 刷新周期触发，见[拉取策略](fetch-trigger-strategy.md)。
- 先按在场、队列、加载中 ID 和冷却去重，再限量揭示；[容量桶](node-list-queue-strategy.md)限制在场节点，Scene 整场计一项。
- [串行放置](asset-place-queue-strategy.md)等待每个异步加载完成，条目之间留出 `placeStaggerMs`，分散主线程实例化开销。
- 正式 AR 在 VisionKit RAF 上限频到 30 FPS。匹配默认每秒读取一帧 224×224 RGBA，CPU 推理在单独 Worker 中运行；忙时丢帧、慢时降频，命中后销毁 Worker。相机与内容共用同一 SLAM 会话，调度与释放见[识别流程](anchor-recognition.md)。

## 场景媒体

场景时钟、空间与参数采样来自共享 Scene Core。当前有效音视频全部准备，同时准备未来 5 秒内最近 2 条媒体；离开预加载窗口释放播放器和未完成请求。暂停与跳转仍按新时间重新计算窗口。

普通音频走原生渐进播放，视频通过 Range 读取 MP4 索引后交给原生解码器；旧格式按兼容路径处理。播放中的声音由原生时钟推进，主动跳转和循环才触发显式定位。全部细节及模拟器限制见[场景播放](scene-asset.md)，避免在多个文档复制媒体实现。

## 测量与验证

`[ThreeAR][timings]` 记录 JS/API 耗时，不能当作 GPU profiler。`XR_CONFIG.debugLog` 控制热路径诊断，默认关闭；错误和警告仍保留。

```sh
npm test
npm run test:scene-memory
```

开发者工具的[场景联调页](scene-auto-debug.md)可加 `stressCycles=100` 观察反复加载后的 WebGL 资源计数。比较同一 fixture、运行环境、缓存状态和采样窗口；对象数量、Node 堆、浏览器 WebGL 和真机原生媒体内存分别报告。

性能验收需在目标手机验证实际帧率、首次就绪、重复进出与长媒体播放。历史测试耗时、检查数量和截图只用于解释当时结果，不作为当前性能承诺。
