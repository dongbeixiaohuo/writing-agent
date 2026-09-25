# WA-005 领域与 SQLite 存储验证结果

状态：`PASS_LOCAL`  
日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- 在 `packages/writing-core` 建立 `quick/deep` 项目模式、actor、工件/版本/来源边、项目事件、命令 envelope、统一 mutation result 和 `StoragePort`。
- 在 `packages/storage` 建立每 workspace 一个 `.writing-agent/workspace.sqlite3` 的 Node `node:sqlite` adapter，固定 application ID、schema version、WAL、foreign key 和 STRICT 表；每次打开都启用 defensive、禁用扩展并读回验证 ADR 要求的 PRAGMA。
- 项目、operation、不可变工件版本、显式指针、项目序列事件、来源边、事实快照/门禁状态在单个 `BEGIN IMMEDIATE` 事务中提交。
- 支持 project revision 与 base version 双重 CAS、`operationId + inputHash` 幂等回放、同内容 no-op、显式回退新版本、旧核查状态失效。
- 支持只读打开/检查、未来 schema/损坏库/已有空库 fail-closed、在线备份、仅向空目标恢复选定备份，以及带项目 ID 二次确认的范围删除；删除后仅保留删除 operation 作为幂等 tombstone。
- 未实现 provider、run/session/request snapshot 组装、工具权限、完整事实门禁计算或 UI；这些仍属于后续任务。

## 2. TDD 记录

按可观察的领域/StoragePort 接口分三条竖切：

1. 先写项目创建、事件和重启读回测试；初始失败为 `packages/*/src/index.js` 不存在，补最小实现后通过。
2. 先写不可变版本、CAS、幂等、no-op、回退、门禁失效和故障注入测试；初始失败为版本命令不存在，补事务实现后通过。
3. 先写未来/损坏 schema、只读、磁盘错误、删除和备份恢复测试；初始失败为恢复接口不存在，补 fail-closed 与恢复边界后通过。

之后依据 F07 增加 `quick/deep`、创建事件号和 SQLite 来源边契约；测试先因旧临时模式和缺少来源 API 失败，修正模型后通过。

## 3. 验收映射

| 验收 | 本地证据 | 结果 |
|---|---|---|
| AT-05 | 在版本插入后、项目指针更新后、事务提交前分别注入故障；另由子进程在事务中直接退出并重开数据库。项目 revision、指针、版本、事件和 operation 均无半提交，原 operationId 可重试 | PASS |
| AT-06 | 相同 operationId/输入返回保存的同一结果且版本数不增加；同 ID 换输入返回 `IDEMPOTENCY_KEY_REUSED` | PASS |
| AT-23 | 未来 schema、损坏文件、只读打开和确定性 `SQLITE_FULL` 均显式失败；原文件/已提交数据保留，支持只读检查 | PASS_LOCAL |
| AT-27 | 相同内容返回 `no_change` 且 revision/版本数不变；回退创建新版本、新事件和父版本来源边 | PASS |
| AT-28 | 错误确认 ID 拒绝删除；正确删除只级联目标项目；在线备份恢复分别证明选择早期/后期快照会得到对应状态 | PASS |

AT-23 的磁盘耗尽使用错误码为 `SQLITE_FULL` 的确定性事务故障注入，以稳定验证应用回滚和错误映射；没有把开发机磁盘实际填满，因此不记录为物理磁盘压力测试。

## 4. 验证命令

### `npm run check:runtime`

结果：PASS。

- TypeScript strict/noEmit：PASS。
- Node test runner：12 项通过，0 失败，覆盖领域、foundation、schema、versioning、真实子进程退出恢复和 recovery。

### `npm run check:m0`

结果：PASS。

- Node 24 `node:sqlite` foundation smoke：PASS。
- M0 架构、来源和 legacy fixture：11 项通过。
- WA-005 `check:runtime`：12 项通过。

### 整仓与发行镜像回归

结果：PASS。

- `npm ci --ignore-scripts`：干净安装 309 个包，0 vulnerabilities。
- `npm run check`：Python 226 项通过、1 项按设计跳过；26 个 Python 文件语法、workflow/docs、`claude-runtime` 同步、plugin/marketplace strict validation 全部通过。
- `RUN_PLUGIN_INSTALL_TEST=1` 的隔离插件安装：1 项通过。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 需求包检查：25 个任务、38 个验收场景、依赖图/引用/链接全部通过。
- `git diff --check`：通过；仅有 Windows 工作树 LF→CRLF 提示，无 whitespace error。

## 5. 边界与后续

- `recordFactAssessment` 是 StoragePort 内供受信 Application Service 使用的持久化原语，不是暴露给模型的“直接写 passed”工具；事实状态计算和授权仍须由后续 fact-check/application-service 层完成。
- `requestSnapshotId` 已作为版本的可空来源字段固定，但真正的最终可见请求快照由 WA-008 实现后写入，当前测试只验证 `null` 不被伪造。
- 本轮没有 commit、push、PR、Issue、tag、Release、真实模型调用或真实项目数据迁移。
- 远端 GitHub Actions、跨进程高并发压力和物理只读目录/磁盘耗尽仍未执行，不能由本地故障注入替代。
