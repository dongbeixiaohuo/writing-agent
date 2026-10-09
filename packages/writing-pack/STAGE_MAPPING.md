# 旧 Stage 到 Writing Pack 任务映射
> **CR-002 状态纠正（2026-09-19）：** 下表的 IMPLEMENTED_VERIFIED_REAL 仅代表阶段工具曾由真实 provider 执行，不代表原功能完整迁移。准备阶段缺口追问、导演决策、独立评审上下文隔离均未完成业务验收；WA-010 为 IN_PROGRESS。以[强制增补](../../docs/implementation/CR002_INTERACTIVE_COLLABORATION.md)为准。

本映射用于保留旧工作流中已经验证过的写作约束，不把 Claude Code、Subagent、文件名或二十余个 Stage 搬成新 runtime 的执行前提。新 runtime 的唯一写入口仍是 Application Service；旧 `.claude`/`claude-runtime` 在兼容期继续按原同步规则维护。

| 旧阶段 | 新任务/能力 | 1.0 当前状态 | 保留边界 |
|---|---|---|---|
| 1、0、1.5 | `prepare-direction` | `IMPLEMENTED_VERIFIED_REAL` | 简报区分暂定、用户确认与授权代选；已有授权不重复索取 |
| 2、3、4、5 | `research-check` + `outline` | `IMPLEMENTED_VERIFIED_REAL` | 读取全部授权材料，形成结构化证据、反证、适用边界和文体化结构 |
| 5.5、5.8 | `prepare-direction` | `IMPLEMENTED_VERIFIED_REAL` | 标题/开头可暂定，不能伪造用户锁定 |
| 6 | `draft` | `IMPLEMENTED_VERIFIED_REAL` | 主笔读取项目授权材料及已保存研究/提纲后提交不可变正文版本 |
| 7、8、9 | `independent-review` | `IMPLEMENTED_VERIFIED_REAL` | 三类评审绑定同一正文版本，只交建议，不能覆盖正文 |
| 9.5 | `central-revision` | `IMPLEMENTED_VERIFIED_REAL` | 仅主笔集中修订；恢复段必须先读取正文、证据与全部评审产物 |
| 10 | `language-review` | `IMPLEMENTED_VERIFIED_REAL` | 有具体收益才改，不补造亲历或事实；最终正文拒绝混入说明文字 |
| 11 | 配图扩展 | 本任务不实现 | 仍需显式选择和付费授权；改变正文后旧核查失效 |
| 10.5 | `fact-check` | `IMPLEMENTED_VERIFIED_REAL` | 最终事实门禁不可由模型自报 passed，也不可被 quick 绕过；partial/none/red 一律阻断 |
| 12、12.5 | publication export | `IMPLEMENTED_VERIFIED_REAL` | 工作备份与正式交付分离，TXT/HTML 共用当前事实门禁；正文变化后必须重查 |
| 13、14 | 复盘/真实发布指标 | 后续任务 | 区分用户修改、模型建议和真实指标，不自我强化偏好 |

## quick / deep 的有界语义

- `quick`：执行研究/证据、提纲、完整初稿、编辑审校、集中修订、语言终审和事实核查；省略发布/读者两类独立审校，重大修订最多 1 轮。
- `deep`：执行研究/证据、提纲、完整初稿、编辑/发布/读者三类独立审校、集中修订、语言终审和事实核查；重大修订最多 2 轮。
- `autonomous` 连续执行有界序列；`co_creation` 在提纲、初稿和三类审校后保存检查点，由用户显式继续。每次恢复都必须从持久工件读取所需上下文，不能依赖上一轮模型会话。
- 两种模式都不能绕过最终事实门禁。真实 MiniMax-M3 已完成 Quick 与 Deep 代表性旅程；这证明执行闭环，不代表 12 例质量盲评或所有 provider 兼容性已经签收。
