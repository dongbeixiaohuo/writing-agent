# Writing Agent 1.0 基线审计

状态：`VERIFIED_BASELINE`  
审计日期：2026-09-16  
对应任务：WA-001  
源码基线：`ca01dcf989729a5c255bbb50b4b7896f3ef810a4`（v0.11.0）

## 1. 结论

当前仓库足以开始 1.0 开发，但不是可直接增量扩展成 1.0 的单一应用：仓库中同时存在一套成熟的 legacy Claude 工作流，以及一套功能较窄、契约不兼容的桌面预览应用。1.0 应保留前者的写作和事实门禁语义，保留后者的数据迁移入口；不得复用旧桌面的页面、全局 CSS 或 Tauri 启动链作为新产品基础。

M0 检查未发现需要先暂停开发的产品级阻断项。SQLite 驱动、首个正式 provider 和最终桌面壳的实现细节仍需由 ADR 固化，但需求已经给出默认方向和验收边界，可以在小步实现中作出并验证决定。

## 2. 工作区与版本状态

审计开始时：

- 分支为 `main`，与 `origin/main` 指向同一 commit：`ca01dcf989729a5c255bbb50b4b7896f3ef810a4`。
- remote 为 `https://github.com/dongbeixiaohuo/writing-agent.git`。
- 存在三项未跟踪内容：需求包 ZIP、解压后的 `writing-agent-1.0-prd-v1.1-dsh-ui/`，以及 `writing-agent-app/.gitignore`。它们均未修改、删除或暂存。
- 按需求建立本地集成分支 `next/runtime`；未推送远端、未创建 Issue/PR、未修改 `main`。
- 已有版本标签包含 `v0.11.0`、`v0.10.0` 和 `app-preview-0.1.0`。是否新增 legacy 标签属于后续维护者发布决定，本次不改标签。

## 3. 产品边界

| 范围 | 当前事实 | 1.0 处理 |
|---|---|---|
| `claude-runtime/` | legacy 写作规则、Agent、Skill、脚本的唯一源；同步到 `.claude/` 和插件镜像 | 作为行为基线，逐项抽取宿主无关契约；迁移完成前继续维护原同步链 |
| `.claude/`、`plugins/` | legacy 运行镜像及发行入口 | 保持兼容，不作为新 runtime 的源码源头 |
| `writing-agent-app/` | React 19 + XState v5 + Zod + Tauri 2 的 0.1.0 预览应用 | 仅保留历史支持、真实 schema 与只读迁移输入；不进入新 UI/壳依赖闭包 |
| 根 Python 测试与 `evaluations/` | 工作流、门禁和质量评估回归 | 保留，并为 TypeScript 移植建立差分基线 |
| 1.0 新 runtime/UI | 尚不存在 | 在 `next/runtime` 上新建自主维护模块；UI 直接源移植固定 DSH 前端 |

## 4. Legacy 工作流基线

### 4.1 执行和产物

- `claude-runtime/workflows/collab_v2.json` 定义 A/B/C 三种模式。B 模式采用完整写作序列；C 模式完成选题后交接到 B；默认交互策略为自主推进。
- 完整工作流包含简报、历史经验、立场、研究/证据、大纲、传播设计、标题、开头、初稿、多角色评审、集中修订、语言诊断、可选配图、事实核查、纯文本/HTML 交付和复盘。
- 动态正文必须由 `run_manifest.json.latest_body_file` 解析，不能以文件修改时间猜测。正文和内部备注分开。
- `claude-runtime/` 为唯一修改源；直接修改 `.claude/` 或插件镜像会被同步检查拒绝。

### 4.2 严格事实门禁

当前 `fact-check-v2` 是 1.0 必须保持的最低语义：

- 核查前固定正文、锁定标题/分发文案和证据账本，并记录文件 SHA-256。
- claims 必须绑定本轮 `snapshot_id`，声明正文、标题和分发文案完整覆盖。
- `UNSUPPORTED`、`CONTRADICTED`、`BROKEN_LINK`、`NEEDS_USER_SOURCE`、`partial/none` 支持或红色风险均阻断。
- 正文、标题、证据账本、snapshot、claims 或报告任一变化，旧 `passed` 失效。
- 清稿、直接导出和 HTML 写入共享同一 `publication_passed()` 校验；旧 `passed` 不能迁移为新版通过。

脚本验证的是结构、绑定和一致性；它不证明来源在业务上真实支撑 claim。真实事实质量仍需 Agent/人工核查。

### 4.3 依赖与运行条件

- 根项目以 Python 标准库脚本和 `unittest` 为主要回归入口，Node 脚本负责同步、插件/TypeScript 构建等检查。
- legacy 交互依赖 Claude 宿主能力；1.0 运行时不得要求普通用户安装 Claude Code。
- 根包当前为 `private: true`。任何未来 npm 名称或命令都尚未成为公开发行事实。

## 5. 旧桌面 0.1.0 基线

### 5.1 当前实现

| 层 | 当前实现 |
|---|---|
| UI | React 19；主 `App.tsx` 约 143 KB，并依赖旧全局样式 |
| 状态 | XState v5 项目状态机；`quick` 4 阶段、`deep` 8 阶段 |
| 校验 | Zod 结构化输出；解析失败存在人工/应急占位路径 |
| 桌面 | Tauri 2 + Rust + `rusqlite` |
| 模型 | 仅 `anthropic-compatible` 配置；Agent SDK 子进程或直接 HTTP 回退 |
| 存储 | SQLite 元数据 + 项目目录 Markdown + `project.json` + `secrets.json` |

旧桌面的阶段名和文件契约与 legacy 工作流不同：

- quick：`theme → outline → draft → humanize`
- deep：`theme → position → research → outline → titles → draft → review → humanize`
- 产物使用 `02_research.md`、`04_titles.md`、`draft.md`、`review.md`、`final.md` 等旧桌面命名，不等价于完整 `collab-v2`。

### 5.2 模型调用边界

`writing-agent-app/agent-runtime/execute-claude.mjs` 将 Agent SDK 调用限制为 `maxTurns: 1`、`tools: []`、`settingSources: []`。Tauri 侧同样传入 `maxTurns: 1`。因此它不是具备材料读取工具、持久事件和可恢复循环的 1.0 Agent runtime。

旧桌面还存在下列已确认限制：

- prompt 只截取部分前序产物；历史路径曾限制到 2500/3500 字符。
- 结构解析失败时可生成 `_formatFallback` 占位结果并继续保存，不能作为 1.0 成功语义。
- `run_id` 字段存在，但当前保存输出时固定写入 `NULL`。
- 没有 request snapshot、operation/idempotency、project revision/CAS、append-only event log、replay、cancel/resume 或 unknown-outcome 恢复协议。

### 5.3 SQLite schema（以源码和只读实库核对）

当前建表包括：

- `model_profiles(id, preset_id, provider_label, protocol, base_url, model, source_url, policy_note, include_anthropic_version_header, is_default, last_test_status, last_test_error, last_tested_at, created_at, updated_at)`
- `writing_projects(id, slug, title, mode, topic, audience, word_target, style_profile_id, model_profile_id, current_stage, status, is_archived, archived_at, workspace_path, created_at, updated_at)`
- `stage_outputs(id, project_id, run_id, stage_key, version, summary, word_count, markdown, structured_json, raw_text, artifact_path, status, usage_json, created_at, updated_at)`
- `exports(id, project_id, format, file_path, created_at)`
- `app_settings(key, value, updated_at)`

只读实库检查结果：

| 数据目录 | model_profiles | writing_projects | stage_outputs | exports |
|---|---:|---:|---:|---:|
| `%APPDATA%\com.lanmeng.writingagentapp.preview0414` | 1 | 1 | 3 | 0 |
| `%APPDATA%\com.lanmeng.writingagentapp` | 2 | 8 | 50 | 4 |

两个数据库均为 `PRAGMA user_version = 0`、`foreign_keys = 0`、`journal_mode = delete`。检查只读取表结构、PRAGMA 和记录数；未读取 API Key、文章正文或用户配置值。

### 5.4 文件格式和一致性风险

- 项目目录名为日期与标题 slug；根目录写入 `project.json`，内容是 `ProjectSummary`。
- 第一版阶段产物使用基础文件名，后续版本写为 `stem.vN.ext`。
- `save_stage_output` 先写文件，再插入 SQLite；两步没有共同事务或恢复日志。
- 删除项目先递归删除工作目录，再逐表删除数据库记录；中途失败可能只完成一侧。
- 导出先覆盖 `final_export.md`，再写 `exports`；无事实门禁，也未绑定正文/标题/证据版本。
- API Key 按 profile id 明文写入应用数据目录的 `secrets.json`；1.0 不得照搬。

## 6. 能力分栏

### 已有且需要保持

- legacy 写作阶段、职责分工、版本指针和事实门禁语义。
- 旧项目 Markdown/manifest 的可读性与回归测试。
- 旧桌面 SQLite、`project.json` 和产物目录的真实迁移依据。
- 基本模型配置、项目创建、阶段生成和 Markdown 导出的历史参考。

### 部分存在但不能直接宣称 1.0 可用

- 模型调用：可发请求，但不是多轮工具循环，也没有持久恢复。
- 桌面项目：可保存阶段产物，但文件/数据库不具备原子一致性。
- 版本：有阶段级自增文件，但没有领域 ArtifactVersion/current pointer/冲突控制。
- 导出：能写 Markdown，但不区分工作备份与正式交付，且绕过严格门禁。
- 设置：能保存模型配置，但凭据存储不满足 1.0 安全要求。

### 尚未实现

- 自主维护的 provider adapter、可恢复 Agent loop、受控材料读取工具。
- append-only 事件、幂等 operation、取消/恢复、重启重放和 unknown outcome 处理。
- 新版 SQLite schema、迁移版本、CAS/锁和原子文件提交。
- DSH 源码移植 UI、Writing Agent brand/bridge/writing-ui，以及同源 Web/桌面壳。
- 工作草稿备份与正式交付双语义、新版 migration dry-run/backup/readback。

### 仍需在实现中验证的选择

- SQLite 的最终 Node 驱动及 Windows 打包兼容性。
- 首个纳入公开支持矩阵的 provider 与能力降级规则。
- DSH 前端的最小可维护依赖闭包。
- DSH Electron 最小壳在本项目 native 依赖和签名环境下的最终可行性。

这些是 M0 ADR/后续竖切面的验证项，不阻止开始开发。

## 7. 迁移边界

1. legacy `articles/<project>/` 和旧桌面数据均只能作为只读来源。
2. 迁移先扫描、报告、空间检查和独立备份，再写新目标；本阶段不执行迁移。
3. API Key 不进入普通迁移报告，不从旧 `secrets.json` 自动搬运；需要用户单独同意并写入安全存储。
4. 旧 `passed` 一律导入为待重新核查；缺失事件历史不得伪造。
5. 旧 UI、CSS 和 Tauri 启动链不进入新产品；旧目录保留到迁移和回退策略完成。

## 8. 基线验证

本次已运行根仓库完整检查、旧桌面 TypeScript 检查和 Web 构建。详细命令、环境、结果和跳过项见 `docs/testing/BASELINE_RESULTS.md`。结论为：当前 legacy 回归通过；旧桌面前端可构建；因本机未安装 Rust/Cargo，旧 Tauri Rust 编译仅标记 `SKIPPED_ENV`，不把它误报为通过或阻断新版 Electron 路线。

## 9. WA-001 完成判据

- [x] 记录真实 HEAD、分支、remote 和未提交内容，且未覆盖用户工作。
- [x] 区分 legacy 与 desktop 的执行链、依赖、SQLite 和目录格式。
- [x] 将已有、部分实现、未实现和待验证能力分栏。
- [x] 明确旧桌面只作数据/历史审计，不列入新版 UI/壳复用目标。
- [x] 对本机旧数据只读取结构和计数，未读取正文或密钥。
