# rc.48：minimap 渲染修复（自锁 bug）与最小可视验证

日期：2026-09-27。范围：对话 minimap 组件挂载逻辑；不修改写作工作流、事实门禁、存量项目数据或凭据。

## 根因

rc.47 交付的 minimap 在用户界面完全不出现。自查代码确认是组件的自锁 bug：`if (!scrollable) return null` 让轨道元素在"不可滚动"时不挂载，而"能否滚动"的判断又要读取轨道自身高度（`trackRef.current.clientHeight`）——不挂载则高度恒为 0，`scrollable` 恒为 false，组件永远不显示。这是"只过类型检查和单元测试、不做最小可视验证"必然漏掉的一类错误。

## 修改与验证

- `scrollable` 改为只由 `scrollHeight > clientHeight + 1` 决定，与轨道高度无关；轨道元素始终挂载（`display: none` 占位），标记与视口框按 `scrollable` 显隐；`scrollable` 纳入布局效应依赖，翻转后立刻用已挂载轨道重新测量。
- **浏览器端到端实测**（vite mock 模式 + 浏览器工具）：mock 时间线临时注入 60 条填充消息使会话流可滚动，实测到 `scrollable=true`、61 个消息标记、视口框 11px；在 minimap 轨道约 1/3 高度处点击，会话流平滑跳转到对应位置（视口内容从末尾真实消息变为中段填充消息）。验证后已撤除全部临时改动（调试标记与填充消息均已还原，`git diff` 为零）。
- 教训固化：今后 UI 新功能交付前必须做一次最小可视验证（本仓库 vite mock 模式 + 浏览器工具即可，无需真实模型）。

## 已验证

- 上述端到端渲染与跳转实测（mock 环境，不冒充真实写作环境验收）。
- UI 78/78、Bridge 63/63、Desktop 44/44；web TypeScript 通过。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.48-x64.exe`；SHA256 `0922507c8a23497902f6eb7ccdc8ac2695e8370c819af4c590edf77c8a99a341`，与 `output/desktop/SHA256SUMS.txt` 登记一致。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0、1167 ms（`output/rc48/desktop-smoke.json`）；长 OneDrive 路径直启沿用既有规避。
- 两处 `resources/app.asar` SHA256 一致：`752ff0604d117f30cd2bd14fbfd0a92d68df8cd35acf43f9a94a12fd67a6ad9f`。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证（除上述 mock 实测），未触碰用户正在运行的已安装实例与真实凭据。
- 用户侧验证点：安装后打开任一消息较多的会话（如"ai短期对人类就业的冲击不可避免"），右缘应出现消息标记条与视口框；点击定位条应平滑跳转。
