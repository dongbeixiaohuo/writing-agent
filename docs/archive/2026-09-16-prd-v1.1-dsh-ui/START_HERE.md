# Writing Agent 1.0 改造文档包（历史入口）

> 历史快照：原始日期 2026-09-16，后续修订截至 2026-09-24；适用 Writing Agent 1.0 早期实施（PRD 修订 1.1）。2026-10-05 归档，状态和计划仅适用于当时版本。当前要求与替代入口见 [归档映射](README.md)和 [文档中心](../../README.md)。

> 2026-09-20 追加 [CR-003：对话优先 Harness](docs/implementation/CR003_CONVERSATION_FIRST_HARNESS.md)。默认入口必须允许一句想法开始；四步必填向导不是 Agent 访谈。结构化简报在后台生成，工程层约束授权、版本与可执行状态，而不是把用户锁进字段填写顺序。

> 当前必须先读 [CR-002：导演协作与交互式写作](docs/implementation/CR002_INTERACTIVE_COLLABORATION.md)。本修订于 2026-09-19 生效，补充下文 PRD 1.1/CR-001。WA-010 重新实施，原最终用户验收就绪结论撤回。目录内文件为当前依据，根目录旧 ZIP 未重新分发，不应作为最新基线。

版本：PRD 1.1 · 2026-09-16 · 状态：建议实施基线。

**目标：在原 writing-agent 仓库内，参考并选择性移植 DSH 源码，形成自主维护、独立启动、专门面向写作的 agent runtime。不是将写作做成 DSH 插件，也不是套用 DSH SDK。**

**CR-001 已定：前端必须直接复用 DSH 源码及 UI 体系，旧桌面 0.1.0 不作为新界面/分发基线。文档版本是 1.1，目标产品仍为 1.0。** 先读 [修订记录](CHANGELOG_PRD.md)；已拿到初稿的 Agent 必须以本包替换旧方案，保留其已做代码并按交接说明核对，不能强制重置。

## 阅读顺序

1. [完整 PRD](docs/prd/WRITING_AGENT_1_0_PRD.md)：产品目标、范围、需求编号、里程碑与上线门禁。
2. [运行时契约](docs/implementation/RUNTIME_CONTRACTS.md)：状态、事件、工件版本、并发、恢复、事实门禁、接口及不变量。
3. [DSH 前端复用方案](docs/implementation/FRONTEND_REUSE_PLAN.md)：源码保真、依赖/协议、写作扩展、主题/布局调整与桌面分发。
4. [Agent 开工交接](docs/implementation/AGENT_HANDOFF.md)：操作顺序、已有代码入口、验证与权限边界。
5. [机器可读任务清单](docs/implementation/BACKLOG.json)：任务 ID、依赖、产物和验收。
6. [GitHub 与传播方案](docs/roadmap/GITHUB_AND_LAUNCH_PLAN.md)：分支、发布、旧用户迁移、README、预览招募及发布内容草案。
7. [来源与基线](docs/research/SOURCE_BASELINE.md)：固定 commit、引用及尚未验证事项。

可把本包的 `docs/` 放入原仓库对应目录。遇到同名文件先比较，不自动覆盖。不要用本包覆盖仓库已有 `AGENTS.md` 或 `CLAUDE.md`。

## 可直接发给开发 Agent 的开工指令

```text
请在 dongbeixiaohuo/writing-agent 原仓库中，按这份文档包实施下一代改造。
先阅读 START_HERE.md、完整 PRD、FRONTEND_REUSE_PLAN.md、RUNTIME_CONTRACTS.md、AGENT_HANDOFF.md 和 BACKLOG.json，
同时遵守实际工作区中适用的仓库指引。先核实 HEAD、工作区状态和现有测试，不覆盖我的未提交修改。

核心边界：利用 DSH 源码做选择性移植及自主维护，不做 DSH 插件/profile，不依赖 DSH SDK/CLI 启动，
不把 Claude Agent SDK 继续作为新 runtime 执行器。允许使用普通底层库；移植代码保留许可与来源。
前端必须直接移植 DSH 页面、布局、主题、组件和所需客户端/通信闭包，先保真后加写作功能；
不得沿用旧 0.1.0 的 App.tsx/CSS/Tauri 启动链，也不得照截图重新设计。旧应用只作数据迁移与历史参考。
桌面容器默认评估移植 DSH Electron 最小壳，不因此启动或依赖上游 DSH 宿主。
保留原仓库、历史、旧版入口与用户数据，在 next/runtime 或其短期特性分支上开发，禁止直接改 main。

先执行 M0 / WA-001 至 WA-004，形成现状审计、源代码移植清单、ADR 和回归基线。
随后并行推进 WA-005–010 的 runtime 闭环与 WA-023 的 DSH 前端移植基线，WA-011 接通两线。
完成 WA-024–025 的主题/插槽扩展与视觉/协议验收。不要只给计划后停下，也不要一次生成整个大框架。
每次交付一个可运行、可测试的小改动：列出文件、测试命令、实际结果、限制与下个任务。
优先实现创建项目→模型调用工具读取材料→保存稿件→记录事件→重启恢复，先用可复现 mock 验证，
再在具备明确授权和合法配置时验证真实模型。不能把 mock 测试说成真实生成质量验证。

不要擅自创建独立 GitHub 仓库、重写 git 历史、删除旧数据、发布 npm/GitHub Release、
变更默认分支或批量通知用户。这些操作在文档中是后续计划，需维护者授权。
普通实现细节按 PRD 的默认设计推进并记录 ADR；真正阻塞的权限或外部凭据缺失，说明具体阻塞，
继续完成不依赖它的工作。不得为了通过测试移除事实核查、并发保护或许可证要求。
```

## 一句话理解本次升级

把散落在提示词、脚本和文件名里的写作规则，转为新系统能够执行、保存、恢复并验证的状态与操作契约；保留原项目的写作方法和社区积累。
