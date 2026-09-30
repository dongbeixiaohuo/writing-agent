# DSH 前端源码移植映射

状态：`PORTED_VERIFIED_WA025_WEB_ACCEPTANCE`  
对应任务：WA-002 / WA-023 / WA-011 / WA-012 / WA-024 / WA-025  
固定上游：`deepseek-ai/deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`  
许可：MIT  
当前是否已复制：是；10 个登记文件

## 1. 结论

新版 UI 继续以 DSH 源码为唯一视觉基础；旧 `writing-agent-app/src/App.tsx`、旧全局 CSS 和 Tauri 启动链未进入新依赖闭包。WA-023 已按固定 commit 精确复制首个可执行竖切所需的 10 个主题、布局、侧栏、输入和 Button 文件，并用自有 composition/bridge 隔离上游 Host。WA-012/013/014 在同一右栏/主题体系内加入稿件、差异、版本、核查、来源和交付，没有新建第二套页面或视觉系统；WA-024 集中品牌/主题/Slot，WA-025 已用固定上游和真实 Application Service 完成量化 Web 验收。

源码审计确认，DSH UI 是插件/Slot 组合，不是独立组件库：`client/web` 启动页面，`modules` 装载浏览器模块，`ui-renderer`/`ui-slots` 组合 React 树，typed Remote/API 与 Host 提供 session、workspace、settings 和文件读取。只复制可见组件会留下隐式 DSH Host 依赖，或者迫使本项目重写每个页面的数据层，均不符合要求。

`frontend-foundation` 与 `frontend-shell-and-writing-surfaces` 已在 `upstream-sources.json` 标为 `ported_verified`；其他 runtime、Host 和 desktop 范围仍为 `audited_planned` 或 `excluded`，不得从本次 UI 基线推导为已移植。

### 1.1 WA-023 实际复制切片

| 固定上游范围 | 本仓库目标 | 状态 |
|---|---|---|
| `ui-theme/src/styles/{base,design-platform,scrollbar,corner-shape}.css` | `packages/ui/src/upstream/theme/` | 字节精确，hash 已登记 |
| `ui-layout/src/client/AppFrame.module.css`、`columns.ts` | `packages/ui/src/upstream/layout/` | 字节精确，column solver 有单测 |
| `ui-sidebar/src/client/SidebarRoot.module.css` | `packages/ui/src/upstream/sidebar/` | 字节精确，宽/窄栏浏览器实测 |
| `ui-conversation/.../InputBar.module.css` | `packages/ui/src/upstream/conversation/` | 字节精确，发送/停止/中文输入壳实测 |
| `ui-primitives/src/Button.tsx`、`Button.module.css` | `packages/ui/src/upstream/primitives/` | 字节精确，实际进入 mock bundle |

完整 SHA-256、原/目标路径与 MIT notice 分别见 `upstream-sources.json` 和 `THIRD_PARTY_NOTICES.md`。自有 `WritingAgentShell`、图标、品牌、Mock 数据及 adapter CSS 是派生层，不冒充上游原文件。

## 2. 来源模块明细

`Git OID` 是固定 commit 下的目录 tree id；表中范围大于上述实际切片时，“目标”仍是后续计划，不代表全部目录已经移植。

### 2.1 启动、组合、主题和基础控件

| 上游目录（文件数 / Git OID） | 关键入口 | 必要依赖 | 目标与差异 | 最低测试 |
|---|---|---|---|---|
| `packages/client/web`（22 / `9585c8b...ba50`） | `src/boot-client.ts`、`boot.ts`、`mount.ts` | modules、renderer、构建配置 | 移植到 `apps/web`/`packages/ui/shell`；启动自有 Host，不读取 DSH profile | 本地离线启动、无 DSH server/CLI |
| `packages/client/modules`（13 / `d507a6a...db7`） | `src/client/manifest.ts`、`system.ts` | Cordis loader、manifest | 保留模块装载思想；模块表由本项目固定，正式包禁运行时拉代码 | 模块顺序、缺失/重复模块失败 |
| `packages/client/ui-renderer`（25 / `c356aac...093`） | `src/client/app.tsx`、`registry.ts`、`scoped-slots.tsx` | React、slots、store | 保留 React/Slot 组合与生命周期 | mount/unmount、Slot 隔离、错误边界 |
| `packages/client/ui-slots`（12 / `1bd5db9...b50`） | `src/renderer.ts`、`store.ts` | Cordis、renderer 类型 | 保留为内部扩展，不作为外部 DSH 插件 | 注册/注销、键冲突、顺序 |
| `packages/client/ui-theme`（36 / `3a88771...cfd`） | `src/boot-theme.ts`、`src/styles/*.css` | settings、layout、locale | 保留 `--dsw-*` token、明/暗/系统主题；设置改存自有服务 | 首屏无闪烁、三主题、字号、对比度 |
| `packages/client/ui-primitives`（180 / `883082f...456`） | 控件、Markdown renderer、icons | React、Lexical、Markdown/Shiki 等 | 按页面真实使用闭包移植；保留 URL 消毒，逐项审计图标/资产 | 控件、键盘、Markdown XSS/URL、长中文 |
| `packages/client/locale`（23 / `4a7e31b...ac7`） | locale service/messages | renderer、settings、primitives | 保留文案结构；替换用户可见品牌和产品语义 | 中英文 fallback、动态切换 |

### 2.2 布局、导航与文档面板

| 上游目录（文件数 / Git OID） | 关键入口 | 必要依赖 | 目标与差异 | 最低测试 |
|---|---|---|---|---|
| `ui-layout`（23 / `d378b61...d7d7`） | `AppFrame.tsx`、`columns.ts`、`theme-presenter.ts` | renderer、slots、theme、session | 保留三列 AppFrame、收放和右栏；Writing Agent 面板走 Slot | 1440×900/1280×800、窄窗、拖宽、全屏 |
| `ui-dockkit`（37 / `4ff72df...668d`） | dock service/components | renderer、store、primitives | 保留必要 docking，不增加页面设计器 | tab 生命周期、恢复、键盘 |
| `ui-sidebar`（21 / `154ee0a...e44c`） | 左侧导航/品牌 seats | layout、workspace、renderer | 项目/会话导航适配 `projectId/sessionId`，不显示官方账户 | 项目切换、归档状态、迟到响应隔离 |
| `ui-sidebar-right`（37 / `df4cacd...c0b4`） | 右栏 tab/track | layout、dockkit、session | 保留右栏组合，为稿件/证据/版本提供扩展位 | 开关、全屏、tab 持久/释放 |
| `resources`（12 / `d4ea8d5...4f91`） | resource provider model | protocol、store、slots | 地址改接自有 artifact/material 查询 | 授权范围、404、版本变化 |
| `ui-sidebar-documentpreview`（96 / `4c218f0...fa4`） | `TextPreview.tsx`、`document/registry.ts`、Markdown/HTML bodies | resources、workspace-files、PDF/Markdown | 首版只保留安全的文本/Markdown/必要图片/PDF只读预览；领域稿件另接 ArtifactVersion | 大小限制、路径越界、只读、资源释放 |

DSH 的 HTML viewer 使用 Blob iframe 和精确 `sandbox="allow-scripts"`（无 `allow-same-origin`），并能封装有限本地 JS/CSS。Writing Agent 首版明确不移植该脚本执行能力：模型、用户或网页材料中的脚本均不执行。若未来加入 HTML 预览，必须单独安全评审；视觉保真不能覆盖此差异。

上游 document preview 明确是预览而非编辑。WA-012 已通过 Client Bridge v3 调用 `body.save`/revision 领域命令并携带版本与 operationId；不得把文件预览 Remote 变成直接写盘通道。

### 2.3 对话、会话、工具和设置

| 上游目录（文件数 / Git OID） | 关键范围 | 本项目处理 | 最低测试 |
|---|---|---|---|
| `ui-conversation`（112 / `babe7dc...eb3e`） | event assembler、composer、input/queue contract | 保留视图/输入体验，事件改接本项目 session/run 投影 | 流、历史 prepend、revision gap、取消、重连 |
| `ui-chat`（122 / `91389dc...f410`） | assistant/user/tool/usage view | 保留聊天呈现；只显示已记录真实事件 | 流式文本、工具状态、错误、长内容 |
| `ui-session`（10 / `ef3f7f7...1eac`） | session controller → Slot adapter | 适配 `projectId/sessionId` 显式关系 | 跨项目隔离、会话恢复 |
| `ui-tool`（59 / `a3e5bf3...be0`） | tool tree/registry/views | 只注册获准写作工具，不挂 shell/任意执行 | pending/success/failure/cancel、输出上限 |
| `ui-workspace`（31 / `74ffb06...f1aa`） | workspace select/create | 改为写作项目入口，不读取 `$DSH_HOME` | 创建/切换/无项目/迁移入口 |
| `ui-model-selection`（19 / `1dc154e...e873`） | 模型选择 | 接 provider capability/配置引用 | 不兼容预检、离线、Key 缺失 |
| `ui-settings`（18 / `3567b79...62ea`） | 设置 shell/extension seats | 保留结构；只挂本项目设置 | 导航、保存状态、错误回读 |
| `ui-settings-models`（40 / `28bcbee...988e`） | provider editor、DeepSeek onboarding | 复用通用交互；删除官方套餐/身份暗示，改接安全凭据引用 | Key 不回显、不进日志、provider 差异 |
| `ui-deliverables`（30 / `f46e608...0dd3`） | produced-files turn tail | 改为 ArtifactVersion/工作备份/正式交付语义 | stale/blocked/passed、旧导出不覆盖 |

## 3. Client/Host/API/类型闭包

以下不是可见组件，但属于所选 UI 的必要审计范围：

| 类别 | 固定来源 | 决定 |
|---|---|---|
| Client connection/store | `packages/client/connection@0f22ab5...`、`store@093e34e...` | 保留 snapshot/store 和可取消请求中有价值部分；transport 由自有 bridge 承担 |
| Host delivery | `packages/host/webserver@9031ef1...`、`frontend-static@36ea968...` | 参考静态资源/本地 Host；不得连接外部 DSH Host |
| API gateway/remotes | `packages/api/gateway@c2a9cd3...`、`remotes@1f0c558...` | 保留 typed Remote 结构候选；远程命令改为本项目 Application Service |
| Session/settings/workspace APIs | `session-controller@f13e361...`、`settings-controller@936aa89...`、`workspace-controller@0fde5a6...`、`workspace-files@a4e18ed...` | 只取 UI 所需读模型/流/取消模式；领域状态和授权重写 |
| 类型协议/生成 | `packages/typert/protocol@3218368...`、`registry@9d24c2d...` | WA-023 实测生成链；若保留必须纳入 build/CI，禁止手写漂移副本 |
| Web 入口 | `apps/web@a183a80...` | 新应用共享同一 Web UI；移除 upstream preview runtime 和 coding 模块 |

递归依赖分析显示：如果直接采用上游 `dsh-web-app` bundle，会拉入 terminal、plugin inventory、subagent、schedule、feedback、DeepSeek provider、shell 和完整 `dsh-base`。因此不使用上游 bundle 作为产品运行时；保留所需源码包边界，以本项目 composition 明确挂载模块。

## 4. 品牌、端点和资产

### 不启用的上游模块/行为

- `packages/client/ui-brand-official`（OID `23deaf6...f99`）不挂载；以 `packages/ui/brand` 自有模块填充品牌 Slot。
- 官方反馈、遥测、账户/套餐、插件市场、在线插件安装和 coding terminal 不进入首版 composition。
- DSH Desktop 的生产更新源包含 `https://download.deepseek.com`，并使用官方 COS 上传流程；本项目不得继承。未建立自有签名更新服务前，禁用自动更新并引导到本仓库 Release。
- 不复用 DeepSeek Logo 作为 Writing Agent 图标；上游法律署名和源码来源仍保留。

### 必须逐项替换/审计

- 页面标题、Logo、欢迎页、About、帮助、反馈、外链、模型 onboarding。
- appId、自定义协议、安装目录、应用数据目录、更新 URL 和签名配置。
- 图标、字体、PDF worker/WASM 等实际进入 bundle 的资产及许可。
- Markdown/链接/远程图片策略，尤其是模型或网页材料带来的不可信 URL。

## 5. 桌面壳来源

`apps/desktop`（171 个文件，OID `5c34ef8a69782a01782ca396ab705da3108de3c7`）是 Electron 44 壳，捆绑 Node/pnpm/dsh runtime、profile/plugin 管理、自动更新和签名流程。它只能作为最小壳的源码来源候选：

- 保留：受限 renderer、preload/IPC 边界、host process 生命周期、Windows 打包中可复用的安全思路。
- 替换：所有 DSH runtime/profile/package-set 启动、自有数据目录和 bridge。
- 排除：官方更新源、COS 上传、在线插件管理、与 CLI 共享 `$DSH_HOME`。
- 验证：`contextIsolation=true`、renderer 禁 Node、IPC allowlist、自定义协议路径校验、导航/外链策略、匹配平台的 native 依赖。

WA-017 已采用 Electron 44 最小壳，并且只精确复制上游的 `single-instance.ts` 生命周期助手；对应 hash 和固定 commit 已进入 `upstream-sources.json`。其余 preload/IPC、自定义协议、数据目录、runtime host、打包与产品身份均为 Writing Agent 自有实现。替代容器仍需单独 ADR 和维护者批准；不能静默回到旧 Tauri 或产生第二套新前端。

## 6. 目标映射与改动入口

| 目标 | 来源 | 允许差异 |
|---|---|---|
| `packages/ui/shell` | web/modules/renderer/slots/layout/sidebar/conversation | 自有 composition、项目语义、安全裁剪 |
| `packages/ui/primitives` | ui-primitives + 实际使用闭包 | 只保留所需控件/渲染器；安全补丁 |
| `packages/ui/theme` | ui-theme token/styles | 集中品牌 token 覆盖，不散改组件 |
| `packages/ui/brand` | 自有实现；复用 Slot 合同 | Writing Agent 名称、Logo、About/帮助 |
| `packages/client-bridge` | connection/store/API/type 思路 | 自有协议、兼容握手、snapshot/stream/cancel/reconnect |
| `packages/ui/src/shell` 写作扩展（后续可按需拆到 `packages/writing-ui`） | 注册现有右栏/Slot 语义 | WA-012 已实现稿件、差异、锁和版本；证据、核查与导出后续接入 |
| `apps/web` | apps/web 构建模式 | 自有 Host 与组合，不带上游 preview/coding runtime |
| `apps/desktop` | DSH 单实例助手 + 自有 Electron 最小壳 | 自有 runtime/路径/IPC/协议/发行；不带 DSH host/updater/plugin |

## 7. 来源和差异验证

WA-023 已新增并执行以下自动检查：

1. 每个 copied file 在 `upstream-sources.json` 有原路径、固定 commit、SHA-256、目标路径和状态。
2. 禁止新应用 import `writing-agent-app/src/**`、旧 CSS 或 Tauri 启动代码。
3. 禁止发行闭包执行 `dsh`、读取 `$DSH_HOME`、连接外部 DSH server 或运行时加载上游页面。
4. 扫描用户可见 DeepSeek 品牌和官方更新/反馈/遥测端点；法律/来源文本列入允许清单。
5. 测试 HTML 不执行脚本、文档预览只读、renderer 无 Node 权限。
6. 在固定内容下执行视觉/交互基线，差异只能来自品牌、安全裁剪或已审核写作扩展。

检查入口为 `npm run check:ui`；测试矩阵、白名单和结果分别见 `docs/testing/UI_BASELINE_PLAN.md`、`UI_CHANGE_ALLOWLIST.md`、`WA023_RESULTS.md`、`WA011_RESULTS.md` 和 `WA012_RESULTS.md`。WA-011 已按 ADR-0003 将 production composition 接到自有 Bridge；WA-012 将协议升至 v3，并以同一进程内 Application adapter 与 Local Web Host/Remote 接入受版本保护的稿件编辑。正式运行不启动外部 DSH server；具体安全、恢复与修订契约见 `CLIENT_BRIDGE_PROTOCOL.md`、`REVISION_CONTRACT.md`。

## 8. WA-002 前端部分完成判据

- [x] 固定 client、Host、API、类型生成、主题、品牌和 desktop 来源。
- [x] 明确直接移植、适配、重写和排除项及计划目标。
- [x] 记录官方品牌、更新、反馈/遥测和插件能力的隔离边界。
- [x] 记录 HTML `allow-scripts` 与本项目禁脚本的安全差异。
- [x] 明确 document preview 是只读，不冒充稿件编辑。
- [x] WA-002 完成时未复制源码；WA-023 复制后已同步 registry、notice、hash、自动测试和真实截图，不把 Mock 冒充真实 runtime。

> OID 在正文中为便于阅读有缩写；完整值以 `upstream-sources.json` 为准。
