# Asset 串行放置队列策略

## 问题背景

每次 GPS 触发 `fetchNearbyAssets` 后，可能一次返回 10–20 个素材。旧实现直接用 `forEach` 调用 `_placeAsset`：

```js
newAssets.forEach((a) => this._placeAsset(a));
```

这会造成两类卡顿：

| 素材类型 | 原因 |
|---|---|
| `text`（文本气泡）| `_placeTextAsset` 完全同步，N 个 `createTextAsset`（文字排版 + Canvas 生成字形纹理）+ `shadowRoot.add` 全部压在同一帧，JS 线程长时间被占用 |
| `model / image / audio`（异步加载）| `ModelCache.acquire` / `loadTexture` / `download` 全部同时发起网络请求；一旦集中回调完成，所有 post-`await` 的 scene 操作扎堆进入同一个 microtask 批次 |

结果：XR 渲染帧被 JS 阻塞，画面出现明显卡顿/掉帧。

---

## 解决方案：串行放置队列

### 核心思路

将"批量同时触发"改为"逐个串行完成"：

```
旧（并发）:
asset1 ─> 加载 ─────────────> 回调 ┐
asset2 ─> 加载 ─────────────> 回调 ┤← 同时完成，scene 操作扎堆
asset3 ─> 加载 ─────────────> 回调 ┘

新（串行）:
asset1 ─> 加载 ─> scene操作 ─> 等40ms ─>
                                               asset2 ─> 加载 ─> scene操作 ─> 等40ms ─>
                                                                                              asset3 ─> ...
```

本队列每次只等待一个素材的放置完成；素材内部、场景播放器和巨大模型仍可能有各自的资源请求。错峰可减少集中回调，但不能保证慢设备每帧都不卡顿。

### 关键方法

#### `_enqueueDisplayAssets(assets)`

将新素材追加进内部 `_placeQueue` 数组，如果 drain 循环当前没有在跑，则启动它。

```js
_enqueueDisplayAssets(assets) {
  if (!this._placeQueue) this._placeQueue = [];
  for (const a of assets) this._placeQueue.push(a);
  if (!this._placingBusy) this._drainPlaceQueue();
},
```

多次 GPS 触发的连续 fetch 会自然排队，不会并发爆发。

#### `_drainPlaceQueue()`

循环从队列头部取出一个 asset，await 其放置完成，再等一个 `placeStaggerMs` 的空闲窗口，然后处理下一个。

```js
async _drainPlaceQueue() {
  this._placingBusy = true;
  const baseStagger = XR_CONFIG.placeStaggerMs || 40;
  while (this._placeQueue && this._placeQueue.length > 0) {
    const asset = this._placeQueue.shift();
    await this._placeAsset(asset);           // 等待 IO + scene 操作完成
    // 模型放置触发 GPU 资源上传，至少留 120ms；其他类型用基础值
    const stagger = asset.file_type === "model" ? Math.max(baseStagger, 120) : baseStagger;
    await new Promise((r) => setTimeout(r, stagger)); // 让渲染帧喘气
  }
  this._placingBusy = false;
},
```

#### `_placeAsset(asset)`（现为 async）

根据 `file_type` 分发，并 `await` 放置方法；以下是简化示意，实际错误记录与取消逻辑以源码为准：

```js
async _placeAsset(asset) {
  if (!this._isAssetPlacementCurrent(asset)) return; // 内容代次 / 白名单复检
  if (asset.file_type === "scene")     await this._placeSceneAsset(asset);
  else if (asset.file_type === "model") await this._placeModelAsset(asset);
  else if (asset.file_type === "text")  await this._placeTextAsset(asset);
  else if (asset.file_type === "image") await this._placeImageAsset(asset);
  else if (asset.file_type === "audio") await this._placeAudioAsset(asset);
  else if (asset.file_type === "video") await this._placeVideoAsset(asset);
},
```

`text` 素材本身是同步的（`await` 非 Promise 立即完成），放置后直接进入 stagger 等待。

---

## 配置参数

位于 `config.js`：

```js
placeStaggerMs: 40,   // 相邻两次放置之间的空闲窗口（毫秒）；模型在 _drainPlaceQueue 内提升到至少 120ms
```

| 值 | 效果 |
|---|---|
| `0` | 当前实现使用 `placeStaggerMs || 40`，设为 0 仍回退到 40ms，不能关闭间隔 |
| `40`（默认）| 每个素材之间留 ~40ms 给渲染帧（≈2.5 帧），10 条非模型素材仅间隔就约 0.4s，还需加上加载与构建时间；模型固定至少 120ms |
| `150+` | 增大两次放置之间的窗口，也延后后续素材的加载与展示；效果需实测 |

> 放置是串行的，调大间隔会推迟下一条素材开始加载；不能把间隔总和当作整批就绪时间。

---

## 生命周期安全

组件 `detached`、页面隐藏时经 `pauseRetrieval()` → `_clearRemoteAssets()`（`matching/index.js`）清空队列并递增内容代次，防止已销毁的场景引用被继续操作；异步放置在每个 `await` 后用 `_isAssetPlacementCurrent` 复检，旧素材不会复活：

```js
_clearRemoteAssets() {
  this._contentEpoch++;
  this._allowedAssetIds.clear();
  this._placeQueue = [];
  this._pendingDisplayAssets = [];
  // ... 销毁 nodeList 全部节点
}
```
