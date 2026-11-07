# 附近素材拉取触发策略

GPS 模式使用 v2 SLAM，等待 GPS 与空间定位就绪后读取首批素材；GPS 就绪回调也会经过 `firstFetchDelayMs` 启动首轮拉取。`handleTick()` 按 `XR_CONFIG.gpsRefreshMs` 定期请求普通及巨大素材，当前位置来自持续 GPS，放置坐标来自 SLAM 相机位姿。

请求保留模式代次、在途去重与后台取消。素材仍由容量桶、去重与分批揭示规则决定是否加入。活动内容使用独立刷新计划，以读取暂停或审核变化。

匹配模式先执行 OSD 扫描，命中后切换 SLAM，在空间中保持当前内容，直到手动重新扫描、切换模式或离开页面；不运行 GPS 素材刷新。详见[本机 OSD 识别](anchor-recognition.md)。

参数在 `miniprogram/components/xr-start/config.js`，调度在 `index.js`，请求在 `assets/index.js`。当前 SLAM 位移用于渲染，不作为额外拉取触发条件；旧净位移拉取策略保留于 Git 历史。
