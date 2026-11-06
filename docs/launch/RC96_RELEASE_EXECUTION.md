# RC96 公开测试版发布记录

2026-11-07：维护者授权提交、同步远端和更新安装包。桌面继续使用未签名 Pre-release，保留 Skill `v0.11.0` latest 与历史 Release。安装包作为 Release 附件，不进入源码历史。

## 源码与构建

- [PR #32](https://github.com/dongbeixiaohuo/writing-agent/pull/32) 的 Windows/Linux 五项必需检查全部通过后正常合并，没有绕过分支保护。
- 功能提交 `0e71332`，兼容修复提交 `e43dd1a`，来源清单修正提交 `b93bbcf`。初次 CI 拦截了两份供应商派生文件的旧哈希；更新实际 SHA-256 后，来源校验及完整检查通过，未删除检查。
- 公开包固定源码 `12ac1ac48d1223bef9680223abfd4ed6479bfa11`，标签 `desktop-v1.0.0-rc.96`；后续下载文档提交不改变构建基线。
- [Windows 候选工作流 42262638445](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/42262638445) 完整通过：Runtime、UI、Bridge、Desktop、搜索专项、Python、脚本、文档、Skill 镜像、生产依赖高危审计、打包、安装及升级。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.96) 发布于 2026-11-06 17:48:33 UTC（北京时间 2026-11-07 01:48:33）；`draft=false`、`prerelease=true`，显式 `make_latest=false`。读回远端标签与构建 SHA 一致，Skill latest 仍为 `v0.11.0`。

## 安装包与下载校验

- 安装包 `Writing-Agent-Setup-1.0.0-rc.96-x64.exe`，111,742,963 字节，未签名。
- SHA-256：`f475239fa3efff1fb8dfd5cf4fe731548bb26b883b2f8c5b03c7760b42b994fc`。
- blockmap SHA-256：`ee12745fe81d2386ce140f2675ce8887bb173f29816c60cde45c2f021c370a78`。
- 六个附件为 EXE、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json`、`upgrade-test.json`；发布前 GitHub digest、大小与本地 CI 产物 6/6 一致。构建清单、两份安装证据中的版本与安装包哈希一致。
- `curl -q` 无登录完整下载公开 EXE 后，大小与 SHA-256 再次一致；没有以链接存在或远端 digest 代替完整下载。
- 最终公开 EXE 位于本地 `output/desktop` 根目录；六份 CI 附件与安装证据在 `output/desktop/rc96-public-42262638445`。旧版本包和本地资料未清理。

## 安装、升级与功能变化

- 全新安装、隔离启动、卸载 PASS；启动 ready、协议 24、exitCode=0，耗时 1.138 秒。
- RC93 固定标签重建包 → RC96 原位升级 PASS；升级后 ready、协议 24、exitCode=0，启动耗时 0.857 秒。
- 稳定安装器身份、单一注册项、旧安装移除、已有快捷方式保留、AppData/Workspace 合成哨兵在升级和卸载后保留均 PASS。孤立旧安装恢复为 `NOT_APPLICABLE`。
- 两次 smoke 的退出阶段均记录 `No handler registered for writing-agent:bridge:v7`；原始 stderr 保留在附件，握手与退出码通过，不表述为零警告。
- 三组角色模型可独立选择已验证模型，默认跟随同一模型；详见[三组模型说明](../implementation/2026-11-06-model-groups.md)。显式绑定失效时给出提示，不自动换用其他模型。
- 模型 API 支持 HTTP/HTTPS，新增 Magpie 网关预设。仅对 Magpie 中明确的 DeepSeek 路由设置 `reasoning_effort: "none"`，覆盖连接验证与正式请求，尊重显式请求配置，不影响其他模型或不透明的分组别名。
- 连接测试输出额度从 64 提升至 2048 token，仍要求完整流和有效工具调用，不以收到文本替代能力验证；修复重复验证后的旧成功提示残留，结果按供应商与模型分别显示。
- `check:runtime` 修正连接测试文件路径，`test:ui` 纳入设置界面回归。生产依赖高危门禁通过，仍有两项低危报告，不宣称零漏洞。

## 验证边界

安装/升级在干净 Windows Runner 中执行，保留数据使用合成哨兵；RC93 从固定标签重建，不声称与历史公开 EXE 字节一致。Smoke 关闭硬件加速，不证明正常 GPU、所有历史数据库迁移或完整人工写作旅程通过。

Magpie/DeepSeek 新增兼容回归使用受控 HTTP 服务，未调用真实付费上游；模型响应耗时、输出质量和真实网关配置仍需实际使用验证。连接验证通过不等于整篇写作可靠性保证。系统剪贴板偶发异常不宣称解决。

升级前备份工作区并完全退出旧客户端，优先默认本地安装目录。没有自动更新，不保证新数据库直接降级；回退需兼容备份。
