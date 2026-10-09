# RC80 公开测试版发布记录

2026-10-10：维护者授权同步源码与更新下载包。沿用未签名 Pre-release，不改变原 Claude Code Skill 的 latest，不删除历史版本。安装包只进入 Release 附件，不进入源码历史。

## 源码与构建

- 本地 RC72—RC80 成果及此前提交通过 [PR #24](https://github.com/dongbeixiaohuo/writing-agent/pull/24) 的五项必需检查后合并，未绕过分支保护。
- 公开源码固定为 `79062b6c80027df0685c4a91f69f6c0a2a41949e`，标签 `desktop-v1.0.0-rc.80` 指向该 SHA。发布入口的后续纯文档提交不改变这个构建基线。
- [Windows 候选工作流 37963782888](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/37963782888) 从该 SHA 干净构建，全部通过 Runtime / UI / Bridge / Desktop / 搜索专项、Python、脚本、工作流、文档/镜像、生产依赖高危审计和打包。
- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.80) 于 2026-10-09 17:38:42 UTC（北京时间 10 月 10 日 01:38:42）发布，`draft=false`、`prerelease=true`，指定 `make_latest=false`。再次查询 `releases/latest` 仍为 `v0.11.0`。

## 公开附件与本地交付

六个附件：安装包、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json` 和 `upgrade-test.json`。草稿阶段逐一核对 GitHub digest、大小与本地产物，6/6 一致。

- 安装包：`Writing-Agent-Setup-1.0.0-rc.80-x64.exe`，111,601,486 字节。
- SHA-256：`ab8aaf1245d0ce17ca3f4308eda9cc2c995c0048b16b2be9ee5b94d281a64bb0`。
- blockmap SHA-256：`56a28b6a319df3d70aa9e2f8fe8af998ae6ddbacd108c969993f565a718e49ae`。
- 签名：`NotSigned`；发布页披露未知发布者风险，不要求关闭安全防护。
- 最终本地包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.80-x64.exe`，复制后再次校验一致。
- 构建产物与验证证据：`output/desktop/rc80-public-37963782888`。下载网络较慢，分段取回后合并；完整压缩包 SHA-256 与 GitHub artifact digest `9f4d8d8a912c20b039306a1b3b5427bc611a6f5ec5f78f6cb2d98c614966b08a` 一致。
- 发布后使用不携带登录凭据的请求重新下载完整安装包，大小与 SHA-256 均一致，公开下载验证 PASS。

此前本地 RC80 测试包保留在 `output/desktop/rc80-build/local-test-before-public`，大小 111,601,125 字节，SHA-256 为 `3de0ca0b11094b72df45a573bd72a678f161f8ddc0a5ed313cd0bccce576aa8d`。该包基于 `3d6a9d7` 及当时未提交修改，与最终公开包不同；旧测试说明及校验文件一起保留，不能用旧哈希核对公开包。

## 安装与升级结果

- 全新安装、启动、卸载 PASS；启动 `ready`、协议 23、exitCode=0，隔离启动耗时 1.154 秒。
- RC68 → RC80 原位升级 PASS；升级后 `ready`、协议 23、exitCode=0，隔离启动耗时 0.996 秒。
- 旧安装移除、安装器身份稳定、单一注册项、已有快捷方式保留均 PASS。
- AppData / Workspace 合成哨兵在升级及正常卸载后保留，均 PASS。孤立旧安装恢复为 `NOT_APPLICABLE`，不声称已验证。
- 只在干净 Windows Runner 运行，没有操作维护者日常安装或真实用户工作区。旧版由 RC68 标签重建，不声称与当时公开附件字节相同；数据保留是安装器级合成检查，不代表所有历史数据库迁移。

## 发布前拦截与修正

首次同步 CI 拦截了两个错误放在 Skill 镜像根目录的开发检查脚本。新增回归先复现严格镜像漂移，再将脚本移到 `tests/check_document_pack.py`、`tests/measure_agent_context.ts` 并更新引用。没有删掉实质文档检查或放宽镜像规则。

之后高危审计拦截 `source-map-js@1.2.1`。仅更新兼容补丁至 1.2.2，同步根与插件锁文件；重新验证 UI / Desktop、镜像与高危审计后推送，再经必需 CI 合并。仍有 3 low / 4 moderate 依赖报告，不宣称零漏洞，没有通过强制降级或降低审计阈值绕过门禁。

## 范围与边界

- 此次公开候选自动验证不等于真实 MiniMax 耗时、文章质量、所有服务商兼容或完整人工桌面旅程；字符缩减不能外推同比例速度与费用收益。
- 事实核查是文章重点事实复核，不是论文式全点引用或专业查证保证；无联网依据的部分必须如实说明。站点验证、付费墙和拒绝访问不做绕过。
- 旧本地包从 OneDrive 程序路径启动发生过 GPU/主界面故障，TEMP 隔离启动通过；具体环境原因未确认。建议默认本地安装位置，正常 GPU 和全部 Windows 环境未穷举。
- 系统复制粘贴偶发异常仍在排查，本版不宣称解决该异常；采集脚本不读取剪贴板内容，也不是修复程序。
- 重要稿件和工作区保留备份，当前无自动更新，不保证新版数据库可被旧版打开。

反馈请提供版本、系统、模型协议、复现步骤和已自行检查的脱敏记录；不上传 Key、完整私人数据库或客户材料。无关本地审查报告与临时文件不进入本次提交和 Release。
