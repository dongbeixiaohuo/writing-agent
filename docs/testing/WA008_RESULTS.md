# WA-008 自有循环、Session 与请求快照验证结果

日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- 在 `packages/runtime/agent` 实现仓库自有 `AgentRuntime.run(...)`：每次模型请求先落不可变快照和 `request.prepared`，再记录真实 dispatch attempt；完整收集 stream，只有经过校验的 tool call 才进入工具注册表，工具结果按原 call ID/name 注入下一轮模型请求。
- 确定性两轮测试实际走完 model → `read_material` → tool result → model，最终文本经受信 `FinalOutputCommitter` 写入真实 SQLite 不可变正文版本，版本的 `requestSnapshotId` 指向最后一次模型输入。
- 在 `packages/runtime/session` 固定 `SessionStore` 公开合同；SQLite schema v2 新增 `sessions`、`runs`、`request_snapshots`，事件增加可查询 `run_id`，仍由同一项目递增 `projectSeq` 排序。
- 每份请求快照同时保存 provider-neutral 逻辑请求和 provider 最终序列化载荷，另存 provider/model/adapter/serialization/assembly 版本、参数、版本化工具 schema、内容引用、redaction/unreconstructable 声明及三组 SHA-256。工具结果全文保留在对应 model message 中，内容引用不是只有 hash 的死指针。
- `OpenAICompatibleProvider.snapshotRequest(...)` 与实际 HTTP 发包共用 `serializeRequest(...)`；集成测试逐项断言两轮 snapshot normalized payload 与本机 HTTP server 收到的 body 完全一致，Authorization 不进入载荷。
- 重启后 `rebuildModelRequest(snapshotId)` 只读 SQLite 即可恢复 system/user/assistant tool call/tool result/schema/参数；不会构造 provider 或发网络请求。直接篡改 normalized payload 后 hash 校验拒绝重建。
- schema v1 不会静默修改。显式 `migrateWorkspaceStorage(...)` 先用 SQLite online backup API 生成唯一备份并核对 application ID、旧 schema 与 `quick_check`，再在事务中按 1→2 迁移；测试验证项目与旧正文保留、备份仍为 v1。
- `apps/cli` 提供最小 `npm run runtime:cli -- request rebuild --workspace ... --snapshot ...` 离线入口；真实模型配置和 Application Service 命令面留给后续编排任务。

本项没有使用外部 DSH runtime、DSH CLI 或 Claude Agent SDK，也没有生成“进度百分比”一类虚假领域事件。`request.completed`、`tool.completed`、`run.completed` 只在对应动作真实结束并持久化时写入。

## 2. TDD 记录

公开 seam 在写测试前固定为：`AgentRuntime.run(...)`、`SessionStore.get/list/rebuild...` 和最小 CLI；测试不调用私有循环步骤或私有 SQL helper。

首轮红灯为三个新模块均不存在的 `ERR_MODULE_NOT_FOUND`。随后按最小竖切转绿：

1. session/run/request snapshot 持久化、重启读取、不可变 ID、离线重建和篡改拒绝；
2. 两次模型请求、一次真实工具执行、tool call/result 对应、正文提交和项目事件序列；
3. provider wire payload 与快照等价、鉴权头不入库；
4. provider 失败只请求一次，持久化 `request.failed`/`run.failed`，不产生正文或假成功；
5. v1 verified backup 后有序迁移到 v2；
6. 新 runtime 生产源码/包清单不导入或启动外部 DSH/Claude agent engine。

## 3. 需求与验收映射

| 条目 | 本地证据 | 结果 |
|---|---|---|
| IND-02 | session、循环、工具调度、请求格式与 CLI 均由本仓库源码负责；生产闭包扫描无 external DSH/Claude agent SDK import、dependency 或进程启动 | `PASS_LOCAL_SOURCE_CLOSURE` |
| F02 | 真实多轮工具循环可连续推进，工具权限由应用签发；最终结果可提交正式版本 | `PASS_LOCAL_FOUNDATION`；完整 quick/deep 写作任务链归 WA-010 |
| F05 | project-scoped session/run、不可变最终请求/schema/参数/内容引用、项目递增事件、离线重建及篡改拒绝 | `PASS_LOCAL` |
| AT-02 | 确定性模型先请求 `read_material`，收到真实工具结果后生成正文；call ID/name 对应，正文版本绑定最终 snapshot | `PASS_LOCAL_MOCK`；未冒充真实付费 provider 验收 |
| AT-03 | 关闭并重开 SQLite 后完整重建第二次请求，CLI 同样离线恢复；无 provider/network | `PASS_LOCAL` |
| AT-24 | 新 runtime 源码和模块 manifest 独立性扫描通过 | `PASS_LOCAL_SOURCE`；安装包依赖/进程终验仍归 WA-018/RC |

## 4. 验证命令

```powershell
npm run check:runtime
npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.runtime.json
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B tests/check_document_pack.py
python -B scripts/check_claude_runtime_sync.py
git diff --check
```

最终数量和退出码以本轮命令输出为准；当前没有 commit、push、PR、Issue、tag、Release 或远端 CI 记录。

本轮最终读回：

- `check:runtime`：57/57 通过；
- `check:m0`：Node SQLite foundation 通过，11/11 M0 Python 测试通过，57/57 runtime 测试通过；
- `check`：226 项 legacy/Python 测试通过，1 项按既有环境条件跳过；脚本、工作流、docs、runtime 同步和 plugin manifest 均通过；
- production audit：0 vulnerabilities；
- PRD 文档包：25 个任务、38 个验收场景、依赖/链接/来源检查全部通过；
- 严格 TypeScript `noUnused` 与 `git diff --check`：退出码 0（Git 仅提示既有 LF/CRLF 转换警告）。

## 5. 明确保留到后续的边界

- WA-009：持久取消、统一模型/工具/重试/修订预算、崩溃后 `interrupted`、外部请求 `unknown_outcome` 与 operation 对账。WA-008 的 32 次硬安全上限只是防止无预算层时无限循环，不是产品预算实现。
- WA-010：材料实体持久化、中性写作能力包、完整 quick/deep 任务链、写入型模型工具和真实文章样例。
- WA-011 及 UI 任务：Application Service 命令面、正式 CLI run 配置、bridge、Web/Desktop/DSH UI。
- WA-018：真实授权模型、发行包依赖与子进程扫描、取消/恢复/安全/迁移候选验收。
