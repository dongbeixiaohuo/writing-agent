# WA-010 中性写作能力包与文章闭环验证结果

日期：2026-09-17  
分支：`next/runtime`

## 1. 完成范围

- 新增中性 `packages/writing-pack`。它直接使用 `WritingBrief`、材料元数据和 quick/deep 模式，不加载 `.claude`、`claude-runtime`、Claude SDK 或 DSH 外部宿主。
- 将旧写作方法压缩为有界任务：quick 4 项、deep 8 项；评审角色只读，只有主笔可提交正文和进行集中修订，重大修订分别限制为 1/2 轮。旧 Stage 映射见 `packages/writing-pack/STAGE_MAPPING.md`。
- 保留四类文体、材料不具指令权限、作者声音、用户确认/授权代选区别、第一手素材授权和“无收益不改”的集中修订规则。没有已授权一手材料时，提示词明确禁止补造作者亲历。
- SQLite schema v4 新增 `materials`、`writing_brief_versions`、`decisions`，项目投影增加 `current_brief_version_id`。材料保存来源类别、导入时间、不可变内容版本/hash、角色、信任标签与项目可见范围；简报和显式决定均走 operationId、项目 revision 与持久事件。
- 新增 `WritingApplicationService` 作为 CLI 的统一写边界。它从当前简报和项目材料建立 writing-pack 提示词，注册受控只读工具，调用仓库自有 AgentRuntime，并以 CAS 提交最终正文版本。
- CLI 新增 `run`：读取显式指定的 UTF-8 brief/material/provider 配置，创建项目、导入材料、保存简报/授权决定，完成材料工具往返和草稿保存。路径仍经 `AuthorizedPathPolicy`，非 UTF-8 在任何项目写入前拒绝。
- 提供确定性 mock 和 OpenAI-compatible 真实 provider 配置示例。真实配置仅从环境变量解析 Key；仓库未使用真实 Key，也未发起付费调用。

## 2. TDD 记录

写测试前固定的公开 seam 为：

1. `WorkspaceStorage.importMaterial/saveWritingBrief/recordDecision`；
2. `createWritingPlan/buildWritingPrompt`；
3. `WritingApplicationService.runDraft`；
4. CLI `run`。

测试使用真实 SQLite，只替换模型外部边界。首轮红灯分别为材料/简报方法不存在、writing-pack 模块不存在、Application Service 不存在和 CLI 不识别 `run`。转绿后覆盖：

- 项目级材料隔离、不可变快照/hash、简报版本、授权决定和持久事件；
- 简报引用跨项目/不存在材料时拒绝；只有 `user_firsthand` 材料可授权作者亲历；
- quick/deep 不超过 4/8 个逻辑任务，只有一个主笔集中修订任务，所有 reviewer 任务禁止提交正文；
- 初次模型请求只含材料目录，不含私人正文或本地来源路径；模型调用 `read_material` 后，第二次请求才收到带 `instructionAuthority=none` 的工具结果；
- 最终 Markdown 绑定实际末次 request snapshot 并写为正文版本；仍保持 `factGateStatus=not_checked` 和 `publicationReady=false`；
- 模型调用预算耗尽时统一进入 `budget_exhausted`，保留材料/简报且不生成正文；
- CLI 确定性 mock 实际完成两次模型请求、一次工具调用和正文保存；无效 UTF-8 在创建项目之前失败。

## 3. 需求与验收映射

| 条目 | 本地证据 | 结果 |
|---|---|---|
| F01 | `WritingBrief`/`Material`/`Decision` schema v4 持久化；项目隔离；来源/hash/角色/授权；CLI UTF-8 与显式路径门禁 | `PASS_LOCAL_WA010_SCOPE`；首个 CLI 竖切只接受一个显式文本材料，网页导入/多材料 CLI 交互仍待后续扩展 |
| F02 | quick/deep 有界计划；真实 AgentRuntime 多轮工具闭环；评审只读、主笔集中修订规则 | `PASS_LOCAL_DRAFT_CLOSURE`；评审、集中修订、语言检查目前为 `policy_migrated_not_executed` |
| F13 | 简报保留作者声音、styleReference 与用户确认/授权代选来源，决定单独留痕 | `PASS_LOCAL_FOUNDATION`；跨文章自动学习不在 1.0 P0，风格档案导入 UI 尚未实现 |
| AT-02 | 真实 SQLite + 确定性 mock 完成 model → read_material → result → model → 正文版本 | `PASS_LOCAL_MOCK`；真实 provider 未获 Key/费用授权，因此不写真实模型 PASS |
| AT-26 | Application Service 传递统一 run budget；第二次模型调用前耗尽即停止，无正文半提交 | `PASS_LOCAL` |
| AT-29 | `npm run check`：226 项 legacy/Python 测试通过，1 项联网插件隔离安装按既有 `RUN_PLUGIN_INSTALL_TEST=1` 条件跳过；同步和插件校验通过 | `PASS_LOCAL_WITH_1_EXPLICIT_SKIP` |

## 4. 能力状态

CLI 与 Application Service 对外返回同一份状态，不将策略迁移冒充执行完成：

| 能力 | 状态 |
|---|---|
| 材料持久化、材料工具闭环、草稿版本保存 | `implemented_verified` |
| 独立评审、集中修订、语言检查 | `policy_migrated_not_executed` |
| 最终事实门禁 | `deferred_to_WA014` |
| 正式发布导出 | `deferred_to_WA015` |
| 真实模型验证 | `requires_credential_and_authorization` |

因此 WA-010 完成的是“材料 → 模型工具往返 → 草稿保存”的 M1 runtime 闭环，不代表文章已经事实核查、达到发布质量或可正式导出。

## 5. 验证命令

```powershell
npm run check:runtime
npx tsc --noEmit --noUnusedLocals --noUnusedParameters -p tsconfig.runtime.json
npm run check:m0
npm run check
npm audit --omit=dev --audit-level=high
python -B writing-agent-1.0-prd-v1.1-dsh-ui/tools/check_document_pack.py
python -B scripts/check_claude_runtime_sync.py
git diff --check
```

确定性 CLI 示例还按 `examples/writing-pack/README.md` 实际执行一次，读回为 `draft_saved`、`mock_verified`、2 次模型请求、1 次工具调用、`not_checked`、`publicationReady=false`。

最终数量和退出码以本轮命令输出为准。当前没有 commit、push、PR、Issue、tag、Release 或远端 CI 记录；没有真实付费模型调用。

本轮最终读回：

- `check:runtime`：83/83 通过；
- `check:m0`：Node 24.18.0 SQLite foundation 通过，11/11 M0 Python 测试通过，83/83 runtime 测试通过；
- `check`：226 项 legacy/Python 测试通过，1 项联网插件隔离安装按环境开关明确跳过；脚本、工作流、docs、runtime 同步和 plugin manifest 均通过；
- production audit：0 vulnerabilities；
- PRD 文档包：25 个任务、38 个验收场景、依赖/链接/来源检查全部通过；
- 严格 TypeScript `noUnused`、runtime 同步与 `git diff --check`：退出码 0（Git 仅提示既有 LF/CRLF 转换警告）。

## 6. 后续边界

- WA-023：完成 DSH 派生 UI 本地保真基线；这是 M1 尚未完成的另一条线。
- WA-011：待 WA-023 后将该 UI bridge 接到本轮 Application Service。
- WA-012–014：实现版本化改稿、独立评审/集中修订和事实门禁，届时才能把对应能力从 policy/deferred 提升为已执行。
- WA-015：在事实门禁之后实现工作备份与正式发布双出口。
