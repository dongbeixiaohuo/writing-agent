# WA-014 本地实施与验收结果

日期：2026-09-17  
状态：`COMPLETE_LOCAL`  
任务：实现工作备份与统一正式导出闭环

## 1. 交付结果

- 将“工作备份”和“正式交付”拆成两个明确命令：工作备份始终可用，正式 TXT/HTML 必须通过同一个当前事实门禁。
- 工作备份保存当前 Markdown 原文，并生成 `.status.json`，明确标记 `WORKING_COPY_NOT_PUBLICATION` 及尚未满足的发布条件；它不会伪装成可发布成稿。
- 正式导出重新核验当前项目、正文、锁定标题、分发文案、证据账本、事实快照、assessment、policy/schema 版本及全部内容 hash；旧 `passed`、输入变化、失效记录或绑定不一致都会 fail closed。
- TXT 与安全静态 HTML 共用门禁和当前快照。HTML 对全部输入转义，不生成脚本、外链或远程资源。
- SQLite schema 升至 v7，新增持久化 `exports`：先记录 `prepared` 内容和预期 hash，再同目录临时写入、`fsync`、校验、原子改名，最后提交完成事件和 `EXPORTED_AS` 来源边。
- 进程在文件改名后中断时可在重启或同 operation 重试时完成文件/数据库/hash 对账；目标冲突或已完成文件被篡改时拒绝覆盖。
- Application Service、CLI、Client Bridge v5、Local Web Host 与 DSH“备份与交付”页签均使用同一导出边界；无 Provider 时仍可离线保存工作备份。

详细语义见 `docs/architecture/EXPORT_CONTRACT.md` 与 `docs/architecture/CLIENT_BRIDGE_PROTOCOL.md`。

## 2. 自动验证

| 范围 | 证据 | 结果 |
|---|---|---|
| 领域合同 | 工作备份原文/状态清单、TXT/HTML 同门禁、名称净化、stale/hash/绑定篡改拒绝 | PASS |
| SQLite/迁移 | v1-v6 有序迁移到 v7、prepared→file→completed、改名后崩溃恢复、篡改检测、冲突文件保护 | PASS |
| Application/CLI | 无 Provider 工作备份、当前 projection、正式导出前置门禁、operation 幂等 | PASS |
| Bridge/Host | Bridge v5 能力与类型、项目隔离、远程持久化、工作备份与正式 HTML 导出 | PASS |
| Mock/UI 单测 | 独立备份/正式交付动作状态、阻断提示、导出历史、既有布局回归 | PASS |
| 真实浏览器 | Chromium 1440×960 打开“备份与交付”，两类动作与警告可见，项目切换无泄漏且无 console error | PASS_LOCAL |

真实浏览器脚本与截图：`output/wa014_playwright_check.py`、`output/wa014-ui-delivery.png`。脚本通过 `webapp-testing` 的受控本地 server helper 启动/停止 Mock Vite 服务；Mock 中写操作按设计禁用，因此该浏览器证据验证界面和隔离，不替代真实 Application/Host 的文件写入测试。

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-06 | `PASS_WA014_SCOPE` | 导出使用持久 prepared 记录、临时文件、`fsync`、hash 校验和原子改名；改名后崩溃可对账，失败不提交虚假完成状态 |
| AT-11 | `PASS` | TXT 与 HTML 对同一当前正文、锁定标题、分发文案、证据和 assessment 调用同一严格门禁 |
| AT-12 | `PASS` | 任一绑定输入变化或显式 invalidation 都会阻断新导出；已有交付文件不被失败尝试改写 |
| AT-15 | `PASS` | 未通过事实门禁时仍可保存带不可发布声明和状态清单的 Markdown 工作备份 |
| AT-16 | `PASS` | 只有当前门禁通过才写正式 TXT/HTML；门禁失败、目标冲突和 hash 不一致均不覆盖旧文件 |

## 4. 验证命令

```powershell
npm run check:runtime
npm run check:ui
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py
python C:\Users\Dante\.agents\skills\webapp-testing\scripts\with_server.py --server "npm run ui:dev:mock -- --host 127.0.0.1 --port 4173" --port 4173 -- python output/wa014_playwright_check.py
```

本轮结果：Node 24.18.0 下 runtime 104/104；UI 10/10；Bridge/Host 9/9；UI/来源 Python 7/7；M0 Python 12/12；legacy 共运行 232 项，其中 231 通过、1 条既有条件跳过；production dependency audit 为 0 vulnerabilities；需求包 25 个任务、38 个验收场景的一致性检查全部 PASS。没有删除、跳过或改写失败测试来获得通过。

## 5. 未宣称内容

- 未调用真实 Provider、付费模型或外部检索；正式导出测试使用确定性本地数据与事实门禁夹具。
- 未实现网络发布、上传或第三方平台投递；WA-014 只负责用户工作区内的本地文件交付。
- 未完成远端 CI、Electron 安装包、干净机器或真实用户交付验收。
- 未执行 commit、push、PR、Release 或生产部署。
