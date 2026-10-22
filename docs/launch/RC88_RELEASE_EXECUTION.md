# RC88 公开测试版发布记录

2026-10-23：维护者授权同步远端源码并更新客户端公开下载。沿用未签名 Pre-release，不改变原 Claude Code Skill 的 latest，不删除历史版本。安装包只进入 Release 附件，不进入源码历史。

## 源码与构建

- DeepSeek 搜索与流程可靠性成果经 [PR #28](https://github.com/dongbeixiaohuo/writing-agent/pull/28) 的五项必需检查后正常合并，未绕过 main 分支保护。
- 公开源码固定为 `a2324fd690c1fb8e3cfdfa70eee18ca4a31621d5`，标签 `desktop-v1.0.0-rc.88`；后续下载文档提交不改变构建基线。
- [Windows 候选工作流 39816908062](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/39816908062)第二次执行全部通过：Runtime、UI、Bridge、Desktop、搜索专项、Python、脚本、工作流、文档/镜像、生产依赖高危门禁、打包及安装/升级。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.88)发布于 2026-10-22 17:21:07 UTC（北京时间 10 月 23 日 01:21:07）；`draft=false`、`prerelease=true`，发布时显式 `make_latest=false`。发布后读回标签 SHA 与构建一致，仓库 latest 仍为 Skill `v0.11.0`。

## 附件与本地交付

六个附件：安装包、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json` 和 `upgrade-test.json`。发布前逐一核对 GitHub digest、大小和本地 CI 文件，6/6 一致。

- 安装包：`Writing-Agent-Setup-1.0.0-rc.88-x64.exe`，111,607,492 字节。
- SHA-256：`280dc0cde3b3be566586ce87b16818e13d640c417ee4d1dc82a960d36cfe80fe`。
- blockmap SHA-256：`ba2fe7052827d2b57568c5a31b6fdcae94c820c92a41f761eb5605a54a179a0c`。
- 签名：`NotSigned`。发布页披露未知发布者风险，不要求关闭安全防护。
- 本地最终包位于 `output/desktop` 根目录，复制后 SHA-256 一致；六个 CI 附件在 `output/desktop/rc88-public-39816908062`。
- 公开安装包无登录完整下载验证 PASS：`curl -q` 禁用本机 curl 配置，不携带登录凭据；首次连接在 12,664,113 字节处中断，经断点续传后完整文件为 111,607,492 字节，SHA-256 与 CI / Release 一致。未将部分下载当作成功，不以远端 digest 或链接存在替代完整下载验证。

此前基于 `0cb688b7d08d613fd55828abd743d3e20bd9d631` 的本地 RC88 测试包保留在 `output/desktop/rc88-local-before-public-20261023`，111,607,641 字节，SHA-256 `84358471a08941e8bd1aeac18a7e3329bbfd35894fcf4dd68fe4b5b5f1298950`。其旧说明、校验和一并保留，原根目录 RC87 通用元数据保留在该目录的 `root-rc87-metadata/`，不混作 RC88 证据。`rc88-build/` 的本地解包及两种路径 smoke 记录不变。旧本地测试包与新公开包字节不同，不能混用哈希；RC87 公开包与历史下载仍保留。

## 安装、升级与拦截结果

- 全新安装、隔离启动、卸载 PASS；启动 ready、协议 24、exitCode=0，隔离启动耗时 1.314 秒。
- RC87 标签重建版 → RC88 原位升级 PASS；升级后 ready、协议 24、exitCode=0，隔离启动耗时 3.524 秒。
- 旧安装移除、稳定安装器身份、单一注册项、已有快捷方式保留均 PASS。
- AppData / Workspace 合成哨兵在升级和正常卸载后保留。孤立旧安装恢复为 `NOT_APPLICABLE`，不声称已验证。
- 只在干净 Windows Runner 执行安装/卸载，没有操作维护者日常安装、凭据或真实数据库。RC87 从固定标签重建，不声称与其历史公开包字节相同；合成保留检查不代表所有历史数据库迁移已穷举。
- 首次候选执行在 `clipboard-diagnostics.test.ts` 的无访问探针模式触及 25 秒 PowerShell 进程超时，桌面测试 81/82 通过；同轮带探针模式及其他 PowerShell 辅助测试通过，其中校验和辅助脚本也明显偏慢。未改代码、未放宽超时，同一提交重新完整执行通过；本地相关专项 12/12 通过。证据支持环境或时序抖动的怀疑，但具体 Runner 根因未确定，首次失败保留在工作流历史中。
- 生产依赖高危门禁通过，不将其表述为全仓库零漏洞。Actions 的 Node 20 弃用提醒仍存在，运行时已由平台使用 Node 24；不把警告写成零警告。

## 范围与边界

本版新增默认关闭、独立 Key 的 DeepSeek 搜索；仅取最多五条摘要，不额外调用付费 Fetch。启用后按 DeepSeek → Parallel → Tavily 顺序，只访问已启用服务，仅失败时回退。连接验证会发送固定公开查询并可能产生服务费用。实现边界见 [DeepSeek 搜索与流程可靠性](../implementation/2026-10-22-deepseek-flow-reliability.md)。

同业务状态重复读取先纠正再有界暂停，正常分页/保存不误计为重复；过长或无效 Retry-After 转为可恢复提示，有效建议时间前不向同服务/模型提前重发，需用户主动恢复。来源快照只在当前工具实例、同 run / 正文 / 证据版本及仍获授权时复用，取消、开关与网络安全检查保留。作者确认、版本绑定、标题选择及轻量事实核查门禁不删除。

DeepSeek 本次使用合成 transport，没有执行真实付费搜索、真实模型完整写作或文章质量/耗时测量。历史 Tavily / Parallel 实测不能替代 DeepSeek 验收。安装与升级 smoke 关闭硬件加速，不证明正常 GPU 或完整原生人工旅程。此前本地同字节 RC88 从 OneDrive 解包目录启动发生 GPU 子进程异常，复制至本机 TEMP 后握手通过，具体原因未确定；两份记录分别保留，不承诺云同步程序目录兼容。

系统剪贴板偶发异常不宣称已解决。轻量事实核查不是论文查证保证，模拟读者不是真实用户调研，登录墙/验证码/付费墙不绕过。所有服务商、历史项目和 Windows 环境尚未穷举。

升级前备份工作区并完全退出旧客户端，优先默认本地安装目录。当前没有自动更新，不保证新数据库可直接降级；回退需兼容备份。反馈请脱敏，不上传 Key、私人数据库或客户材料。
