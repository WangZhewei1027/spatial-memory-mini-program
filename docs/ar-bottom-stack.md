# AR 页面 Slots、调试栏与功能导航

`pages/ar/ar` 负责组合模块与页面生命周期。`ar-shell` 使用原生 `multipleSlots: true`，将场景、顶部诊断、业务覆层和底部操作分开，保留主要 AR 观看区域。定位由传感器模块提供，不作为底部业务入口；`retrievalMode` 只决定普通素材怎样发现，不决定能否参与活动。

## 页面装配

| Slot | 当前组件 | 职责 |
| --- | --- | --- |
| `scene` | `xr-start` | 相机、识别与空间内容 |
| `top` | `ar-debug-bar` | 单行诊断，可横向滚动 |
| `overlay` | Logo、`ar-shop-overlays` | 品牌、打卡罗盘与奖励弹窗 |
| `bottom` | `ar-recognition-panel`、`ar-danmaku-panel`、`shop-checkin` | 当前业务面板；图标导航由 shell 统一绘制 |

静态组件声明在 [`ar.json`](../miniprogram/pages/ar/ar.json)，slot 装配在 [`ar.wxml`](../miniprogram/pages/ar/ar.wxml)，布局在 [`ar-shell`](../miniprogram/components/ar-shell/index.wxml)。注册表提供模块可用状态、顺序、导航、动作和调试分发，不动态加载任意 WXML；新增界面仍须在 `usingComponents` 与页面模板中声明。

页面方法按 [`pages/ar/modules/`](../miniprogram/pages/ar/modules/) 拆分：`context.ts` 定义组合接口，`ui.ts` 管理注册表与事件转发，`activities.ts` 管理留言和打卡动作，`recognition.ts` 接收识别状态，`runtime.ts` 接收地图和相机状态，`sensors.ts` 管理定位、罗盘及订阅释放。

## 导航与状态保留

底部按下表顺序显示可用入口，当前面板紧贴导航上方，每次只展开一个：

| 入口 | 显示条件 | 业务内容 |
| --- | --- | --- |
| 识别 | 地图配置就绪且为 `anchor` 模式 | 面向访客的识别提示、重新扫描 |
| 留言 | 有 `activeDanmaku`，或活动正在加载、加载失败 | 活动选择、字数、范围提示、输入与发送、加载及重试提示 |
| 打卡 | 地图配置就绪且 `shopCheckinEnabled` | 活动选择、服务端进度、打卡点距离与操作 |

注册表输出 `bottomNavItems`、`activeBottomPanel`、`bottomPanelExpanded`。未手动选择时默认第一个可用入口；手动选择仍可用时保留，否则回到第一个可用入口。没有可用业务时不绘制底栏，顶部诊断仍可显示。

图像识别的低阈值线索只在识别面板内沿显示呼吸边框，并提示“画面中可能有目标”。navbar 保持原样，图标和标签不闪烁；提示不会改变当前入口或展开状态，面板不显示时不绘制边框。具体相似度门槛与失效规则见[识别流程](anchor-recognition.md#调度与释放)。

shell 的 `panelchange` 经 `onPanelChange()` 转给注册表 `select()`：切换入口时展开对应面板，再次点击当前入口可收起或展开。标签切换不会关闭业务模块或重新挂载 `xr-start`。留言草稿和所选活动继续保留；打卡组件在启用期间保持挂载，首次打开后保留 `visible`，`panelCollapsed` 只隐藏详情列表。`onActivate` 在重新打开打卡面板时刷新服务端进度。

打卡业务组件通过 `shop` 模块发布 `target`、`compass`、`reward` 动作：目标转给 XR，罗盘与奖励状态转给独立的 `ar-shop-overlays`。覆层再发送 `closeReward`、`saveReward`，由注册动作调用打卡组件。覆层不占底部面板高度，切换标签不丢失当前导航、奖励或在途请求。

## 调试与模块接口

顶部汇总 GPS 精度、经纬度、海拔、朝向、相机状态、活动加载状态和匹配数据；底部保留用户需要采取行动的提示、活动选择、范围、距离与打卡进度。识别事件 `recognitionstatus` 的 `message` 用于业务面板，`diagnostic`、`phase` 用于顶部；技术准备数量、确认次数和原始错误进入诊断。`matchprogress` 保留原接口并进入顶部。字段详情见 [识别流程](anchor-recognition.md#页面状态接口)。

[`createUiRegistry`](../miniprogram/utils/ar-ui/registry.ts) 每页创建一次，不拥有业务数据。`register()` 返回 `update()`、`publishDebug()`、`unregister()`；`batch()` 合并状态同步，`select()` 管理面板，`dispatch()` 仅执行已启用模块声明的动作，`dispose()` 在页面退出时释放注册。调试贡献独立于模块启用状态，模块应以 `publishDebug([])` 主动清除；每次发布替换该模块的完整调试列表。

新增模块在自己的文件中注册，并接入 `ui.ts` 的初始化与同步。以下为接口示意，`runExample` 由新业务模块实现：

```ts
const feature = registry.register({
  id: "example", slot: "bottom", order: 40,
  navigation: { label: "示例", icon: "scan-line" },
  actions: { run: payload => runExample(payload) },
});
registry.batch(() => {
  feature.update({ enabled: true });
  feature.publishDebug([{ key: "state", label: "示例", value: "就绪", order: 90 }]);
});
```

对应原生组件在 `ar.json` 声明后，加入 `ar.wxml` 的 shell 内：

```xml
<example-panel slot="bottom"
  active="{{bottomPanelExpanded && activeBottomPanel === 'example'}}"
  bind:moduleaction="onModuleAction" />
```

组件通过 [`utils/ar-ui/action.js`](../miniprogram/utils/ar-ui/action.js) 发出意图，统一事件包为 `{ moduleId, action, payload }`，由页面转给 `dispatch()`：

```js
const emit = require("../../utils/ar-ui/action");
Component({ methods: {
  onRun() { emit(this, "example", "run", { source: "button" }); },
} });
```

模块 ID 必须唯一，只有 `bottom` 模块可注册导航；移除模块时调用其 `unregister()`，页面退出统一 `dispose()`。slot 元数据不会代替模板中的 `active` 或 `wx:if` 条件。

## 主题、传感器与键盘

局部主题在 [`styles/ar-theme.wxss`](../miniprogram/styles/ar-theme.wxss)：主题色 `#8fbc8f`、导航背景 `#1b1e1a`、面板背景 `rgba(30, 32, 30, 0.96)`。顶部调试栏固定单行 `48rpx`；罗盘箭头和距离使用主题色，指南针圆盘与文字底板为 `rgba(0, 0, 0, 0.8)`，以承托明亮相机背景。上述值仅约束本 AR 界面。

罗盘接受首个样本，后续同时满足方向变化至少 `2°`、间隔至少 `200ms` 才更新；跨越 `0°/360°` 按最短角差计算。顶部朝向最多每秒更新一次，避免诊断刷新与 AR 渲染争用。退出页面解除传感器订阅。

shell 统一负责底部固定定位与键盘避让，系统安全区只由导航栏补齐。留言输入关闭原生 `adjust-position`，通过 `keyboard` 动作抬高整个底部区域，键盘显示时移除额外安全区留白。切换标签、输入失焦或页面隐藏时清零高度；切出留言面板或收起后的迟到键盘事件不会抬高底栏，活动刷新使输入框消失时也会关闭键盘并清零高度。

## 运行边界

活动身份为 `activity:<recordId>`，由活动接口或成功发送回执登记，不能仅凭字符串前缀放开普通素材。历史留言和即时动画复用现有文字渲染与容量桶；空间展示仍要求有效 SLAM 位姿。

| 操作 | 普通识别内容 | 活动内容 |
| --- | --- | --- |
| 扫描尚未命中 | 不展示未授权素材 | 位姿就绪后正常展示 |
| 命中 / 重新扫描 / 移动重扫 | 替换或清理 | 保留节点、待展示文字和在途活动请求 |
| 活动暂停 / 隐藏记录 / 离开范围 | 不受影响 | 下次活动刷新移除 |
| 模式切换 / 后台 / 会话错误 / 退出 | 清理 | 清理并失效在途请求 |

## 验证

- 2026-11-16 完整 `npm test` 退出码为 0，日志在 `ignore/artifacts/ar-slots-2026-11-16/npm-test.log`。新增 `scripts/test-ar-ui.cjs` 覆盖注册、选择、分发与释放；活动回归覆盖传感器首帧、组件动作、诊断、草稿和键盘状态；识别回归覆盖结构化状态事件。原有活动与 AR 生命周期回归一并运行。
- 微信开发者工具 WXML/WXSS 编译与 `npm run check:upload` 通过。固定数据截图使用实际原生组件及生产模板，XR 使用 mock，店铺业务 I/O 使用 stub，无后台写入。截图位于同目录的 `recognition.jpg`、`danmaku.jpg`、`shop.jpg`、`collapsed.jpg`、`keyboard.jpg`、`reward.jpg`、`bright.jpg`；键盘为固定 `280px`。临时验证页已删除，`app.json` 精确恢复，模拟器已回到原首页。
- 独立视觉复查指出的 F1 指南针对比度问题已调整底板，并用白底截图确认；该项结论为 `resolved / ship`。这不证明真实相机、GPS、输入法或完整真机 AR 行为，相关现场验收仍待完成。
- 后续已修复类型检查发现的 5 处错误：首页授权 key、场景页追踪恢复状态、`wx.getDeviceInfo` 声明和 `getApp` 泛型约束。项目固定 TypeScript 5.9.3，`npm run typecheck` 全量通过，并纳入 `npm test`。修复后的日志在 `ignore/artifacts/type-fixes-2026-11-16/`。
