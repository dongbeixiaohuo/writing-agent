# ADR-0002：SQLite 存储与可恢复提交

## 状态

- 状态：Accepted
- 日期：2026-09-16
- 对应任务：WA-004
- 决策范围：SQLite 驱动、事实来源、事务、备份、恢复与文件副本

## 决策

Writing Agent 1.0 每个用户选择的 workspace 使用一个 SQLite 数据库：

```text
<workspace>/.writing-agent/workspace.sqlite3
```

新 runtime 的最低 Node 版本为 24.15.0，初始 CI 固定在 Node 24.18.0。存储实现采用 Node 内置 `node:sqlite` 的 `DatabaseSync`，并只通过本项目 `StoragePort` 暴露领域事务；业务层和 UI 不直接持有数据库连接或 SQL。

选择 `node:sqlite` 的原因是：不增加 `better-sqlite3` 一类 native addon 的 Electron ABI/重编译矩阵，Node 自带事务与 backup 能力，且固定 DSH 源码也提供了同一路径的实际参考。`node:sqlite` 在当前 Node 24 文档中仍为 Stability 1.2，因此通过窄适配层隔离；Beta 前若其稳定性或打包验证失败，可替换 StoragePort 实现而不改变领域契约。

每次打开数据库必须显式设置并读回验证：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
PRAGMA trusted_schema = OFF;
```

同时禁用运行时扩展加载，使用 defensive 模式，并以单进程写队列串行化本应用的写事务。`foreign_keys` 不能依赖 SQLite 默认值。1.0 支持本地文件系统 workspace；网络共享、同步盘按需文件和不支持 WAL 锁语义的文件系统默认拒绝写入，除非后续用目标环境完成专门兼容测试并形成 ADR。

数据语义如下：

1. `artifact_versions`、请求快照、事实快照、评审和领域事件为不可变记录。
2. 项目当前指针、run 状态等是同一事务内更新的投影；每个写命令用 `operationId + inputHash` 幂等，并检查 `expectedProjectRevision`。
3. 内容版本、来源边、事件、门禁失效、operation 结果和项目 revision 在一个事务提交；提交后才广播事件。
4. schema 只通过有序 migration 前进。数据库 schema 高于程序支持版本时拒绝写入；不自动降级、不删除重建。
5. `.md`、TXT、HTML 和兼容 `run_manifest` 都是派生输出。外部修改须显式导入为新版本，不能静默反写数据库。

恢复策略：

- 本地事务未提交时由 SQLite 回滚；同一 `operationId` 可重新验证后执行。
- 已提交 operation 重放时返回原结果；同 ID 不同 input hash 返回 `IDEMPOTENCY_KEY_REUSED`。
- 每次 schema migration、legacy migration 和破坏性维护前，使用 SQLite online backup API 写入唯一的新备份文件，完成后执行 `quick_check`、记录 hash/大小/schema 版本，再允许下一步。
- 启动时检查 schema、`quick_check`、未完成 operation、run 和 export。损坏、空间不足、权限错误或新版本数据库均 fail closed，保留原文件并给出可操作诊断。
- 数据库备份恢复写到新的临时目标，验证后原子切换；不在打开的数据库上做文件级覆盖。
- 取消先持久化状态再触发 AbortSignal；迟到的 provider/tool 结果不得提升为已提交正文。

## 约束

- `DatabaseSync` 是同步 API，只能在 Application Service 的受控存储执行上下文内使用；不得在 renderer 或请求渲染热路径散落 SQL。
- 同一 workspace 同时只允许一个写宿主。第二实例必须只读或明确提示占用，不能靠最后写入取胜。
- WAL、主库、`-wal` 和 `-shm` 是一组数据库状态；运行时不得用普通文件复制声称完成在线备份。
- API Key、OAuth token 和系统凭据不进入业务 SQLite；只存安全存储的非秘密引用与必要元数据。
- 文件导出采用同目录临时文件、flush/close、原子 rename，并在数据库记录文件 hash；数据库提交与外部文件系统无法组成单事务时，用持久 operation 状态对账。
- 根 legacy 包继续支持 Node 18.17+；只有新的 runtime workspace 和 M0 foundation CI 使用 Node 24.15+，直至正式切换方案另行验收。

## 证据

- `docs/architecture/BASELINE_AUDIT.md` 记录旧桌面数据库为 `foreign_keys=0`、`journal_mode=delete`，且文件与数据库双写无共同事务。
- 需求包 `RUNTIME_CONTRACTS.md` 要求每 workspace 一个 SQLite、不可变事件/内容、operation 幂等、CAS 和派生导出。
- 固定 DSH 源码的 `packages/storage/storage-sqlite` 使用 `node:sqlite`，说明该 API 与所选上游技术栈可共同构建；本项目不直接复制其领域 schema。
- Node 24 官方文档将 `node:sqlite` 标为 Stability 1.2，并提供同步 `DatabaseSync` 与 `backup()`。
- SQLite 官方文档要求每个连接显式开启 foreign key；online backup API 生成数据库一致快照，优于打开期间直接复制文件。

## 备选方案与拒绝理由

1. **`better-sqlite3`。** 暂不选。API 成熟，但会增加 Electron/Node ABI、Windows 工具链和 native 预编译产物验证；若内置 API 阻断，可在 StoragePort 后重新评估。
2. **SQLite WASM。** 拒绝作为主存储。桌面和本地服务已有 Node 文件系统能力，WASM 会增加持久化、锁和大内容复制复杂度。
3. **JSON/JSONL 或 Markdown 为权威状态。** 拒绝。难以同时保证 CAS、跨表约束、幂等 operation 和原子门禁失效。
4. **单个全局数据库。** 拒绝。会削弱 workspace 可移植、备份和故障隔离，也扩大误操作范围。
5. **数据库与项目文件双向自动同步。** 拒绝。冲突和部分失败会形成两个权威源；外部变更必须显式导入。
6. **在启动时自动清库或原地修复未知 schema。** 拒绝。可能不可逆丢失用户数据；只允许备份后的显式维护流程。

## 数据与安全影响

- `foreign_keys`、CAS 和单事务提交降低悬空引用及部分写入风险；`synchronous=FULL` 优先保证已确认提交的耐久性。
- `trusted_schema=OFF`、禁扩展和 renderer 隔离减少恶意数据库触发非预期代码路径的机会。
- workspace 边界、路径规范化和文件 allowlist 必须在打开数据库或导出前完成，拒绝符号链接/联接点越界。
- 备份清单可能包含项目标题等元数据，诊断导出需单独预览和脱敏；备份本身沿用 workspace 权限，不上传网络。
- 业务删除先写 tombstone/operation，再按可恢复策略处理文件；不执行宽目录递归删除。

## 测试与验收

- `tests/check_node_sqlite.mjs` 在 Node 24.15+ 验证 SQLite 加载、WAL、foreign key、STRICT 表、事务、`quick_check` 和 online backup/readback。
- 存储合同测试覆盖正常提交、异常回滚、相同 operation 重放、ID 复用、CAS 冲突、门禁失效和事件序列。
- 故障注入覆盖磁盘满、只读目录、数据库忙、进程在事务中退出、导出 rename 前后退出和备份中断。
- 打开测试覆盖损坏库、未来 schema、旧 schema migration、WAL 残留和第二实例。
- Windows 打包测试必须验证 Electron 内 Node 与开发 Node 使用同一 SQLite 行为；不能只在源码环境通过。
- 性能基线记录长文章、事件重放和批量 migration 时的最长同步事务；若影响事件循环，将存储执行移到 utility/worker process，接口不变。
