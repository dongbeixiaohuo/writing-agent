# Desktop Release Preparation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for task-by-task review; this is release preparation, not authorization to publish. Steps below track the existing dirty checkout without resetting or relocating user changes.

**Goal:** 准备可审查的桌面/Skill 双入口文档、提交范围和当前发布门禁，不自动推送、合并、打 Tag、创建远程 Release 或安装覆盖用户软件。

**Architecture:** 一个仓库保留桌面源码与 Claude Skill；桌面安装包只进 Release Assets，下载入口绑定桌面 Tag。发布证据区分源码检查、打包检查、真实模型、干净机与用户签收，不复用历史 rc.6 签收作为当前结论。

**Tech Stack:** Markdown、Git、现有 Node/Python 检查、Electron/NSIS。

## 1. 提交范围和风险核对

- [x] 读取 `git status --short`、`git diff --stat`、现有发布工作流；保留所有已有改动。
- [x] 在 `docs/launch/RELEASE_PREPARATION_2026_09_30.md` 分类记录产品变更、待审查测试脚本、明确排除的本地资料；不自动暂存。
- [x] 核对 rc.57 GPU 启动失败和搜索真实验收边界，不能删除未解决的阻塞。

## 2. 用户入口文档

- [x] 将现有完整 README 归档到 `docs/launch/LEGACY_README_V0_11.md`，修正相对链接，保留历史教程。
- [x] 重写 `README.md`：桌面与 Skill 双入口、真实发布状态、能力/差异、隐私费用、贡献入口；不生成未发布下载链接。
- [x] 更新 `docs/QUICKSTART_1_0.md`，新增 `docs/CLAUDE_CODE_GUIDE.md` 与 `docs/DESKTOP_SKILL_COMPARISON.md`；修正数据目录、搜索和升级说明。
- [x] 更新 `.gitignore` 的文档白名单、`docs/PROJECT_STRUCTURE.md`，保持生成物不入 Git。

## 3. 发布操作与草稿

- [x] 保留历史发布门禁到 `docs/testing/RELEASE_GATE_RC6_HISTORY.md`，更新 `docs/testing/RELEASE_GATE.md` 为当前证据清单并保持 CLOSED。
- [x] 新建 `docs/launch/DESKTOP_RELEASE_RUNBOOK.md`：精确提交、PR/CI、最终 SHA 构建、仅该版本校验值、Tag/Assets/下载链接复核、回退和维护者批准步骤。
- [x] 更新 `docs/launch/PR_DRAFT_1_0.md`，增加本地 Release 模板 `docs/launch/DESKTOP_RELEASE_DRAFT.md`；未创建远端对象。

## 4. 验证和交接

- [x] 对新增/修改入口文档检查 Markdown 相对文件链接；`git diff --check` 必须成功。
- [x] 执行 `npm run check:docs`、`npm run check:claude-runtime`、`npm run test:fact-search`，如失败按真实原因记录，不掩盖。
- [x] 运行安全的隔离成品 smoke（不执行安装器、不关闭旧软件），保留实际结果；不把本机 smoke 当干净机测试。
- [x] 报告已完成项与待签收项，最终提交/公开发布仍待维护者确认。

工作拆分：主 Agent 维护文档与汇总；一个只读审查子 Agent（gpt-5.6-sol / medium）独立核对工作流测试覆盖、打包与 GPU 证据，避免同文件竞争。无用量估算。
