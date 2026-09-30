# rc.51：事实核查死循环修复（FACT_EVIDENCE_INVALID）与工具失败熔断

日期：2026-09-27。范围：证据账本契约对齐（研究提交 ↔ 核查快照）、agent 运行时重复失败熔断；不修改事实核查口径、写作工作流阶段顺序、存量项目数据或凭据。网络搜索继续推后。

## 根因与证据（用户报告：点继续后 600 多秒无反应）

工作区留证（FDE 项目，run `baeb598a`）：

1. 每次 `submit_fact_check` 都在 `:snapshot` 步骤抛 `FACT_EVIDENCE_INVALID`——**不是模型提交的内容有问题，而是已保存的证据账本本身不符合核查快照的严检**：账本中 E007–E009 三条推演条目 `verification_status: "illustrative"`、`source_quote: ""`，而 `parseEvidenceLedger` 要求所有条目十个字段全非空。
2. 契约不对称：研究阶段提交时（`evidenceLedgerContent`）只检查"是 JSON 且有 claims 数组"就保存，字段级严检只存在于核查快照侧。非法账本在研究阶段畅通无阻，到核查阶段才爆炸——而核查专家**没有权限改账本**，只能一遍遍重新提交，每次 GLM 编码端点约 300 秒一轮（14:06→14:11→14:16，事件流实证），用户看到的就是"600 多秒没反应"。
3. 工具调用路径没有熔断：文本保存路径早有"同一拒绝重复 3 次即停"（STAGE_OUTPUT_NOT_SAVED），但 tool_call 路径的失败会无限反馈给模型继续。

## 修改

1. **账本严检放行推演条目**（`packages/writing-core/src/index.ts`）：`parseEvidenceLedger` 允许 `verification_status === "illustrative"` 的条目 `source_quote` 为空字符串（推演条目没有原文可引，其 use_boundary 已限定只能条件式论证）；其余字段照旧全检，非 illustrative 条目空引句照旧拒绝。函数从此导出，供两侧共用。
2. **研究阶段提交即严检**（`packages/application/src/workflow-tools.ts`）：`evidenceLedgerContent` 在保存前用同一个 `parseEvidenceLedger` 校验；不合法则抛可重试的 `EVIDENCE_LEDGER_INVALID` 并附逐条规则说明——在研究阶段拒绝，模型当场可修，而不是留到核查阶段变成死局。非法账本不再入库。
3. **重复工具失败熔断**（`packages/runtime/agent/src/index.ts`）：同一工具以同一错误码失败满 3 次，运行即暂停为 `TOOL_FAILURE_LOOP`（waiting_user，可恢复），不再盲目烧模型往返。新 scope 切换时计数重置。
4. **熔断的展示与恢复接线**：`TOOL_FAILURE_LOOP` 接入运行记录标签、对话时间线行、检查点文案（interaction.ts）、bridge 恢复逻辑（`recoverPendingAssignment` / `preservePendingAssignment` / 恢复时不伪造用户指令），与 STAGE_OUTPUT_NOT_SAVED 同等恢复待遇：作者重试不重做已保存阶段。
5. **研究阶段指令补充**（collaboration.ts 与 writing-pack）：明确"推演或无原文可引的条目必须 verification_status=illustrative 且 source_quote 留空，其余条目 source_quote 必须是原文直接引句，否则账本会被保存校验拒绝"。

## 已验证

- **用户真实台账直接过检**：把 FDE 项目当前证据账本（E001–E010，含三条 illustrative 空引句条目）原文喂给修复后的 `parseEvidenceLedger`，通过，10 个证据 ID 全部提取。安装 rc.51 后该项目重试核查可越过快照步骤。
- 新增测试：writing-core 接受 illustrative 空引句/拒绝非 illustrative 空引句；agent 运行时同一门禁拒绝 3 次即熔断暂停；应用层集成测试"非法账本研究阶段被拒 + 熔断 + 对话时间线出现'自动重试已暂停' + 账本未入库"。
- 全量：runtime 260、bridge 63、ui 78、desktop 44、conversation 67、legacy-parity 59 全绿；runtime/web/desktop 三端 TypeScript 通过。

## 未验证边界

- 熔断阈值固定为 3 次同一工具+同一错误码；不同错误码交替的"花式失败"不触发熔断（仍会消耗预算，受 run 预算上限兜底）。
- 推演条目经 `matchedEvidenceId` 匹配后，模型仍可能把条件式表述误标 SUPPORTED/full——这靠提示词约束（use_boundary 已写明），门禁不做语义降级。
- GLM 编码端点单请求约 300 秒的现状未改变（上游速度问题，非本应用可修）；熔断只是把"无限空转"变成"3 次后停下并说明原因"。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.51-x64.exe`；SHA256 `00257a8ed374845bced2512608bbae16826292e60ba301a6f18acd8ec45d7ec2`，已登记 `output/desktop/SHA256SUMS.txt`。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0、868 ms（`output/rc51-desktop-smoke.json`）。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证，未触碰用户正在运行的已安装实例与真实凭据。
