# Writing Agent 1.0 桌面版快速开始

当前状态：`BLOCKED_CORE_WORKFLOW`。已撤回 rc.6 最终用户验收就绪结论；以下安装步骤仅用于历史候选复现，不代表修订后的核心协作能力已交付。详见 [CR-002](../writing-agent-1.0-prd-v1.1-dsh-ui/docs/implementation/CR002_INTERACTIVE_COLLABORATION.md)。源码协议正在升级到 v18，现有 rc.6 仍为 v17，未重新打包或安装。正式下载地址仍只会在维护者批准后的 GitHub Release 中出现。

## 普通用户

### 1. 安装

本地验收安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.6-x64.exe`。安装前用同目录 `SHA256SUMS.txt` 核对 SHA-256 `11bfd315eeaca79ac548ac2cfc47cea5028341bce901ff6397a9d726e00531fa`。该包为 Windows x64 unsigned 候选，已完成协议 v17 打包后启动握手和零会话历史项目/删除入口隔离验收；独立干净 Windows 机仍待最终验收。

已经安装 rc.1–rc.5 时先关闭正在运行的 Writing Agent，不要手工卸载，再直接运行 rc.6 安装包。确认升级后，进度页应依次显示“步骤 1/2：正在移除旧版本”和“步骤 2/2：正在安装 Writing Agent 1.0.0-rc.6”；旧版移除成功前不会进入新版覆盖。若 Windows 的旧卸载登记意外缺失，安装器会从桌面或开始菜单快捷方式找回原安装位置，并显示“旧安装记录不完整”。该升级机制已用 rc.4 → rc.5 的正常/缺失登记两条路径实测；rc.5 → rc.6 的安装包级原位升级留给本轮最终用户验收，以避免自动测试关闭用户当前正在运行的软件。升级应保留 `%APPDATA%\Writing Agent`、`%USERPROFILE%\Documents\Writing Agent\Workspace` 和 Windows Credential Manager 中的模型 Key。

### 2. 配置模型

首次打开后进入“模型设置”，选择协议：

- OpenAI-compatible；或
- Anthropic-compatible。

填写服务类型、HTTPS API 地址、模型名称和 API Key；配置名称与工具能力在“高级设置”中。API Key 保存到 Windows Credential Manager；本地 `provider.json` 只记录凭据引用，不回显 Key。HTTP 地址默认拒绝。

点击“保存并验证连接”。应用会发出一条最小真实请求，分别检查鉴权、模型 ID、流式响应和工具调用，并给出可操作的失败原因；这可能产生极少量模型费用。当前候选已用 Anthropic-compatible MiniMax-M3 完成真实连接、Quick/Deep 工作流和事实重查；其他模型及 OpenAI-compatible 商业端点仍以 Release 实测矩阵为准。

### 3. 创建第一篇项目

1. 点击“创建第一篇项目”。
2. 按“选题策划 → 读者研究 → 创作导演 → 资料研究”逐步回答；默认是 Deep + 逐步共创，可主动改成快速或连续推进。
3. 添加一份或多份粘贴文本、本地 TXT/Markdown 或带 HTTPS 来源的网页文本快照，并标记材料角色。
4. 检查系统展示的完整简报；必要时修改，明确确认后再发送写作要求。
5. 在对话区查看真实阶段进度和角色交接；提纲、初稿和读者审校的成果会自动展开并渲染，无需再点一次或辨认 Markdown 符号。
6. 成稿后可直接发送“压缩到 3000 字”“开头更直接”等要求；系统会先读当前保存稿件，再基于它修改。
7. 事实阻断、失效或错误必须直接出现在主对话；按“查看并处理”才会直达细节。“稿件与版本”主要用于材料/过程、三类审校、局部差异、锁定和历史版本等追溯或精调。
8. 内容变化会让旧核查自动失效；重新核查通过后才能导出正式 TXT，或选择清爽、杂志、紧凑三种 HTML 排版。

已有项目时，点击左侧项目名会恢复该项目当前、可继续或最新会话；左侧应同时显示“当前项目”与“正在查看”，不需要通过顶部小字猜测上下文。若旧项目还没有任何会话，点击项目也必须选中它，并显示“在‘项目名’中开始新对话”和可用输入框；发送第一条消息时才在该项目下创建会话。点击左上“新建对话”可在当前项目中明确开启新对话，不会误用上一个项目的会话。

每个项目右侧都有删除入口。删除会永久移除该项目的材料、对话、草稿、版本、事实核查和运行记录，必须输入完整项目名后按钮才会启用；正式项目建议先在“设置 → 数据与诊断”创建整库备份。

工作备份与正式交付不同：未通过事实门禁时可保存工作备份，但 TXT/HTML 正式交付会被拒绝。

### 4. 数据位置

- 项目数据：`%USERPROFILE%\Documents\Writing Agent\Workspace`
- 应用设置：`%APPDATA%\Writing Agent`
- API Key：Windows Credential Manager

卸载默认不删除用户项目。迁移或重装前建议在“设置 → 数据与诊断”创建整库备份。恢复时应用会先校验选定备份、自动保存当前工作区的安全副本，再替换并重启；恢复不会合并两个工作区，Windows Credential Manager 中的 Key 不受影响。

## 旧版用户迁移

旧 `articles/<project>/` 和 0.1.0 桌面 SQLite 只能通过 `migrate scan → apply → readback` 流程导入；旧源保持只读，旧 `passed` 不会升级为新版核查通过。具体见 [Legacy 迁移指南](implementation/LEGACY_MIGRATION_GUIDE.md)。

## 开发者本地验证

需要 Node 24.15+ 构建新 runtime/desktop；旧根工作流仍保留 Node 18.17+ 兼容范围。

```powershell
npm ci
npm run check:runtime
npm run check:ui
npm run check:desktop
npm run desktop:package
& apps/desktop/scripts/test_desktop_installer.ps1 `
  -InstallerPath 'output/desktop/Writing-Agent-Setup-1.0.0-rc.6-x64.exe'
```

完整本地 RC 检查：

```powershell
& apps/desktop/scripts/run_rc_validation.ps1 `
  -InstallerPath 'output/desktop/Writing-Agent-Setup-1.0.0-rc.6-x64.exe' `
  -PreviousInstallerPath 'output/desktop/Writing-Agent-Setup-1.0.0-rc.5-x64.exe'
```

这些命令不会自动调用真实模型或发布 Release。
