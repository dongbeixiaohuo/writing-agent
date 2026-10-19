# RC87 公开测试版发布记录

2026-10-20：维护者授权提交、同步源码并更新客户端公开下载。沿用未签名 Pre-release，不改变原 Claude Code Skill 的 latest，不删除历史版本。安装包只进入 Release 附件，不进入源码历史。

## 源码与构建

- RC81–RC87 成果及 CI 修复经 [PR #26](https://github.com/dongbeixiaohuo/writing-agent/pull/26) 五项必需检查后合并，未绕过 main 分支保护。
- 公开源码固定为 `28650711c745570e35b84a502c94780cebcb3a49`，标签 `desktop-v1.0.0-rc.87` 指向该 SHA。后续下载文档提交不改变构建基线。
- [Windows 候选工作流 39290159875](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/39290159875)从干净 checkout 构建，Runtime、UI、Bridge、Desktop、搜索专项、Python、脚本、工作流、文档/镜像、生产依赖高危门禁、打包及安装/升级检查全部通过。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.87)发布于 2026-10-19 17:17:56 UTC（北京时间 10 月 20 日 01:17:56）；`draft=false`、`prerelease=true`、`make_latest=false`。发布后查询仓库 latest 仍为 Skill `v0.11.0`。

## 附件与本地交付

六个附件：安装包、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json` 和 `upgrade-test.json`。发布前逐一核对 GitHub digest、大小和本地文件，6/6 一致。

- 安装包：`Writing-Agent-Setup-1.0.0-rc.87-x64.exe`，111,604,553 字节。
- SHA-256：`0644f2a3b2930b53c71953bbff6fdd6b1c67e8fac00497493c907f2d00b4ffff`。
- blockmap SHA-256：`319bc77debb32703e3596e63bb8272146b8b88f7afc00e0219ab7297c7354198`。
- 签名：`NotSigned`。发布页披露未知发布者风险，不要求关闭安全防护。
- 本地最终包在 `output/desktop` 根目录，复制后 SHA-256 一致；CI 资产及证据在 `output/desktop/rc87-public-39290159875`。
- 发布后不携带登录凭据，重新下载完整 EXE，大小和 SHA-256 一致，匿名公开下载验证 PASS。

此前本地 RC87 测试包及旧说明、校验和隔离启动证据保留在 `output/desktop/rc87-local-before-public-20261020`：111,604,622 字节，SHA-256 `731a2e1e413eb9716b91f493acf2fb2d851e04a6f498cd2238eed45f93913103`。旧包基于 `ccdc4cd` 加当时未提交修改，与本次公开包不同；不得混用旧哈希。

## 安装、升级与拦截结果

- 全新安装、隔离启动、卸载 PASS；启动 ready、协议24、exitCode=0，隔离启动耗时 1.335 秒。
- RC80 标签重建版 → RC87 原位升级 PASS；升级后 ready、协议24、exitCode=0，隔离启动耗时 1.257 秒。
- 旧安装移除、稳定安装器身份、单一注册项、已有快捷方式保留均 PASS。
- AppData/Workspace 合成哨兵在升级及正常卸载后保留。孤立旧安装恢复为 `NOT_APPLICABLE`，不声称已验证。
- 只在干净 Windows Runner 执行安装/卸载，没有操作维护者日常安装、凭据或真实用户数据库。RC80 由标签重建，不声称与其历史公开包字节相同；合成保留检查不等于所有历史数据库迁移已验证。
- 首轮 CI 在真实 Electron contextBridge 测试发现 `electron/dist` 缺失：Electron 44 不再通过 npm postinstall 下载运行文件。在桌面 PR 和候选工作流中显式执行锁定依赖的 `electron/install.js`，新增回归先失败再通过，未删除真实运行测试。Windows 插件隔离安装超时重试通过，未放宽门禁。
- 生产依赖高危审计通过，仍有 3 low / 4 moderate；全依赖安装日志另有开发依赖告警，不将生产审计结果表述为全仓库零漏洞。

## 范围与边界

本版包含轻量启发对话、从聊天创建项目、纸感主题，以及模型切换、确认恢复、导出隔离和迁移缺口修复。功能行为及限制见[桌面/Skill 对照](../DESKTOP_SKILL_COMPARISON.md)、[迁移审计后调整](../implementation/RC80_AUDIT_FOLLOWUP.md)与[启发式对话记录](../implementation/2026-10-16-conversation-ideation.md)。

自动回归和安装器验证不等于真实 MiniMax 耗时/文章质量、完整原生桌面旅程、正常 GPU 或所有服务商已验收。系统复制粘贴偶发异常不宣称已解决。事实核查不是学术查证保证，模拟读者不是真实用户研究，网页登录/验证码/付费墙不绕过。

升级前备份并退出旧客户端，优先默认本地安装目录。当前没有自动更新，不保证新库可被旧版读取；回退需兼容备份。反馈先脱敏，不上传 Key、私人数据库或客户材料。
