# Workflow Contract Repair Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 统一协作写作工作流的读写契约，保留可直接复制粘贴的 `_clean.txt` 终稿产物，并用脚本把关键约束从 prompt 口头层下沉到可验证的工程规则。

**Architecture:** 采用“兼容式 v2 协议”路线：新增机器可读的 workflow manifest 作为唯一协议源，agent prompt 和文档全部对齐到 v2；历史 `articles/**` 不做批量迁移，只通过 alias 和 scope 控制保持可读。新增 `run_manifest.json` 记录当前项目最新正文产物，`auto_clean_hook.py` 优先按显式路径生成 `_clean.txt`，不再只靠“最近修改文件”猜测。

**Tech Stack:** Markdown agent specs、Python 3.11 标准库脚本、PowerShell、root `package.json` 脚本。

---

## 方案决策

### 推荐方案：兼容式 v2 协议 + 显式 run manifest

- **优点**：不需要批量重写 `articles/**` 历史样本；可以先修活跃流程，再上 validator；`_clean.txt` 生成路径明确，稳定性高。
- **缺点**：短期内仓库会同时存在 legacy/v2 两套产物名，需要 validator 做范围控制。

### 备选方案 1：全量迁移历史文章

- **优点**：仓库内只保留一套文件名，视觉上最整齐。
- **缺点**：改动面过大，历史文章、README 示例、现有截图和复盘记录都会受影响；不适合作为第一轮修复。

### 备选方案 2：只修 prompt，不加 manifest/validator

- **优点**：改动快。
- **缺点**：几周后还会再次漂移，无法证明“约束已固化”。

本计划采用**推荐方案**。

## 实施边界

- 本轮不修改 `writing-agent-app/`。
- 本轮不批量迁移 `articles/**` 历史项目，只保证新流程稳定、历史内容可读取。
- `_clean.txt` 继续作为最终可复制粘贴终稿。
- `draft_v*.md` 只放正文，内部备注继续放 `draft_v*_notes.md`。
- validator 只对“活跃协议文件”和“活跃文档”报错；对 `articles/**` 历史样本只给出 legacy 提示，不直接失败。

---

### Task 1: 冻结 v2 协议与兼容策略

**Files:**
- Create: `.claude/workflows/collab_v2.json`
- Modify: `.claude/skills/工作流导演/SKILL.md`
- Create: `docs/WORKFLOW_CONTRACT.md`

**Step 1: 先写协议文件**

在 `.claude/workflows/collab_v2.json` 中定义：

```json
{
  "workflow_version": "collab-v2",
  "final_copy_artifact": "_clean.txt",
  "stages": [
    { "id": "1", "agent": "writing-clarifier", "outputs": ["01_theme.md"] },
    { "id": "1.5", "agent": "position-engine", "inputs": ["01_theme.md"], "outputs": ["01b_position.md"] },
    { "id": "2", "agent": "research-expert", "inputs": ["01_theme.md", "01b_position.md"], "outputs": ["02_scar_tissue.md"] },
    { "id": "3", "agent": "outline-architect", "inputs": ["01_theme.md", "01b_position.md", "02_scar_tissue.md"], "outputs": ["03_outline.md"] },
    { "id": "4", "agent": "empathy-designer", "inputs": ["03_outline.md", "01b_position.md", "02_scar_tissue.md"], "outputs": ["04_share_map.md"] },
    { "id": "5", "agent": "concretizer", "inputs": ["03_outline.md", "04_share_map.md"], "outputs": ["05_concrete_library.md"] },
    { "id": "5.8", "agent": "opening-tournament", "inputs": ["01b_position.md", "02_scar_tissue.md", "04_share_map.md", "05_concrete_library.md"], "outputs": ["05c_opening_hook.md"] },
    { "id": "6", "agent": "writing-executor", "outputs": ["draft_v1.md", "draft_v1_notes.md"] }
  ],
  "legacy_aliases": {
    "02_cases.md": "02_scar_tissue.md",
    "04_empathy_map.md": "04_share_map.md"
  }
}
```

**Step 2: 更新导演说明**

把 `.claude/skills/工作流导演/SKILL.md` 改成引用上面的 manifest，明确：

- 人类可读规则以 `SKILL.md` 为解释层。
- 机器校验以 `.claude/workflows/collab_v2.json` 为准。
- 历史 `articles/**` 可以保留 legacy 产物名，但新流程禁止再写 legacy 名称。

**Step 3: 补一页协议文档**

在 `docs/WORKFLOW_CONTRACT.md` 写清：

- 哪些文件是 canonical artifacts
- 哪些 legacy 名称只用于历史兼容
- `_clean.txt` 是终稿复制出口，不参与正文统计

**Step 4: 验证 JSON 结构**

Run:

```powershell
C:\Program Files\Python311\python.exe -m json.tool .claude\workflows\collab_v2.json > $null
```

Expected: 命令成功退出，无输出错误。

**Step 5: Commit**

```bash
git add .claude/workflows/collab_v2.json .claude/skills/工作流导演/SKILL.md docs/WORKFLOW_CONTRACT.md
git commit -m "docs: add v2 workflow contract manifest"
```

---

### Task 2: 先补 validator，再开始批量改 prompt

**Files:**
- Create: `scripts/validate_workflow.py`
- Create: `tests/test_validate_workflow.py`

**Step 1: 先写失败用例**

`tests/test_validate_workflow.py` 至少覆盖这几类断言：

```python
def test_rejects_legacy_artifacts_in_active_agents():
    ...

def test_allows_legacy_artifacts_under_articles_samples():
    ...

def test_requires_v2_outputs_for_stage_agents():
    ...
```

**Step 2: 先运行，确认失败**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_validate_workflow -v
```

Expected: FAIL，提示 `scripts.validate_workflow` 不存在或断言失败。

**Step 3: 实现最小 validator**

`scripts/validate_workflow.py` 需要支持：

- 读取 `.claude/workflows/collab_v2.json`
- 扫描 `.claude/agents/*.md`
- 扫描 `README.md`、`articles/README.md`、`docs/WORKFLOW_QUICK_REFERENCE.md`、`docs/PROJECT_STRUCTURE.md`
- 对活跃文件发现 `02_cases.md` / `04_empathy_map.md` 报错
- 对 `articles/**` 历史样本只标记 legacy，不作为失败条件
- 支持 `--targets active|docs|all`

**Step 4: 再运行，确认通过**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_validate_workflow -v
```

Expected: PASS。

**Step 5: Commit**

```bash
git add scripts/validate_workflow.py tests/test_validate_workflow.py
git commit -m "test: add workflow contract validator"
```

---

### Task 3: 用 run manifest 接管 clean 终稿的来源

**Files:**
- Create: `scripts/update_run_manifest.py`
- Modify: `scripts/auto_clean_hook.py`
- Create: `tests/test_run_manifest.py`

**Step 1: 先写失败用例**

`tests/test_run_manifest.py` 至少覆盖：

```python
def test_update_run_manifest_writes_latest_body_and_notes():
    ...

def test_hook_prefers_explicit_clean_source_from_manifest():
    ...

def test_hook_ignores_notes_file_even_if_newer():
    ...
```

**Step 2: 先运行，确认失败**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_run_manifest -v
```

Expected: FAIL。

**Step 3: 实现显式产物登记**

`scripts/update_run_manifest.py` 设计成统一入口，示例：

```powershell
C:\Program Files\Python311\python.exe scripts\update_run_manifest.py `
  --project "项目名" `
  --body draft_v2.md `
  --notes draft_v2_notes.md `
  --status reviewed `
  --workflow-version collab-v2
```

写入 `articles/[项目名]/run_manifest.json`，字段至少包括：

```json
{
  "workflow_version": "collab-v2",
  "latest_body_file": "draft_v2.md",
  "latest_notes_file": "draft_v2_notes.md",
  "clean_source_file": "draft_v2.md",
  "status": "reviewed"
}
```

`auto_clean_hook.py` 改成：

1. 优先读取 hook stdin 里显式路径
2. 其次读取最新项目目录里的 `run_manifest.json`
3. 最后才回退到现有“最近修改终稿候选”逻辑

**Step 4: 再运行，确认通过**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_run_manifest -v
```

Expected: PASS。

**Step 5: Commit**

```bash
git add scripts/update_run_manifest.py scripts/auto_clean_hook.py tests/test_run_manifest.py
git commit -m "feat: resolve clean output from explicit run manifest"
```

---

### Task 4: 修正活跃 agent 的读写契约

**Files:**
- Modify: `.claude/agents/outline-architect.md`
- Modify: `.claude/agents/concretizer.md`
- Modify: `.claude/agents/writing-executor.md`
- Modify: `.claude/agents/editor-review.md`
- Modify: `.claude/agents/pre-publish-review.md`
- Modify: `.claude/agents/edit-diff-learner.md`
- Modify: `.claude/agents/humanizer.md`

**Step 1: 先跑 validator，拿到当前失败清单**

Run:

```powershell
C:\Program Files\Python311\python.exe scripts\validate_workflow.py --targets active
```

Expected: FAIL，并列出 `outline-architect.md`、`concretizer.md`、`writing-executor.md` 等 legacy 引用。

**Step 2: 改大纲师与具象化专家**

- `outline-architect.md` 输入改为 `01_theme.md + 01b_position.md + 02_scar_tissue.md`
- `concretizer.md` 把 `04_empathy_map.md` 全部替换为 `04_share_map.md`
- 示例表格、输入规范、摘要模板一并改

**Step 3: 改主笔、主编、发布前评审**

- `writing-executor.md` 强制读取 `05c_opening_hook.md`
- `writing-executor.md` 明确“正文开头必须落入锁定 hook”
- `writing-executor.md`、`editor-review.md`、`pre-publish-review.md` 在保存新版本后都调用 `scripts/update_run_manifest.py`
- `edit-diff-learner.md` 继续排除 `_notes.md`，并可选读取 `run_manifest.json`

**Step 4: 改 humanizer**

- 删除“保存 `_clean.txt` 后再交接”的旧要求
- 不再使用硬编码 `[10/11]` 这类进度条
- 若 humanizer 产出新的最终正文文件，也调用 `scripts/update_run_manifest.py`

**Step 5: 再跑 validator，确认通过**

Run:

```powershell
C:\Program Files\Python311\python.exe scripts\validate_workflow.py --targets active
```

Expected: PASS。

**Step 6: Commit**

```bash
git add .claude/agents/outline-architect.md .claude/agents/concretizer.md .claude/agents/writing-executor.md .claude/agents/editor-review.md .claude/agents/pre-publish-review.md .claude/agents/edit-diff-learner.md .claude/agents/humanizer.md
git commit -m "fix: align active agents with v2 workflow contract"
```

---

### Task 5: 刷新 README、articles 说明和快速参考

**Files:**
- Modify: `README.md`
- Modify: `articles/README.md`
- Modify: `docs/WORKFLOW_QUICK_REFERENCE.md`
- Modify: `docs/PROJECT_STRUCTURE.md`

**Step 1: 先跑 docs 校验**

Run:

```powershell
C:\Program Files\Python311\python.exe scripts\validate_workflow.py --targets docs
```

Expected: FAIL，指出旧文件名、旧 skill 名、过期版本块等问题。

**Step 2: 改 README 主文档**

至少修这几类内容：

- 删除页尾 `v0.2.0` 历史残片
- 核心 skills/agents 名称与当前目录一致
- Stage 说明引用新文件名
- 明确 `_clean.txt` 仍是最终复制出口

**Step 3: 改 `articles/README.md` 与快速参考**

- 用 `01b_position.md`、`02_scar_tissue.md`、`04_share_map.md`、`05c_opening_hook.md`
- 版本文件继续保留 `draft_v*.md` + `draft_v*_notes.md`
- 增加 `run_manifest.json` 说明

**Step 4: 再跑 docs 校验**

Run:

```powershell
C:\Program Files\Python311\python.exe scripts\validate_workflow.py --targets docs
```

Expected: PASS。

**Step 5: Commit**

```bash
git add README.md articles/README.md docs/WORKFLOW_QUICK_REFERENCE.md docs/PROJECT_STRUCTURE.md
git commit -m "docs: refresh workflow documentation for v2"
```

---

### Task 6: 清掉仓库里的本地配置泄漏

**Files:**
- Delete: `.claude/settings.local.json`
- Create: `.claude/settings.example.json`
- Modify: `.gitignore`

**Step 1: 创建示例文件**

`.claude/settings.example.json` 只保留当前仍存在的能力示例，避免继续传播旧 skill 名。

**Step 2: 删除本地文件**

从仓库中移除 `.claude/settings.local.json`，避免把开发者本机权限配置继续提交。

**Step 3: 忽略本地配置**

在 `.gitignore` 增加：

```gitignore
.claude/settings.local.json
```

**Step 4: 验证**

Run:

```powershell
Get-ChildItem .claude\settings*.json
```

Expected: 仅保留 `.claude/settings.example.json` 受版本管理；`settings.local.json` 为本地忽略文件。

**Step 5: Commit**

```bash
git add .claude/settings.example.json .gitignore
git rm --cached .claude/settings.local.json
git commit -m "chore: remove local Claude settings from repo"
```

---

### Task 7: 给 clean/split/hook 脚本补回归测试

**Files:**
- Create: `tests/test_generate_clean.py`
- Create: `tests/test_auto_clean_hook.py`
- Create: `tests/fixtures/sample_draft.md`
- Create: `tests/fixtures/sample_draft_notes.md`

**Step 1: 先写失败用例**

重点断言：

```python
def test_generate_clean_strips_metadata_and_internal_notes():
    ...

def test_generate_clean_stats_report_body_chars_only():
    ...

def test_auto_clean_hook_never_selects_notes_file():
    ...
```

**Step 2: 先运行，确认失败**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_generate_clean tests.test_auto_clean_hook -v
```

Expected: FAIL。

**Step 3: 补脚本细节**

必要时调整：

- `scripts/generate_clean.py`
- `scripts/split_draft_notes.py`
- `scripts/auto_clean_hook.py`

确保测试覆盖的真实场景都通过。

**Step 4: 再运行，确认通过**

Run:

```powershell
C:\Program Files\Python311\python.exe -m unittest tests.test_generate_clean tests.test_auto_clean_hook -v
```

Expected: PASS。

**Step 5: Commit**

```bash
git add tests/test_generate_clean.py tests/test_auto_clean_hook.py tests/fixtures/sample_draft.md tests/fixtures/sample_draft_notes.md scripts/generate_clean.py scripts/split_draft_notes.py scripts/auto_clean_hook.py
git commit -m "test: cover clean generation and hook selection"
```

---

### Task 8: 补基础脚手架并做总体验证

**Files:**
- Modify: `package.json`

**Step 1: 增加最小可用脚本**

在 root `package.json` 增加：

```json
{
  "scripts": {
    "generate-image": "tsx scripts/generate_image.ts",
    "validate:workflow": "python scripts/validate_workflow.py",
    "check:docs": "python scripts/validate_workflow.py --targets docs",
    "test:py": "python -m unittest discover -s tests -p \"test_*.py\"",
    "check:scripts": "python -m py_compile scripts/generate_clean.py scripts/auto_clean_hook.py scripts/split_draft_notes.py scripts/update_run_manifest.py scripts/validate_workflow.py"
  }
}
```

本轮**不强行加 ESLint**，因为 repo 目前没有对应配置，先保证命令真实可执行。

**Step 2: 跑协议校验**

Run:

```powershell
npm run validate:workflow
```

Expected: PASS。

**Step 3: 跑文档校验**

Run:

```powershell
npm run check:docs
```

Expected: PASS。

**Step 4: 跑 Python 回归**

Run:

```powershell
npm run test:py
npm run check:scripts
```

Expected: PASS。

**Step 5: Commit**

```bash
git add package.json
git commit -m "chore: add workflow validation scripts"
```

---

## 总体验收标准

- `scripts/validate_workflow.py --targets active` 返回 PASS
- `scripts/validate_workflow.py --targets docs` 返回 PASS
- `python -m unittest discover -s tests -p "test_*.py"` 返回 PASS
- 新流程所有活跃 agent 不再引用 `02_cases.md`、`04_empathy_map.md`
- 新流程保存正文后会写入 `run_manifest.json`
- `auto_clean_hook.py` 能优先根据显式 `clean_source_file` 生成 `_clean.txt`
- `articles/**` 历史文章仍可保留，不要求批量重命名
- 最终仍保留可直接复制粘贴的 `_clean.txt` 终稿

## 风险与回退

- **风险 1：历史文档仍有旧文件名**
  处理：validator 只对活跃 specs/docs 报错；历史 `articles/**` 仅告警。

- **风险 2：hook 环境拿不到 stdin 事件**
  处理：`auto_clean_hook.py` 保留 manifest -> legacy fallback 双重兜底。

- **风险 3：README 改动面大，与用户现有修改冲突**
  处理：README 和 docs 放在单独 commit，必要时最后再 rebase。

- **风险 4：agent prompt 继续手写 JSON 容易再次漂移**
  处理：统一通过 `scripts/update_run_manifest.py` 写 manifest，不让 prompt 手写结构。

## 推荐执行顺序

1. Task 1-2：先把协议和 validator 立住
2. Task 3：把 `_clean.txt` 产出路径固定下来
3. Task 4-5：再大规模修 agent 和文档
4. Task 6：最后清本地配置泄漏
5. Task 7-8：补测试和 package scripts，做总验收
