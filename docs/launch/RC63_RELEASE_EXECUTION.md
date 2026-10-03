# RC63 公开测试版发布记录

2026-10-03：维护者授权同步远端源码并更新公开下载的安装包。沿用已接受的未签名 RC 方案，不作为稳定版发布，不改变原 Claude Code Skill 的 latest，不删除历史版本。

## 源码与发布

- [源码 PR #18](https://github.com/dongbeixiaohuo/writing-agent/pull/18) 已在五项必需检查通过后合并。安装包源码固定为 `2b31ecc779bc94f9f10164021656771048eae912`。
- [最终 Windows 候选构建](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/37084961515) 从该 main 提交干净构建，结论为 success。包含 Runtime / UI / Bridge / Desktop / 搜索专项 / Python / 脚本 / 文档镜像 / 生产依赖审计和 NSIS 打包。
- 桌面标签 `desktop-v1.0.0-rc.63` 固定指向该提交；[公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.63) 于 2026-10-03 01:24:53 UTC 发布，`draft=false`、`prerelease=true`，发布指定 `latest=false`。
- 首页下载链接在 Release 公开之后才更新。无关业务报告、渗透测试脚本、临时文件、用户数据库和安装包未进入源码提交。

## 公开资产

六个附件：安装包、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json`、`upgrade-test.json`。上传后逐项核对 GitHub digest 与本地 SHA-256，一致。随后不携带登录凭据从公开链接重新下载安装包，校验一致。

- 文件：`Writing-Agent-Setup-1.0.0-rc.63-x64.exe`
- 大小：111,533,352 字节。
- SHA-256：`77cd2cc7cef377116aed1e21c894d09cf774dab90443691617034398ad111a01`
- 签名状态：`NotSigned`。下载说明提示未知发布者风险，不要求关闭安全防护。
- 本地留档：`output/desktop/release-1.0.0-rc.63`。

此前供维护者测试的本地 RC63 包不是这次固定合并提交的公开构建，字节和校验值不同。保留旧测试证据，不将旧包哈希冒充本次公开包哈希。

## 安装与升级证据

在干净 Windows Runner 执行，不在维护者日常安装环境卸载或覆盖应用：

- RC63 在含中文及空格的隔离路径安装、启动、卸载均 PASS；启动握手 protocolVersion=21、exitCode=0。
- 从 `desktop-v1.0.0-rc.58` 标签重建旧版，再原位升级 RC63；不是用同版本重装冒充升级，也不声称使用了原 RC58 公共附件的相同字节。
- 旧安装移除、安装器身份稳定、单一注册项、已有快捷方式保留均 PASS。
- AppData 与 Workspace 的合成哨兵文件在升级及卸载后保留，均 PASS。

此处数据保留是安装器级的合成检查，不代表所有历史数据库迁移、原生桌面人工操作和 Windows 环境已穷举。升级前仍需备份工作区、退出旧版；当前没有自动更新，新数据库不保证能由旧程序打开。

## 本轮额外验证与边界

- 本地 `check:ui` 通过（UI 95、Bridge 80 等检查），完整 `check:runtime` 复验通过（Runtime 307、确认 16、迁移 15、需求对话 82、原版对照 67、搜索 30）。最终发布仍以同一合并 SHA 的干净 CI 构建为准。
- 曾发现私有推理流进度测试使用 75ms 截止时间，在本地整套并发测试下偶发超时。改为保留同一断言、增加测试调度余量，并断言总响应时长确实超出单阶段时限；窄测试 13/13 与完整回归通过。没有放宽产品超时或删掉测试。
- 过程展示、已保存内容和运行轨迹详情证据见[过程可见性](../testing/2026-10-03-process-visibility.md)与[轨迹检查器](../testing/2026-10-03-run-trace-inspector.md)。历史详情只读，缺失字段不重新调用模型补造；私有推理不公开，真实写作上下文仍可能包含敏感内容。
- 9/30 的 MiniMax / Parallel / Tavily 真实服务验收是历史样例，不包装为 RC63 当日全量联网验收。没有穷举所有模型、长历史和阶段组合；RC 用于继续收集社区反馈。

反馈请提供版本、系统、模型协议、复现步骤和自行检查过的运行记录，不上传 Key、完整用户库或客户材料。回退不移动旧 Tag、不替换同名不同字节资产；需要修复时发布新版本。
