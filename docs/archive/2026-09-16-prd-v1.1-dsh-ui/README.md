# PRD 1.1 / DSH UI 文档包归档

- 归档日期：2026-10-05。
- 原始形成日期：2026-09-16；CR-002 更新于 2026-09-19，CR-003 及后续补充更新至 2026-09-24。
- 适用版本：Writing Agent 1.0 改造早期实施快照，文档修订号 1.1。
- 历史状态：文件中的 `DONE`、`READY`、`BLOCKED`、`IN_PROGRESS` 和百分比只描述当时任务或候选版本，不代表当前产品状态。
- 替代入口：[文档中心](../../README.md)、[当前 PRD](../../prd/WRITING_AGENT_1_0_PRD.md)、[当前实施进度](../../architecture/IMPLEMENTATION_PROGRESS.md)和[发布门禁](../../testing/RELEASE_GATE.md)。

## 为什么归档

旧包同时保存拆分文档、完整合订副本、开工说明、任务 JSON 和发布草案，容易形成多个维护源。合并后只维护拆分后的产品、架构和实施文档；本目录保留审计价值，不接受日常产品要求更新。

## 迁移映射

| 原文件 | 处理 | 当前维护源或替代者 |
|---|---|---|
| `START_HERE.md` | 历史入口保留 | [文档中心](../../README.md) |
| `Writing_Agent_1.0_PRD_Full.md` | 历史合订快照保留，不再同步 | [当前 PRD](../../prd/WRITING_AGENT_1_0_PRD.md)及其链接的拆分文档 |
| `docs/prd/WRITING_AGENT_1_0_PRD.md` | 合并为产品维护源 | [当前 PRD](../../prd/WRITING_AGENT_1_0_PRD.md) |
| `CHANGELOG_PRD.md` | 合并并补充覆盖关系 | [PRD 修订记录](../../prd/CHANGELOG.md) |
| `docs/implementation/RUNTIME_CONTRACTS.md` | 按职责归入架构 | [运行时与领域契约](../../architecture/RUNTIME_CONTRACTS.md) |
| `docs/implementation/FRONTEND_REUSE_PLAN.md` | 合并为实施文档 | [DSH 前端复用方案](../../implementation/FRONTEND_REUSE_PLAN.md) |
| `CR002_*`、`CR003_*` | 保留为有效强制修订 | [CR-002](../../implementation/CR002_INTERACTIVE_COLLABORATION.md)、[CR-003](../../implementation/CR003_CONVERSATION_FIRST_HARNESS.md) |
| `docs/research/SOURCE_BASELINE.md` | 按职责归入架构 | [来源基线](../../architecture/SOURCE_BASELINE.md) |
| `AGENT_HANDOFF.md` | 早期 M0/M1 交接归档 | [文档中心](../../README.md)与[当前实施进度](../../architecture/IMPLEMENTATION_PROGRESS.md) |
| `BACKLOG.json` | 25 项任务状态快照归档 | [当前实施进度](../../architecture/IMPLEMENTATION_PROGRESS.md)和各测试记录 |
| `GITHUB_AND_LAUNCH_PLAN.md` | 早期分支/传播计划归档 | [桌面发布手册](../../launch/DESKTOP_RELEASE_RUNBOOK.md) |
| `DOCUMENT_CHECKS.json` | 原包检查报告归档 | `python -B scripts/check_document_pack.py`；需要快照时加 `--write-report` |

归档保留原文以便审计，内部旧相对路径可能指向原包结构；导航和当前事实请使用上表链接。
