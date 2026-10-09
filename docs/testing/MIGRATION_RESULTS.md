# WA-016 本地实施与验收结果

日期：2026-09-18
状态：`COMPLETE_LOCAL`
任务：建立旧 manifest 与桌面库的只读迁移

## 1. 交付结果

- 新增独立 `@writing-agent/legacy-migration` 模块与 CLI `migrate scan/apply/rollback`，支持旧 `articles/<project>/` manifest/Markdown，以及实测桌面 0.1.0 SQLite + `project.json`/产物目录。
- dry-run 生成与来源定位、内容清单、目标绑定的确定性 `planHash`/`importId`，检查空间但不创建目标；执行前重新扫描，stale plan 在备份或写入前阻断。
- 旧 SQLite 以 `readOnly`、`query_only`、defensive 和 `quick_check` 打开；manifest 路径限制在所选目录内并拒绝 symlink。执行前复制清单源文件，桌面数据库用 SQLite backup API 备份并校验逻辑 hash。
- 目标已有新版数据库时先保存独立 online backup；每次复用已有源备份会逐文件和逐数据库复验，备份被改动即阻断。写入使用确定性 operation ID，中断后用同一 plan 重试不会重复项目或工件版本，完成后重复 apply 返回原报告。
- 旧正文、标题、证据、提纲、评审和可追溯 stage 历史导入为 `legacy_import` 工件；未知作者保持 `unknown/legacy_import`。旧 `passed` 仅留审计字段，新事实门禁固定为 `not_checked`。
- 旧风格引用记录为 `legacy_unknown` 且要求重新确认；不存在的用户决定和事件历史不伪造。`secrets.json`/Key 不读取、不备份、不报告，只标记为需另行明确同意。
- 精确 rollback 要求 workspace 内完成报告和匹配项目 ID，只删除该次迁入项目；目标内原有项目保留，迁入后 revision 已变化时拒绝删除。
- 新 Application Service/Client Bridge 可直接打开迁入项目；迁移模块与 CLI 不 import、启动或打包旧 `App.tsx`、旧 Tauri 或 `writing-agent-app`。

操作说明见 `docs/implementation/LEGACY_MIGRATION_GUIDE.md`。

## 2. 自动验证

| 范围 | 覆盖 | 结果 |
|---|---|---|
| dry-run | 两类来源、确定性项目身份、空间检查、不创建目标、Key 排除 | PASS |
| 源只读与备份 | manifest 目录树 hash、桌面 DB hash/产物树 hash、SQLite 备份 readback、备份篡改后拒绝续跑 | PASS |
| 失败保护 | stale plan、空间不足、目标不可写/类型错误、未来 schema、损坏 DB、工件不一致边界 | PASS |
| 中断/重试 | 工件写入后故障注入、同 plan 恢复、无重复项目/版本、完成报告重放 | PASS |
| 语义降级 | legacy passed → `not_checked`、style → `legacy_unknown`、未知作者、tentative brief | PASS |
| 回退/恢复 | 精确项目确认、保留无关项目、迁移前目标备份恢复到独立 workspace | PASS |
| 新 UI 链路 | 不启动旧应用，经 Application Client Bridge 读取正文/版本/门禁/导出状态 | PASS_LOCAL_BRIDGE |
| 静态依赖边界 | migration/CLI 无旧 App/Tauri import；检查脚本与操作文档接入整仓回归 | PASS |

专项命令：

```powershell
npx tsc --noEmit -p tsconfig.runtime.json
npm run test:migration
python -B -m unittest tests.test_legacy_migration_boundary
```

专项结果：迁移 Node 测试 15/15；静态 Python 边界测试 3/3。完整回归结果见第 4 节。

## 3. PRD 验收映射

| 验收 | 本任务结果 | 证据与边界 |
|---|---|---|
| AT-21 | `PASS` | manifest/桌面导入、旧源 hash 不变、中断重试无重复、旧 passed 不升级 |
| AT-22 | `PASS` | 风格保持 `legacy_unknown`；未知作者/来源和 tentative 决定保留；不伪造事件或用户确认 |
| AT-23 | `PASS_LOCAL_BOUNDARY` | 未来 schema、损坏 DB、确定性空间不足、不可写/非目录目标均明确失败且不清库；未改已有源数据 |
| AT-28 | `PASS` | 精确项目回退不影响其他项目；迁移前目标备份只按明确文件恢复到独立 workspace 验证 |
| AT-37 | `PASS_LOCAL_BRIDGE` | 未安装/启动旧 0.1.0，合法合成夹具迁入后由新 Client Bridge 打开；静态检查排除旧页面/Tauri；发行包终验仍属 WA-017/018 |

## 4. 完整回归

最终验证命令：

```powershell
npm run check:runtime
npm run check:m0
npm run check
npm run check:ui
npm audit --omit=dev --audit-level=high
python -B tests/check_document_pack.py
git diff --check
```

最终结果：Node 24.18.0 下既有 runtime 130/130、迁移专项 15/15；M0 Python 12/12；legacy Python 共 239 项，其中 238 通过、1 条既有条件跳过；UI 16/16、Bridge/Host 17/17、UI/来源 Python 11/11，production/mock/extension-demo 三构建及分发边界通过；production dependency audit 为 0 vulnerabilities；需求包 25 个任务、38 个验收场景一致性检查通过。`git diff --check` 通过。任何失败都没有通过删除、跳过或放宽测试掩盖。

## 5. 未宣称内容

- 只使用无私人正文、无真实 Key 的合法合成夹具；未迁移客户真实历史库，真实数据仍应先 dry-run 和人工核对。
- 未在真实磁盘写满、企业 ACL 只读目录或运行中的旧桌面写并发下压测；空间和不可写边界使用确定性注入/目标类型检查，旧桌面应先正常退出。
- 新 UI 打开验证覆盖 Application Service/Client Bridge；WA-017 后续已完成本机 Electron 安装包、启动与卸载。独立干净 Windows、签名决定和打包 UI 的完整迁移旅程仍由 WA-018/WA-021 验收。
- 未迁移 Key、未调用模型、未访问互联网，也未执行 commit、push、PR、Release 或生产部署。
