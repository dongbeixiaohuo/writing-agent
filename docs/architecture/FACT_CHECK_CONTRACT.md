# 事实门禁、失效传播与来源契约

状态：`IMPLEMENTED_LOCAL`  
当前产品策略：2026-10-06 轻量文章事实复核（未以本地测试宣称真实模型效果已验收）
对应任务：WA-013  
领域权威：`packages/writing-core/src/index.ts`  
持久化权威：`packages/storage/src/index.ts`、`packages/storage/src/schema.ts`  
界面投影：`packages/client-bridge/src/protocol.ts`

## 1. 门禁不是调用者声明

本项目服务公众号、今日头条等文章写作，不是论文或学术审稿系统。最终核查旨在减少明显事实错误和模型幻觉，不要求所有点都有公开出处、独立信源或论文引用。先筛查当前成稿，仅对易错、时效性强或存疑的重要事实及疑似错误进一步核对；普通背景、稳定常识、作者确认的亲历无疑点时不单独列项。**没有引用本身不是事实错误。**下述门禁针对已经选择的待查问题，不要求把所有客观陈述送入门禁。

事实门禁采用 `fact-check-v2` 输入格式和 `fact-check-v2-ts-v1` 运行时策略。调用者只能提交逐条 claim、覆盖声明和无事实说明，不能直接决定 `passed`。即使 payload 额外携带旧的 `status: "passed"`，运行时也会忽略该字段并按当前输入重新计算。

放行必须同时满足：

1. 正文、已锁定标题、标题中的最终分发文案和证据账本与冻结快照一致；
2. payload 绑定当前 snapshot、正文版本和标题版本；
3. `body`、`title`、`distributionCopy` 三项覆盖均为 `true`；
4. 每条 claim 都通过结构校验，claim ID 唯一；
5. `SUPPORTED` claim 至少说明判断依据（账本 evidence ID、作者提供材料或模型知识等），不强制外部网址或论文；模型复核使用 `model-knowledge:unverified`，不冒充联网；
6. 每条 claim 都是 `SUPPORTED`、非 `red` 且支持范围为 `full`。

以下任一旧状态继续阻断：`UNSUPPORTED`、`CONTRADICTED`、`BROKEN_LINK`、`NEEDS_USER_SOURCE`、`red` 或 `partial/none`。缺少论文或公开引用本身不得触发这些问题状态。来源读取失败也不必然代表事实错误，能用已有依据判断时记录读取限制即可。空 claim 列表只有在三项覆盖完整且提供非空 `noFactualClaimsReason` 时才可通过；理由说明完整筛查后没有需要进一步核对的易错或可疑事实，不表示文章没有任何客观信息或普通背景已外部验证，不能用空数组隐藏实际问题。

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

## 7. 2026-10-06：轻量事实复核与核查方式分层

适用范围：本次桌面 App 源码调整后的新核查。旧 assessment 不重写、不追认联网查证；本节覆盖原有“所有可核实背景均逐条展开”的应用层策略，不改变第 1 节已选条目的领域门禁。

1. `extract` 读取完整当前成稿、已选标题及可选配文，筛查幻觉、原始材料错误及事实含义变化；待查清单只选择 `key_fact`（易错、时效性强或存疑的重要事实）和 `suspected_error`（疑似虚构、矛盾或事实含义改变）。不把全部人物背景、日期或客观句子自动列项。普通背景、稳定常识和作者确认的亲历无疑点时不展开；同义改写不是事实错误。空清单须说明筛查范围与没有待查事实的理由，不声称省略信息已独立证实。
2. `prepare_fact_check.checkReason` 记录选择原因；正常写作与专项重新核查使用同一选项策略。已选且未证实的条目不能从提交中删除，非 `SUPPORTED/full` 或 `red` 继续阻断。本文不以报告精简为由放宽真实性门禁。
3. 每项记录 `verificationMethod`：`material_comparison` 只对照已有材料，`model_review` 只做模型复核，`external_source` 使用实际取得的外部具体来源。仅有 URL、证据编号或素材一致不能称为外部查证。
4. Application 在任何标题/快照写入前校验 `external_source`：`verificationRecordIds` 须指向本轮成功的 `search_fact_sources` 或 `read_fact_source` 工具记录，记录含来源文本，且具体 URL 与 `sourceReference` 对应。失败、空结果或其他来源不能冒充联网依据。成功读取支持请求 URL 与重定向后的最终 URL。该校验只证明来源实际取得，事实是否被该来源支持仍需模型判断，不承诺来源权威或事实绝对正确。
5. **取消“启用搜索后所有 `key_fact` 必须有外部证明”的规则。**搜索是辅助能力，不是逐条证明义务。根据真实疑点和已有依据决定是否联网；作者自述可引用授权材料，不要求公开证明，稳定知识可用模型复核并注明未联网。需要联网时优先能直接回答问题的具体资料，简单事实摘录足够时不强求论文或全文。没有引用不算错误；实际矛盾、疑似虚构或重要事实仍不确定时才提出最小纠正动作，不能凭素材一致把已知错误放行。
6. 主对话仅简短总结已核对重点（最多四项），实际问题优先展开（前八项，明确提示其余问题数量），说明方式与下一步。外部记录仅显示“外部来源核对，模型判断一致”，不把来源取得校验说成程序认证事实。完整依据保留在详情；旧条目不推断为外部验证，如需按新策略核查旧稿，主动重新核查。
7. 不新增模型收尾请求；每轮检索上限仍为六次，返工/恢复不重置。共用来源的事实合并检索，已有工具记录通过本地读取复用，不为普通背景重复查找。

8. 新增待查条目要记录选择原因，原有条目保留；兼容旧输出时，已明确记录为矛盾、无依据、待作者确认或高风险的问题可由程序补记 `suspected_error`，不为可推定字段追加纠正轮；新加的正常通过条目仍须明确选择原因。核查期间保存相同的正文派生标题不重建标题版本，首次保存该派生标题也可复用同一正文的待查清单。只有默认标题文本完全一致且版本来源为 `workflow:fact-check-title` 时才允许这项复用；正文、证据、作者选定标题或配文真正变化仍失效，最终快照门禁不放宽。

字段为可选 JSON 元数据，兼容旧工作区，无 SQLite 表迁移。测试覆盖普通背景不展开、作者自述不强制外部证明、真实错误继续阻断、外部记录真实性、中文引用网址、派生标题复用、旧记录保守展示及模拟联调。模拟测试只验证程序流程与提示词契约，不证明真实模型能无遗漏发现错误或绝不会产生误报。

## 8. 2026-10-07：核查续轮的请求历史投影

适用范围：本次源码调整后的新请求，尚不代表已安装的 RC74 已包含此修复。2026-10-07 的实际记录表明，提取/核实阶段虽已隔离，核实 Agent 后续调用 `read_fact_article`、`read_fact_evidence`、`read_material`、`read_fact_record` 得到的长文本仍被逐轮完整回传。正文目录很小不代表正文没有从工具历史重新进入输入。

1. Runtime 的请求投影向应用提供原始消息历史及当前工具结果位置。只在组装发送给模型的请求时替换内容，不修改 SQLite 原始工具结果、成果、证据或内存原始历史。运行记录的请求快照仍准确保存实际发送内容，不通过隐藏统计伪造压缩效果。
2. 核查的最新一批并行本地读取结果完整传入，同一正在读取的正文/素材版本或来源记录的各页继续一起提供，避免跨页限定被过早退役；其他已交给模型的成功读取改为 `read_receipt_not_source` 定位记录，保留版本、页范围、证据编号及原调用参数。定位记录不是引文或通过证明；需要相关限定时，可按原参数本地重读。无法匹配原调用或解析结果时保守保留原文。格式纠正消息不算新读取批次，不提前退役最新片段。
3. 搜索结果的来源定位、已有摘录与失败原因继续保留。失败读取不能被定位记录改写为成功；来源/事实绑定及六次搜索预算不变，不以压缩为由删除实际待查问题或放宽来源校验。
4. 选中证据显式标记 `delivery=selected_full`，`claimFields` 与 `claimRows` 提供完整选中引句及限定。verify 阶段不再次遍历全文和原始素材，只补具体主张缺失的上下文；这是一项行为指导，不限制必要的本地读取。
5. `claimType` 是展示分类，不是事实判定。提交接口接受有长度边界的非空字符串，无法识别的分类规范化为 `other` 后再进入既有领域校验，原始模型参数保留在工具记录。`status`、风险、支持范围、证据关联与外部来源记录仍使用原有严格契约，不把未知分类当作通过依据，不为分类名称错误重写整个报告。
6. 输入统计将 `preparedClaims`、`savedSourceRecords`、`noFactualClaimsReason` 计入证据与核查信息，而非无法解释的“阶段状态及其他字段”。此项仅改善分类，总输入字符数不变。

离线验收：对 2026-10-07 14:18:30 的真实请求仅应用工具历史投影，按原统计口径由 49,669 减到 32,835 字符（减少约 33.9%），历史部分由 26,290 减到 9,456；绑定状态、证据和网页失败记录保持原样。这是同一历史请求的输入对比，不是新版全部提示词/工具定义的大小，不是实际 MiniMax 加速测试。剩余内容包括选中条目、必要证据、工具定义和来源定位，不以统一字符上限截断事实材料。

回归覆盖：最新并行批次、正在读取的同一来源多页与跨页限定、其他旧正文/素材/证据/来源记录退役、失败保留、原始记录不变、实际请求快照一致、共创恢复后的核查与格式纠正、非标准分类不追加模型轮且矛盾仍阻断。真实模型耗时和误报/漏报质量仍需另行验收。
