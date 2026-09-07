# 项目结构说明

## 顶层目录

```text
写稿Agent/
├── .claude/
│   ├── agents/                 # 21 个活跃 subagent 定义
│   ├── skills/                 # 顶层 skill，目前保留 3 个
│   ├── styles/                 # 风格库
│   ├── workflows/              # 机器可读工作流契约
│   ├── settings.json
│   └── settings.example.json
├── articles/                   # 每篇文章一个项目目录
├── docs/                       # 使用说明、结构文档、计划文档
├── scripts/                    # hook、清洗、校验、run manifest 等脚本
├── tests/                      # Python 回归测试
├── evaluations/                # 固定简报、配对盲评工具与说明
├── README.md
├── package.json
└── CHANGELOG.md
```

## `.claude/agents/`

这里放的是工作流里的执行单元，不再是旧版 skill 平铺结构。

当前活跃组件包括：

- `topic-generator`
- `topic-research`
- `writing-clarifier`
- `memory-loader`
- `position-engine`
- `research-expert`
- `outline-architect`
- `empathy-designer`
- `concretizer`
- `title-designer`
- `opening-tournament`
- `writing-executor`
- `editor-review`
- `pre-publish-review`
- `wechat-reader-test`
- `humanizer`
- `fact-checker`
- `article-illustrator`
- `html-exporter`
- `edit-diff-learner`
- `performance-review`

## `.claude/skills/`

当前保留 3 个顶层 skill：

- `workflow-producer`
- `style-modeler`
- `web-article-extractor`

职责划分：

- skill 负责入口、总控、工具编排
- agent 负责单阶段执行

## `.claude/workflows/`

这里放机器可读协议。目前主文件是：

- `.claude/workflows/collab_v2.json`

它定义：

- A/B/C 模式与活跃阶段顺序
- canonical 输入输出文件名
- 可选发布后 Stage 14
- legacy alias
- 最终复制出口 `_clean.txt`

## `articles/`

每个项目目录应遵守 `collab-v2` 契约。典型结构：

```text
articles/[项目名]/
├── 00_memory_packet.md
├── 01_theme.md
├── 01b_position.md
├── 02_scar_tissue.md
├── 02_evidence_ledger.json
├── 03_outline.md
├── 04_title.md
├── 04_share_map.md
├── 05_concrete_library.md
├── 05c_opening_hook.md
├── draft_v1.md
├── draft_v1_notes.md
├── draft_v2.md
├── draft_v2_notes.md
├── run_manifest.json
├── editor_review.md
├── pre_publish_review.md
├── wechat_reader_test.md
├── revision_brief.md
├── revision_result.md
├── humanizer_review.md
├── fact_check_snapshot.json
├── fact_claims.json
├── fact_check_report.md
├── publication_metrics.jsonl
├── performance_reviews/
├── [正文文件名]_clean.txt
├── [正文文件名].html
└── 99_episode.md
```

说明：

- `draft_v*.md` 只放正文。
- `draft_v*_notes.md` 只放内部备注。
- `run_manifest.json` 记录当前正文来源、状态，以及正文、标题、账本、核查快照及结果的完整绑定。
- `_clean.txt` 是最终复制出口，不是正文版本源。
- `04_title.md` 记录差异化候选与分发文案，早期可暂定，Stage 9 前结合成稿锁定。
- `publication_metrics.jsonl` 是可选的 append-only 发布指标账本，不写入 `run_manifest.json`。

## `scripts/`

当前关键脚本：

- `fact_check_gate.py`：核查前快照、逐条结果校验与交付一致性门禁
- `generate_clean.py`：清洗正文、统计正文字数、生成 `_clean.txt`
- `auto_clean_hook.py`：hook 入口，优先根据 `run_manifest.json` 生成纯净版
- `update_run_manifest.py`：登记当前项目最新正文/备注/状态
- `verify_required_files.py`：校验阶段必需产物、语义状态及 manifest 动态输入
- `record_publish_metrics.py`：追加记录版本绑定的发布后表现
- `validate_workflow.py`：校验活跃阶段、风格登记表和文档是否发生契约漂移
- `split_draft_notes.py`：把历史内嵌备注拆成 `*_notes.md`
- `generate_image.ts`：配图生成入口

## `tests/`

当前测试以 Python `unittest` 为主，覆盖：

- 工作流契约校验器
- `run_manifest.json` 更新逻辑
- clean hook 的来源选择
- 快照/核查清单/报告完整绑定与纯文本、HTML 交付门禁
- 发布指标 schema、追加语义与路径安全

## 常见修改入口

- 调整阶段顺序或产物名：修改 `claude-runtime/workflows/collab_v2.json`
- 调整导演交互逻辑：修改 `claude-runtime/skills/workflow-producer/SKILL.md`
- 调整主笔或主编行为：修改 `claude-runtime/agents/*.md`
- 调整 `_clean.txt` 生成规则：修改 `claude-runtime/scripts/generate_clean.py` 与 `claude-runtime/scripts/auto_clean_hook.py`
- 修改唯一源后执行 `npm run sync:claude-runtime`，不要分别手改 `.claude/` 和插件镜像。
