# rc.58 公开测试版收尾

2026-09-30：维护者明确要求完成公开 RC 发布，不以稳定版 1.0 的盲评与五人上手实验阻挡社区反馈。已接受未签名 RC，下载页须说明未知发布者提示，不要求关闭安全防护。保留原 Skill 版本与历史 Release。

## 本次范围

- [x] 拒绝模型接口重定向，避免内容与凭据发送到未配置的地址。
- [x] Tavily Key / 开关保存失败时保持一致性。
- [x] 搜索查询程序级外发边界及明确说明：维护者已接受展示确切检索词与接收方、同意后才发送，拒绝则本轮不再请求外部搜索。
- [x] 共创确认不叠加旧核查失效警告；稿件和导出入口说明报告的证据边界。
- [x] 修复 Windows 独立插件安装不稳定，加入 PR 桌面检查与候选安装验证；PR #15 五项必需检查全部通过后合并。
- [x] 最终候选运行 Runtime / UI / Bridge / Desktop / 搜索 / 文档镜像 / 依赖检查。
- [x] 最终提交打包 rc.58，记录 Git SHA、单版本校验和；本地发布资产放 output/desktop/release-1.0.0-rc.58。
- [x] 隔离桌面启动、Windows Runner 安装/升级/数据目录保留与完整合成共创链路验证；不关闭或覆盖用户日常软件。数据保留测试使用合成哨兵文件，不冒充所有历史数据库迁移验收。
- [x] 代表性真实模型与搜索验证，记录失败和降级，不把预设数量当实测供应商数量。
- [x] 更新 README / Release 说明、已知限制与反馈入口，源码 PR #15 通过门禁后合并，首页下载入口以发布后文档 PR 同步。
- [x] desktop-v1.0.0-rc.58 Pre-release 发布安装包及校验和，不设置全仓库 latest，核对公开下载。

## 验证记录

- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.58) 于 2026-09-30 发布，`draft=false`、`prerelease=true`，指定 `latest=false`。六个附件（exe、blockmap、校验和、构建清单、安装证据、升级证据）的 GitHub digest 均与本地 SHA-256 一致；不带登录凭据重新下载 exe 再次校验一致。
- 最终安装包 111,509,616 字节，SHA-256 `01b61fc06561c4e214ff0ee23459f8cdb05e660e6978faadf2a8047e041a44fe`，签名状态 `NotSigned`。其来源为合并提交 `cdfe876df1d275b617189d1408217227877d6699`；同版本早期本地/PR 验证包不是公开分发包，不混用其校验值。
- 最终 Windows 候选工作流 `36686059037` 全部通过：Runtime / UI / Bridge / Desktop / Python / 搜索 / 脚本 / 文档镜像 / 生产依赖审计、NSIS 打包、中文及空格路径安装启动卸载、从 `dee9c2edaecc9545872c342e97d25f5adc514afb`（rc.57）升级 rc.58。升级验证旧程序移除、单一安装项、快捷方式保留，以及升级/卸载前后的 AppData 与 Workspace 哨兵文件保留；不代表所有历史用户数据库兼容性已经穷举。
- PR #15 的源码提交 `40b1d61951903b130464e3230953a37dabd2af1a` 五项必需检查通过后合并，main 提交为 `cdfe876df1d275b617189d1408217227877d6699`；合并后的 [Packaging checks](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/36686030979) 通过。最终候选由同一 main SHA 的 [Windows 发布工作流](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/36686059037) 构建，不发布 PR 临时合并引用下的包。
- 共创确认与证据提示：修改前重现 stale + CO_CREATION_CHECKPOINT 重复警告；修复后 conversation-primary + conversation-export 共 10 项通过。
- 报告来源提示使用已持久化的核查主张，不根据今天的搜索开关推断历史报告曾联网。包含网址只标注“来源引用”，不宣称网址已被完整读取或事实绝对正确。
- 其它证据随执行追加。不能把尚未完成的项目勾选为通过。
- 安全回归：24/24；搜索相关 23/23；runtime 276/276；runtime/desktop TypeScript 通过。真实本地 307 服务器在修复前收到假凭据，修复后第二目标零请求。
- Windows Credential Manager：独立临时配置和假 Key，首次/重开均为 system persistence；空 Key 保存保留原值；唯一测试凭据已删除且读回不存在。不改用户真实配置。
- 主线 `check:ui` 与 `check:desktop` 通过（桌面 46 项）；最终提交还需远端 CI。
- 最终本地整合：UI 85、Bridge 66、Desktop 46 项通过；Python 244 项、1 项按条件跳过，`npm run check` 通过；生产依赖审计 0 漏洞；文档包及运行时镜像检查通过。期间观察到 CI 子任务的两个测试先失败中间态，完整实现后均通过。
- 独立插件安装：裁剪桌面开发依赖后，offline 生产依赖 312 包 + HTML 导出 34.641 秒通过；对照历史同 HEAD 160.647 秒及 240 秒超时。不靠单纯放大超时解决。
- PR 新增 `desktop-pr`；手动候选工作流支持 `previous_ref` 构建上一版并真实升级，拒绝以同版本重装冒充升级。构建清单记录源码 SHA，校验文件仅收录当前版安装包和 blockmap。最终包仍需从提交后的源码构建。
- 第一轮真实共创测试因测试脚本将 5 分钟总时限传给跨轮恢复而中止（持久事件为 external_abort），不计作通过。已将验收脚本总时限与单轮时限区分，继续用独立合成项目验证；不修改产品超时掩盖失败。
- 第二轮 `tests/ux/rc58_release_journey_live.ts --live` PASS：MiniMax-M3.1-Flash-Preview，60 次真实请求；提纲、初稿、编辑审校、发布审校、读者审校、集中修订、语言润色分别暂停，另有一次审校分歧询问；自然语言确认后继续。选择标题原文后完成模型复核，finalGate=passed，HTML 导出成功。此为已确认 brief 起点的服务层+Bridge 验收，不涵盖首次需求澄清或原生鼠标操作。
- 真实耗时仍有波动：部分专家超过 60 秒才出现普通 text_delta；工具参数可能先于普通文字到达，不能将脚本 text_delta 统计当作 UI 首字时间。该限制保留为 RC 反馈重点，不宣称所有模型都即时响应。
- Parallel 真实完整核查：`node --import tsx tests/ux/fact_search_live.ts --parallel-only`，MiniMax-M3.1-Flash-Preview 共 5 次模型请求、2 次搜索，28,031 ms，核查成功保存。正确日期为 SUPPORTED，故意错误的 1959 年为 CONTRADICTED，个人感受比喻未列为事实问题。最终 blocked 是负向样例预期结果，不是运行失败。脚本对合成公开主题显式授权，未读取用户文章。

## 非本次阻塞

稳定版的 12 题三组盲评、5 位独立用户实验、全部旧版能力迁移、macOS/Linux、自动更新。必须公开说明 RC 性质与未覆盖范围，但不再把这些稳定版要求作为公开 RC 的前置条件。

本次两项独立实现委派 gpt-5.6-sol / high：模型凭据安全、CI 与构建可靠性。主 Agent 负责搜索外发、UI 与发布整合；共享目录按文件职责划分，不改无关业务文件。
