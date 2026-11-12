# 实验与临时文件

本目录集中存放当前小程序不用的内容，位于 `miniprogramRoot: "miniprogram/"` 之外，因此不参与主项目编译、预览和上传。直接上传项目根目录即可。

| 路径 | 内容 |
| --- | --- |
| `labs/` | 图像匹配、SIMD、xr-three 和模拟相机场景实验 |
| `xr-frame-demo-master/` | 上游 xr-frame 参考工程 |
| `assets/`、`pages/logs/`、`utils/` | 已停用图片、平面标记模型和默认日志页及其工具 |
| `scripts/`、`tools/` | 实验构建、诊断、样例生成和旧图片处理工具 |
| `cache/` | 模型下载缓存、实验报告等本机产物，Git 忽略 |
| `artifacts/` | 旧生成产物，Git 忽略；其中的历史上传副本已停用 |

实验源码与参考资料继续版本管理；部分 Node 回归还使用这里的实验夹具。实验页面已从 `app.json` 移除，历史文档中的页面路径不再是主项目入口。

正式模型、Worker、Three.js 和 Scene 运行时留在 `miniprogram/`，正式构建与回归入口留在根目录 `scripts/`。正式代码不依赖此目录；临时产物统一写入这里。
