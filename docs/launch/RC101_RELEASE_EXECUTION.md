# RC101 公开测试版发布记录

2026-11-18，维护者授权提交、同步远端、打包并更新 GitHub 下载。桌面版本为 `1.0.0-rc.101`，发布形式为未签名 Windows x64 Pre-release。

## 源码与构建

- [PR #39](https://github.com/dongbeixiaohuo/writing-agent/pull/39) 通过 Windows/Linux 五项必需检查后合并到 `main`，合并提交为 `26656b1e02918e5a4721e9cbd237c957f72d8269`。
- 固定构建源码及标签 `desktop-v1.0.0-rc.101` 指向 `45774c5011b41c924e88db62a80528c271cd4ab1`。已核对该提交的源码树与上述合并提交一致。后续下载文档提交独立于构建源码。
- [Windows 候选工作流 44129569410](https://github.com/dongbeixiaohuo/writing-agent/actions/runs/44129569410) 全部通过，包含 922 项运行时相关测试、UI/桥接、桌面、Python、脚本、工作流与文档、Skill 镜像、生产依赖高危审计、打包、安装与升级。
- 发布回归发现两处旧测试与新行为不符，已调整重复读取恢复测试的材料夹具，并将研究提示断言对齐到关键原文、争议比对和禁止编造。断点恢复仍校验不重复研究和派发。新增段落修订与修订上下文测试已纳入常规回归。

## 下载与校验

- [公开 Release](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.101) 发布于北京时间 2026-11-18 01:06:45，`draft=false`、`prerelease=true`，显式 `make_latest=false`。仓库 latest 为 Skill `v0.11.0`。
- 安装包 `Writing-Agent-Setup-1.0.0-rc.101-x64.exe` 大小为 111,787,487 字节，SHA-256 为 `e9ab06f108207e7f7137b43a38fbe6a06b78d3b8be45790811af10fecaa03de4`。
- blockmap SHA-256 为 `4f4efe99b1ff0025f1afcb5fcdd14fd6c3bf29e140cd1730dab7906ca68f24ff`。
- 六个附件为 EXE、blockmap、`SHA256SUMS.txt`、`build-manifest.json`、`installer-test.json`、`upgrade-test.json`。远端 digest 和大小与本地 CI 产物逐一核对，6/6 一致。
- 无登录完整下载公开 EXE 后，大小和 SHA-256 与 CI 产物一致。最终 EXE 与版本校验文件同步到维护者本机 `output/desktop` 根目录，CI 原始附件留存在 `output/desktop/rc101-public-44129569410`。

## 安装与升级

- 全新安装、隔离启动与卸载通过，启动约 1.379 秒，状态 ready，协议 24，退出码 0。
- 从固定 RC98 标签重建旧版后原位升级到 RC101，通过隔离启动与卸载验证。升级启动约 1.020 秒，状态 ready，协议 24，退出码 0。
- 稳定安装器身份、单一注册项、旧安装移除、既有快捷方式，以及 AppData/Workspace 合成哨兵在升级和卸载后保留均通过。孤立旧安装恢复为 `NOT_APPLICABLE`。
- 升级 smoke 退出阶段记录 `No handler registered for writing-agent:bridge:v7`，原始 stderr 保留在附件中，握手与退出码通过。

## 功能范围

- 方向未定时提供 3–5 个选项。作者选择后，将确认原句和明确补充传递给研究、选材与主笔。材料缺口沿原方向处理。
- 主笔收到完整来源和原文书签，选材的 `interest` 评语留在内部。提示要求通过新的动作、回应或后果接续，减少讲完再复述的段落。
- 正文提交对已识别的编辑说明表达进行检查，命中后进入现有有限纠正流程。模式检查的覆盖范围有限，最终仍由作者阅读验收。
- 整合读者反馈与修订交接。写前构思与集中修订使用“写作与表达”模型组，默认仍跟随当前默认模型。
- 补充来源链接传递与压缩网页读取兼容，保留来源安全和大小限制。

验证使用干净 Windows Runner 和合成数据。RC98 旧包由固定标签重建，其字节与历史公开 EXE 不作一致性承诺。Smoke 禁用硬件加速，正常 GPU、全部历史数据库及完整人工写作旅程仍待各自验收。当前采用手动下载安装升级，维护者本机已安装的 App 由用户自行测试。
