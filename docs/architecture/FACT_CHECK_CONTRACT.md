# 事实门禁、失效传播与来源契约

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-013  
领域权威：`packages/writing-core/src/index.ts`  
持久化权威：`packages/storage/src/index.ts`、`packages/storage/src/schema.ts`  
界面投影：`packages/client-bridge/src/protocol.ts`

## 1. 门禁不是调用者声明

事实门禁采用 `fact-check-v2` 输入格式和 `fact-check-v2-ts-v1` 运行时策略。调用者只能提交逐条 claim、覆盖声明和无事实说明，不能直接决定 `passed`。即使 payload 额外携带旧的 `status: "passed"`，运行时也会忽略该字段并按当前输入重新计算。

放行必须同时满足：

1. 正文、已锁定标题、标题中的最终分发文案和证据账本与冻结快照一致；
2. payload 绑定当前 snapshot、正文版本和标题版本；
3. `body`、`title`、`distributionCopy` 三项覆盖均为 `true`；
4. 每条 claim 都通过结构校验，claim ID 唯一；
5. `SUPPORTED` claim 至少引用账本中的 evidence ID 或明确来源；
6. 每条 claim 都是 `SUPPORTED`、非 `red` 且支持范围为 `full`。

以下任一旧状态继续阻断：`UNSUPPORTED`、`CONTRADICTED`、`BROKEN_LINK`、`NEEDS_USER_SOURCE`、`red` 或 `partial/none`。空 claim 列表只有在三项覆盖完整且提供非空 `noFactualClaimsReason` 时才可通过，不能用空数组绕过核查。

## 2. 冻结、评估与不可变结果

```text
not_checked
    │ create snapshot
    ▼
 checking ── computed evaluation ──► passed | blocked
    │                                  │
    └──────── any bound input change ──┴──► stale
```

`fact_input_snapshots` 冻结正文、标题、分发文案和证据账本的版本 ID 与 SHA-256；`fact_assessments` 保存规范化 payload、运行时计算的 blockers、claims/report hash 和不可变报告。一个 snapshot 只能提交一次 assessment，二次改写返回 `FACT_ASSESSMENT_EXISTS`。

评估前还会重新读取当前 ArtifactVersion 并计算 hash。快照不再是项目当前快照、版本指针已变化、内容 hash 不一致、绑定错误、覆盖不完整或 claims/evidence 结构不合法时均 fail closed，不生成伪造的通过记录。

## 3. 失效传播

任何新的 `body`、`title` 或 `evidence` ArtifactVersion 都走同一 StoragePort 写边界，并为所有绑定旧版本的快照追加 `fact_invalidations`：

| 输入变化 | 失效原因 | 影响 |
|---|---|---|
| 正文版本变化 | `body_version_changed` | 当前门禁变为 `stale` |
| 标题或其中分发文案变化 | `title_version_changed` | 当前门禁变为 `stale` |
| 证据账本变化 | `evidence_version_changed` | 当前门禁变为 `stale` |

历史 assessment 和报告保留用于审计，但 `getFactCheckStatus` 始终以当前项目指针、当前输入快照和失效记录计算状态，历史 `passed` 不能成为当前放行凭证。schema v5 升级到 v6 时，旧 `fact_snapshots` 记录保留，但任何旧门禁结果重置为 `stale`；缺少 v2 snapshot 的旧指针也会被查询层防御性视为 `stale`。

## 4. 来源关系的含义

成功评估会从该事实快照向正文、标题和证据版本各写一条 `CHECKED_IN` 来源边，`evidenceRef` 指向本次 assessment。Application Service 与 Client Bridge v6 只投影所选项目的边，项目切换后不会复用上一项目的核查状态、来源或导出记录。

来源边只回答“这个核查结果绑定了哪些输入版本”，不回答“现实世界中的事实一定为真”。无法核实的 claim 继续显示为未知或阻断，UI 固定提示：来源关系仅说明产物如何形成；核查通过表示该输入快照通过既定流程，不承诺事实绝对正确。

## 5. Bridge/UI 边界

Client Bridge v6 的 `FactCheckWorkspace` 只读暴露：当前状态、冻结版本/hash、运行时计算的 assessment、逐条 claim、blockers、失效原因和来源边。UI 的“核查与来源”页签只渲染该投影，不在浏览器内重复计算门禁，也不能写 SQLite、修改 assessment 或接触 Provider Key。`DeliveryWorkspace` 可以据此显示正式导出可用性，但实际 TXT/HTML 命令仍在 Application/Storage 边界重新执行完整门禁。

状态文案区分 `not_checked`、`checking`、`passed`、`blocked`、`error` 和 `stale`。其中 `passed` 明确使用“通过既定核查流程”，不得改写为“事实真实”或“可无条件发布”。

## 6. 兼容与验证

- Python legacy `fact_check_gate.py` 与 TypeScript 领域门禁对同一组 canonical fixtures 做差分测试，结果必须在 `passed/blocked/error` 和 blockers 上一致。
- v1–v5 工作区仍按顺序、先 verified backup 后迁移；v6 新增 `fact_input_snapshots`、`fact_assessments`、`fact_invalidations` 三张 STRICT 表。
- 旧 `fact_snapshots` 表暂留作迁移与历史审计，不是 v2 当前门禁的权威来源。
- 当前任务没有运行真实模型或外部事实检索；事实质量仍取决于输入证据、核查执行和必要的人审。WA-014 已让正式 TXT/HTML 共同强制使用该门禁，详见 `EXPORT_CONTRACT.md`；这仍不等同于现实事实已经自动验证。
