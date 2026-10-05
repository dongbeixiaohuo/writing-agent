# Writing Agent 1.0 RC 验收记录
> **当前结论：BLOCKED_CORE_WORKFLOW / BLOCKED_FOR_PUBLIC_RELEASE。** 以下 rc.6 READY 判断已撤回，仅保留历史证据。CR-002 的缺口提问、导演与独立评审没有通过业务验收；原 38 项不足以证明主流程完成，必须补齐 [C02 场景](../implementation/CR002_INTERACTIVE_COLLABORATION.md)。

候选：`1.0.0-rc.6`  
日期：2026-09-19  
总体结论：`BLOCKED_CORE_WORKFLOW / BLOCKED_FOR_PUBLIC_RELEASE`。rc.7 / 协议 v18 仅提供隔离桌面工程测试。导演/隔离评审已有请求及自动测试证据，真实缺口追问和提纲修改通过，但完整写作仍失败，不恢复最终用户验收就绪。见[本轮完整记录](CR002_DESKTOP_EXPERIENCE_RESULTS.md)。历史 Anthropic-compatible 阶段执行、rc.6 协议 v17 启动和项目生命周期专项不能替代核心场景；干净机、其他模型、人工质量评估及维护者签收仍未完成。

## 1. 状态口径

- `PASS`：对应验收已由真实本地实现/故障路径执行，未发现该项缺口。
- `PASS_LOCAL`：本机实现闭环通过，但仍需不同机器、人工或发行环境复验。
- `PASS_FIXTURE`：协议、模型或故障由确定性 fixture 执行；不是商业服务实调。
- `PARTIAL`：主要闭包成立，验收原文仍有必要环节未执行。
- `BLOCKED_EXTERNAL`：缺少明确授权、凭据、独立环境或真实参与者。

## 2. 环境和统一入口

当前环境：Windows 11 企业版 x64 build 26200、31.4 GiB RAM、Node 24.18.0、npm 11.16.0、Python 3.11+、Electron 44.0.0。桌面安装测试见 `WA017_RESULTS.md`。

```powershell
& apps/desktop/scripts/run_rc_validation.ps1 `
  -InstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.6-x64.exe `
  -PreviousInstallerPath output/desktop/Writing-Agent-Setup-1.0.0-rc.5-x64.exe `
  -EvidencePath output/rc-local-validation-rc6.json
```

脚本只运行本地自动检查；它不会读取真实 Key、调用付费模型、伪造人工评分或执行公开发布。

rc.6 当前自动矩阵为 Runtime 142/142、迁移 15/15、UI 42/42、Bridge 33/33、Desktop 23/23、Python 241 通过/1 跳过基线，并重新通过 Desktop、文档与交付包检查。`output/desktop-rc6-smoke.json` 证明封装后的 Electron 44 应用以协议 v17 完成 renderer/Application Service/SQLite 握手、退出码 0 且 stderr 为空。`output/desktop-upgrade-test-rc4-to-rc5.json` 与 `output/desktop-orphan-upgrade-test-rc4-to-rc5.json` 是固定安装身份和两阶段升级机制的上一轮实测；`output/installer-upgrade-progress-rc4-to-rc5.json` 证明原生安装页按“移除旧版本 → 安装新版本”切换。rc.5 → rc.6 精确原位升级没有在本轮自动执行，因为用户当前程序仍在运行，脚本不得擅自将其关闭；该项进入最终用户验收，不把 rc.4 → rc.5 证据冒充为当前二进制实测。

真实模型证据除旧基准报告外，新增 `output/playwright/final-interaction-rc2/interaction-rc2-report.json`、`desktop-layout-export-report.json`、`restart-readback-report.json` 与 `guided-project-report.json`。MiniMax-M3 连接探测覆盖鉴权、模型、流式响应和工具调用；rc.2 在现稿上完成九阶段与三个带自由文本意见的角色化检查点，事实 `passed`、滚动距离 0、TXT/杂志 HTML 正式导出并在重启后读回。文件级抽查还发现并修复了 Desktop IPC 丢失排版参数的问题。

rc.4 新增、并由 rc.5 继续包含的主对话专项证据为 `output/main-conversation-priority-regression.json`：项目可选、跨项目会话恢复、项目/会话选中语义、提纲内联 Markdown 渲染、无原始 Markdown 符号、阻断主对话显示和直达核查均为 `PASS`。这证明 UI/Bridge 交互投影，不冒充一次新的付费 provider 长文旅程。

rc.6 新增 `output/playwright/project-lifecycle-rc6/project-lifecycle-report.json`：在隔离桌面工作区创建两个已确认且零会话的项目后，`test` 可被明确选中并进入新对话状态，输入框可用，删除入口可见，错误名称不放行，完整名称才允许删除，删除后另一个项目仍保留。真实用户数据库的 `test` 只做了只读检查，确认其正是“简报已确认、1 份材料、0 个会话”的兼容场景，未修改或删除，证据为 `output/live-test-project-readonly-inspection.json`。

## 3. AT-01 至 AT-38

| ID | 状态 | 实际证据与限制 |
|---|---|---|
| AT-01 | `PARTIAL` | rc.6 NSIS 已封装并通过协议 v17 打包后启动；rc.4 正常/缺失登记→rc.5 已证明两阶段可见升级、数据保留和卸载机制。rc.5→rc.6 精确原位升级与无开发工具的独立干净 Windows 尚未执行 |
| AT-02 | `PASS_REAL_ONE_PROTOCOL` | MiniMax-M3 真实完成多轮 model→tool→result→model、两份材料、九阶段、三个共创检查点和正文保存；OpenAI-compatible 商业端点仍待验收 |
| AT-03 | `PASS` | 请求快照离线重建覆盖 system/user/tool/schema/参数，重建不发网络请求 |
| AT-04 | `PASS` | 真实子进程强退后恢复最新提交、决定/锁和 interrupted run |
| AT-05 | `PASS` | 事务前/后故障注入不产生半版本、悬空指针或旧 passed 配新正文 |
| AT-06 | `PASS` | 相同 operation ID 返回相同结果，正文和导出均不重复 |
| AT-07 | `PASS` | 已发送但未知的外部结果持久化为 `unknown_outcome`，恢复不自动收费重试 |
| AT-08 | `PASS` | 旧 baseVersion 修改被拒绝，已保存用户正文保持 |
| AT-09 | `PASS` | 锁定块修改被领域层拒绝并投影为锁冲突 |
| AT-10 | `PASS` | 取消后迟到输出不更新正式稿；generation/operation 状态可查 |
| AT-11 | `PASS` | 正文、标题、账本或分发文案变化触发 stale，正式导出阻断 |
| AT-12 | `PASS` | claims/report/snapshot hash 篡改或旧引用拒绝 |
| AT-13 | `PASS` | unsupported/contradicted/broken_link/needs_user_source/partial/none/red 全部阻断 |
| AT-14 | `PASS` | 空 claims 只在覆盖语义完整时按合同处理，不是一律放行 |
| AT-15 | `PASS` | 未核查工作备份可取回且标状态；publication 拒绝 |
| AT-16 | `PASS` | TXT/HTML 共用同一 snapshot gate；失败保护已有文件 |
| AT-17 | `PASS` | canonical fixtures 的 Python/TS 门禁差分一致 |
| AT-18 | `PASS` | 路径穿越、符号链接、系统/Key 目录越界测试均拒绝 |
| AT-19 | `PASS` | 网页提示注入不授予权限；私网/重定向/危险 HTML 被固定地址和净化策略阻断 |
| AT-20 | `PASS_REAL_ONE_PROTOCOL` | fixture 覆盖错 Key、额度、无 tools、截断 JSON、429/5xx；rc.2 MiniMax-M3 连接探测及 18/32 模型、23/40 工具、7,053 tokens 的现稿共创通过，其他商业端点仍待验收 |
| AT-21 | `PASS` | manifest/旧桌面 SQLite 导入，中断重试不重复，源 hash 不变，旧 passed 不升级 |
| AT-22 | `PASS` | `legacy_unknown`、未知来源和 tentative 决定按原状态保留 |
| AT-23 | `PASS_LOCAL` | 新 schema、损坏库、只读/非目录、确定性 `SQLITE_FULL` 均 fail closed；未做物理满盘 |
| AT-24 | `PASS_LOCAL` | 生产包扫描排除 DSH/Claude/Python/Tauri/旧 UI/node_modules/source map，依赖 manifest 入包 |
| AT-25 | `PASS` | 诊断预览/ZIP 和分发扫描不含 Key、私人正文或私有路径 |
| AT-26 | `PASS` | 模型/工具/重试/修订四类预算统一停止并保留当前产物 |
| AT-27 | `PASS` | 同内容保存不造新内容版；显式回退生成可审计新事件/版本 |
| AT-28 | `PASS_LOCAL` | 精确项目回退不影响其他项目；选定备份经 hash/schema/integrity 校验后关闭数据库交换，失败保留 live，并有用户可见恢复入口；原生文件选择的完整可见 E2E 待最终用户 |
| AT-29 | `PASS_LOCAL` | legacy Python/工作流/插件回归按统一命令执行；环境性联网项保留 SKIPPED，不记 PASS |
| AT-30 | `PASS` | 固定 DSH commit/tree/hash、MIT notice、copied files 和修改理由可追溯 |
| AT-31 | `PASS` | 无旧应用/DSH 服务即可启动同源 UI；Mock 与 production 入口分离 |
| AT-32 | `PASS_LOCAL` | Chromium 明暗主题、双视口、关键交互和像素阈值通过；rc.4 主对话专项 8 项，以及 rc.6 零会话历史项目/新对话/项目删除专项均通过并复核截图；尚无另一台机器人工签收 |
| AT-33 | `PASS` | 写作 Slot 挂载/卸载、项目切换、编辑/差异/核查入口和状态隔离通过 |
| AT-34 | `PASS` | 集中主题/品牌/布局可恢复并持久化；演示 Slot 不进入 production |
| AT-35 | `PASS` | 重连、旧 generation、低 revision、协议不匹配均显式拒绝且不重复启动 |
| AT-36 | `PASS_LOCAL` | Web/desktop 自有品牌/appId/数据目录；无上游 updater/账户/遥测；模型只按配置发起 |
| AT-37 | `PASS_LOCAL` | 不启动旧 0.1.0 即导入夹具并由新 Bridge 打开；发行闭包无旧页面/Tauri；同源打包 UI 的真实 Provider 全旅程已通过，干净机仍待 |
| AT-38 | `PASS_LOCAL` | renderer sandbox、Node 关闭、受限 preload/IPC、导航和自定义协议路径测试通过 |

## 4. RC 签收阻塞项

1. 在无 Node/Python/Claude Code/DSH 的独立 Windows x64 机器或 VM 执行安装、首次配置、创建项目、真实写作、重启恢复、导出和卸载。
2. Anthropic-compatible MiniMax-M3 已完成一条真实多轮工具闭环；仍需 OpenAI-compatible 商业端点，并继续记录模型、端点类别、usage、错误与成本。
3. 生成 12 例 × 旧版/新版/简单基线三组正文，完成盲评；再由 5 位真实参与者执行首次上手任务，保留真实分母和阻塞。
4. 决定代码签名证书；若无证书发布，Release 首屏必须明确 `unsigned` 与 SmartScreen 风险。
5. 维护者签署 `RELEASE_GATE.md`，然后才可创建/合并 PR、tag 和公开 Release。

## 5. 结论边界

当前可以说“最终用户验收候选已就绪”，不能说“Writing Agent 1.0 已完成最终签收或已经发布”。真实单模型样例、Mock/fixture、当前开发机安装、独立干净机和人工外部验收分别记录，不互相替代。
