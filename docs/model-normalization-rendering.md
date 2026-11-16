# 模型归一化大小渲染逻辑调查（xr-start）

> **当前实现**：正式 AR 页 `pages/ar/ar` 已从 xr-frame 切换为 VisionKit v2 + Three.js（见 [`visionkit-three-migration.md`](visionkit-three-migration.md)）。"最长边归一到目标尺寸再乘 `scale_multiplier`" 的思路不变，但本文原先引用的 xr-frame 机制（`calcTotalBoundBox`、`transform.scale.setValue`、`gltfComp`、`_placeHugeModel`、`HUGE_MODEL_SCALE`）已不存在，当前统一由 `assets/model.js` 的 `instantiateModel(handle, targetSize, config)` 用 `THREE.Box3().setFromObject()` 实现；下文已按当前实现更新。xr-frame 写法仅适用于 `labs/xr-three/xr-view/` 与 `ignore/xr-frame-demo-master/`（注意 xr-frame 相机 forward 为 +Z，Three 为 −Z）。

## 调查范围

本次仅覆盖 `miniprogram/components/xr-start` 内与「3D 模型尺寸归一化」直接相关的路径：

- 普通远程模型（`file_type = model`）
- 巨型远景模型（`is_huge = true`）
- 音频素材附带的耳机 GLB 模型
- 每个素材可选配置：`asset.config.scale_multiplier`

不包含 2D 图片、文本气泡、弹幕、粒子的尺寸策略。独立 Scene 的实例使用保存的米制变换，不走普通素材归一化；仅通过 `lib/three-runtime/pivot.js` 的 `groundOffset` 将底部中心对齐实例原点，见[场景播放](scene-asset.md)。

## 结论摘要

现有实现采用了统一思路：

1. 加载 GLTF/GLB
2. 计算模型总包围盒 `new THREE.Box3().setFromObject(model)`（`instantiateModel`，`assets/model.js`）
3. 取最长边 `maxExtent = max(size.x, size.y, size.z)`
4. 使用目标最长边（`targetSize`：普通模型 1m / 耳机与种树 0.3m / 巨型 15m）反推等比缩放
5. 再乘素材级倍率 `asset.config.scale_multiplier`（缺省按 `1.0` 处理）

核心公式：

$$
baseScale =
\begin{cases}
\frac{targetLongestEdge}{maxExtent}, & maxExtent > 0.0001 \\
 targetLongestEdge, & maxExtent \le 0.0001
\end{cases}
$$

$$
finalScale = baseScale \times scaleMultiplier
$$

巨型模型是在 1m 归一化后再乘以倍率：

$$
hugeScale = \frac{1.0}{maxExtent} \times HUGE\_MODEL\_SCALE \times scaleMultiplier
$$

`scaleMultiplier` 的读取方式（当前实现）：

```js
const configured = Number(config.scale_multiplier),
  multiplier = Number.isFinite(configured) && configured > 0 ? configured : 1;
```

说明：`config` 缺省、`scale_multiplier` 非数字或非正数时回退到 `1`。

## 代码调用链（何时触发）

### 普通模型

1. GPS 与 AR 均就绪后触发首批拉取：`updateGPS()` / `handleARReady()` → `_maybeStartFirstFetch()`
   - 文件：`miniprogram/components/xr-start/gps.js`
2. 进入素材分发：`fetchNearbyAssets()` -> `displayAssets()` -> `_placeAsset()`
   - 文件：`miniprogram/components/xr-start/assets/index.js`
3. `file_type === "model"` 时调用 `_placeModelAsset()`
   - 文件：`miniprogram/components/xr-start/assets/model.js`

### 巨型模型

1. 与普通模型同一闸门触发：`_maybeStartFirstFetch()` → `fetchHugeAssets()`
   - 文件：`miniprogram/components/xr-start/gps.js` → `assets/huge.js`
2. 放置流程：`_placeHugeAssets()` 内 `_hugeModelCache.acquire()` -> `instantiateModel(handle, 15, asset.config)`
   - 文件：`miniprogram/components/xr-start/assets/huge.js`
3. 每帧维护：`tickHugeModels()`
   - 文件：`miniprogram/components/xr-start/assets/huge.js`
   - 在 `handleTick()` 中调用
   - 文件：`miniprogram/components/xr-start/index.js`

## 归一化实现细节

### 1) 普通模型（目标最长边 = 1m）

位置：`miniprogram/components/xr-start/assets/model.js`

关键逻辑：

- `instantiateModel(handle, 1, asset.config)`（`_placeModelAsset`），内部：
- `const bounds = new THREE.Box3().setFromObject(model), size = bounds.getSize(new THREE.Vector3());`
- `const extent = Math.max(size.x, size.y, size.z);`
- `model.scale.multiplyScalar((targetSize / (extent > 0.0001 ? extent : 1)) * multiplier);`

说明：

- 最长边先归一到 1m，再乘 `scale_multiplier`。
- `extent <= 0.0001` 时分母取 `1`（即直接用 `targetSize`），避免除零或异常放大。
- 若模型无内置动画，仅附加上下跳动与旋转，不改变 scale。

### 2) 巨型模型（先归一到 1m，再放大 15 倍）

位置：`miniprogram/components/xr-start/assets/huge.js`

关键常量：

- 无单独常量，`_placeHugeAssets()` 直接调用 `instantiateModel(handle, 15, asset.config)`（`targetSize = 15`）。

关键逻辑：

- 与普通模型同一函数：`model.scale.multiplyScalar((15 / extent) * multiplier)`，等价于 `1/maxExtent × 15 × scaleMultiplier`

说明：

- 尺寸归一化规则与普通模型一致。
- 在 15m 基础上继续乘 `scale_multiplier`，形成可配置远景体量。
- 该分支还会基于 GPS 与罗盘计算放置方向/距离，但这是位置逻辑，不影响大小归一公式本身。

### 3) 音频耳机模型（目标最长边 = 0.3m）

位置：`miniprogram/components/xr-start/assets/audio.js`

关键逻辑：

- 先通过 `require.async` 加载 `packages/audio-assets/ready.js`，再用其 `headphonePath`（`/packages/audio-assets/headphone.glb`）取得 `ModelCache` handle；与普通模型共用缓存，下载分包后再次检查当前内容代次。
- `instantiateModel(handle, 0.3, asset.config)`

说明：

- 和普通模型相同算法，但目标最长边改为 `0.3m`，随后再乘 `scale_multiplier`。
- 若耳机模型加载失败，回退为 `BoxGeometry(0.15, 0.15, 0.15)` 立方体占位（非归一化分支）。

## 种树与其他尺寸路径

种树复用归一化；其他路径有各自的尺寸规则：

1. `placeNode()` 点击种树：已改为 `instantiateModel(handle, 0.3)`（归一到 0.3m，不读 `scale_multiplier`），并把包围盒底部中心对齐到光标落点
   - 文件：`miniprogram/components/xr-start/index.js`
2. 音频模型加载失败回退立方体：`BoxGeometry(0.15, 0.15, 0.15)`
   - 文件：`miniprogram/components/xr-start/assets/audio.js`
3. 图片素材按目标高度建面片：`PlaneGeometry(0.6 * aspect, 0.6)`
   - 文件：`miniprogram/components/xr-start/assets/image.js`

## 调试与验收要点

当前实现不再输出 `[model] / [huge] / [audio] … normalizeScale=…` 这类归一化日志（历史）；加载失败会打 `[ThreeAR][asset-error]` 并抛 `asseterror` 事件，需要核对缩放时可在 `instantiateModel` 临时打印 `extent` 与 `multiplier`。

快速验收建议：

1. 准备两个原始尺寸差异很大的模型（如一个 0.2m，一个 8m）。
2. 在普通模型路径下观察最终视觉大小应接近一致（最长边约 1m）。
3. 在巨型路径下观察应约为普通模型 15 倍体量。
4. 在音频路径下观察耳机模型最长边应稳定在约 0.3m。

## 可优化点（可选）

1. 将 `1`、`0.3`、`15` 提升到统一配置，避免多处硬编码（目前仍在各调用点硬编码）。
2. 为 `maxExtent <= 0.0001` 增加告警日志，便于定位损坏模型或异常包围盒。
