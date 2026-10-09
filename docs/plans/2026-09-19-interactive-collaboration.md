# Interactive Collaboration Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 恢复“发现缺口即提问并等待、答复后继续”的可验证闭环，并以导演/独立专家业务证据重新建立验收标准。

**Architecture:** 先沿用现有工具事务、run.waiting_user 与恢复事件实现 R1，不新增另一套会话存储。readiness 是工具写入的强制前置条件，问题答案用持久事件重建；R2 再建立独立任务调用，不把 R1 宣称为多智能体迁移完成。

**Tech Stack:** TypeScript、Node SQLite、现有 AgentRuntime/StoragePort、React、Node test。

---

## 2026-09-19 本轮执行记录

Task 1 已落盘；Task 2/3 的 R1 源码及本地自动验证已完成，独立规格和代码质量审查所发现缺口均已修复并复核通过。最终 Runtime 151 项、迁移 15 项、Bridge 35 项通过。真实模型/桌面视觉验证未完成。详见 [R1 实施结果](../testing/CR002_R1_RESULTS.md)。R2–R4 仍未完成，整体验收状态不变。

协作：runtime 实现及 CLI mock 兼容由 `gpt-5.6-sol / high` 处理，理由是跨模块状态与持久化约束需要较强审查；主 Agent 处理文档、Bridge/UI 与集成。独立 R1 规格审查和代码质量审查同为 `gpt-5.6-sol / high`，各自聚焦业务合同和状态/幂等/安全边界；未并行派发多个实现者。没有可用的精确 token/费用记录，不估算费用。

## Task 1：纠正文档与验收（本地修改，不发布）

- 新增 CR-002 权威补充，现维护于 `docs/implementation/CR002_INTERACTIVE_COLLABORATION.md`。
- PRD、Runtime Contracts、交接、合订本接入 CR-002；BACKLOG 的 WA-010 从 DONE 改为 IN_PROGRESS，补充 DoD。
- IMPLEMENTATION_PROGRESS、RC_RESULTS、FINAL_USER_UAT_CHECKLIST、PRODUCT_PARITY_RECOVERY_PLAN 撤回当前 READY。旧运行证据标记为历史，保留不删除。
- 执行 `python -B tests/check_document_pack.py --write-report`（现维护路径；原包报告保留在历史归档）。

## Task 2：R1 强制 readiness 与暂停（先红后绿）

文件：`packages/application/src/workflow-tools.ts`、`packages/application/src/index.ts`、`packages/writing-pack/src/index.ts`、`packages/application/test/writing-application.test.ts`。

1. 测试：提交研究但未判断 readiness 被拒绝；needs_input 返回 waiting_user；同响应之后的写作工具不执行，正文为 null。
2. 运行 `node --import tsx --test packages/application/test/writing-application.test.ts` 确认新增断言先失败。
3. 实现 `assess_writing_readiness({status,reason,questions})`。已读必要材料/上下文才允许 ready；needs_input 最多两问，结果携带 awaitingUserInput。各阶段提交必须先 ready。
4. Application pause hook 将其转为 WRITING_INPUT_REQUIRED，并在恢复提示重建问题/答复；新执行段重新判断，禁止空答复。
5. 提示词说明自主模式也必须提问、禁止用缺料说明冒充正文。现有成功夹具增加显式 readiness，保留原断言不以跳过检查求绿。

## Task 3：R1 主对话恢复

文件：`packages/client-bridge/src/application-bridge.ts`、`packages/client-bridge/src/protocol.ts`、`packages/ui/src/shell/WritingAgentShell.tsx`、`packages/ui/src/shell/run-records.ts` 及对应测试。

1. Bridge/UI 测试先覆盖问题投影、答复非空、主输入框恢复同 run。
2. 恢复卡直接展示具体问题；主输入框在等待缺口时发送的是答复，不另建 run。运行/就绪状态不得显示完成。
3. 执行 `npm run check:runtime`、`npm run check:ui`；发现失败按业务契约修正，不削弱断言。
4. 结果记录明确区分 mock 验证、真实模型验证、桌面发行验证；本轮不操作真实用户数据库、不擅自关闭已安装程序，不打新就绪标签。

## 后续批次（未完成，不能隐去）

### 2026-09-19 继续执行：桌面体验候选

用户授权继续至可进行客户端桌面体验测试。本轮在当前 `next/runtime` 继续：大量必要实现尚未跟踪，另建 HEAD worktree 会遗漏现有工作，故不迁移/重置、不做整体暂存。真实数据与测试数据隔离；本地构建候选不等于公开发布。

1. R2/R3 后端（实施中）：同一有界 run 内 `director_decide(dispatch/ask/rework/finish)`；独立专家请求与工具白名单，评审共同版本且意见隔离；持久决策/输入绑定/返工失效；共创改提纲必须重新确认，事实阻断不得完成。
2. R3 主窗口（待验证）：对话显示导演决策和实际阶段成果，主输入框可回答/修改共创选择；阻断在最新位置可见；阶段保存计数不冒充全文完成百分比，历史已结束但未过门禁也不得显示可交付。
3. 集成验证：新增场景先红后绿，升级确定性模型夹具使其遵守真实导演合同；Runtime/Bridge/UI/Desktop 回归、规格审查及质量审查。
4. R4 候选：构建新版本，隔离启动实际 Electron 桌面；验证缺口问答、提纲修改、恢复、阶段展示和错误提示。保留测试截图/日志和可启动入口；真实模型测试、用户最终签收、安装升级与公开发布分开记录，不误标已完成。

协作：后端由 `gpt-6-astra / high` 负责，因涉及持久状态、请求隔离与权限/预算跨层边界；主 Agent 负责主窗口、桌面与集成，避免重叠修改。用量以实际工具记录为准，当前无精确费用数据。

- R2：Application/Runtime 独立 director dispatch 与 specialist 请求快照、受限工具 registry；验证串行评审上下文互不包含。
- R3：版本绑定与返工状态、重要选择的共创检查点、事实阻断不完成；不能仅靠最终阶段补救早期缺口。
- R4：按 CR-002 的 C02-01 至 C02-10 逐项取证，真实模型复验 test 和充分材料样例；桌面候选通过后才更新就绪结论。

提交/推送/发布留待明确授权；现有脏工作区不做整体暂存、重置或覆盖。
