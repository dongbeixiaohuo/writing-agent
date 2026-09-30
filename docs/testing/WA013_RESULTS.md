# WA-013 本地实施与验收结果

日期：2026-09-17  
状态：`COMPLETE_LOCAL`  
任务：移植事实门禁并建立失效传播与来源查询

## 1. 交付结果

- `writing-core` 新增 `fact-check-v2` 快照、claims/evidence 严格结构、运行时门禁计算和确定性报告/hash；调用者传入的旧 `passed` 不具权威。
- SQLite schema 升至 v6，新增不可变输入快照、assessment 和显式 invalidation；正文、标题/分发文案、证据账本任一版本变化都会令旧结果 `stale`。
- v5 迁移保留旧历史但不信任旧 `passed`；缺少 v2 snapshot 的 legacy 指针也防御性降为 `stale`。
- Application Service 提供创建快照、提交评估、当前状态与来源查询；每次评估向三项冻结输入写入 `CHECKED_IN` 边。
- Client Bridge 升至 v4，DSH 派生右栏新增“核查与来源”，展示状态、绑定版本/hash、逐条 claim、阻断原因、失效记录和来源关系，并固定说明来源不等于事实真实。
- Python legacy 门禁与 TypeScript 新门禁使用同一 canonical fixtures 做差分验证。

详细语义见 `docs/architecture/FACT_CHECK_CONTRACT.md` 与 `docs/architecture/CLIENT_BRIDGE_PROTOCOL.md`。

## 2. 自动验证

| 范围 | 证据 | 结果 |
|---|---|---|
| 领域门禁 | 全部旧 blocker、full-only、空 claim 理由、coverage/binding/hash/evidence 拒绝、恶意 `status: passed` | PASS |
| SQLite/迁移 | checking→passed/blocked、assessment 不可改写、三类失效原因、v5 legacy passed 降为 stale | PASS |
| Application/Bridge | 当前计算状态、三条 `CHECKED_IN`、项目隔离、Bridge v4 类型与 Host 路由 | PASS |
| TS/Python 差分 | canonical legacy fixtures 的 outcome/blockers 一致 | PASS |
| Mock/UI 单测 | 核查投影、项目切换隔离、既有布局/运行回归 | PASS |
| 真实浏览器 | Chromium 1440×960 打开核查页、显示未知 claim/冻结输入/来源/免责声明，切换项目无泄漏且无 console error | PASS_LOCAL |

真实浏览器脚本与截图：`output/wa013_playwright_check.py`、`output/wa013-ui-fact-check.png`。脚本通过 `webapp-testing` 的受控本地 server helper 启动/停止 Mock Vite 服务；截图证明实际 DOM 与项目隔离，不代表真实外部检索或模型核查已经运行。

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-11 | `PASS_WA013_SCOPE` | 冻结当前正文/标题/分发文案/证据并计算门禁；正式 TXT/HTML 文件写入仍由 WA-014 接入同一状态 |
| AT-12 | `PASS` | 任一输入版本变化产生明确 invalidation，当前状态为 `stale`，旧 assessment 保留但不能冒充当前 |
| AT-13 | `PASS` | 全部旧非 `SUPPORTED`、`red` 或非 `full` 结果继续阻断；运行时忽略调用者 `passed` |
| AT-14 | `PASS` | 空 claims 必须完整覆盖并提供非空原因；否则 fail closed |
| AT-17 | `PASS_WA013_SCOPE` | 当前项目可查询三项输入与 assessment 的 `CHECKED_IN` 来源，未知保持未知；尚未宣称来源能证明现实真实性 |

## 4. 验证命令

```powershell
npm run check:runtime
npm run check:ui
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py
python C:\Users\Dante\.agents\skills\webapp-testing\scripts\with_server.py --server "npm run ui:dev:mock -- --host 127.0.0.1 --port 4173" --port 4173 -- python output/wa013_playwright_check.py
```

本轮结果：Node 24.18.0 下 runtime 94/94；UI 8/8；Bridge/Host 9/9；UI/来源 Python 7/7；M0 Python 12/12（含 TS/Python 门禁差分）；legacy 231 通过、1 条既有条件跳过；production dependency audit 为 0 vulnerabilities；需求包 25 个任务、38 个验收场景的一致性检查全部 PASS。没有删除、跳过或改写失败测试来获得通过。

## 5. 未宣称内容

- 未调用真实 Provider、付费模型或外部检索；当前证明的是门禁、持久化、失效和查询契约，不是每条事实已经由现实来源确认。
- 来源关系证明产物形成链，不证明来源正确、完整或当前有效；未知和缺证仍会阻断。
- “核查与来源”当前是只读投影；核查执行编排和独立标题编辑入口没有在浏览器内伪造。
- 正式 TXT/HTML 导出、旧文件保护和文件/数据库/hash 对账属于 WA-014。
- 未执行 commit、push、PR、Release 或生产部署；远端 CI 与安装包验收尚未运行。
