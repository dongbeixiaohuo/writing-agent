# RC98 公开测试版发布记录

2026-11-09：维护者授权修复、提交、同步远端并更新安装包。桌面继续使用未签名 Pre-release，保留 Skill `v0.11.0` latest 和历史 Release；安装包不进入源码历史。

## 源码与发布

- [PR #34](https://github.com/dongbeixiaohuo/writing-agent/pull/34) 五项 Windows/Linux 必需检查通过后正常合并为 `cef2487b792f78f3eae486b6a153d2af3360bcc8`，没有绕过分支保护。
- 固定构建源码及标签 `desktop-v1.0.0-rc.98` 指向 `938939736ff962c9cb8846e3af53ca4c738c97ab`；该提交的源码树与上述合并提交一致。后续下载文档提交不改变构建基线。
- [Windows 候选工作流 42502841022](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/42502841022) 完整通过 Runtime、UI、Bridge、Desktop、Python、脚本、文档、Skill 镜像、生产依赖高危审计、打包、安装与升级。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.98) 发布于 2026-11-08 17:15:03 UTC（北京时间 2026-11-09 01:15:03），`draft=false`、`prerelease=true`，显式 `make_latest=false`。读回标签与构建 SHA 一致，Skill latest 仍为 `v0.11.0`。
- 首轮完整 CI 发现 CLI 离线模拟仍使用旧收尾工具、模型分组测试仍返回旧风格描述、历史暂停测试仍匹配旧文案；修正模拟协议和夹具后全部通过，没有放宽正式格式、完成或事实门禁。

## 安装包与验证

- `Writing-Agent-Setup-1.0.0-rc.98-x64.exe`：111,754,444 字节，SHA-256 `4ca28dde6affb64e0a6e784f598b180728df44eb61251d0d060607467be4b475`。
- blockmap SHA-256：`b5e57936b684bcc87ec02c09fc9652fc2fcb39307b658a075f74127d53a37671`。
- 六个附件为 EXE、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json`、`upgrade-test.json`。发布前远端 digest、大小与本地 CI 产物 6/6 一致；清单及安装证据的源码、版本与安装包哈希一致。
- `curl -q` 无登录完整下载公开 EXE，大小与 SHA-256 再次一致；没有以链接存在或远端 digest 代替完整下载。
- 全新安装、隔离启动和卸载 PASS；ready、协议 24、exitCode=0，启动 1.298 秒，stderr 为空。
- RC96 固定标签重建包 → RC98 原位升级 PASS；升级后 ready、协议 24、exitCode=0，启动 0.980 秒。
- 稳定安装器身份、单一注册项、旧安装移除、既有快捷方式，以及 AppData/Workspace 合成哨兵在升级和卸载后保留均 PASS；孤立旧安装恢复为 `NOT_APPLICABLE`。
- 升级 smoke 退出阶段仍记录 `No handler registered for writing-agent:bridge:v7`。原始 stderr 随附件保留，握手与退出码通过，不表述为零警告。
- 六份最终 CI 附件存放于本机 `output/desktop/rc98-public-42502841022`，当前安装包和校验文件同步到 `output/desktop` 根目录；旧版包未清理。

## 功能与成文验证

- 读者响应按五个字段的完整性验证，不再因引用正文的百分比或措辞而被整份拒绝；真实失败不冒充成功，也不新增自动付费重试。
- 需求整理、主笔、审校、修订和润色一起区分读者需要的解释与内部工作备注，清理写法自述和重复真假标签，保留假设语气、事实限定、引文和必要注释。审校检查论证和案例，不以风格动作覆盖率验收。
- 风格提取与写作使用完整指南、连贯原文及迁移示例；内置“瘦仙人”“胖仙人”候选保留。过程说明改为面向作者的 Agent 动作，并包含完成后的导演收尾修复。详见[风格 v3](../implementation/2026-11-08-style-guide-v3.md)、[过程说明](../implementation/2026-11-09-human-progress-copy.md)和[读者与正文机制](../implementation/2026-11-09-reader-and-publishable-prose.md)。
- 本地完整 Runtime 803/803、Desktop 88/88 通过。另用独立虚构材料进行了 5 轮、15 次真实模型请求；前四轮暴露去标签后丢失假设语气或保留工作自述的问题，最终三类受控样例通过。它不是同选题完整成文质量或跨模型稳定性验收。
- 用户工作区只读核对的 33 个既有正文和标题版本指纹不变；没有回写测试稿、改写历史读者报告或自动更新个人风格。此次只提供升级安装包，不自动替换用户当前 App。

## 使用与边界

退出旧 App、备份工作区后安装。若要测试新版风格提取，在风格库重新提取并保存，再在新测试项目中选用保存后的版本；旧项目快照不会自动换版，现有正文与标题留作对照。

安装与升级验证在干净 Windows Runner 中使用合成数据，RC96 从固定标签重建，不声称与历史公开 EXE 字节一致。Smoke 禁用硬件加速，不证明正常 GPU、全部历史数据库或完整人工写作旅程通过。当前没有自动更新；文章质量仍需作者同题复测，不承诺模型不会再生成模板化文字。
