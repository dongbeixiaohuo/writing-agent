# PR 草稿：Writing Agent 独立运行时与桌面 RC

> 本地草稿；未创建远程 PR。

## 关联

- 计划：WA-001–WA-021（WA-018/019/021 外部签收未完成）
- 目标分支：`next/runtime` → `main`
- 发布候选：`1.0.0-rc.5`

## 用户结果

把材料、模型工具调用、稿件版本、局部修改、事实门禁、恢复、迁移和 Windows 桌面分发收进 Writing Agent 自有 runtime。普通用户不需要安装 DSH、Claude Code、Python 或旧 Tauri 应用。

## 主要变化

- Node 24 + `node:sqlite` 的领域/存储/Application Service。
- OpenAI-compatible 与 Anthropic-compatible adapter、系统凭据、预算/取消/恢复。
- 固定 DSH commit 的同源 UI 切片、Writing Agent 品牌/主题/Slot 和真实 Client Bridge。
- 块级版本/锁/冲突、事实门禁、工作备份和带三种排版的 TXT/HTML 正式导出。
- 四步引导建稿、角色化共创检查点、自由文本反馈续跑和基于当前稿的连续修改。
- 主对话优先的信息架构：历史项目可直接恢复对话，当前选中态明确，阶段成果/Markdown/事实阻断/完整稿件在对话内可见，工作台仅承担历史追溯和精细调整。
- legacy manifest/SQLite 的只读迁移、幂等重试和精确回退。
- Electron 44 sandbox 容器、明确展示“移除旧版 → 安装新版”的 NSIS 安装包、异常登记恢复、可读版本页、来源/依赖/校验和与安装卸载测试。

## 来源与许可

复用 DeepSeek Harness 固定 commit `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720` 的已登记 UI 源码和单实例 helper；完整路径、tree/hash、修改边界与 MIT notice 见 `upstream-sources.json` 和 `THIRD_PARTY_NOTICES.md`。不包含上游 runtime host、账户、遥测、更新、插件市场或官方品牌。

## 验证

- runtime 142 项 + migration 15 项；最终数字仍以 PR 当次 CI 为准。
- UI/Bridge/Desktop 单测、production/mock/extension builds 与分发扫描。
- Windows NSIS 安装、打包应用握手、卸载与 SHA-256。
- legacy Python/工作流/插件回归与 production audit。
- 详情：`docs/testing/RC_RESULTS.md`、`WA017_RESULTS.md`、`RELEASE_GATE.md`。

## 未完成/不在本 PR 冒充完成

- 独立干净 Windows 机全旅程。
- 经授权的两个协议真实商业 provider 调用。
- 12 例三组人工盲评和 5 人上手实验。
- 代码签名、维护者签收、tag、Release 和 `latest`。

## Schema 与回退

新 workspace schema 通过逐版备份迁移；旧源只读。出现 RC 问题时不强推、不移动旧 tag，保留 0.11.x 入口，从新 commit 发布下一个 RC。卸载默认不删用户 Workspace。
