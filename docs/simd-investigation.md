# MediaPipe SIMD 真机兼容性调查

2026-11-09。用户决定暂停排查，生产与默认实验构建使用无 SIMD。稳定基线提交：`bc1d725`。测试机：iPhone 15 Pro、iOS 26.6.2、微信 8.0.80、基础库 3.17.6。

## 已复现的故障

同一模型、同一对 320×320 合成图：官方无 SIMD 版在真机得到余弦相似度 0.285722；SIMD 版得到 0.999999662。模拟器两版均约 0.285750。像素与 WebGL 读回统计正常；限制 `readPixels` 缓冲区没有修复。详细设备证据见 [初始化与输入检查](benchmarks/image-match-initialization-2026-11-09.json)。

原始 SIMD 与无 SIMD 包来自 `@mediapipe/tasks-vision@0.10.21`。现有构建把 Emscripten JS memcpy 替换为 WASM `memory.copy`，两版真实初始化内存均已与上游做固定时钟 SHA-256 一致性回归；该回归不等于已证明真机所有推理计算正确。

复核已回传的故障记录：`node scripts/diagnostics/check-embedding-result.cjs .cache/image-match/events-1794195519462-33cad8.jsonl` 返回 `pass:false`、相似度 `0.9999996624751116`、退出码 1。该命令是保存记录的判定器；实际复测仍须在手机重新运行两图自检，不能拿旧记录当新版本结果。

## 联网核对

- [微信官方 WXWebAssembly 文档](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/wasm.html)：当前明确写明“从微信 8.0.25 开始支持 SIMD 特性”。没有给出逐指令兼容表，也没有说明本次特征塌缩问题；不能仅凭支持声明认定数值正确。
- [TensorFlow.js #5021](https://github.com/tensorflow/tfjs/issues/5021)：2021 年报告基于微信 8.0.3，称当时没有 SIMD/线程支持，并禁用了 SIMD 检测。早于官方声明的 8.0.25，不能作为当前微信不支持 SIMD 的结论。
- [Rive 微信适配作者记录](https://github.com/henrywhuang/rive-weapp)：记录了 SIMD 编译失败 `invalid value type 0x7B`，使用无 SIMD 构建。它与我们“成功加载、数值错误”的症状不同，不能直接当成本次原因。
- [WebAssembly SIMD 规范](https://github.com/WebAssembly/spec/blob/main/proposals/simd/SIMD.md)与 [Emscripten SIMD 说明](https://emscripten.org/docs/porting/simd.html)：SIMD 有明确的数值语义；不能把任意数值偏差解释成正常浮点误差。指令探针允许 NaN 有效载荷差异，其余结果按位比较。

当前检索未找到能直接解释这份 MediaPipe 数值异常的微信官方修复记录。没有使用非官方文章对 JIT、SIMD 或线程的泛化说法作为结论。

固定二进制只使用标准 SIMD，没有 Relaxed SIMD 指令。当前优先顺序是逐指令数值错误、MediaPipe SIMD 处理分支、二进制适配差异；尚未确定根因，不把任何候选改动作为已修复版本。

## 最小指令探针

`node scripts/diagnostics/build-simd-probes.cjs` 从固定 MediaPipe 二进制提取用到的 90 种 SIMD 指令及 shuffle 掩码，生成 183 个 WASM 函数、2,196 个数值用例。覆盖不同输入、非对齐读、lane 读写、数值转换、浮点运算和整数运算。探针不运行优化器，以保留被测指令；Node WebAssembly 产生期望结果。

入口：`labs/image-match/index?simdProbe=1`。不加载模型、不打开相机，只实例化约 5.6 KB 的测试模块。结果回传至本地 `events-*.jsonl`。

读取最近且哈希匹配的真机结果：`node scripts/diagnostics/read-simd-result.cjs`；模拟器加 `--simulator`。有数值差异时退出码为 1，无报告为 2，通过为 0。Node 与微信模拟器目前全部通过。探针覆盖指令样例，不是完整的 WebAssembly 一致性认证；复杂调用、长循环和寄存器压力仍可能需要进一步缩小复现。

## 暂停前的最终证据（2026-11-09）

[真机汇总](benchmarks/image-match-simd-final-2026-11-09.json)：首轮 90 种指令、183 个函数、2,196 个用例全部通过。扩展版加入 26 MiB、64 MiB+3 内存基址、memory.grow、4/16/40 个向量局部变量及直接/间接向量调用，188 个函数共 6,768 个用例，真机和模拟器均零差异。

随后使用字节未改动的官方 SIMD WASM，将 JS memcpy 转调独立 WASM memory.copy helper；手机不同图片的相似度仍为 0.999999662，模拟器约 0.285751。该对照排除了“必须由主模块 memory.copy 二进制改写引起”的解释；固定时钟 Node 全内存一致性也通过。

尚未定位到具体错误指令或内核。基本探针通过不证明完整模型正确，也不能泛化为微信所有 SIMD 都错误。用户已要求以后再排查，本轮不继续收窄故障；保留探针源码与原始回传，生产改为同一模型的无 SIMD Worker。实验构建需要恢复时运行 `npm run build:image-match-lab`，生产构建为 `npm run build:image-matcher`。
