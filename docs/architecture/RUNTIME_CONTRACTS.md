# Writing Agent 1.0 运行时与领域契约
> 当前强制增补：[CR-002](../implementation/CR002_INTERACTIVE_COLLABORATION.md) 和 [CR-003](../implementation/CR003_CONVERSATION_FIRST_HARNESS.md)。缺口必须转入等待用户；恢复必须重新判定；导演/专家隔离与可交付状态不能用阶段完成替代。澄清运行独立标识用途、无正文写权限，未知字段不补假值；方案确认绑定当前版本，非确认的新反馈使旧方案不可执行。

文档版本：1.1 · 2026-09-16。配套 [PRD](../prd/WRITING_AGENT_1_0_PRD.md)。本文是建议实现契约，不宣称这些类型或端点已存在。

本文对 PRD 的 P0 要求给出可编码的边界。参数默认值可经 ADR 调整；独立性、数据安全、版本一致性和门禁不得因实现困难而默默取消。

## 1. 结构与依赖方向

```text
CLI / DSH 源码派生 Web UI / 新桌面容器（同源 UI）
          │  同一应用命令与事件协议
          ▼
Application Service
     ├── Writing Core：项目、稿件、证据、锁定、修改、核查、导出
     └── Runtime：agent loop、session、模型、工具与预算
                     │
             Storage / Provider / Capability
```

- `writing-core` 不依赖 React、Electron/Tauri、DSH CLI、Claude SDK 或具体 provider。
- `runtime` 不硬编码正文文件名和旧 Stage 编号；通过领域工具完成写作操作。
- `storage` 提供事务、事件和内容快照。状态机与 gate 不藏在 UI 点击处理器中。
- `Application Service` 是所有修改入口的授权与事务边界，CLI/Web/桌面调用相同命令。
- 来源代码可在本仓库实现上述模块，普通 Cordis 等框架库可按 ADR 使用；不得调用外部 DSH 程序/SDK替代自己的应用执行。

## 2. 关键实体

| 实体 | 必要字段 | 说明 |
|---|---|---|
| WritingProject | id, name, schemaVersion, revision, latestBodyVersionId, currentTitleVersionId, currentEvidenceVersionId, mode, createdAt | revision 是并发保护的项目状态版本，不是文章第几稿 |
| WritingBrief | projectId, versionId, genre, audience, lengthTarget, materials, constraints, interactionMode, authorAuthorization | 假设和用户确认分开 |
| Session | id, projectId, createdAt, purpose | 一个项目可多会话 |
| Run | id, sessionId, status, planVersion, budget, usage, lastCommittedEventSeq, stopReason | 一次持续执行；不等于一次模型请求 |
| RequestSnapshot | id, runId, requestId, provider, model, parameters, normalizedPayload, payloadHash, toolSchemas, schemaHash, assemblyVersion, redactions | normalizedPayload 必须在 provider 最终转换边界截取；不能只存原始 prompt |
| Material | id, projectId, sourceKind, sourceReference, importedAt, contentVersionId, hash, trustLabel | 网页需记录抓取时间与实际读取片段；URL 不能替代快照 |
| Artifact | id, projectId, kind, logicalName | kind 如 body/outline/title/evidence/review/report |
| ArtifactVersion | id, artifactId, parentVersionIds, content, contentHash, actor, reason, requestSnapshotId, createdEventSeq | content 版本不可变；可标 known/unknown 来源 |
| Decision | id, projectId, type, value, scope, actor, sourceEventId, active, revokedBy | 标题/方向/预算/风格/锁定授权，必须可撤回并留记录 |
| RevisionProposal | id, projectId, baseBodyVersionId, edits, reason, requestedBy, status | 不自动成为正文 |
| Review | id, reviewedBodyVersionId, reviewedTitleVersionId, recommendations, reviewer, runId | 只读建议，绑定被审版本 |
| FactCheckSnapshot | id, schemaVersion, bodyVersionId/hash, titleVersionId/hash, distributionVersionId/hash, ledgerVersionId/hash, policyVersion, status | 分发文案未声明时须显式为 null，与空字符串区分 |
| FactAssessment | snapshotId, claimsContent/hash, reportContent/hash, coverage, computedStatus, checkedAt | gate 计算状态，不能接收模型直接指定 passed |
| ExportRecord | id, projectId, mode, format, sourceSnapshotId, filePath, fileHash, operationId, status | mode=working_copy 或 publication；两者不得混用 |
| ProvenanceEdge | id, projectId, fromId, relation, toId, actor, eventSeq, evidenceRef | 关系语义须明确，未知不补造 |
| Operation | id, projectId, kind, inputHash, state, resultRef, effectClass | 本地幂等和未知外部结果的恢复依据 |

所有时间持久化为带时区的 ISO 时间，内部推荐 UTC；显示按用户时区转换。字符串 ID 与序列号不要复用。每个引用验证属于同一项目，跨项目材料必须显式导入/授权。

## 3. 持久化策略：一个事实来源，不双写两套权威状态

### 3.1 默认实现

首版使用本地 SQLite。默认每个 workspace 一个数据库，路径类似 `<user-selected-workspace>/.writing-agent/workspace.sqlite3`，该路径由设置决定，不放入代码仓库。

建议逻辑表：`projects`、`sessions`、`runs`、`events`、`operations`、`artifacts`、`artifact_versions`、`request_snapshots`、`materials`、`decisions`、`revision_proposals`、`reviews`、`fact_snapshots`、`fact_assessments`、`exports`、`provenance_edges`、`migration_runs`、`schema_migrations`。

首版以文本/Markdown为主，工件正文和请求快照内容可直接入库，保证事务一致性。`events` 保存领域变化，引用不可变内容；`projects/runs` 等当前状态是事务内更新的可重建投影。事件、引用内容和 schema 一起构成恢复事实来源，不能说仅靠 event ID 就能恢复正文。

项目目录中的 `.md`、`run_manifest` 兼容输出和 HTML/TXT 均是从当前记录生成的可读副本/导出，不是第二个写入权威源。用户在文件管理器修改副本时，必须经显式导入创建新版本，不自动更新数据库或假定原核查仍有效。

数据库 journal/同步级别、驱动和备份实现由 ADR 固定。在线备份使用驱动支持的一致性备份，或应用停写后的完整快照，不能只随手复制一个仍在写入的数据库文件。

### 3.2 大文件与文件系统副作用

1.0 可限制单材料/单项目规模并明确错误，避免无限占用。若内容移到内容寻址文件存储，必须先原子落盘并确认可读，再事务记录引用；失败产生的孤立文件允许后续清理，不能反向出现有引用无内容。

正式导出文件先写同目录临时文件，校验 hash，再原子替换目标。数据库提交和文件系统不能凭空形成一个事务，需 `Operation` 状态与重启对账：若文件已写且 hash 与预期一致，可补记完成；结果不一致则停止并提示。重试不产生多份同名发布，也不覆盖不同来源的文件。

## 4. 事件契约

事件表示已经发生的事实，不是模型计划。最小形状：

```ts
type Actor =
  | { kind: 'user'; id: string }
  | { kind: 'agent'; id: string; runId: string }
  | { kind: 'runtime'; id: string }
  | { kind: 'legacy_import'; id: string };

interface DomainEvent<TPayload> {
  id: string;
  schemaVersion: number;
  projectId: string;
  projectSeq: number;
  type: string;
  occurredAt: string;
  actor: Actor;
  operationId: string;
  causationEventId: string | null;
  correlationId: string;
  payload: TPayload;
}
```

事件类型最小集合：

```text
project.created
brief.confirmed
material.imported
decision.recorded / decision.revoked
run.started / run.paused / run.interrupted / run.resumed
run.cancelled / run.failed / run.completed / run.budget_exhausted
request.prepared / request.dispatch_attempted / request.completed / request.failed
request.outcome_unknown
tool.requested / tool.completed / tool.failed / tool.outcome_unknown
artifact.version_committed
revision.proposed / revision.accepted / revision.rejected
review.recorded
fact.snapshot_created / fact.assessment_recorded / fact.invalidated
export.requested / export.completed / export.failed
migration.started / migration.completed / migration.failed
```

所有事件提交后再通知 UI；UI 订阅断线时按 `projectSeq` 补读，不能把页面重连当成新任务。流式 token 可另走瞬时事件，不提升成已提交稿件。一次发包是否真的被远端接收有不确定窗口，`dispatch_attempted` 不能被解释为服务端已执行或未执行的绝对证明。

### 4.1 请求可重建约束

保存最终系统内容、已接受的用户消息、工具调用/结果、注入材料内容、模型标识与参数、工具 schema、适配器/模板版本。provider 特有的转换也需版本记录；无法原样重建的字段须明确标识。

发送用 API Key 属于鉴权头/安全配置，不属于模型可见文本，不写入快照。若用户输入误带密钥，应先按策略拦截或脱敏，再发送并记录实际脱敏内容。不能先把一份发给模型，再保存另一份假称完全一致。

不读取或承诺恢复模型内部隐藏思考。日志可解释输入和发生的操作，并不能给出模型真正的内部因果过程。对“同样输入再次生成完全相同输出”不作保证。

## 5. 三组状态，不混成一个 stage

### 5.1 Run 执行状态

```text
queued → running → completed
             ├→ waiting_user → running
             ├→ paused → running
             ├→ failed
             ├→ cancelled
             ├→ budget_exhausted
             └→ interrupted → waiting_user / running / failed
```

`completed` 表示本次任务结束，不代表文章通过核查或已经导出。终态 run 不能因迟到回包恢复为 running。用户继续修改可创建新 run，保留历史。

`interrupted` 的恢复入口先对账 operations；未知外部副作用必须进入 waiting_user。`budget_exhausted` 后增加预算需用户决定事件，再创建新 run 或明确授权恢复，不由 agent 自己增额。

### 5.2 RevisionProposal 状态

```text
proposed → accepted
         → rejected
         → conflicted
         → withdrawn
```

接受时需要匹配基准版本和锁定约束；同一提案不能重复生成多个有效正文。用户撤回已接受结果，应通过新版本回退，不删除接受事件。

### 5.3 当前事实门禁

```text
not_checked → checking → passed / blocked / error
                  └────── 任一输入改变 → stale
passed / blocked / error → 任一输入改变 → stale
stale → checking → passed / blocked / error
```

报告自身是不可变历史结果；这里改变的是项目当前“能否引用该报告”状态。新正文没有核查快照时不得因旧报告 passed 显示绿色。任何不可验证引用一律阻断正式导出。

## 6. 命令、事务与并发

每个修改命令具备 `operationId`、`projectId`、`expectedProjectRevision`、操作者与输入。使用受验证的权限上下文，不相信用户提交的 `actor='runtime'`。

```ts
interface MutationEnvelope<T> {
  operationId: string;
  projectId: string;
  expectedProjectRevision: number;
  payload: T;
}

interface CommitBodyPayload {
  artifactId: string;
  baseVersionId: string | null;
  content: string;
  reason: string;
  acceptedProposalId: string | null;
}

type MutationResult<T> =
  | { ok: true; projectRevision: number; operationId: string; result: T }
  | { ok: false; code: string; message: string; retryable: boolean; details: Record<string, unknown> };
```

`commit_body` 在单一数据库事务中：

1. 检查 operationId：同输入已完成则返回原结果；同 ID 不同 inputHash 返回 `IDEMPOTENCY_KEY_REUSED`。
2. 检查项目 revision、正文 baseVersion、角色权限和锁定段落。
3. 校验内容、计算 hash；若内容未变且不是显式回退，不创建无意义新内容版本，但可记录用户决定/无变更结果。
4. 插入不可变正文版本、来源边及事件，更新 latestBodyVersionId。
5. 使当前核查 stale；必要的标题/评审适用性同步变更，保留历史报告。
6. 更新项目 revision 和 operation 状态，提交事务后发布事件。

首版单进程可用项目级队列序列化写入，但仍需数据库 revision 条件更新，以防多个 UI/进程或恢复后冲突。不要只用前端禁用按钮保护并发。

`projectSeq` 对持久事件排序；`project.revision` 对影响项目有效状态的领域修改做并发检查，二者不等同。瞬时 token/进度广播不推进 revision；纯观察事件无需使正常编辑失效。具体哪些命令推进 revision 必须写进契约测试，不能在各 UI 中各自判断。

如果锁定目标不再能无歧义映射到最新内容，返回冲突，不“尽量找个相似段落”。

## 7. 段落修改与来源图

### 7.1 首版修改粒度

解析正文为有稳定 `blockId` 的段落/标题块。Patch 包含 `baseVersionId`、目标 blockId、原块 hash、替换内容和修改理由。首版支持替换/插入/删除完整块，不自动三方合并或基于过期字符偏移修改。

自由文本编辑保存时重新解析；能确定保持原块的才复用 ID，不能确定则生成新 ID并标记来源不确定。锁定块不能在此过程中丢失，需要明确解锁或拒绝操作。正文原始内容和解析版本一起保存，以免升级解析器后定位漂移。

### 7.2 来源图语义

建议关系：`DERIVED_FROM`、`USES_MATERIAL`、`CHANGED_BY_DECISION`、`REVIEWED_IN`、`CHECKED_IN`、`EXPORTED_AS`。

依赖版本派生关系必须无环；并不是所有可能的图关系都强制 DAG。每条证据支持关系应绑定具体断言、证据快照、支持范围、检查来源和时间。存在 `USES_MATERIAL` 不代表正文每句话都被该材料证实。

最小可用查询：这版稿子基于哪版；谁接受了什么改动；为什么当前核查失效；当前导出依据哪一组输入。先实现这些查询，不先实现交互式图谱画布。

## 8. 事实核查与兼容契约

### 8.1 与旧版的差分验证

现有 Python 脚本和其测试夹具是迁移基线，不是生产中永久 shell-out 的依赖。实施 Agent 先阅读完整 `fact_check_gate.py`、`update_run_manifest.py`、`verify_required_files.py` 及关联测试，再把判断逻辑移入 TS。

把同样输入转为规范夹具，比较 Python 和 TS 的 accept/block 及阻断原因。UUID、时间戳、内部文件路径不必逐字相等，语义门禁必须一致。新增加的安全限制应有 ADR 和新用例，不能称为“无差异迁移”。

### 8.2 快照与 gate

1. 由 runtime 冻结正文、最终标题、可选分发文案、证据账本及核查策略版本。
2. 模型/人工生成逐条 claims 和来源；覆盖声明需涵盖全文/标题/分发文案。空 claims 必须有合理原因。
3. runtime 校验结构、来源定位、支持范围、风险和 hash 一致性，计算 `passed/blocked`。
4. 核查期间或核查后任一输入改变，旧快照不得作为当前发布依据。
5. claims/报告是不可变输出，手工改动须成为新记录并重验证，不能改个标签就通过。

原协议 claim 枚举保持：`SUPPORTED`、`UNSUPPORTED`、`CONTRADICTED`、`BROKEN_LINK`、`NEEDS_USER_SOURCE`。风险是 `red/yellow/green`，支持范围是 `full/partial/none`。任何非 SUPPORTED、red 或非 full 阻断。

来源是用户本人陈述时，记录为作者提供，不冒充网络验证。是否足以支持特定可核查断言由明确策略决定；首版不得新增一个“用户说了就豁免全部事实”的总开关。

### 8.3 工作备份与正式交付

`save_working_copy` 不把稿件标成可发布，输出 `.md` 和状态说明，不复用 `_clean.txt`/正式 HTML 入口。`export_publication` 仅在共享 gate 成功后创建导出 operation。

工作备份是数据自主权路径，不是让模型自发绕过核查的替代动作。界面和 CLI 必须明确区分，所有正式出口共用相同核心函数，不允许前端自行判断 passed。

## 9. 工具、模型与取消契约

```ts
interface ToolDefinition<TArgs, TResult> {
  name: string;
  version: string;
  inputSchema: Record<string, unknown>;
  effect: 'read_only' | 'local_idempotent' | 'external_side_effect';
  permissions: string[];
  execute(args: TArgs, context: ToolContext): Promise<TResult>;
}

interface ToolContext {
  projectId: string;
  runId: string;
  operationId: string;
  abortSignal: AbortSignal;
  expectedBodyVersionId: string | null;
  grantedPermissions: readonly string[];
}
```

类型不替代运行时验证：输入必须经 JSON schema/Zod 校验，权限由应用签发，不从模型参数读取。输出长度和可见范围有上限，截断/摘要发生时记录实际注入的版本。

模型 stream 事件最小集合：`text_delta`、`tool_call_delta`、`tool_call_complete`、`usage`、`completed`、`error`。多块工具参数必须完整拼接后验证；tool_call ID 在请求/结果间保持一致。错误或截断不能伪装 `completed`。

模型兼容测试先使用 mock/provider fixture，再在维护者提供授权后做真实工具往返。无工具能力模型只可走明确标记的受限草稿路径，不算 IND/AT 的自主运行闭环完成。

取消标记先持久化再传播 abort，阻止之后提交 active 产物。迟到输出可以保存为 `abandoned` 尝试供诊断，不自动合入正文。再次应用要经过用户明确选择和版本校验。

## 10. 恢复与外部副作用

| 操作状态 | 重启策略 |
|---|---|
| 本地命令已提交成功 | 返回已保存结果，不重做 |
| 本地命令未提交 | 事务回滚后可以在同 operationId 下重新验证执行 |
| 只读工具结果已保存 | 复用快照；需要刷新时创建新 operation |
| 外部请求准备好但确定尚未发送 | 可由恢复策略重新发起，仍检查授权和预算 |
| 已尝试发送且没有确定结果 | unknown_outcome；查询外部状态或让用户决定是否重试 |
| 用户已取消 | 不自动恢复；需新 run/明确恢复授权 |
| 当前 schema 高于程序支持版本 | 只读支持能力内的信息或拒绝打开，不降级写入 |

本地历史重放不触发任何模型/网络工具、文件导出或新用户授权。`replay` 和 `resume` 是不同命令：前者计算状态，后者经过判断后继续执行。

采用快照加事件尾部加速可以，但快照必须含最后事件序列与 schema/hash；删除快照后仍应能从合法事实来源重建。缺少引用内容必须报告缺损，不能悄悄从当前网页重新抓取假称历史重建。

## 11. 建议应用 API 与 CLI

下列为待实现接口；字段名可按代码规范调整，但操作语义须保留。

| 命令/API | 输入 | 输出 |
|---|---|---|
| project.create | brief, workspaceId, operationId | projectId, revision |
| material.import | projectId, source, permission, operationId | materialId, snapshot/hash |
| run.start | projectId, expectedRevision, mode, budget | runId |
| run.cancel | projectId, runId, operationId | cancelled/pending status |
| run.resume | projectId, runId, recoveryDecision | resumed/blocked + reason |
| revision.propose | projectId, baseVersionId, blockIds, instruction | proposalId, diff |
| revision.accept | projectId, expectedRevision, proposalId | newVersionId |
| body.save | projectId, expectedRevision, baseVersionId, content | newVersionId/no_change |
| fact.check | projectId, expectedRevision, inputVersionIds | snapshotId, runId |
| export.working_copy | projectId, versionId, target | file/hash + unverified status |
| export.publication | projectId, expectedRevision, format, operationId | export record or gate blockers |
| project.inspect | projectId | latest versions, decisions, gate, pending operations |
| project.events | projectId, afterSeq | durable events in order |
| migration.dry_run | source, target | proposed changes and blockers |
| migration.execute | dryRunId, confirmedPlanHash | migration result |
| diagnostics.export | explicit selections | redacted archive + preview manifest |

上述命令名定义领域语义，不强制将 DSH 客户端重写为 REST/SSE。前端默认保留经审计移植的 client model、gateway/remotes 与 connection 必要闭包，在本仓库通过 bridge 映射到 Application Service；生成的类型、schema 与构建步骤亦纳入闭包。[S14] 若 M0 证明换成 HTTP JSON/SSE 更简单，须用 ADR 证明界面、会话/取消/重连语义和测试均保留，不能只换请求 URL。桌面使用与选定容器匹配的受限 IPC/自有协议 transport；默认评估 DSH Electron 同源壳，不接旧 Tauri 链路。CLI 直接调用 Application Service。UI 不直接写数据库或正文文件。

CLI 目标语义：`web` 启动工作台；`run` 发起写作；`inspect` 看状态；`resume` 对账后继续；`doctor` 检测安装与 provider；`replay` 为开发诊断仅重建本地状态。真实命令语法实现后通过文档测试生成，不提前宣传未发布的调用。

## 12. 标准错误码

| 错误码 | 面向用户的含义 | 是否可直接自动重试 |
|---|---|---|
| AUTH_FAILED | 密钥/权限不正确 | 否 |
| MODEL_UNSUPPORTED | 当前模型不支持所需能力 | 否 |
| RATE_LIMITED | 服务限流 | 有限次数且遵守 Retry-After/总预算 |
| MODEL_RESPONSE_INVALID | 工具参数或响应结构无效 | 可控修复一次或停止，不执行非法调用 |
| TOOL_PERMISSION_DENIED | 当前操作超出授权 | 否，先取得授权 |
| REVISION_CONFLICT | 文章已被别人/你更新 | 否，重新基于最新版 |
| LOCK_CONFLICT | 修改涉及锁定内容 | 否 |
| FACT_CHECK_BLOCKED | 当前事实核查存在阻断 | 否，先处理问题 |
| FACT_CHECK_STALE | 核查不对应当前内容 | 否，重核查 |
| BUDGET_EXHAUSTED | 本轮达到预算 | 否，需用户决定 |
| UNKNOWN_EXTERNAL_OUTCOME | 外部请求结果未确认 | 否，先查询/用户判断 |
| IDEMPOTENCY_KEY_REUSED | 同操作 ID 对应不同输入 | 否 |
| STORAGE_UNAVAILABLE | 空间/权限/数据库不可用 | 否，先修复 |
| SCHEMA_UNSUPPORTED | 数据来自更新版本 | 否，不重置数据 |
| SOURCE_SNAPSHOT_MISSING | 历史引用内容不可取回 | 否，不用新抓取伪装历史 |

错误结果统一包含 `code/message/retryable/operationId/runId/details`，details 脱敏。用户文案以可操作原因表达，不直接倒出 SDK 堆栈。

## 13. 源码移植清单与许可证

建议建立 `docs/architecture/UPSTREAM_MAP.md` 与机器清单 `upstream-sources.json`。每条包含：上游 repo、commit、路径、license、source hash、目标路径、移植方式、相关测试、本地改动及维护者。初始清单可只有已计划项，但必须标记 planned/ported/verified，不能把待移植当完成。

`THIRD_PARTY_NOTICES.md` 与适用许可证随发行包一起生成/校验。不是只写 inspired by；也不要求无意义地改名所有函数以掩盖来源。上游源码注释中的版权保留，商标/图片/第三方依赖另外检查。[S10]

CI 检查外部宿主依赖、移植来源记录、license 产物、API schema、schema 迁移和边界测试。最终代码切换与依赖升级单独 PR，减少归因困难。


## 14. 内置扩展模块的最小生命周期

保留类似 harness 的可组合能力，但只实现当前产品需要的内部模块接口：

```ts
interface RuntimeModule {
  id: string;
  version: string;
  requires: readonly string[];
  activate(context: ModuleContext): Promise<() => Promise<void>>;
}

interface ModuleContext {
  getService<T>(name: string): T;
  registerService<T>(name: string, service: T): () => void;
}
```

`getService` 缺少服务时必须明确失败，不能回退成空对象。启动前校验依赖、循环依赖与重名注册；按依赖顺序初始化。初始化失败时逆序释放已启动模块，不留半个可用 runtime；正常退出与取消路径保证 dispose 至多执行一次。

角色/写作规则包可以注册工具、模型适配或领域任务策略，但不能覆盖受保护的门禁、获得未授予权限或绕过 Application Service 提交稿件。内部工具的注册不等于第三方代码隔离。1.0 不做热更新、在线安装或保证 DSH 插件 API 兼容。

这部分可使用经过审查的 Cordis 等普通库来实现，也可使用规模较小的自有实现。M0 记录依赖成本和测试结果后决定，不为了减少一个库而重造整套复杂服务容器。

## 15. DSH 前端移植的客户端契约（CR-001）

完整方案见 [FRONTEND_REUSE_PLAN](../implementation/FRONTEND_REUSE_PLAN.md)。这是新产品在原仓库中维护的客户端，不是 DSH 宿主插件。

1. **唯一权威来源：**项目、正文版本、Decision、核查门禁仍归 Application Service/Storage。Client model 只镜像和投影已提交数据；React 组件不持有另一套持久业务状态。
2. **身份映射：**分别保持 workspaceId、projectId、sessionId、runId、artifactVersionId、projectSeq、client generation。初版可每篇默认一个会话，但数据模型不强制一对一。切换项目必须退订旧流并废弃旧页面请求。
3. **命令桥接：**用户输入→run.start/自有 session 命令，停止→run.cancel，编辑保存→body.save，接受修改→revision.accept，正式交付→export.publication。每个写命令携带领域所需的 operationId/expectedRevision；不可直接把对话最后一条回答写成 currentBody。
4. **事件桥接：**持久事件按项目序列补读；流式 token 只做临时显示。bridge 明确映射上游会话事件与自有 run/领域事件，不伪造工具成功。数据推送丢失、重复和乱序按契约测试处理；重连不等于重新开始任务。
5. **版号契约：**客户端、bridge 与 runtime 的 protocolVersion/构建标识随发行绑定，握手不兼容时给出明确错误。UI 缓存不能让旧前端静默读取不兼容的新协议。
6. **内容入口：**上游预览组件是只读能力；编辑另经有版本保护的写作模型。Key 留在凭据边界，真实模型请求由 runtime 发出，不让浏览器绕过预算与请求快照直连。
7. **扩展边界：**写作面板注册到移植的 Slot/布局入口；主题集中为 token/别名覆盖，品牌单独模块。基础组件不直接导入写作门禁实现。必要的新注册 API 名称由本项目定义，不能宣称未实现接口是 DSH 现有 API。
8. **安全覆盖：**上游可预览脚本执行型 HTML 不等于本产品允许。首版仍遵守 NFR-07 的禁脚本安全渲染；相关差异进入上游改动清单与 AT-38。桌面 IPC、自定义 URL、外部导航的允许范围必须明确。
9. **独立性检查范围：**检查实际 imports、打包模块、进程、数据目录和网络依赖，不以代码里出现 dsh 字符串就失败。上游版权、原 CSS token 和合法来源标记可保留；外部宿主启动与旧 UI 引用不可保留。
