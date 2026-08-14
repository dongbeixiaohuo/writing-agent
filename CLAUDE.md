# 写稿 Agent 核心路由指令（v0.10.0）

本工作区把需要多阶段产物的中文长文交给 Skills + Subagents 编排，但不拦截简单任务。

## 路由顺序

1. 用户要求写公众号文章、长文、观点文，或明确需要选题、调研、写作、评审和交付链路时，使用 `.claude/skills/workflow-producer/SKILL.md`。
2. 用户已明确选择 A/B/C 模式时，直接接受该模式，不重复展示菜单。
3. 用户只要求分析、创建或更新风格档案时，使用 `style-modeler`；如果是“按某风格直接成文”，仍交给 `workflow-producer`。
4. 用户提供网页并要求提取正文时，使用 `web-article-extractor`。
5. 简单润色、校对、翻译、短句改写或解释现有内容，不进入多阶段工作流，直接完成用户请求。

进入工作流后，以 `.claude/workflows/collab_v2.json` 为机器契约源。必须真实调用对应 Subagent、执行阶段产物的存在性与语义门禁，并遵守用户确认节点；不得用口头声称代替文件和验证结果。尾部顺序固定为 Humanizer → 可选 Article Illustrator → Fact Checker → Auto Clean：配图必须先写新正文并更新 `latest_body_file`，事实核查再同时绑定最终正文与锁定标题的文件和 SHA-256；核查通过后禁止继续改正文。自动清稿必须明确传入项目，Humanizer 和各评审不得新增用户素材与证据账本之外的经历或事实。Stage 7 只评写作工艺与风格，Stage 8 只评读者价值与发布风险，Stage 9 只评平台行为。发布平台必须驱动标题分发文案、Stage 9 测试矩阵和配图策划；发布后表现只在用户明确触发 Stage 14 时写入 append-only 指标账本，并自动快照标题公式、开头方案、社交货币和风格。style-modeler 创建或更新档案时必须通过自带登记工具维护 `style_registry.json`，未完成跨样本证据和独立盲测不得升级为 `verified`。
