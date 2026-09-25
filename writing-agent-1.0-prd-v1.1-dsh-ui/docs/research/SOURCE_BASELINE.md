# 来源、代码基线与事实边界

初稿核对日期：2026-09-15（UTC+08:00）；CR-001 前端补充核对日期：2026-09-16。原仓库统计仍是初稿时间点快照，不标为本次重新统计。本包是方案与实施契约，不是已经完成的代码改造或运行测试报告。

## 1. 固定代码基线

| 项目 | 本次读取的分支 | 本次核对的 commit |
|---|---|---|
| dongbeixiaohuo/writing-agent | main | `ca01dcf989729a5c255bbb50b4b7896f3ef810a4` |
| deepseek-ai/deepseek-harness | master | `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` |

实施 Agent 必须重新读取实际工作区的 HEAD、未提交修改、仓库指引和上游快照。如果已有后续提交，先记录差异，不得强制回退到本表。选择 DSH 移植基线后，后续升级必须显式审批，不能跟随 master 自动变化。

当前已确认：Writing Agent 根 package.json 为 `0.11.0`、`private: true`；桌面包为 `0.1.0`、`private: true`。版本字段不证明同名 Git tag、GitHub Release 或 npm 包已存在。此文没有核实 npm 包名归属、签名证书、全部 release/tag 与发布权限。

## 2. 一手来源索引

以下编号供 PRD 和实施文件引用。仓库文件链接固定到本次 commit，GitHub 产品文档会继续更新。

**[S01] 原仓库元数据及分支。**

- https://api.github.com/repos/dongbeixiaohuo/writing-agent
- https://api.github.com/repos/dongbeixiaohuo/writing-agent/git/ref/heads/main
- 核对快照：repository id `1120473357`；417 stars，63 forks，`subscribers_count=4`；`has_discussions=false`；默认分支 main。它们是时间点数据，不是活跃用户、付费用户或完整通知受众数量。

**[S02] 根包和现有检查入口。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/package.json
- `npm run check` 包括 Python 测试、语法/工作流/文档/运行时镜像检查，以及调用 `claude plugin validate` 的旧插件检查。新 runtime 不依赖 Claude Code，不等于可以删除旧插件回归检查。

**[S03] 现行写作工作流契约。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/docs/WORKFLOW_CONTRACT.md
- 现行唯一源是 `claude-runtime/`，`.claude/`、相关脚本与插件副本由同步生成。包含最终稿版本指针、证据账本、集中修订、事实快照门禁、来源区分和迁移限制。

**[S04] 可执行事实核查规则。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/claude-runtime/scripts/fact_check_gate.py
- 本次检查了文件前 160 行，覆盖快照、claims 评估和报告生成。`fact-check-v2` 允许 `SUPPORTED / UNSUPPORTED / CONTRADICTED / BROKEN_LINK / NEEDS_USER_SOURCE`；非 SUPPORTED、红色风险、partial/none 支持均阻断。完整导出链仍须由实施 Agent 阅读和运行回归。

**[S05] 桌面产品与实现基线。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/writing-agent-app/package.json
- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/writing-agent-app/docs/PRD.md
- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/writing-agent-app/docs/CURRENT-FUNCTION-SPEC.md
- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/writing-agent-app/src/types.ts
- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/writing-agent-app/agent-runtime/execute-claude.mjs
- 已有 React/Tauri/XState/Zod 及 SQLite/项目目录设计。读取到的桌面执行路径依赖 Claude Agent SDK、禁用 tools，调用端以单轮生成为主。这里描述该路径，不推断所有旧工作流均无工具能力。旧功能规格有历史更新时间，目标行为不等于全部已经实现。

**[S06] 作者素材与修改经验。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/claude-runtime/agents/writing-clarifier.md
- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/claude-runtime/agents/edit-diff-learner.md
- 已有关键素材追问、禁止伪造亲历、区分真实用户修改和模型建议等规则。下一代应落实为数据与操作约束，不因改写技术栈而丢失。

**[S07] 现有质量评估工具。**

- https://github.com/dongbeixiaohuo/writing-agent/blob/ca01dcf989729a5c255bbb50b4b7896f3ef810a4/evaluations/README.md
- 12 个合成案例、四类文体、人工配对盲评。工具存在不代表新旧文章已完成盲评，更不证明复杂工作流必然胜过简单提示词。

**[S08] 原仓库用户反馈。**

- https://github.com/dongbeixiaohuo/writing-agent/issues/11
- https://github.com/dongbeixiaohuo/writing-agent/issues/3
- #11 于 2026-09-05 提问桌面版能否独立使用；它说明认知/上手疑问，不能单凭提问证明具体依赖缺陷。#3 是历史质量反馈，后续更换 Demo 并关闭；不能用其证明当前版仍存在同一质量问题。

**[S09] DSH 分支与架构。**

- https://api.github.com/repos/deepseek-ai/deepseek-harness/git/ref/heads/master
- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/docs/architecture.md
- 文档描述 Cordis 插件组合、session 事件、agent loop、模型和工具接口；模型请求的已记录输入应能从日志重建。DSH 的具体模块互相依赖，不能仅凭目录名判断可以单文件移植。

**[S10] DSH 许可和安全边界。**

- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/LICENSE
- https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md
- https://opensource.org/license/mit
- 本次 LICENSE 明确为 MIT、版权主体为 DeepSeek（2026）。复制代码需保留适用版权与许可声明；依赖及资源逐项审查。预览和安全声明在此前对话已读取，实施时应在锁定 commit 上复核。本文不提供法律合规保证。

**[S11] GitHub 的 star 与 Watch 含义。**

- https://docs.github.com/en/rest/activity/starring
- star 是收藏/兴趣信号，不等于订阅更新。API 的 `watchers_count` 与 star 数对应；实际 watchers 使用 `subscribers_count`。保留同一仓库身份意味着不是把星迁移到另一个仓库，但不能防止用户自行取消 star。

**[S12] GitHub 发布和更名。**

- https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository
- https://docs.github.com/en/repositories/creating-and-managing-repositories/renaming-a-repository
- 可以在指定 tag/目标分支发布预发布版本；发布正文与资产需核验。改名有重定向规则和例外，本方案不要求改名，不将其作为升级前置条件。

**[S13] DSH 前端模块地图。**

- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/client/README.md
- 本次读取到 client/web、modules、connection、store、locale、ui-renderer、ui-slots、ui-theme、ui-primitives、ui-layout、侧栏、Conversation/Chat、设置、官方品牌与文档预览等模块。模块地图不证明所有模块可以单独移植；实施须核对实际依赖。

**[S14] DSH 官方 Web Client 分层与协议说明。**

- https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-client
- https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/web-client
- 2026-09-16 检索读取到的官方说明，网页不是固定 commit。描述 Host、Remote、Client model、UI adapter、Conversation、Slot/React 分层及 boot graph。细节以 M0 固定源码为准，不能用在线文档覆盖已锁定版本。

**[S15] DSH 主题变量与扩展。**

- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/client/ui-theme/README.md
- 本次读取其 light/dark/system、主题快照、Host-backed preferences、`--dsw-*` token 与别名覆盖说明。已存在扩展点不等于 Writing Agent 已有主题编辑器；移植后设置须写入自有数据空间。

**[S16] DSH 文档预览的范围与安全差异。**

- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/packages/client/ui-sidebar-documentpreview/README.md
- 本次读取：右侧 Sidebar 的资源/只读预览、Markdown/文本内容读取、渲染器扩展；明确不提供编辑。其 HTML 支持带 `allow-scripts` 的隔离预览；本产品首版按更保守 NFR-07 不继承该脚本执行行为，属于有记录的本地差异。

**[S17] DSH Electron 桌面与同源 Web UI。**

- https://github.com/deepseek-ai/deepseek-harness/blob/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720/apps/desktop/README.md
- 本次读取到 Electron 包装同一 Web UI、匹配后端资源、独立 Node、受限传输和分发流程；返回内容有截断，未完整审计桌面安全/构建实现。没有实测移植成本，不承诺直接复制就能打包；官方运行时启动、home、品牌、更新与插件设施不能原样成为本项目依赖。

## 3. 已知、设计与未知

- **用户明确的方向：**利用 DSH 源码和架构，改造原 Writing Agent 为拥有自有运行时的独立项目；不是依赖 DSH 来运行的插件、profile、SDK 包装产品；保留原项目积累并改善使用门槛和传播。CR-001 进一步明确直接复用 DSH 前端 UI 源码和体系，不利旧 0.1.0 桌面页面，以减少从零设计和后续调整负担。
- **本方案给出的默认设计：**TypeScript 自有 runtime；SQLite 事务记录；M1 并行运行时与 DSH 前端源码移植；M2 接写作服务和面板；桌面默认优先评估移植 DSH Electron 最小壳并自包含分发。具体桌面容器未被用户逐项指定，必要调整须 ADR 与维护者批准，不得恢复旧 UI。先文件/段落级溯源；1.0 前不做公开插件市场。
- **未知：**真实活跃与留存、模型额度/价格、签名证书、完整 OS 兼容范围、DSH 具体移植成本、性能实测、首发模型有效性、用户实际本地数据库格式差异。
- **本次前端补充的事实边界：**只读检查了模块与架构文档；未在运行页面上检查视觉，不以用户提及的其他社区魔改作品作为已验证样本，未移植或构建源代码。
- **本次没有做：**在用户仓库写入文件、创建分支/Issue/Release、运行该项目测试、构建安装包、调用付费模型、做 UI 可用性实验。本包中的测试名称、任务 ID、接口和目录，除明确标注现有者外，均为待实现目标。
