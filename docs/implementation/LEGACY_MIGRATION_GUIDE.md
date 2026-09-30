# Legacy 只读迁移指南

本指南适用于 WA-016 的两类旧数据：`articles/<project>/` 的 manifest/Markdown 项目，以及旧桌面 0.1.0 的 SQLite + `project.json`/产物目录。迁移由新版 CLI 独立完成，不要求安装或启动旧桌面应用，也不会原地升级旧数据库。

## 1. 迁移边界

| 来源 | 会导入 | 不会导入或升级 |
|---|---|---|
| manifest 项目目录 | `run_manifest.json` 指向的当前正文；显式或约定的标题、证据账本、评审备注；显式 `style_profile_id` | 未被 manifest 引用的任意文件；`.claude` prompt/agent 不会成为可执行运行时；旧事件历史不会被猜测重建 |
| 桌面 0.1.0 | 与所选 `project.json` 匹配的项目元数据和 `stage_outputs` 历史；研究、提纲、标题、正文、评审等映射为新版工件版本；旧风格引用 | `secrets.json`、API Key、旧应用代码、Tauri 启动链；数据库中不存在的用户决定不会被伪造 |

所有导入版本的作者归因为 `unknown/legacy_import`。旧 `passed` 只留在迁移审计信息中，新项目事实门禁始终为 `not_checked`，必须针对当前正文重新核查。旧风格只保存为 `legacy_unknown` 引用，并要求用户重新确认，不会升级为新版已验证风格。

API Key 不在扫描范围、plan、普通报告或源备份中。确需继续使用模型时，应在迁移完成后另行获得用户同意，再通过 `credential set --from-env` 写入系统安全存储；不要把 Key 添加到迁移 JSON。

## 2. 迁移前准备

1. 保留旧源的原始副本。内置 `source-backup` 只覆盖扫描清单中的相关文件，不替代整机或完整旧目录备份。
2. 桌面来源建议先正常退出旧应用，避免扫描与执行之间仍有写入；旧应用无需卸载，也无需再次启动。
3. 为新版选择与旧源不同的目标 workspace。目标不能位于旧源目录内。
4. 桌面来源同时准备旧 `writing-agent.db` 与合法产物根目录；不要只提供数据库中的历史绝对路径。
5. 在仓库根目录使用 Node 24.15+。以下示例使用 PowerShell，并把 plan 保存为本机 UTF-8 文件。

## 3. 先 dry-run，再检查 plan

manifest 来源：

```powershell
$planFile = Join-Path $env:TEMP "writing-agent-manifest-migration-plan.json"
node --import tsx apps/cli/src/main.ts migrate scan `
  --kind manifest `
  --source "D:\legacy\articles\project-name" `
  --workspace "D:\WritingAgent\workspace" |
  Set-Content -LiteralPath $planFile -Encoding utf8
```

旧桌面来源：

```powershell
$planFile = Join-Path $env:TEMP "writing-agent-desktop-migration-plan.json"
node --import tsx apps/cli/src/main.ts migrate scan `
  --kind desktop_v0_1 `
  --source "D:\legacy-desktop\writing-agent.db" `
  --artifacts-root "D:\legacy-desktop\workspace" `
  --workspace "D:\WritingAgent\workspace" |
  Set-Content -LiteralPath $planFile -Encoding utf8
```

`scan` 不创建目标 workspace。执行前至少检查：

- `source.kind` 和本机来源路径是否正确；plan 含本机路径，应留在本机，不作为普通诊断报告外发。
- `sourceContentHash`、项目数、目标项目 ID、工件数和 warnings 是否符合预期。
- `migratedFactStatus` 必须为 `not_checked`；有旧风格时 `styleStatus` 必须为 `legacy_unknown`。
- `credentialDisposition` 必须为 `excluded_requires_explicit_consent`。
- `spaceCheck.ok` 必须为 `true`。空间不足时 scan 返回非零，不得继续执行。

不要手改 plan。执行时会重新扫描同一来源并复算 `planHash`；来源、目标或清单发生变化会以 `MIGRATION_PLAN_STALE` 拒绝，且不会先创建目标。

## 4. 执行与读回

确认 plan 后执行：

```powershell
node --import tsx apps/cli/src/main.ts migrate apply --plan $planFile
```

执行顺序固定为：重新扫描和 hash 校验 → 空间/目标可写预检 → 独立源备份 → 既有新版数据库备份（如存在）→ 幂等写入 → 再次核对旧源 hash → 原子写完成报告。中断后可使用同一 plan 重跑；项目 ID 与 operation ID 均由来源定位和内容清单稳定生成，不会重复造项目或版本。

完成产物位于：

```text
<workspace>/.writing-agent/legacy-imports/<importId>/
├── source-backup/
├── state.json
├── target-before.sqlite3   # 目标原先已有新版数据库时才存在
└── report.json
```

以 `report.json` 为完成依据，并核对 `status=completed`、`sourceUnchanged=true`、项目 ID、版本数、`factGateStatus=not_checked`。报告只保存相对备份位置、hash 和计数，不含正文、Key 或完整旧源路径。迁移项目可通过新版 Application Service/Client Bridge 打开；当前自动测试已覆盖此链路，正式桌面壳与安装包由 WA-017/WA-018 验收。

## 5. 精确回退

项目级回退必须同时提供 workspace 内的完成报告和报告中的目标项目 ID：

```powershell
node --import tsx apps/cli/src/main.ts migrate rollback `
  --workspace "D:\WritingAgent\workspace" `
  --report "D:\WritingAgent\workspace\.writing-agent\legacy-imports\<importId>\report.json" `
  --confirm-project "legacy-<project-id>"
```

回退只删除确认的迁入项目，不影响目标中原有项目；若项目在迁移后已继续编辑，revision 不一致会阻断删除。成功后写入幂等 rollback receipt，同一命令重跑不会扩大删除范围。

若需要恢复迁移前的整个新版数据库，只能显式选择该次 `target-before.sqlite3`，按存储恢复流程先恢复到另一个空 workspace 并读回确认；不要在应用运行时手工覆盖 `workspace.sqlite3`。旧源从未被迁移过程修改，因此无需“还原旧源”，也不要在迁移成功后自动删除旧目录。

## 6. 常见失败

| 错误码 | 含义与处理 |
|---|---|
| `MIGRATION_PLAN_STALE` | dry-run 后来源或目标选择变化；重新 scan 并重新确认 |
| `TARGET_SPACE_INSUFFICIENT` | 目标空间不足；换目标或释放空间后重新 scan |
| `TARGET_NOT_WRITABLE` | 目标不是可写真实目录，或最近的既有父目录不可写；修复权限或换目标 |
| `LEGACY_SCHEMA_UNSUPPORTED` / `LEGACY_DATABASE_CORRUPT` | 数据库版本不支持或完整性失败；不清库、不原地升级，保留旧源并人工检查 |
| `LEGACY_ARTIFACT_MISMATCH` | SQLite 内容与同名产物文件不同；先确认哪份是合法来源，不自动代选 |
| `SOURCE_BACKUP_HASH_MISMATCH` / `MIGRATION_BACKUP_MISSING` | 源备份内容变化，或已完成记录引用的备份缺失；停止重跑并人工审计 |
| `ROLLBACK_CONFIRMATION_MISMATCH` | 确认项目不属于该报告；重新核对报告，不扩大删除范围 |

任何失败都不授权清空数据库、重新初始化目标、删除旧目录或迁移 Key。
