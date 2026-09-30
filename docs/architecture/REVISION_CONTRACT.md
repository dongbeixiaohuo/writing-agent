# 正文块修订与锁定契约

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-012  
领域权威：`packages/writing-core/src/index.ts`  
持久化权威：`packages/storage/src/index.ts`、`packages/storage/src/schema.ts`

## 1. 模型边界

已提交的 `ArtifactVersion` 仍是不可变正文事实源；`BodyDocument` 是与该版本一一对应的块索引，不取代原始正文。当前解析器版本为 `markdown-blocks-v1`，识别 heading、paragraph、list、blockquote、code 和 thematic break 六类 Markdown 块。

新正文提交时会重建块索引。只有旧版与新版中都恰好出现一次、且类型、原文和 SHA-256 完全相同的块才复用 `blockId`；重复或有歧义的内容重新分配 ID，避免把锁或提案错误绑定到另一段。schema v5 为既有正文版本补建 `body_documents`，不改写原 ArtifactVersion。

## 2. 修改命令

| 命令 | 基准 | 结果 |
|---|---|---|
| `revision.propose` | project revision、当前正文版本、目标 block ID/hash | 持久化 instruction、constraints、edits 和 diff；正文不变 |
| `revision.accept` | 当前 project revision、仍为 pending 的 proposal | 重新校验基准、块与锁；通过后创建不可变正文版本 |
| `revision.reject` | 当前 project revision、仍为 pending 的 proposal | 保留 rejected 提案和事件；正文不变 |
| `body.save` | project revision、当前正文版本 | 手动全文保存；同内容返回 `no_change` |
| `body.block_lock` / `body.block_unlock` | project revision、当前正文版本、block ID/hash | 追加锁定决定与事件，不覆写历史决定 |
| `artifact.rollback` | project revision、当前版本、历史目标版本 | 复制历史内容为一个新的 `rolled_back` 版本，不删除中间历史 |

局部编辑只允许 `replace`、`delete`、`insert_before`、`insert_after` 四类整块操作；替换与插入内容必须能解析成恰好一个块。每项 edit 都携带目标 `blockId` 和 `baseBlockHash`，一个提案最多 100 项，且同一块不能在同一提案中被重复替换或删除。

## 3. 接受与冲突

提案状态为：

```text
proposed ──accept──> accepted
    │
    ├──reject──────> rejected
    └──base/hash/lock conflict──> conflicted
```

接受时在同一 SQLite mutation 中重新检查：

1. 命令携带的 project revision 仍是当前值；
2. proposal 仍属于该项目且状态为 `proposed`；
3. 当前正文版本仍等于 proposal 的 `baseBodyVersionId`；
4. 每个目标块仍存在且 SHA-256 与 proposal 一致；
5. 提交结果没有修改或删除任何当前有效锁定块。

任一基准失效返回 `REVISION_CONFLICT`；锁定被触碰返回 `LOCK_CONFLICT`。冲突提案会持久化为 `conflicted` 并写入 `revision.conflicted` 事件。系统不自动做三方合并，也不把旧窗口内容覆盖到当前正文；用户只能基于最新版重新生成、手动修改，或显式解锁后再操作。

## 4. 锁定语义

`block_lock_decisions` 是 append-only 决定流。某 block 的最新决定为 `lock` 时才视为有效锁；`unlock` 必须显式执行。用户、Agent 和通用正文提交都走同一锁检查，用户身份不会自动绕过锁。正文中的 Markdown heading 也是独立 block，因此当前以首个 heading 表示的已确认标题可用同一按钮锁定。

锁绑定 block ID 和内容 hash。未触碰的唯一块可在新版本中继续保持同一 ID，因此锁随其有效；修改、删除或产生歧义都会触发 `LOCK_CONFLICT`。重复 lock 是无副作用成功，未锁定块的 unlock 明确返回 `LOCK_NOT_FOUND`。

## 5. 事务、幂等与版本规则

- 所有写命令继续经过 Application Service 与 StoragePort；浏览器不直写 SQLite。
- `operationId` 沿用统一幂等账本：同 ID/同输入返回原结果，同 ID/不同输入拒绝。
- 提案创建、接受/拒绝、锁定/解锁与正文提交都持久化事件；项目 revision 作为 CAS 边界推进。
- 手动保存和普通修订若内容完全相同，返回现有版本且不制造空内容版。
- 显式回退即使内容等于历史版本，也必须创建新版本与来源关系，以保留用户行为和完整历史。
- 正文版本、项目指针、块索引、锁检查和事件在同一事务内提交；失败不留下半个版本。

## 6. UI/Bridge 边界

WA-012 由 Client Bridge v3 暴露当前块、锁状态、版本元数据、提案与持久差异，并提供 proposal、accept/reject、save、lock/unlock、rollback 命令；WA-013 的当前协议 v4 在不改变这些写命令语义的前提下增加事实/来源只读投影。浏览器只拿到当前项目的投影，不获取 SQLite 路径、材料正文或 Provider Key；项目切换会更新 generation 并清空组件内临时编辑值。

DSH 文档预览仍是只读能力。WA-012 的“稿件与版本”右栏是本项目新增的受保护编辑面板：先形成持久差异，再由用户接受；Mock 构建只展示隔离 fixture 并保持只读，不冒充真实保存。

## 7. 已知边界

- 当前粒度是 Markdown 整块，不是字符级 OT/CRDT，也不提供多人实时协同光标。
- 不自动合并冲突；这是保护已保存用户修改的产品选择。
- 当前写作流的标题来自正文首个 Markdown heading，并按块锁定；WA-013 已接入独立 `title` Artifact 的事实门禁状态只读投影，但尚未实现独立标题编辑/确认界面，不能把正文 heading 锁误称为完整标题工作流。
- `BodyDocument` 是可重建索引；原始 ArtifactVersion 正文及 hash 始终保留。
