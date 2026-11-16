# AR 渲染模块与独立 Layer

`lib/three-runtime/render-layers.js` 管理注册、生命周期、异步代次、节点所有权和逐层合成。`ARRuntime` 仍只创建一个 Canvas、WebGLRenderer 和 VisionKit 会话；渲染器不识别具体业务模块。装配入口为 `components/xr-start/render-modules/index.js`，与页面 UI 注册表分别管理 3D 内容和 WXML slots。

## 当前模块

| ID | 内容 | 深度策略 | 内容管理 |
| --- | --- | --- | --- |
| `world` | GPS / 识别发现的普通素材及巨大模型 | shared | 普通素材串行队列、容量桶与模型缓存 |
| `scene` | 地图 Scene 和独立 Scene 预览 | shared | 独立加载队列与取消代次；整场播放、灯光与资源释放 |
| `danmaku` | 活动历史留言与发送动画 | isolated | 独立请求、身份、队列、容量、避让与飞行动画 |
| `confetti` | 彩带 | isolated | 独立生成定时器、节点及回收 |

GPS / 图像识别是普通内容的发现方式，不各建一套渲染器。Scene 与普通内容保留共享的空间深度。弹幕仍采用 SLAM 世界坐标，但不参与普通素材的容量、布局、斥力或透明排序；其屏幕像素可以覆盖 Scene，即便弹幕在几何上离相机更远。

活动源使用服务器记录 ID，在自己的索引内去重，不再向普通素材允许集合插入 `activity:` ID。历史留言上限 20，已发送留言上限 8；待生成历史队列上限 40，每帧至多创建一条且间隔至少 40 ms，参数见 `config.js` 的 `danmaku`。普通素材和活动素材可复用纯文字生成器，但互不持有对方的节点。

## 注册接口

```js
const layer = runtime.layers.register({
  id: "new-activity",                 // 注册表内唯一，可在卸载后重新注册
  label: "新活动",                    // 顶部调试栏标签
  order: 150,
  space: "world",                    // world 或 view
  depth: "isolated",                 // shared 或 isolated
  lit: false,                        // 无灯光文字/粒子不创建环境光资源
  actions: { update: payload => updateContent(payload) },
  onFrame: ({ dt, now, camera, tracking }) => animate(dt, camera),
  onResize: ({ width, height }) => resizeLayout(width, height),
  onResume: () => resumeWork(),
  onPause: () => pauseWork(),
  onReset: reason => clearOwnedState(reason),
  onDispose: () => removeSubscriptions(),
});
```

模块通过 `runtime.layers.dispatch(moduleId, action, payload)` 通信。暂停、禁用、卸载后的动作不执行，未知动作不透传；相机、Renderer 和其他模块的内部状态不属于业务动作包。

句柄提供 `root`、`active`、`enabled`、`capture()`、`mount()`、`remove()`、`clear()`、`setEnabled()` 和 `dispose()`。`root` 用于局部变换和只读遍历，节点所有权必须通过 `mount/remove` 登记。一个节点只能被一个 layer 持有。

```js
const current = layer.capture();     // 在开始异步任务前捕获
const resource = await loadResource();
layer.mount(resource.node, {
  current,
  dispose: () => resource.dispose(), // 完整释放该实例及其 GPU / 媒体资源
});
```

`clear`、暂停、禁用、卸载都会使旧 `current()` 返回 false。迟到的 `mount` 立即调用清理函数，不挂入场景；卸载后用相同 ID 注册新模块也不能复活旧任务。自定义 `dispose` 负责完整资源释放，省略时默认调用 `disposeTree`。共享模型继续通过 cache handle 归还引用，不能直接销毁共享模板。

## 生命周期

- 注册：创建独立 Scene/root，通知初始尺寸；宿主已运行且模块启用时调用 `onResume`。
- 宿主开始/暂停：统一通知各模块；暂停取消在途代次、停止帧更新及绘制。通用注册表可保留已挂载节点，当前空间业务模块在 `onPause` 中清空，确保媒体、定时器和旧 SLAM 内容停止。
- `clear(reason)`：只重置该模块、释放自己的节点；其他模块不受影响。`onReset` 清理请求、队列、索引等非 Three 状态。
- `setEnabled(false)`：暂停并清空该模块；重新启用后进入新代次。UI 收起或切换底部标签不会触发这项操作。
- `dispose()`：注销单个模块；重复调用无副作用。运行时退出释放所有模块后才销毁 Renderer。
- 空间跟踪暂时丢失：暂停 world 模块的帧更新及绘制，保留原有世界位置；不等同于会话退出。view 模块使用原点相机，可以继续显示。

重扫、命中和移动重扫只清空 `world/scene`；活动请求与排队保持有效。切换发现模式、进入后台、会话错误和退出清理所有内容。Scene 的请求与素材加载队列分离，慢模型加载不会阻塞 Scene；旧 Scene 请求的完成回调不能清掉新一代的加载状态。

## 合成与诊断

每帧先绘制原生相机背景，再绘制所有 shared 模块，最后按 `order` 绘制 isolated 模块。同策略、同顺序时按注册先后排序。shared 模块限定使用 world 相机；isolated 模块在绘制前只清除深度，不清除颜色，保留自身内部的深度和透明排序。各 Scene 的背景保持透明，已有独立 Scene 灯光流程在各自 layer 内运行。

`space: "view"` 使用原点相机与当前投影，适合相机相对提示；`space: "world"` 使用同一原生 SLAM 相机。模块数量不受 Three.js 32 位 Layers 掩码限制；每个可见模块会增加绘制开销，不意味着可以无限增加同时在场的内容。无需为每层创建全屏离屏纹理。

单个模块更新或绘制失败时禁用并释放该模块，同时报告错误，其他模块继续运行；相机和 WebGL 上下文丢失仍属于整个运行时错误。层状态变化通过 `renderlayers` 事件进入页面运行时模块，再由 UI 注册表 `publishDebug` 发布到顶部；同一轮同步变化合并发送。多通道 GPU 提交统计按帧累计。

## 验证

`npm run test:render-layers` 覆盖共享/独立深度绘制顺序、view 相机、注册与重复注册、单层开关/重置/卸载、异步迟到释放、模块异常隔离，以及 Scene 独立队列的同 ID 竞态。`test:ar-runtime` 使用真实 Three 节点验证识别与弹幕共存、重扫保留、独立关闭与整体退出；`test:activities` 覆盖活动发现和审核/范围变化；`test-scene-asset` 覆盖真实组件前后台与播放资源回收。

浏览器 WebGL2 像素测试确认：普通内容与 Scene 共享遮挡，独立活动层覆盖更近的普通内容，禁用活动层恢复原画面。该测试和 Node/native API 替身不能替代真机 SLAM、原生媒体、发热及帧率验收。
