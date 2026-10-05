# Writing Agent 文档中心

这里是产品、开发、测试和发布文档的统一入口。产品行为以维护源和后续修订为准；测试记录只证明其写明的版本、环境和场景，不自动证明当前版本全部通过。

## 用户入口

- [桌面快速开始](QUICKSTART_1_0.md)：下载、首次配置、备份、升级和常见限制。
- [桌面版与原版 Skill 能力对照](DESKTOP_SKILL_COMPARISON.md)：选择适合自己的入口。
- 原版使用说明见 [Claude Code 指南](CLAUDE_CODE_GUIDE.md)。个人资料不纳入版本化产品入口。

## 产品与开发维护源

| 类别 | 维护源 | 说明 |
|---|---|---|
| 产品需求 | [Writing Agent 1.0 PRD](prd/WRITING_AGENT_1_0_PRD.md) | 唯一完整产品契约；不再维护另一份合订 PRD |
| 修订关系 | [PRD 修订记录](prd/CHANGELOG.md) | CR-001、CR-002、CR-003 的生效范围和覆盖关系 |
| 运行时架构 | [运行时与领域契约](architecture/RUNTIME_CONTRACTS.md) | 状态、版本、恢复、权限和事实门禁不变量 |
| 前端实施 | [DSH 前端复用方案](implementation/FRONTEND_REUSE_PLAN.md) | 固定上游、复用边界和本地差异 |
| 交互修订 | [CR-002](implementation/CR002_INTERACTIVE_COLLABORATION.md)、[CR-003](implementation/CR003_CONVERSATION_FIRST_HARNESS.md) | 对 PRD 指定范围的强制增补；后者在冲突范围内优先 |
| 当前进度 | [实施进度](architecture/IMPLEMENTATION_PROGRESS.md) | 当前实现和证据索引，不反向覆盖产品合同 |
| 测试与验收 | [发布门禁](testing/RELEASE_GATE.md)、[最终用户验收清单](testing/FINAL_USER_UAT_CHECKLIST.md) | 区分自动检查、真实模型、桌面安装和人工体验 |
| 模型输入与核查效率 | [上下文投影与事实核查分段](testing/AGENT_CONTEXT_PROJECTION.md) | 按角色提供输入；区分模拟结果、历史测量与真实模型耗时 |
| RC72 审查修复 | [2026-10-05 修复与回归](testing/2026-10-05-rc72-review-fixes.md) | 桌面回执、核查恢复、搜索额度和启动诊断；未发布的本地修复 |
| 发布 | [桌面发布手册](launch/DESKTOP_RELEASE_RUNBOOK.md) | 当前维护者操作入口；单次 RC 记录只是对应版本证据 |

修订优先级按“基础 PRD → CR-001 → CR-002 → CR-003 及其带日期补充”解释；较晚修订只覆盖其明确声明的产品范围，其余要求继续有效。实现记录、历史 `DONE`/`READY`/`BLOCKED` 和发布记录不能替代产品合同，也不能外推为当前状态。

## 目录约定

- `prd/`：产品需求及修订记录。
- `architecture/`：稳定架构、协议、ADR、来源和安全边界。
- `implementation/`：仍有效的实施指南与迁移说明。
- `testing/`：测试计划、版本化结果与验收门禁；文件中的结论按记录日期和版本理解。
- `launch/`：当前发布流程和逐版本发布证据。
- `archive/`：已被替代的计划、任务清单和历史合订快照；不得作为当前开工入口。

## 历史入口

[PRD 1.1 / DSH UI 文档包归档](archive/2026-09-16-prd-v1.1-dsh-ui/README.md)保留 2026-09-16 至 2026-09-24 的合订稿、开工交接、25 项任务快照、旧发布计划和当时的文档检查报告。归档中的完成、阻断或就绪状态只适用于当时快照。

## 文档检查

```powershell
python -B scripts/check_document_pack.py
npm run check:docs
```

前者检查 PRD/CR 编号、历史任务依赖、来源编号、有效相对链接、代码围栏和已撤回路线；后者同时运行原版工作流的活跃文档约束检查与该产品文档检查。两者都不等于应用、真实模型、安装包或人工体验已经验收。
