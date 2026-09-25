# ADR-0004：Legacy 迁移与双导出语义

## 状态

- 状态：Accepted
- 日期：2026-09-16
- 对应任务：WA-004
- 决策范围：legacy/旧桌面迁移、回退、工作备份与正式交付兼容

## 决策

Legacy 项目和旧桌面数据只能通过显式迁移导入新数据库。新版启动不会扫描后自动写旧目录，也不对旧数据库原地升级。迁移采用 `discover → dry-run → 用户确认 plan hash → backup → execute → readback`，每一步都持久化为 `migration_run` 和 operation。

每个来源使用稳定身份和内容 hash：

- legacy：规范化源目录、`run_manifest.json`、所引用文件及 schema/内容 hash；
- 旧桌面：应用数据目录、SQLite 文件身份、项目 id、schema fingerprint 和产物 hash；
- 重跑相同来源与 plan 时返回已完成结果，不重复创建版本；来源变化时产生新 dry-run，不复用旧确认。

迁移只读取源，写入新的 1.0 workspace。执行前使用适合来源的完整备份，并校验空间、权限、hash 和目标 schema。任何项目失败都保留原数据与已提交的独立项目结果，报告精确边界；不得把部分迁移写成全部成功。

字段映射遵循“已知才记录”：

- legacy/旧桌面正文和阶段输出导入为不可变 ArtifactVersion，并保留 source path/hash/provenance；缺失 actor、事件、request snapshot 或 run 关系标为 unknown，不补造。
- 旧 `passed`、旧报告或导出一律导入为历史材料，当前 publication gate 为 `stale`/待重新核查。
- 旧 API Key 不自动迁移，不进入报告；用户重新配置后写安全存储，只保存 credential reference。
- 文件名和 Stage 仅作为 legacy metadata，不变成新 runtime 状态机。
- 冲突项目默认新建明确标识的 imported project；不按标题或最近修改时间合并。

1.0 将导出分成两个不可混用的领域命令：

| 命令 | 用途 | 门禁 | 文件语义 |
|---|---|---|---|
| `export.working_copy` | 用户备份、交接、离线审阅 | 不要求 publication passed，但显式写 unverified/stale 状态 | `.md` 与状态清单；不使用 `_clean.txt` 和正式 HTML 名称 |
| `export.publication` | 正式发布/交付 | 共享事实门禁必须通过并绑定正文、标题、分发文案、账本与策略版本 | TXT/HTML/Markdown 等正式格式，生成 ExportRecord 和 hash |

legacy 的 `[标题]_clean.txt`、直接 HTML 和旧桌面 `final_export.md` 仍可作为历史输入和兼容读取依据，但新版不会将它们当作 current body 或核查通过证明。需要兼容输出时，由新版当前记录单向生成 `run_manifest`/文件副本；这些文件不是第二写入源。

## 约束

- dry-run 必须列出来源、目标、项目数量、字节数、将创建/跳过/阻断项、秘密处理、备份位置和不可逆影响；用户确认绑定 plan hash。
- 来源在 dry-run 后改变时执行失败，不能静默采用新文件。
- 路径解析拒绝绝对路径注入、`..` 越界、符号链接/联接点越出来源根和未知设备文件。
- 迁移不访问互联网、不调用模型、不把本地正文上传；诊断包另行预览和授权。
- 正式导出只能调用 writing-core 的共享 gate，UI、CLI、迁移脚本和兼容脚本不能各自判断 `passed`。
- 外部文件覆盖默认拒绝；明确覆盖时先创建可恢复备份，并将目标原 hash 纳入 operation 输入。
- 删除旧目录或旧数据库不属于迁移成功后的自动清理；只能由用户另行明确操作。

## 证据

- `docs/architecture/BASELINE_AUDIT.md` 已记录两套真实旧桌面 schema、目录格式、文件/数据库双写顺序和明文 `secrets.json` 风险。
- `tests/fixtures/legacy/` 保存不含私人正文和 Key 的 legacy manifest、SQLite schema 与 fact-check-v2 损坏夹具。
- 当前 legacy 的 publication gate 绑定正文、标题、账本、claims 和报告 hash，任一变化都会使旧 `passed` 失效。
- 需求包 `RUNTIME_CONTRACTS.md` 明确 `working_copy` 与 `publication` 两种 ExportRecord mode，以及 migration dry-run/execute 命令。
- 旧应用导出没有 1.0 的 request snapshot、operation、CAS 或共享门禁，因此不能直接提升为新版正式交付。

## 备选方案与拒绝理由

1. **启动时自动迁移。** 拒绝。用户无法预览来源、空间、冲突和秘密影响，也难以对部分失败回退。
2. **原地修改旧数据库/目录。** 拒绝。会破坏回退和历史支持，且旧 schema 无 migration 版本。
3. **按标题/修改时间自动合并项目。** 拒绝。标题不唯一、mtime 不可靠，可能混合客户或文章数据。
4. **保留数据库和 Markdown 双向同步。** 拒绝。产生两个权威源、冲突和门禁漂移；改为显式导入新版本。
5. **把旧 `passed` 当作新版通过。** 拒绝。旧状态没有完整绑定当前领域版本和策略，存在事实安全风险。
6. **复用 `_clean.txt` 作为工作备份。** 拒绝。该名称在 legacy 中暗示发布收尾，会误导用户绕过核查。

## 数据与安全影响

- 源目录和旧数据库始终只读打开；迁移报告默认隐藏正文、Key、完整用户路径和敏感标题，只显示必要计数与 hash 摘要。
- provenance 保留真实来源与 unknown，不将 Agent 推断写成用户事实。
- 备份和新 workspace 的访问权限继承用户选择位置；备份清单记录可恢复方法和验证结果。
- publication 文件名需清洗保留名、尾点、控制字符和路径分隔符；长路径和同名采用稳定后缀，不扩大删除范围。
- 工作备份显著携带 `UNVERIFIED`/`STALE` 状态元数据；纯文本无法内嵌状态时同目录生成清单且 UI 二次提示。

## 测试与验收

- fixture 测试覆盖 legacy manifest 正常/缺文件/越界、旧桌面 schema 变体、重复项目和损坏数据库，且不需要真实用户数据。
- dry-run 测试证明零写入；plan hash、来源 hash 或目标 revision 改变后执行必须拒绝。
- 迁移故障注入覆盖备份失败、空间不足、单项目事务失败、进程中断、重跑和 readback 不一致。
- 导入后逐项目核对内容 hash、版本数、unknown 字段、provenance、gate=`stale`，且不会导入 secrets。
- export 合同测试覆盖 working_copy 无通过状态、publication 的所有失败门禁、正文/标题/账本变化后的 stale，以及相同 operation 幂等。
- 文件系统测试覆盖 Windows 保留名、长路径、Unicode、同名、只读目标、符号链接/联接点和原子替换失败。

