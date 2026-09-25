# Writing Agent Client Bridge v20

rc.24 增量：`RunDiagnosticToolGroup` 可选增加 `description/category/callers/outcomes`，由固定展示目录、工具事件的角色白名单及成功结果的受限状态生成；不透传工具参数或回复正文。Runtime 请求策略可提供 `actor`，仅记录到对应 `tool.requested`，不改变权限/执行逻辑；历史 intake 运行可以注明“按运行类型”，其他缺失角色保持未知。新工具必须登记用途，未知工具明确提示未登记。协议号仍为 20，旧快照有回退。

rc.23 增量：协议号和 `liveReply` 结构不变。Runtime 仅对明确标记 `textAudience: conversation` 的请求投影普通 `text_delta`；需求交流和未分派专家的作者交流使用该标记，其余请求默认私有。允许字段的工具增量保持兼容，同一回复转入工具保存时不回退已显示文字。待首字状态进入对话跟随目标；所有预览仍不提供保存、确认或发布授权。真实端点的首字延迟和分块大小不由协议承诺。

rc.22 增量：`RecoverableRunSummary.interruption?` 仅从当前执行段尚未解决的 `request/tool.outcome_unknown` 投影 `source: model|tool`、`cause: timeout|unknown`、`replyAccepted: boolean`。后者只表示本段 `run.resumed.displayInstruction` 已持久化，不推断用户同意了哪个业务决定，不透传输入原文或异常消息。恢复段切换清除旧异常；混合未知操作优先保留工具风险。主对话据此区分“模型超时”与“外部操作结果待确认”，无元数据的旧快照仍显示保守提示。协议号仍为 20；显式 `retry_unknown`、状态机和用量规则不变，不引入自动重试。

rc.21 增量：`RunRecordView.diagnostics?` 从每轮持久事件投影执行段、导演任务说明、按工具/材料版本汇总的计数和逐次模型请求状态/耗时/已报告用量。新快照以此替代用于诊断的扁平 `activity`，旧快照保持回退；主对话展示策略不变。材料正文、任意工具结果、源路径和模型原始请求不进入该投影；仅允许材料显示名/安全标识、已分派任务说明与安全错误 code，疑似凭据字段被抑制。耗时为事件时间差，不冒充服务商内部处理耗时；未报告用量保持未知。

rc.20 增量：`BridgeSnapshot.liveReply?` 为可选、内存态的 `{runId, requestId, text} | null`，复用现有快照推送；协议号仍为 20。只投影所选项目/会话当前运行中允许展示的回复或写作内容，不透传原始工具 JSON、研究元数据或导演内部指令。请求切换、完成、失败和取消会清除临时文本；前端必须标明“正在生成 · 尚未保存”。它不进入持久 Timeline、`PreviewDocument` 或事实门禁，不提供崩溃后恢复保证。持久化提交后才展示已保存结果。下文 v17/v18 描述为继承基线，当前接口以权威类型为准。

v18（CR-002 R1）：RecoverableRunSummary 增加可选 inputRequest（reason/questions）。WRITING_INPUT_REQUIRED 的问题从持久事件进入最新主对话；sendMessage 在当前会话等待补充时以答复恢复同一 run，而不是新建文章。resumeRun 对该状态接收必填反馈，空答复被拒绝。v17/rc.6 安装包不会因此自动更新，后文 v17 内容为继承基线。

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-011 / WA-012 / WA-013 / WA-014 / WA-015 安全审计 / WA-017 / WA-024 / WA-025 验收  
权威类型：`packages/client-bridge/src/protocol.ts`  
生成声明：`packages/client-bridge/generated/protocol.d.ts`

## 1. 边界

UI 只依赖 `ClientBridge`。它不能访问 SQLite、工作区路径、Provider、Key、任意文件 API 或外部 DSH Host。所有写作命令由 `WritingApplicationService` 再检查项目归属、简报版本、项目 revision、预算和运行状态；只有持久事件与已提交 ArtifactVersion 能成为界面的“已保存”状态。

同一 v17 类型由四条实现复用。v2–v7 完成运行生命周期、版本保护编辑、事实快照、交付、Host 设置、首次项目创建与安全 Desktop IPC；v8–v15 完成完整简报的修改/确认、可执行写作阶段与运行记录、专项事实重查、材料/过程投影和产品恢复期新增命令；v16 增加共创检查点阶段/下一阶段投影、自由文本反馈续跑和 HTML 排版预设；v17 增加不依赖既有 session 的 `selectProject`，使零会话历史项目和“新建对话”都能先建立明确项目作用域，再由首条消息创建 session。Desktop 的模型验证、诊断、旧项目迁移、工作区备份/恢复和项目删除走独立固定 Host API，不进入通用 browser bridge。UI 不得把只读预览误当成编辑器，也不得在浏览器内另算一套事实门禁或直接写文件：

- `ApplicationClientBridge`：Application Service 到 UI 投影的进程内适配器，是 Web/Desktop 共用语义基线。
- `Local Web Host` + `WebClientBridge`：同源 HTTP 命令与按 revision 长轮询；用于本地 Web。
- `DesktopClientBridge` + Electron main host：固定协议/方法 IPC、受限 preload 与 snapshot 推送；renderer 使用同一 production composition。
- `DeterministicMockBridge`：仅 `--mode mock` 的隔离 UI 回归，不保存真实项目，不进入 production bundle。

## 2. 身份映射与状态

```text
workspaceId
  └─ projectId + project.revision + projectSeq
       └─ sessionId
            └─ runId
                 └─ artifactVersionId
                      └─ blockId + contentHash
       └─ factSnapshotId
            ├─ body/title/evidence version + hash
            └─ assessment + invalidations + CHECKED_IN
       └─ exportId + operationId
            └─ prepared/completed + relative path + content hash
```

- `generation` 是客户端项目/会话选择代次。旧 generation 命令返回 `STALE_CLIENT_GENERATION`，不启动 run；长轮询在切换后返回的旧 generation snapshot 必须被客户端丢弃。
- `projectSeq` 来自 SQLite 持久事件。重连读取当前 snapshot 并补读，不自动执行 `run.start` 或 `run.resume`。
- `revision` 是 bridge snapshot 版本，不替代领域 `project.revision`。同 generation 只接受不低于当前 revision 的 snapshot；本地断线提示不递增服务端 revision，恢复后以 Host snapshot 为准。
- `RevisionWorkspace.projectRevision` 才是写命令携带的领域 CAS 基准；修改提案还绑定 `baseBodyVersionId`、`blockId` 与原块 SHA-256。
- 流式临时文本不进入 `PreviewDocument`；预览正文只来自当前 `ArtifactVersion`。
- 工具事件只映射名称和持久状态，不把材料正文、源路径或原始工具结果送入浏览器。
- 已保存草稿的对话提示只说明用户结果、查看入口和下一步，不展示 `artifactVersionId` 等内部标识；内部版本号仍保留在持久层和版本面板中。
- 项目切换会推进 generation 并重建 `RevisionWorkspace`；编辑框只保留组件内临时值，切换项目/版本立即清空，不跨项目传播。
- 进入会话或发送消息后，对话区跟随最新持久事件；运行期间若用户主动向上滚动超过底部阈值，则保留其阅读位置，直到用户回到底部或再次发送消息。
- `FactCheckWorkspace` 来自 Storage/Application Service 的当前计算状态；历史 assessment 可显示为审计信息，但只要有 invalidation 就必须显示 `stale`。
- 来源边只表示快照绑定了哪些输入版本，不表示对应事实一定真实；未知来源保持未知，UI 必须保留非真实性承诺提示。
- `DeliveryWorkspace` 只投影所选项目的当前正文、领域 revision、门禁状态和导出记录；工作备份与正式交付必须显示为不同语义。
- 导出路径是工作区内受控相对路径，客户端不能提交任意目标路径；正式导出是否可用只作界面提示，后端每次仍重新验证门禁。
- `UiSettings.theme/contentFontSize` 是 workspace 级界面偏好，不属于项目领域状态。production 通过 Host 持久化；Mock 只在内存中变化。

## 3. 写命令

| UI 命令 | Application Service 语义 | 持久/并发边界 |
|---|---|---|
| `createProject` | `project.create` + `material.import` + `brief.confirm` + `decision.record` | 一个 operation 创建项目、材料和已确认简报；相同 operation/input 幂等返回同一项目 |
| `updateBrief` | `brief.update` | 绑定当前简报版本与 project revision；修改后回到 tentative，不能沿用旧确认 |
| `confirmBrief` | `brief.confirm` | 显式持久确认当前版本；未确认时写作入口保持关闭 |
| `sendMessage` | `startDraft` | 客户端 `operationId`；当前 project revision/brief version；同 ID 同输入返回同一结果 |
| `runFactCheck` | `startFactCheck` | 只读取当前正文与证据账本并提交严格 fact-check-v2；不重写正文 |
| `cancelRun` | `cancelDraft` | 先持久 `run.cancelled` 再 abort；迟到结果不提交正文 |
| `resumeRun` | `resumeDraft` | 只接受 `interrupted/waiting_user`；共创检查点可带最多 4,000 字符反馈并进入续跑 `userInstruction`；unknown outcome 必须显式 `retry_unknown` |
| `proposeRevision` | `revision.propose` | 绑定当前 project revision、正文版本、块 ID/hash；先保存提案和差异，不更新正文 |
| `acceptRevision` | `revision.accept` | 接受时重新检查 project revision、baseVersion、块 hash 和锁；通过后创建不可变新版本 |
| `rejectRevision` | `revision.reject` | 保留被取消提案及事件，不生成正文版本 |
| `saveBody` | `body.save` | 手动全文保存仍做 CAS 和锁定检查；相同内容返回 `no_change` |
| `setBlockLock` | `body.block_lock/unlock` | 锁定与显式解锁均保存决定和事件；用户身份不自动绕过锁 |
| `rollbackBody` | `artifact.rollback` | 以当前版和历史目标版生成新版本，不删除历史 |
| `saveWorkingCopy` | `export.working_copy` | 无事实门禁；保存当前 Markdown 原文和状态清单，明确标记不可发布；同 operation 可对账重放 |
| `exportPublication` | `export.publication` | TXT/HTML 共用当前快照门禁；HTML 可选 `clean/editorial/compact`，文件 hash/数据库两阶段对账，冲突不覆盖旧文件 |
| `selectProject` | 切换到项目的新对话状态 | 校验 project 存在、清空所选 session 并推进 generation；不创建 session、不启动模型，首条 `sendMessage` 才在该项目下创建 session |
| `selectSession` | 切换读投影 | 校验 session 属于 project，并推进 generation |
| `updateSettings` | workspace UI 偏好 | Host 校验允许值后原子写入 `.writing-agent/ui-settings.json`；文件无 Key/正文/材料，重连读取同一设置 |

恢复只保证已提交边界。未持久化流式片段不会伪装成可恢复内容：没有已提交正文时，从已保存简报/材料重新执行并保留中断记录；已有正文时，恢复提示模型先读取当前版本再继续。重连本身绝不触发恢复。正文冲突返回 `REVISION_CONFLICT`，锁定冲突返回 `LOCK_CONFLICT`；客户端不得自动三方合并或静默覆盖。

## 4. Local Web 安全契约

- 只调用 `server.listen(0, "127.0.0.1")`，不接收自定义 bind host；端口由系统随机分配。
- index 每次加载生成 60 秒一次性 bootstrap capability；握手消费后换 30 分钟内存 session capability。
- capability 不写 URL、磁盘或日志；index 与 API 使用 `Cache-Control: no-store`，页面读取后立即删除 bootstrap meta。
- Local Web 暂时保留 `/api/v6/*` transport prefix，避免仅因 additive command 改变 URL；真正兼容门禁是值为 17 的 `X-Writing-Agent-Protocol`/handshake，旧 client 会 fail closed。所有 API 只接受 POST，同时校验精确 `Host`、精确同源 `Origin` 和 capability；正文、导出、项目/简报和设置命令也受 2 MiB 请求上限和字段级长度/类型校验。
- 静态资源与 API 同源；CSP 的 `connect-src` 仅 `'self'`，禁止 frame、object、form 和远程脚本。
- production launcher 固定加载 `apps/web/dist/production`，不能用参数切换到 mock 构建。
- 未知异常只返回稳定错误码，不回传堆栈、路径、Key 或 Provider 原始错误正文。
- `WebClientBridge` 对默认 browser fetch 使用 `globalThis.fetch.bind(globalThis)`；注入测试 fetch 保持调用方原值。该约束避免 Chromium 因非法接收者在 HTTP 请求发出前失败。
- poll 暂时断线只把当前投影标记为 offline；下一轮成功 snapshot 可恢复 ready。重连路径不得调用 `run.start` 或 `run.resume`。协议不兼容在 handshake 阶段 fail closed。

## 5. 可复现入口

```powershell
npm run build:bridge:types
npm run ui:build
npm run test:bridge
npm run check:desktop
npm run check:ui
python -X utf8 tests/ui-baseline/scripts/wa025_ui_playwright.py --serve-static --upstream-dist <fixed-upstream-dist>
```

本地 Web 启动器接受 schema v2 的 OpenAI-compatible 或 Anthropic-compatible 配置；Key 由 Node runtime 根据 `managed:<id>`（推荐）或显式开发用 `env:<NAME>` 解析，不进入配置 JSON、bridge 或浏览器：

```powershell
$env:WRITING_AGENT_API_KEY = '<temporary value>'
npm run runtime:cli -- credential set --id openai-primary --from-env WRITING_AGENT_API_KEY
Remove-Item Env:WRITING_AGENT_API_KEY
npm run web:local -- --workspace '<workspace>' --provider-config 'examples/writing-pack/real/openai-compatible.provider.example.json'
```

凭据导入前由操作者在当前进程环境临时设置 `WRITING_AGENT_API_KEY`，成功后应立即移除。启动器只输出随机 loopback origin 与恢复 run 摘要。Desktop 的首次 provider 设置由 preload 暴露的独立、固定 host API 处理：主进程校验 HTTPS/config 后把 Key 交给 Credential Broker，返回 renderer 的只有配置状态和 credential metadata。

Desktop 还提供固定的 `testProviderConnection` host API。它只能使用已保存配置，由主进程创建 Provider 并执行最小连接探测；探测依次覆盖基础请求、流式响应和受控工具调用。renderer 只能得到成功能力摘要，或 `stage/errorCode/retryable` 安全失败投影，不能得到 Key、请求正文或 Provider 原始响应。保存配置后的自动验证和“验证已保存配置”都会产生一次最小真实模型调用，因此 UI 必须提前提示可能产生极少量费用；应用启动、状态刷新和自动化只读检查不得隐式触发验证。

协议 v17 没有给 browser 增加 Key、任意路径、Provider 原始响应或诊断 raw-data 通道；`selectProject` 只改变当前项目/会话选择状态，不写业务数据也不触发模型。2026-09-18/19 的协议 v15 隔离桌面验收由用户已保存的 MiniMax-M3 配置显式触发，真实验证了 Anthropic-compatible 鉴权、流式响应、工具调用、Quick/Deep 工作流、专项事实重查和正式导出；它是历史运行时证据，不代替 v16/v17 交互复验。应用启动、状态刷新、自动回归和恢复仍不得隐式产生模型调用。OpenAI-compatible 商业端点和其他模型仍需分别验收。
