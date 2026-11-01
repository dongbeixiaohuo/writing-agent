# RC93 公开测试版发布记录

2026-11-01：维护者授权提交、同步远端和更新安装包。桌面继续使用未签名 Pre-release，保留 Skill `v0.11.0` latest 与历史 Release。安装包仅作为 Release 附件，不进入源码历史。

## 源码与构建

- [PR #30](https://github.com/dongbeixiaohuo/writing-agent/pull/30) 的 Windows/Linux 五项必需检查全部通过后正常合并，没有绕过分支保护。
- 公开包固定源码 `eedcf922a88626a043e3cb01e4f9f134f0ae0046`，标签 `desktop-v1.0.0-rc.93`；后续下载文档提交不改变构建基线。
- [Windows 候选工作流 41267767830](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/41267767830) 一次完整通过：Runtime、UI、Bridge、Desktop、搜索专项、Python、脚本、文档、Skill 镜像、生产依赖高危审计、打包、安装及升级。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.93) 发布于 2026-11-01 03:30:37 UTC（北京时间 11:30:37）；`draft=false`、`prerelease=true`，显式 `make_latest=false`。读回标签与构建 SHA 一致，Skill latest 仍为 `v0.11.0`。

## 安装包与下载校验

- 安装包 `Writing-Agent-Setup-1.0.0-rc.93-x64.exe`，111,739,329 字节，未签名。
- SHA-256：`d4aed3a1bf826d32a350d45ffebb44842a4f5c6aec96267809b25c21cb0062ed`。
- blockmap SHA-256：`7fe4ffeec94376837ded61bde782b1d18560b14e3d9728c33cade9078c89c9f1`。
- 六个附件为 EXE、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json`、`upgrade-test.json`；GitHub digest、大小与本地 CI 产物 6/6 一致。
- `curl -q` 无登录完整下载公开 EXE 后，大小与 SHA-256 再次一致；没有以链接存在或远端 digest 代替完整下载。
- 最终公开包位于本地 `output/desktop` 根目录；CI 附件与安装证据在 `output/desktop/rc93-public-41267767830`。
- 此前本地 RC93 测试包及旧说明、校验值保留在 `output/desktop/rc93-before-public-release`。旧包 111,726,538 字节，SHA-256 `490365b87ecd74c8c8cedf2ab00519b99835a14959ebe0a676ad2b10aa11caa0`，不得与公开包混用。

## 安装、升级与发布前修复

- 全新安装、隔离启动、卸载 PASS；启动 ready、协议 24、exitCode=0，耗时 2.071 秒，stderr 为空。
- RC88 固定标签重建包 → RC93 原位升级 PASS；升级后 ready、协议 24、exitCode=0，启动耗时 1.425 秒。
- 稳定安装器身份、单一注册项、旧安装移除、已有快捷方式保留、AppData/Workspace 合成哨兵在升级和卸载后保留均 PASS。孤立旧安装恢复为 `NOT_APPLICABLE`。
- 升级 smoke 的退出阶段记录了 `No handler registered for writing-agent:bridge:v7`，原始 stderr 保留在附件中；握手和退出码通过，不表述为零警告或完整人工体验通过。
- 初次 PR 检查拦截了跨目录类型导入、降版测试夹具残留新表、链接输入示例触发界面边界检查。修复为自包含桥接数据类型、真实旧表结构夹具和纯说明占位文案，再完整重验。
- 更新 DOMPurify、Undici、Zod 等生产依赖；Zod 4 的 record 键类型显式声明，OpenAI SDK 及图片脚本代理调用同步适配。新增本地模拟服务器的直连和代理图片响应回归，不访问真实付费接口；Skill 镜像及 lockfile 同步更新。
- 生产依赖高危门禁通过，仍有 KaTeX/Mermaid 低危报告，不宣称零漏洞。现有 Actions/构建警告保留，不关闭门禁。

## 功能与验证边界

RC90–RC93 的风格库进入公开版：粘贴文字、批量文档、批量网页/公众号，联合分析最多 10 份；输入区按名称下拉选择，后台保存项目独立快照。风格包包含实际样文统计、表达模式和可选原文片段，按写作阶段有界注入，不向事实核查或模拟读者注入风格。可选试写提供统计对照；无效可选例句不阻断描述保存。包含紧凑对话导航。

实现与专项验证见[风格库](../implementation/2026-10-30-style-library.md)和[风格包实施记录](../implementation/2026-10-31-style-package-plan.md)。本次没有新提示词的真实模型作者风格相似度、长文耗时或真实用户文章端到端验收；统计不等于相似度评分，片段重复提示不等于完整查重。

安装/升级只在干净 Windows Runner 中执行，使用合成保留数据；RC88 从固定标签重建，不声称与历史公开 EXE 字节一致。Smoke 关闭硬件加速，不证明正常 GPU 或所有历史数据库迁移通过。系统剪贴板偶发异常不宣称解决。

升级前备份工作区并完全退出旧客户端，优先默认本地安装目录。没有自动更新，不保证新数据库直接降级；回退需兼容备份。网页验证/登录墙不绕过，样文不作为新文章事实或作者亲历来源。
