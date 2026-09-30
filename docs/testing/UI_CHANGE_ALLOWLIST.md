# DSH UI 基线差异白名单

状态：`APPROVED_WA025_ACCEPTANCE_CLOSED`  
固定上游：`deepseek-ai/deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`  
适用范围：WA-023 的 `DERIVED_MOCK`、WA-011 的受保护 production Web 入口、WA-012 的写作修订右栏、WA-013 的事实/来源只读页签、WA-014 的备份/交付页签、WA-015 对同一 renderer/Host 的安全复核，以及 WA-024 的集中主题/品牌/Slot 边界

## 允许差异

2026-09-21 rc.15 标题交流修复：主对话等待卡改为真实标题候选与自然语言意见，不再把拟题表达为补齐材料；卡片与主输入框使用同一交流路径。主输入框在自有 shell 内由绝对覆盖改为占据实际布局空间，避免小窗口下遮住决策按钮；同步移除原 190px 避让空白，不改上游 exact-copy 文件、三列配置、主题和权限。专项浏览器覆盖 1440×1000 / 960×640、按钮命中、输入清空、重启读回。此交互修复不宣称与旧像素基线完全相同。

2026-09-21 rc.14 用户授权增量：模型页新增静态供应商选择，自动填写协议/地址，保留自定义与高级设置。只读预设地址作为数据允许进入 renderer bundle，不赋予 renderer 外联能力；请求仍经 Host，CSP、凭据与 IPC 边界不变。设置右侧 `min-height: 0` 修复长表单导致导航/关闭按钮被整体滚出的问题，不改上游 exact-copy 切片。来源及完整范围见 [供应商预设](../implementation/PROVIDER_PRESETS.md)。旧“renderer 不得出现任何 provider 地址”的绝对文字由此收窄为“不得直接请求 provider 或混入上游运行时”。

| 类别 | 派生实现 | 原因与边界 |
|---|---|---|
| 品牌 | 自有 `BrandMark`、Writing Agent 名称、预览标签与 favicon | 官方 `ui-brand-official` 明确排除；不得使用 DeepSeek Logo 或暗示官方产品 |
| 环境标识 | Mock 固定显示“界面移植预览，未接入真实写作”；production 显示本地 Application Service 的连接/运行状态 | Mock 不得冒充真实 runtime；production 不得把流式片段冒充已保存 |
| 业务语义 | 左栏改为写作项目/会话，合成内容改为材料、简报、稿件与核查语义 | 保留布局和交互骨架，不携带 coding、terminal、subagent、plugin 等非写作能力 |
| 稿件面板 | 复用右栏位置和主题组件，production 提供块级编辑/锁定、持久差异、版本和回退；Mock 使用隔离 fixture 且只读 | 不移植上游 HTML `allow-scripts` viewer；文档预览与领域编辑明确分开，接受修改必须经过 Application Service |
| 核查与来源 | 复用右栏页签，展示当前门禁、冻结输入/hash、claims/blockers、失效原因和来源边；Mock 只使用隔离的 blocked/unknown fixture | 浏览器不计算 `passed`、不写 assessment；来源文案必须明确不等于事实真实，未知保持未知 |
| 备份与交付 | 复用右栏新增独立页签，明确区分 Markdown 工作备份与正式 TXT/HTML，展示项目级导出记录；Mock 中操作保持禁用 | 浏览器不选择任意文件路径、不自行判断门禁或渲染不可信 HTML；后端失败不得被界面伪装成成功 |
| Host/Bridge | 自有 protocol v6；production 使用随机 loopback Host/短期 capability/typed Remote，Mock 仍为独立构建 | 不执行 `dsh`、不读 `$DSH_HOME`、不连接外部 DSH Host；浏览器不直写 DB、文件或 Provider |
| 主题/品牌/布局入口 | `brand/config.ts`、`theme/config.ts` 与 shell props 集中覆盖名称、token 别名和布局偏好；默认输出保持既有视觉 | 不改上游 exact-copy 文件、不把配色写进 runtime/领域规则、不借机全面重设计 |
| 写作 Slot | 默认工作台迁到 `packages/writing-ui`，由静态 registry 挂载；project-scoped key 清除跨项目局部状态 | 不动态下载第三方代码、不建设在线市场；演示扩展不进入默认 registry 或 production bundle |
| 设置 | 保留通用/模型/关于结构、明暗/系统主题和字号；production 显示 Provider label 与凭据引用，不显示 Key | 不移植官方账户、套餐、反馈、遥测、更新和在线插件入口；Key 不进入 bridge/URL/localStorage/日志 |
| 依赖裁剪 | 仅分发实际使用的主题、布局、输入和 Button 源码切片 | 不复制完整 DSH Web bundle、字体、图标包、WASM、worker 或官方资产 |
| 安全收紧 | 只渲染 React 文本节点；无不可信 HTML 执行和外部 URL 加载 | 安全边界优先于功能等价；未来富文本/Markdown 另行测试 |

上游 built-in showcase 与派生写作 fixture 使用相同页面状态类别（hero、chat、settings、dark/light、窄窗），但正文内容按产品领域替换。这一内容差异不用于掩盖布局、主题、输入、设置或导航变化；WA-025 已补齐同场景自动行为矩阵和量化视觉阈值。

WA-015 没有新增 UI 视觉或交互差异。它把源码审计固化为自动检查：renderer/`packages/ui` 不得出现直接 provider URL、上游遥测/分析/更新/账户提交、`dangerouslySetInnerHTML`、`window.open`、`eval` 或动态 Function；Local Web Host 必须继续提供 self-only script/connect CSP、禁止 object/base/frame/form，并保持精确 loopback 同源访问。

WA-024 保持默认页面布局与控件不变，只把品牌、主题 aliases、布局偏好和面板组合移到集中入口。独立 `extension-demo` 允许显示 `Editorial Desk Demo`、棕色业务强调色和“编辑备注演示”侧栏，用于证明静态扩展能力；这些差异只允许出现在 `extension-demo.html` / `dist/extension-demo`，正式入口和 production bundle 必须没有示例 ID/文案。主题模式和字号现在经 protocol v6 持久化到 workspace 内 Writing Agent 设置文件；该文件不得包含 Key、正文、材料或源路径。

WA-025 已关闭本地 Web 视觉白名单：相对 WA-023 只批准 WA-024 已登记的“预览→演示”环境标签和“稿件预览→稿件与版本”入口文字，不批准新的布局、字号、间距或颜色变化。像素回归以单通道差值 16、changed pixel ratio 2%、mean channel delta 2.0 为固定上限，五个明暗/视口场景实际最大值分别为 0.541% 和 0.635；未使用任何区域遮罩。设置对话框相对上游减少到 640px 高，继续归入已批准的账户、更新、遥测与插件能力裁剪，宽度和两栏结构不变。

正式 Application Service 画面是业务状态证据，不作为上游像素等同目标：它必须显示“本地”身份、真实持久稿件/差异/门禁/来源和项目隔离，不能为了贴合上游 fixture 隐藏这些状态。Electron appId、preload/IPC、installer 与更新身份仍不在本白名单内，必须由 WA-017/018 实测，不能由 WA-025 Web 结果推定。

## 不允许差异

- 不得混入 `writing-agent-app` 旧页面、全局 CSS 或 Tauri 启动链。
- 不得在未登记情况下改变三列布局、280/56px 侧栏语义、composer、主题 token、设置层级或键盘交互。
- 不得删除 Mock 标识、让 production 自动回退到 Mock，或把 Mock 数据/token/核查状态写入真实项目；production 缺 bootstrap capability 时必须 fail closed。
- 不得增加 DeepSeek 官方更新、遥测、反馈、账户、插件市场或远端 Host 端点。
- 不得把 `example.editorial-notes`、`Editorial Desk Demo` 或其他示例扩展加入默认正式功能清单/production bundle。
- 不得以大范围遮罩、生成图片或手绘稿替代真实源码运行截图。

## 源码与证据

- 精确复制的 10 个源文件、SHA-256 和状态：`upstream-sources.json`。
- 法律声明和实际 browser runtime 闭包：`THIRD_PARTY_NOTICES.md`。
- 上游/派生截图与 hash：`output/playwright/wa023/`、`SHA256SUMS.txt`。
- 执行结果：`docs/testing/WA023_RESULTS.md`。
- WA-011 Bridge/Host/Remote 结果：`docs/testing/WA011_RESULTS.md`。
- WA-012 修订面板/冲突结果与实际浏览器截图：`docs/testing/WA012_RESULTS.md`、`output/wa012-ui-mock.png`。
- WA-013 门禁/来源结果与实际浏览器截图：`docs/testing/WA013_RESULTS.md`、`output/wa013-ui-fact-check.png`。
- WA-014 导出结果与实际浏览器截图：`docs/testing/WA014_RESULTS.md`、`output/wa014-ui-delivery.png`。
- WA-015 renderer/Host 安全审计：`tests/test_ui_upstream_sources.py`、`tests/check_ui_distribution.mjs`、`docs/testing/WA015_RESULTS.md`。
- WA-024 扩展/主题/持久设置：`docs/implementation/UI_EXTENSION_GUIDE.md`、`docs/testing/WA024_RESULTS.md`、`tests/wa024_ui_playwright.py`、`output/wa024-ui-extension-demo.png`。
- WA-025 视觉/交互/Bridge 终验：`docs/testing/UI_BASELINE_RESULTS.md`、`tests/ui-baseline/scripts/wa025_ui_playwright.py`、`output/playwright/wa025/WA025_REPORT.json` 与 `SHA256SUMS.txt`。
