# ADR-0005：DSH 前端源码移植与扩展边界

## 状态

- 状态：Accepted
- 日期：2026-09-16
- 对应任务：WA-004；执行任务：WA-023 / WA-024 / WA-025
- 固定来源：`deepseek-ai/deepseek-harness@0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`

## 决策

DSH 前端源码是 Writing Agent 1.0 唯一的新 UI 基线。WA-023 直接移植固定 commit 下形成可运行页面所需的源文件、样式、资产、类型生成和 Client/Host 闭包；不按截图仿写，不混入旧 `writing-agent-app` 页面/CSS，也不在运行时连接外部 DSH 服务。

移植采用“可执行竖切闭包”粒度：

1. 先实现六个确定性场景：空 workspace、项目/会话导航、普通对话与输入、工具执行中、设置/模型配置、侧栏文档预览。
2. 每个场景从 `client/web` 入口向内解析 imports，按实际需要复制源文件及必要依赖；不能只复制可见 React 组件，也不复制完整 `dsh-web-app` bundle。
3. 在 `packages/ui/shell|primitives|theme` 内为每个上游 package 保留独立 `upstream/<package-name>` 边界；自有 composition、adapter、品牌和写作面板放在 upstream 目录之外。不得将多个来源文件无记录地改写成一个“类似组件”。
4. 每个 copied file 在 `upstream-sources.json` 登记 source path、commit、source hash、target path、状态、许可和相关测试；只有实际复制后才从 `audited_planned` 改为 `ported_unverified/ported_verified`。
5. 上游有用的 Cordis/Slot、typed Remote、client store 和 renderer 生命周期可以作为普通源码/库闭包保留并固定版本；运行 DSH profile/plugin/CLI、读取 `$DSH_HOME` 或连接 DSH Host 不允许。

初始源码范围是 `FRONTEND_UPSTREAM_MAP.md` 已审计的 foundation、layout/sidebar、conversation/chat/session/tool、workspace/settings/model selection、只读安全预览及必要 connection/store/API/type 闭包。`ui-brand-official`、账户/套餐、反馈、遥测、terminal、coding agent、在线插件和官方更新均排除。

扩展边界预先固定：

- 上游主题 token（含必要 `--dsw-*`）留在 source-faithful 层；Writing Agent 语义 token 和品牌覆盖集中在 `packages/ui/theme`/`packages/ui/brand`，不散改每个组件。
- 写作功能通过本项目稳定 Slot 注册，首批至少包含 `project.sidebar.actions`、`conversation.turn.tail`、`document.panel.tabs`、`rightSidebar.tabs`、`settings.sections` 和 `brand.seats`。具体 API 在实现时生成类型并测试，本文不假称上游已有这些同名接口。
- `packages/writing-ui` 只依赖 client bridge 的读模型/命令类型和公开 Slot；基础组件不得 import 写作门禁实现。
- client bridge 握手包含 `protocolVersion/clientBuild/runtimeBuild/capabilities`；项目切换使用 generation 使迟到响应失效，持久事件按 `projectSeq` 补读，流式 token 不成为已提交正文。
- WA-023 可使用确定性本地 mock，但 UI 必须显著标注“界面移植预览，未接入真实写作”，正式构建默认关闭且不能写用户 workspace。

WA-023 与 WA-005 起并行工作，在 WA-011 汇合：前者建立 source-faithful UI/bridge mock，后者建立 storage/writing-core；任何一边都不伪称另一边已经接通。

## 约束

- 保留 MIT 许可和第三方 notices；Writing Agent 不使用 DeepSeek Logo 或官方身份暗示。
- 上游 CSS/组件只有品牌、安全裁剪、领域适配或已记录 bug fix 才能改变；差异进入 allowlist 和测试。
- HTML/Markdown/链接/图片视为不可信输入。首版 HTML 预览不移植 `allow-scripts` 行为，不执行用户、模型或网页材料脚本。
- 浏览器不获得文件系统、provider Key、数据库或任意工具权限；所有命令由 Application Service 重校验。
- 正式 bundle 禁止外部 DSH Host、CLI/SDK、官方更新/反馈/遥测端点和运行时远程代码。
- 首轮不做页面设计器、主题市场、任意第三方 UI 插件或整仓自动上游同步。
- Electron 同源壳和 transport 依 ADR-0003；UI 源码选择不授权复制其完整桌面分发系统。

## 证据

- `docs/architecture/FRONTEND_UPSTREAM_MAP.md` 已列出固定 tree OID、入口、依赖、目标、差异和最低测试。
- `docs/testing/UI_BASELINE_PLAN.md` 定义六个页面场景、视口、主题、行为与视觉证据要求。
- 递归依赖审计证明完整 `dsh-web-app` 会拉入 terminal、plugin inventory、subagent、schedule、feedback、provider 和 shell；只复制组件又会缺 Host/API/type 闭包。
- `upstream-sources.json`、`THIRD_PARTY_NOTICES.md` 和固定只读 checkout 建立来源与许可基线，当前所有 UI 条目仍是 `audited_planned`。
- 需求变更 CR-001 明确旧 App.tsx/CSS/Tauri 不可复用，DSH 页面源码须先保真后扩展。

## 备选方案与拒绝理由

1. **按截图重新实现相似页面。** 拒绝。无法证明直接复用，且会丢失 Slot、状态、键盘和边界交互。
2. **只复制 primitives/按钮。** 拒绝。不能满足页面、布局、对话、设置和 client 闭包的直接移植要求。
3. **复制完整 DSH monorepo 或 web bundle。** 拒绝。引入无关 coding/runtime/plugin/官方服务，扩大维护和攻击面。
4. **把 Writing Agent 做成 DSH 插件。** 拒绝。会要求外部宿主并放弃自主领域与发行边界。
5. **混用旧桌面页面以加快首版。** 拒绝。两套状态/样式/工作流会形成不可维护的双 UI。
6. **立即升级到 DSH 最新主干。** 拒绝。来源未固定、视觉和协议会漂移；升级必须专门比较和审核。

## 数据与安全影响

- UI 只显示服务端已提交事件与投影；“已保存”“passed”“已导出”等状态不能由组件本地推断。
- URL 消毒、CSP、文档大小限制、资源释放、路径授权和外链确认属于移植必要闭包，不因视觉保真删除。
- 模型设置只显示 credential reference/掩码状态，Key 不回显、不进入 mock、截图、事件或浏览器存储。
- 上游 source-faithful 层和自有扩展分开，便于识别安全补丁、许可内容和未来同步冲突。
- 品牌替换不删除法律来源；诊断和 About 页面同时区分产品身份与第三方源码来源。

## 测试与验收

- 来源测试逐文件校验固定 commit、hash、target 和许可；未复制条目不得标 `ported_*`。
- 独立性扫描检查 imports、bundle、进程、数据目录和网络请求，拒绝旧 UI/Tauri、DSH CLI/Host/SDK 和官方服务端点。
- 六个基线场景在 1440×900、1280×800、明/暗主题运行截图与交互测试；差异只允许来自品牌、安全裁剪和已审核写作扩展。
- Slot 合同测试覆盖注册/注销、顺序、键冲突、项目隔离、错误边界和不改核心新增面板。
- bridge 测试覆盖握手不兼容、snapshot/stream、重复/乱序、断线补读、取消、项目切换迟到响应和 mock 隔离。
- 安全测试覆盖 Markdown/URL、HTML 禁脚本、只读 preview、renderer 无 Node、Key 不回显和外链策略。
- WA-025 形成 source/visual/behavior/bridge 对照结果；上游参考无法运行时标 `BLOCKED_EXTERNAL`，不用生成图替代 PASS。

