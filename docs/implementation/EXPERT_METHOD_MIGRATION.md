# 专家专业方法迁移说明

## 结论与边界

本次把原 Claude Code 写作工作流中的专业判断方法迁移到中性 writing pack，公共接口是：

```ts
buildExpertInstructions(role: string): string
```

以及带类型的 `EXPERT_INSTRUCTION_CATALOG`。执行指令不包含旧宿主路径、文件协议、命令或工具名；源文件路径只保留在 metadata 中供审计。返回内容只补充角色专业方法，明确服从调用方已有的 JSON schema、阶段提交格式、工具协议和 scoped context，不自行授予联网、配图、导出或发布能力。

2026-09-21 集成状态：`collaboration.ts` 的导演与阶段专家、`author-conversation.ts` 的专项专家，以及 standalone fact-check 已在实际模型请求中注入本目录。测试检查真实 request snapshot 的指令与 scoped context；不是只增加静态角色标签。完整功能验收仍以 `LEGACY_PARITY_MIGRATION.md` 的逐项状态为准。

## 角色与来源映射

2026-09-25 rc.36 补充：读者审校要按声明平台模拟即时感受和传播动机，含朋友圈熟人场景；明确模拟而非真实调研，不承诺热文，私人写作跳过传播要求。`humanizer` 仍是 `language_review` 的同一专业指令，界面改为“去 AI 味与语言润色”，不是删除或换成普通润色。事实核查区分用户原话中的主观感受与模型新增的具体亲历场景，散文不豁免后者。

| 中性角色 | 兼容别名（节选） | 原版专业来源 |
|---|---|---|
| `director` | `workflow-producer`, `orchestrator` | `claude-runtime/skills/workflow-producer/SKILL.md` |
| `research` | `research-expert` | `claude-runtime/agents/research-expert.md` |
| `outline` | `outline-architect` | `claude-runtime/agents/outline-architect.md` |
| `draft` | `writing-executor`, `writer` | `writing-executor.md`, `writing-clarifier.md` |
| `review_editor` | `editor-review` | `claude-runtime/agents/editor-review.md` |
| `review_publish` | `pre-publish-review` | `claude-runtime/agents/pre-publish-review.md` |
| `review_reader` | `wechat-reader-test`, `platform_reader_test` | `claude-runtime/agents/wechat-reader-test.md` |
| `central_revision` | `revision`, `revision_writer` | 总导演集中修订规则、`writing-executor.md` |
| `language_review` | `humanizer`, `language-review` | `claude-runtime/agents/humanizer.md` |
| `fact_check` | `fact-checker`, `fact-check` | `claude-runtime/agents/fact-checker.md` |
| `topic_generator` | `topic-generator` | `claude-runtime/agents/topic-generator.md` |
| `topic_research` | `topic-research`, `topic validation` | `claude-runtime/agents/topic-research.md` |
| `position` | `position-engine` | `claude-runtime/agents/position-engine.md` |
| `concretizer` | `concrete` | `claude-runtime/agents/concretizer.md` |
| `empathy` | `empathy-designer` | `claude-runtime/agents/empathy-designer.md` |
| `title` | `title-designer` | `claude-runtime/agents/title-designer.md` |
| `opening` | `opening-tournament` | `claude-runtime/agents/opening-tournament.md` |
| `style_modeler` | `style-modeler` | style-modeler Skill 及三份 reference |
| `illustrator` | `article-illustrator` | `claude-runtime/agents/article-illustrator.md` |
| `memory` | `memory-loader` | `claude-runtime/agents/memory-loader.md` |
| `retrospective` | `edit-diff-learner`, `performance-review` | 编辑差异复盘与发布后表现复盘两个 agent |

完整别名与逐角色 `sourceFiles` 以 `EXPERT_INSTRUCTION_CATALOG` 为准。

## 保留的关键专业方法

- 三类评审不合并成通用“审稿”：主编只审写作工艺、结构和作者声音；发布评审审读者价值、承诺兑现和风险；平台读者测试分别使用公众号、今日头条、知乎与未知平台矩阵，并禁止伪造流量预测。
- 研究与立场把支持材料、最强反证、替代解释、证据缺口和适用边界同时纳入；说明性情景不得冒充亲历或事实。
- 作者声音来自真实素材、判断、价值排序和有证据的风格规则；没有授权一手来源时禁止补写第一人称亲历、朋友故事、采访或精确对话。
- 标题、开头和选题都区分候选、暂定、用户确认和授权代选，模型建议不能伪装成用户选择。
- 集中修订要求所有评审绑定同一正文，逐项记录采纳、不采纳或延后的理由，不按票数合并；先处理事实与承诺，再处理结构，最后处理措辞。
- Humanizer 先证明改动收益，只做局部最小修改；句长、破折号、列表、口语和不规则节奏本身不是缺陷。
- 最终事实核查覆盖完整正文、最终标题和实际选用的分发文案；部分支持、无支持、矛盾、待用户来源或重大真实性风险都不能放行。
- 风格建模保留作者锚点、跨样本证据、风格内核与节奏等主要分析方法、通用基线/区分开关、陌生主题仿写、至少三组独立盲测及关键节奏偏差超过 30% 不通过的验证要求。完整 15 维分析表已作为只读工具接通；自动量化/盲测调度尚未接通，不能以指令迁移代替验证执行。
- 记忆与复盘严格区分 `user_edit`、`agent_suggestion`、`reader_feedback` 和 `publication_metric`；只有明确用户确认的 `user_edit` 才可称用户偏好，单篇指标不做因果归因。
- 配图先策划、后确认、再按实际授权能力生成；未确认、无能力或生成失败时不得写假路径或声称成功，配图改变正文后旧事实核查失效。

## 接入建议

1. 调用方继续负责系统安全规则、阶段 schema、提交工具说明和当前 scoped context。
2. 在具体角色的独立请求中追加 `buildExpertInstructions(role)`，不要把整个目录或其他角色指令全部注入，以免破坏评审独立性和扩大上下文。
3. `review_editor`、`review_publish`、`review_reader` 应各自只接收同一正文版本和各自必要上下文，三者完成后才把结果交给 `central_revision`。
4. `buildExpertInstructions` 不应拼进结构化 stage payload；它属于 system/developer 专业约束。调用方现有 JSON schema 和工具协议保持唯一机器契约。
5. 未注册角色会抛出 `TypeError`，调用方应在调度映射或启动检查中提前发现，而不是静默退回通用 prompt。

## 未迁移内容

- 旧 `.claude` 文件树、阶段文件名、Python/Bash 命令、Claude Code Agent/Read/Write/WebSearch 工具协议。
- 旧 Claude Code 宿主中的进程模型；新版采用同 runtime 内的独立请求上下文与工具权限，不伪称每个角色拥有独立 OS 进程。
- 配图生成、风格量化脚本、盲测调度、发布后指标记录等能力的中性运行时实现。
- 真实 provider 的端到端写作质量验收。

因此，可以声明专家方法已进入实际执行链和来源可追溯；不能据此声明原版全部用户功能或真实模型效果已经验收。
