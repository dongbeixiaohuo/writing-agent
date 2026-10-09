# WA-012 本地实施与验收结果

日期：2026-09-17  
状态：`COMPLETE_LOCAL`  
任务：实现块级局部修改、锁定、差异与冲突保护

## 1. 交付结果

- `writing-core` 新增版本化 Markdown 块、四类整块 edit、持久修改提案、差异、锁决定和命令 schema。
- SQLite schema 升至 v5，增加 `body_documents`、`revision_proposals`、`block_lock_decisions`；v1–v4 仍按顺序备份迁移，v4 既有正文补建块索引。
- Storage/Application Service 跑通 propose → diff → accept/reject、全文手动保存、lock/unlock 和显式 rollback；所有正文写入都检查有效锁。
- Client Bridge 升至 v3，进程内 adapter 与受保护 Local Web Remote 使用同一命令/投影；正文请求限制 2 MiB，浏览器不提供 actor、路径、Key 或直写数据库能力。
- DSH 派生右栏新增“稿件与版本”面板：块级局部编辑、锁定、差异预览、接受/取消、版本列表和显式回退。Mock 明示“演示只读”。

详细语义见 `docs/architecture/REVISION_CONTRACT.md` 与 `docs/architecture/CLIENT_BRIDGE_PROTOCOL.md`。

## 2. 自动验证

| 范围 | 证据 | 结果 |
|---|---|---|
| 领域块模型 | 稳定且无歧义的 block ID 复用；错误 ID/hash 拒绝；四类 edit 差异和应用 | PASS |
| SQLite/CAS | 标题 heading 与正文 paragraph 锁、提案预览/接受、旧窗口保存拒绝、提案后加锁竞态、no-op、rollback | PASS |
| schema v5 | v4 备份迁移并为既有正文补建 `BodyDocument`；原数据保留 | PASS |
| Application/Bridge | 锁、持久 diff、新版本和项目级编辑状态投影；跨项目为空 | PASS |
| Local Web | Web Remote 对真实 Application bridge 执行 lock/propose/accept，重连后读回 | PASS |
| Mock/UI 单测 | 项目切换清空修订面板；取消迟到结果回归；列宽约束 | PASS |
| 真实浏览器 | Chromium 1440×960 挂载/卸载右栏、版本 tab、跨项目切换、无 console error | PASS_LOCAL |

真实浏览器脚本与截图：`output/wa012_playwright_check.py`、`output/wa012-ui-mock.png`。脚本通过 `webapp-testing` 的受控本地 server helper 启动/停止 Mock Vite 服务；该截图证明实际 DOM/交互，不代表 production 已连接真实付费模型。

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-08 | `PASS` | 接受新基准修改后，用旧 project revision/body version 保存返回 `REVISION_CONFLICT`；当前已保存版本保持不变 |
| AT-09 | `PASS` | Agent 通用提交修改锁定块返回 `LOCK_CONFLICT`；提案建立后再加锁，接受时仍会二次拒绝并持久化 conflicted |
| AT-10 | `PASS_REGRESSION` | Bridge 既有取消测试继续证明持久取消后的迟到 Provider 结果不提交正文 |
| AT-27 | `PASS` | 同内容手动保存不增加版本；显式 rollback 创建新版本，历史版本总数和事件保留 |
| AT-33 | `PASS_WA012_SCOPE` | 实际浏览器挂载/卸载稿件面板、切换版本 tab 与项目；Mock/Bridge 单测证明无跨项目块或提案状态污染。核查入口已由 WA-013、完整视觉矩阵已由 WA-025 收口 |

## 4. 验证命令

```powershell
npm run check:runtime
npm run test:bridge
npm run check:ui
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B tests/check_document_pack.py
python C:\Users\Dante\.agents\skills\webapp-testing\scripts\with_server.py --server "npm run ui:dev:mock -- --host 127.0.0.1 --port 4173" --port 4173 -- python output/wa012_playwright_check.py
```

本轮结果：Node 24.18.0 下 runtime 86/86；UI 8/8；Bridge/Host 8/8；UI/来源 Python 7/7；M0 Python 11/11；legacy 231 通过、1 条既有条件跳过；production dependency audit 为 0 vulnerabilities；需求包 25 个任务、38 个验收场景的一致性检查全部 PASS。没有删除、跳过或改写失败测试来获得通过。

## 5. 未宣称内容

- 未调用真实 Provider 或付费模型；“局部生成”当前验证的是持久提案/差异/接受合同与 UI，不是模型改写质量。
- 当前是 Markdown 整块修改，不是字符级多人实时协作，也不自动三方合并。
- 正文首个 Markdown heading 可作为标题块锁定；独立 `title` Artifact 的确认界面、核查/来源详情和输入变化后的门禁失效传播仍待后续标题/WA-013 界面，正式导出属于 WA-014。
- Mock 修订面板只读；production 通过 Client Bridge v3 才能写入真实项目。
- 未执行 commit、push、PR、Release 或生产部署；远端 CI 与安装包验收尚未运行。
