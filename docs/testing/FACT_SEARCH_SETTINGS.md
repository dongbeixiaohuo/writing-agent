# 搜索设置与事实核查工具（2026-09-29）

## 范围与行为

- 桌面设置增加“搜索”：Parallel 匿名免费服务开关；Tavily 开关与 API Key。
- 初始均关闭，不因升级而向外部搜索服务发送稿件信息。
- 两者均开启时 Parallel 优先，仅在其请求失败时使用 Tavily；Tavily 用量按账户套餐计费。
- 全部关闭仍执行模型事实复核。设置中明确警示：未联网验证，文章仍可能有事实错误。
- 模型知识不是外部证据：稳定常识若经模型复核记录为支持，来源标记 `model-knowledge:unverified`，依据明确未联网；不允许伪造网页。确实不确定、矛盾或高风险事实仍如实记录，不改变稿件版本绑定与旧结果失效规则。
- 已生成 `output/desktop/Writing-Agent-Setup-1.0.0-rc.57-x64.exe`；未自动安装或修改用户原项目。

## 实现与边界

- `apps/desktop/src/search-settings.ts` 保存开关到 provider.json 同目录的 search-settings.json；Key 通过既有 CredentialBroker 存储，配置文件、IPC 返回与模型上下文不含 Key。
- 系统凭据存储不可用时沿用既有会话回退，界面明确提示重启后需重填。
- `packages/application/src/fact-search.ts` 固定 Parallel/Tavily HTTPS 端点，不允许模型自定服务地址。Tavily 用 Authorization header；拒绝重定向。每个服务操作超时 20 秒，响应体有限制，每个运行最多 6 个不同检索问题，相同问题复用缓存。
- 查询限短公开事实（500 字内），提示词禁止发送完整私人稿件/客户信息。网页和摘录是无指令权限的外部数据，不把“搜索完成”当成“事实通过”。
- `read_fact_source` 可读取账本中或本轮搜索发现的 HTTPS 来源，继续执行私网/SSRF 策略；另一运行不能沿用搜索授权。
- 完整写作只有事实核查专家有搜索工具；专项“重新核查”使用同一配置和说明。关闭搜索时没有网络工具；开启后故障如实返回不可用，不伪装为空证据或已经联网证实。
- 工具结果及引用留在既有运行事件与核查依据中，不改写用户正文和原证据账本。

## 验证

- 新增 `npm run test:fact-search`：配置持久化/Key 不泄漏、开关、匿名 MCP JSON/SSE、Tavily 请求、备用路线、取消与限次、跨运行 URL 边界、专项核查实际权限执行、UI 校验与安全降级。
- 完整写作配置开/关测试验证只有事实专家获得搜索与来源读取工具。
- 现有应用/协作/桌面 RPC 相关 106 项回归通过；Runtime/Desktop/Web TypeScript 与 desktop build 通过。
- Parallel 真实匿名检索成功（公开国庆日期问题，约 3 秒）；非只握手。
- MiniMax-M3.1-Flash-Preview 隔离工作区模型复核约 35 秒完成：正常日期支持、故意错误的 1959 年识别为矛盾、比喻未列为事实问题，来源明确未联网验证。
- 联网模型测试首次收到服务商 529/2064（集群高负载）；第二次成功调用两次 Parallel 搜索，但后续 MiniMax 请求再次 529，未保存最终核查。失败证据保留，不能视为联网端到端完整验收。
- 2026-09-29：Tavily 当时未提供真实 Key，仅验证协议与故障分支。2026-09-30 的真实账户复验见下节。
- 真实测试脚本：`node --import tsx tests/ux/fact_search_live.ts`；只建独立临时项目，不修改原项目、配置或用户稿件。

## 桌面验收步骤

### 2026-09-30 Tavily 真实账户与模型链路验证

- 使用用户授权的 Key，仅通过测试进程环境注入，脚本读取后移除环境变量；未写入源码、报告、应用配置或用户工作区。未切换默认搜索设置、未安装软件。
- 通过项目 `createFactSearchTools` 实际请求 Tavily：HTTP 200，响应头约 1,914 ms，返回 5 条相关来源，摘录包含正确的 1949 年。相同查询再次调用命中缓存，直接探针共 1 次网络请求。
- 独立 TEMP 项目使用已有 `MiniMax-M3.1-Flash-Preview`，Parallel 关闭、Tavily 开启。约 71,687 ms 完成；持久事件读回确认 6 次模型请求、2 次 Tavily 搜索均完成、核查提交成功。
- 样例包含正确国庆日期、故意错误的成立年份 1959、个人感受比喻。结论分别为 SUPPORTED、CONTRADICTED；比喻未被列为事实问题。核查最终状态 `blocked` 是发现故意植入错误后的预期结果，不是运行失败，也没有绕过门禁放行错误文章。
- 两次 `read_fact_source` 读取来源正文失败，事件仅提供 `TOOL_EXECUTION_FAILED`，不足以确定根因。模型依据真实搜索摘录保存来源 URL，并明确披露正文读取失败；不能将本次结果宣称为原文抓取全通过或所有文章均可核查。
- Key 未出现在工具结果和持久运行事件中（脚本断言通过）。包括探针，本次真实 Tavily 请求合计 3 次；具体扣费以账户账单为准，不推算费用。
- 脚本：在测试进程环境设置 `WA_TAVILY_TEST_KEY` 后运行 `node --import tsx tests/ux/fact_search_live.ts --tavily-only`，不要把 Key 写入命令示例或提交文件。测试保留隔离工作区；运行 ID `76b980a6-ed30-4744-a618-ab4afa328375`。
- 本轮探针输出的 `modelRequests: 0` 是诊断脚本使用了不存在的事件名，不是实际用量为零；已改用 `request.dispatch_attempted`，本次 6 次调用以持久事件读回为准，无需为修正计数重做付费请求。
- 搜索专项 17/17 再次通过。这里只验证源码工具与 application 的真实集成，不替代安装包内设置保存、重启凭据恢复和完整写作 UI 验收。

### rc.57 打包验证（2026-09-29）

- 搜索专项 17/17、桌面分发配置 5/5 测试通过；`npm run desktop:package` 成功退出，分发边界检查通过（13 个文件）。
- 包内 app.asar 版本为 1.0.0-rc.57，搜索端点、配置模块和 preload 搜索接口已核验。
- 安装包大小 111,508,495 字节，SHA256：`b39a4f2c7e13e9f552744581866cd910eba45f7e204253c3b99f2c03968a0d74`；未签名。
- 隐藏启动检查两次失败：当时仅测试数据位于 TEMP，程序仍从 OneDrive 中的成品目录运行。Electron GPU 子进程退出 `-2147483645`，日志 `GPU process isn't usable`。没有关闭或改动用户正在运行的旧版本，没有执行安装/升级验收。
- Parallel/模型与 Tavily 的真实验收边界仍以本页上节为准，不因打包完成而提升整体最终验收状态。

### 2026-09-30 发布准备复验

- 将同一 rc.57 `win-unpacked` 复制到本机 TEMP 短路径，使用现有 `run_desktop_smoke.ps1` 和独立数据目录启动；退出码 0，约 1.12 秒 ready，stdout/stderr 均空。
- 复制前后 app.asar SHA-256 一致：`f1762854baa372b22e44d9e8a65f92f637e79ba874c066dad62b7d8718cbb895`。本机证据：`output/desktop/rc57-local-path-smoke.json`，未纳入 Git。
- 这证明该成品在本机非 OneDrive 路径可以启动，不能据此断言唯一根因是 OneDrive，也不等同于安装器、升级或干净机验收。测试副本保留，没有覆盖安装。
- 本次重新执行搜索专项 17/17、桌面分发配置与对话可读性 8/8 通过；文档契约及 Claude runtime 镜像一致性检查通过。将搜索专项加入 `check:runtime`，将对话可读性测试加入 `test:ui`，避免 CI 遗漏。

1. 设置 → 搜索：默认双关闭，出现纯模型风险说明。
2. 开启 Parallel，保存并重开设置；在测试文章中重新核查，运行记录应出现“搜索事实来源”，必要时“阅读事实来源原文”。不是每篇都必须联网：无客观事实或已有材料足够时不应浪费调用。
3. 关闭 Parallel、开启 Tavily：未填 Key 时不能保存；填入有效 Key 后保存，只用 Tavily。重开不回显 Key，留空保存保留旧 Key。
4. 两者均开启：设置明确免费优先、失败才用 Tavily。关闭两者重新核查：不发送外部搜索请求，仍产出带未联网边界的模型复核。
5. 原项目内容、模型供应商配置与旧核查结果不因修改搜索设置而自动变化。

## 接口依据

- https://docs.parallel.ai/integrations/mcp/search-mcp
- https://docs.tavily.com/documentation/api-reference/endpoint/search

本轮按排障与 TDD/验收技能执行；UI 与隔离集成测试委派一个子 Agent（gpt-5.6-sol / medium），主 Agent 实现后端与复核关键路径；没有编造用量或费用。
