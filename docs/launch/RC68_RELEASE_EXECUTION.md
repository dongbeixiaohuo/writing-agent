# RC68 公开测试版发布记录

2026-10-04：维护者授权提交、同步远端和更新公开安装包，并指定本地安装包统一交付到 `output/desktop` 根目录。沿用未签名 Pre-release，不改变原 Claude Code Skill 的 latest，不删除历史版本。

## 源码与构建

- 产品提交 `fcf7042def280ab44240248bd598d233b6b4ed61`，经 [PR #20](https://github.com/dongbeixiaohuo/writing-agent/pull/20) 的五项必需检查后合并，未绕过分支保护。
- 首次候选使用合并提交 `500e4d90c1b50320ba8a5ab74f5b844261589d23`，因下述升级测试契约失配停止发布；不将其作为最终公开产物。
- 升级校验修正经 PR #21 必需检查后合并，新候选锁定 `23f2c23c9075b3b0225c02667b6146710d2f56b2`，执行 [Windows 候选工作流 37141995824](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/37141995824)。
- 最终工作流全部通过，覆盖 Runtime / UI / Bridge / Desktop / 搜索专项、Python、脚本、文档镜像、生产依赖审计与打包。桌面标签 `desktop-v1.0.0-rc.68` 固定指向该 SHA。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.68) 于 2026-10-03 18:06:59 UTC（北京时间 10 月 4 日 02:06:59）发布，`draft=false`、`prerelease=true`，指定 `make_latest=false`。首页入口在公开附件可下载后更新。
- 发布后重新查询仓库 `releases/latest`，仍为原版 Skill 的 `v0.11.0`。

## 公开附件与本地交付

六个附件：安装包、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json` 和 `upgrade-test.json`。草稿阶段逐一核对 GitHub digest、大小与本地产物，6/6 一致。公开后使用不携带登录凭据的下载请求重新获取安装包，SHA-256 一致。

- 安装包：`Writing-Agent-Setup-1.0.0-rc.68-x64.exe`。
- 大小：111,554,625 字节。
- SHA-256：`5323fbecf81b6537948ad02767d360ea8b9a8da9f015cfd5354984fb2eada858`。
- 签名：`NotSigned`，发布页说明未知发布者风险，不要求关闭安全防护。
- 最终本地交付：`output/desktop/Writing-Agent-Setup-1.0.0-rc.68-x64.exe`，复制后再次校验一致。
- 公开产物及验证证据留档：`output/desktop/release-1.0.0-rc.68`。此前本地测试包保留在 `output/desktop/rc68-build`，没有删除旧测试证据或历史安装包。

## 安装与升级结果

- 全新安装、启动、卸载均 PASS，启动握手 protocolVersion=22、exitCode=0。
- RC63 → RC68 原位升级 PASS，升级后握手 protocolVersion=22、exitCode=0。
- 旧安装移除、安装器身份稳定、单一注册项、已有快捷方式保留均 PASS。
- AppData 与 Workspace 合成哨兵在升级及正常卸载后保留，均 PASS。未执行孤立安装记录恢复分支，该项为 `NOT_APPLICABLE`，不据此声称已验证。

## 发布前拦截与修正

重新执行完整回归时，发现作者对话的上下文投影函数尚未接到实际入口，完整核查详情读取工具也未注册。三项原测试按原断言复现失败；修复后通过，未放宽确认、版本和事实门禁。完整说明见[跨 Agent 上下文优化](../testing/2026-10-04-agent-context-optimization.md)。

因此没有上传上一轮本地 RC68 测试包，而是从修正后的合并 SHA 重建。旧本地包留在 `output/desktop/rc68-build`，SHA-256 为 `dee74774e96f68043c4376866227ff08f2f95b12c74d99c44bf74497c195a9cf`；不能使用这个旧校验值核对公开包。

首次[候选工作流 37140506833](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/37140506833)通过全部 Runtime / UI / Bridge / Desktop / 搜索 / Python / 文档 / 依赖审计与单独安装、启动、卸载，但在 RC63 升级后的启动握手校验失败。升级测试脚本的默认协议仍为 21，而当前桥接及单独启动测试已为 22。[修正 PR #21](https://github.com/dongbeixiaohuo/writing-agent/pull/21)只对齐升级测试契约并改善失败时的预期/实际值提示；新增与源码协议常量绑定的回归先失败、修正后通过，7 项分发测试通过。没有移除协议断言或绕过升级验证。

## 范围与边界

- 安装与升级测试仅在干净 Windows Runner 运行，不覆盖维护者日常安装，不操作真实用户工作区。
- 升级检查使用 RC63 标签重新构建的旧版，不声称旧包与当时公开附件字节完全相同；数据保留验证为安装器级合成哨兵，不代表所有历史数据库迁移。
- RC68 的真实 MiniMax 端到端耗时、Token、按需补读次数及文章质量仍需代表性对照；离线上下文字符缩减不等于同比例耗时或费用收益。
- 本地测试包从 OneDrive 路径启动曾发生 GPU 崩溃，同字节放在本机 TEMP 后启动握手通过；不宣称同步目录兼容性已修复。建议默认本地安装位置，不通过关闭 sandbox 或安全防护绕过。
- 原生桌面完整人工旅程、全部供应商和历史项目组合尚未穷举；保留重要稿件备份，当前无自动更新，不保证新版数据库能被旧版打开。

反馈请提供版本、系统、模型协议、复现步骤和已自行检查的脱敏记录，不上传 Key、完整私人数据库或客户材料。安装包只进入 Release 附件，不进入源码历史；无关工作区文件保留不提交。
