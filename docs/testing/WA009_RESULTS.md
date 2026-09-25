# WA-009 取消、操作对账、崩溃恢复与预算验证结果

日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- `AgentRuntime.start(...)` 返回可取消 handle。`cancel(...)` 在传递 abort 前先事务性写入 `run.cancelled`；provider 忽略或迟到的输出不记为 `request.completed`，也不进入 `FinalOutputCommitter`。
- 移除 WA-008 的 32 次临时安全上限，改为持久化 `RunBudget/RunUsage`。默认上限为 24 次模型调用、32 次工具调用、每个模型请求 2 次安全重试、2 次重大修订。模型重试同时计入模型调用总数；工具恢复重试同时计入工具和重试计数。
- 每次模型/工具发出前先创建 operation，并在同一 SQLite 事务内完成预算扣减、`dispatched` 状态与持久事件。故障注入证明事务中断后 operation、usage 和事件一起回滚。
- SQLite schema v3 新增 `runtime_operations`。已完成的本地结果按原 operation ID 返回；已发出的只读/幂等本地工具可在恢复决策后用同 ID 重试；已发出但结果不明的外部操作进入 `unknown_outcome`。
- `RuntimeRecovery` 提供 `recoverProject/replayRun/inspectRun/resumeRun`。本地 replay 只读 session、run、event、operation 和 request snapshot，类本身不接收 provider/tool/network 依赖。普通 resume 遇到 unknown outcome 会阻断；只有显式 `retry_unknown` 才将原尝试标为 `abandoned` 并记录决策。
- CLI 新增 `inspect --workspace ... --run ...`、`replay ...` 和 `resume ... --decision resume|retry-unknown`。`inspect/replay` 以 SQLite read-only 模式打开；`resume` 负责对账和恢复授权，不自行构造 provider 或绕过后续 Application Service。
- v1→v3 和 v2→v3 均先生成 online backup，验证 application ID、原 schema 与 `quick_check` 后才执行事务迁移。v2 的 `null` budget/usage 会迁移为明确默认值，不留下运行时空投影。

## 2. TDD 与故障注入记录

写测试前锁定的公开 seam 为 `AgentRuntime.start/cancel`、`RuntimeRecovery`和 `SessionStore` operation/预算方法。测试使用真实 SQLite，仅替换模型与工具外部边界。

首轮红灯为：

1. 原循环会越过用例预算并继续调用 provider；
2. `AgentRuntime.start` 不存在，无法在流式请求中取消；
3. `RuntimeRecovery` 和 runtime operation ledger 不存在；
4. CLI 仅支持 request rebuild；
5. 重大修订预算预留接口不存在。

转绿后的定向用例覆盖：

- 模型、工具、每请求重试和重大修订四类预算在外部动作前停止；
- 安全 429/5xx 重试遵守 provider `Retry-After`，网络/超时/未分类异常不自动重试；
- 取消的数据库状态在 abort listener 观察时已是 `cancelled`，迟到文本不提交；
- `after_runtime_operation_dispatch` 注入异常后 operation 仍为 prepared、usage 未增加、无 dispatch 事件；
- 真实子进程在正文和 run 已提交后直接 `process.exit(91)`，父进程重开后正文保留且 run 进入 `interrupted`；
- 外部 dispatched 操作重启后变为 unknown，重复 recovery 不追加重复事件；只读工具可在恢复后用同 ID 重试。

## 3. 需求与验收映射

| 条目 | 本地证据 | 结果 |
|---|---|---|
| F06 | 取消先持久化、abort 传递、迟到输出丢弃、重启对账、interrupted/waiting_user 恢复决策 | `PASS_LOCAL_RUNTIME_CORE`；UI 即时反馈与实际任务接管仍归 Application Service/UI 任务 |
| F12 | 持久化 budget/usage/stopReason；模型调用、工具、重试、重大修订计数；usage 缺失及价格未知均不写 0；有限重试遵守 Retry-After | `PASS_LOCAL_RUNTIME` |
| AT-03 | CLI/runtime replay 仅从 SQLite 重建，read-only CLI 事件数不变；无 provider/tool/network 依赖 | `PASS_LOCAL` |
| AT-04 | 子进程提交正文和 running run 后强退；重开后正文保留、run=`interrupted` | `PASS_LOCAL_PROCESS` |
| AT-05 | dispatch 事务内故障注入全回滚；原有工件事务注入继续回归 | `PASS_LOCAL` |
| AT-06 | operation 同 ID/同输入返回原记录，换输入拒绝；重大修订预算预留同样幂等 | `PASS_LOCAL` |
| AT-07 | 已发出外部请求无结果时重启，记为 `unknown_outcome`，普通 resume 阻断且 provider 调用数不增 | `PASS_LOCAL` |
| AT-10 | 持久取消早于 abort；迟到结果无 `request.completed`、无新正文 | `PASS_LOCAL` |
| AT-26 | 分别达到模型、工具、每请求重试、重大修订上限时统一 `run.budget_exhausted`，已提交工件保留 | `PASS_LOCAL` |

## 4. 验证命令

```powershell
npm run check:runtime
npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.runtime.json
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py
python -B scripts/check_claude_runtime_sync.py
git diff --check
```

最终数量和退出码以本轮命令输出为准。当前没有 commit、push、PR、Issue、tag、Release 或远端 CI 记录；没有调用真实付费模型。

本轮最终读回：

- `check:runtime`：72/72 通过；
- `check:m0`：Node SQLite foundation 通过，11/11 M0 Python 测试通过，72/72 runtime 测试通过；
- `check`：226 项 legacy/Python 测试通过，1 项按既有环境条件跳过；脚本、工作流、docs、runtime 同步和 plugin manifest 均通过；
- production audit：0 vulnerabilities；
- PRD 文档包：25 个任务、38 个验收场景、依赖/链接/来源检查全部通过；
- 严格 TypeScript `noUnused`、runtime 同步与 `git diff --check`：退出码 0（Git 仅提示既有 LF/CRLF 转换警告）。

## 5. 明确保留到后续的边界

- WA-010：材料实体持久化、中性写作能力包、quick/deep 真实文章任务链、写入型模型工具和 CLI 材料到稿件闭环。
- WA-011 及 UI 任务：Application Service 负责在 resume 对账/授权后接管实际任务，并向 UI 区分流式输出、已保存、interrupted 和 waiting_user。
- WA-018/RC：真实授权 provider 的收费/取消行为、发行包子进程/网络扫描与干净机终验。
