> 历史快照：以下为 rc.6 门禁原文，不代表当前候选状态。当前签收见 [RELEASE_GATE.md](RELEASE_GATE.md)。

# Writing Agent 1.0 发布门禁

> 新增硬阻断（CR-002）：导演编排、缺口即时暂停/答复恢复、独立评审隔离尚未全部通过业务验收；本页历史勾选仅证明对应工程运行，不构成核心合作能力完成。不得以 rc.6 自动矩阵申请最终用户签收或公开发布。

候选：`1.0.0-rc.6`

日期：2026-09-19

当前决定：**CLOSED / 不允许公开发布**

本文件是维护者签收清单，不是自动批准。开发 Agent 只准备代码、证据和草稿；PR 合并、tag、Release、`latest`、仓库设置和对外传播都需要维护者明确授权。

## 1. 本地已通过

- [x] 独立 Application Service、model/tool loop、SQLite 版本/恢复/预算与事实门禁。
- [x] DSH 派生同源 UI、真实 Bridge、集中主题/品牌和写作 Slot。
- [x] legacy manifest/SQLite dry-run、备份、幂等导入和精确回退。
- [x] Electron sandbox/preload/IPC/导航/路径/网络安全边界。
- [x] Windows x64 NSIS `1.0.0-rc.6` 打包与协议 v17 打包后启动握手；进程退出码 0 且 stderr 为空。
- [x] rc.4 正常/缺失登记→rc.5 原位升级：安装页先显示移除旧版、成功后再显示安装新版；自动移除旧程序、固定安装身份、只留一个卸载项，并保留 AppData/Workspace/已有快捷方式。
- [x] 主对话优先验收：历史项目恢复、明确选中态、阶段成果 Markdown 渲染、完整稿件与关键事实阻断在主对话可见，工作台只承担追溯/精调。
- [x] rc.6 零会话历史项目可选中并开启新对话；项目列表提供可见删除入口，精确项目名确认后只删除目标项目。
- [x] Anthropic-compatible MiniMax-M3 真实连接、三次自由文本共创、基于现稿修改、事实核查、杂志 HTML 导出与重启读回。
- [x] 分发闭包扫描，无 DSH/Claude/Python/Tauri/旧 UI/node_modules/source map。
- [x] 固定上游 commit、copied-file SHA-256、MIT/Chromium/Electron notices。
- [x] 12 例三组盲评工具与 5 人实验协议已准备。
- [x] README/Quickstart/迁移、演示、Issue/PR、Release 草稿已准备且不伪造下载入口。

对应记录：`RC_RESULTS.md`、`WA017_RESULTS.md`、`QUALITY_AND_USABILITY.md`、`MIGRATION_RESULTS.md`、`UI_BASELINE_RESULTS.md`。

## 2. 硬阻塞

- [ ] 独立干净 Windows x64 机器/VM：安装、首次配置、真实写作、恢复、导出、卸载。
- [ ] 用户关闭当前已安装程序后，实测 rc.5 → rc.6 两阶段原位升级、单一卸载项和数据保留；自动脚本未擅自关闭用户正在运行的软件。
- [ ] 经费用授权的 OpenAI-compatible 真实工具闭环。
- [x] 经用户授权的 Anthropic-compatible MiniMax-M3 真实工具闭环（当前机器、单模型代表性样例）。
- [ ] 12 例 × 三组真实生成和完整人工盲评。
- [ ] 5 位真实参与者上手实验，保留真实分母与阻塞。
- [ ] 维护者决定代码签名；若无证书，明确接受 unsigned/SmartScreen 风险。
- [ ] 维护者复核最终 commit、产物、hash、限制和回退步骤。
- [ ] 维护者明确授权 main 合并、tag、Release 和 `latest` 指向。

任何一项未勾选时，WA-018/019/021/022 均不得写 `DONE`，也不得把 `1.0.0-rc.6` 称为已发布正式版。

## 3. 候选资产

当前本地候选，未上传：

| 资产 | SHA-256 | 状态 |
|---|---|---|
| `Writing-Agent-Setup-1.0.0-rc.6-x64.exe` | `11bfd315eeaca79ac548ac2cfc47cea5028341bce901ff6397a9d726e00531fa` | `NotSigned` |
| `Writing-Agent-Setup-1.0.0-rc.6-x64.exe.blockmap` | `ea064606409eeac1178f3e214e51ec5a90f4f20c173bbbecbcf1912173324f13` | 辅助资产 |

最终发布必须针对最终 commit 重建；若 bytes 或 hash 变化，本表与 Release 草稿必须同步更新。不能发布一个 hash、提供另一个 binary。

## 4. 回退和数据边界

1. 不覆盖旧 tag，不强推 main；旧 `0.11.x` 工作流和历史 `app-preview-0.1.0` Release 保持可访问。
2. 新桌面使用 `%APPDATA%\Writing Agent` 配置与 `%USERPROFILE%\Documents\Writing Agent\Workspace` 数据目录；卸载默认不删除用户数据。
3. 迁移前保留旧源只读 hash 和新 workspace 备份；回退只删除本次导入的目标项目，不修改旧源或其他项目。
4. 发布故障时撤下/标记有问题的 RC 资产与公告，不移动旧 tag；修复走新 commit 和新 RC 编号。

## 5. 维护者签收（待填写）

- 最终 commit：`PENDING`
- 干净机证据：`PENDING`
- 真实模型证据：`PASS_ONE_PROTOCOL`；OpenAI-compatible 与更多模型仍 `PENDING`
- 质量/用户实验：`PENDING`
- 签名决定：`PENDING`
- 发布授权人/日期：`PENDING`
- 决定：`NO-GO`（默认，直到以上全部完成）
