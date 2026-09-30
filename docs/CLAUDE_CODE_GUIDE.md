# Claude Code Skill / 插件使用指南

这是 Claude Code 入口，不是桌面客户端安装说明。桌面用户见[桌面快速开始](QUICKSTART_1_0.md)。Skill 与桌面仍在同一仓库维护，当前 Skill 版本线为 v0.11.x。

## 环境

- 已安装并可使用的 Claude Code。
- Node.js 18.17+、Python 3.11+；若同时开发新桌面运行时，按仓库 CI 使用 Node.js 24.18.0。
- 可用的 Claude Code 模型访问配置；订阅或第三方 API 是否可用，以账户与服务商当前规则为准。
- 插件首次安装依赖需要联网访问 npm；不要把桌面“设置 → 模型”的配置当成 Claude Code 配置。

## 方式一：安装插件

在终端执行：

```sh
claude plugin marketplace add dongbeixiaohuo/writing-agent
claude plugin install writing-agent@writing-agent-marketplace
```

在你准备用来写作的目录启动 `claude`；若会话已打开，重启或执行 `/reload-plugins`。用自然语言提出写作需求，例如“想写一篇关于工作节奏的文章，先帮我讨论方向”。

插件通过工作区自举补充缺失的文章、风格和工作流目录，不覆盖已有同名内容。运行时与 Node 依赖在插件的数据目录准备，而不是要求你手工复制某一个 Skill 文件。

更新已有插件：

```sh
claude plugin marketplace update writing-agent-marketplace
claude plugin update writing-agent@writing-agent-marketplace
```

更新前备份工作区；已有工作流不会因“只补缺失文件”自动覆盖，跨版本升级事项须阅读对应 Release。不要把旧事实核查通过结果直接当作新版通过。

## 方式二：克隆源码使用

```sh
git clone https://github.com/dongbeixiaohuo/writing-agent.git
cd writing-agent
npm ci
claude
```

需在仓库根目录启动 Claude Code，才能使用项目级 `.claude/` 配置。这种方式适合查阅样本、修改工作流或参与开发；普通桌面用户无需克隆源码。

## 两个边界

1. `claude-runtime/` 是 Skill 运行时唯一源，`.claude/` 与 `plugins/writing-agent/` 是同步交付入口；贡献修改后执行 `npm run sync:claude-runtime` 和 `npm run check:claude-runtime`，只提交预期变更。
2. Skill 的 `articles/` 工作区与桌面的 SQLite 工作区不是同一个存储；请按[迁移指南](implementation/LEGACY_MIGRATION_GUIDE.md)处理，不直接覆盖或混用。

[完整历史教程](launch/LEGACY_README_V0_11.md)保留过去的详细安装与排障过程，其中模型名称、价格和旧桌面状态是历史记录，不代表当前保证。[工作流契约](WORKFLOW_CONTRACT.md)说明当前 Skill 约束。
