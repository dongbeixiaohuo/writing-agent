# DSH 上游运行时来源与取舍

状态：`AUDITED_PLANNED`  
对应任务：WA-002  
上游仓库：`https://github.com/deepseek-ai/deepseek-harness`  
固定 commit：`0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`  
上游版本：`0.1.6-alpha.1`  
许可：MIT（Copyright (c) 2026 DeepSeek）

## 1. 状态定义

- `AUDITED_PLANNED`：已读取源码、依赖和测试入口，尚未复制到本仓库。
- `PORTED_UNVERIFIED`：已复制/改写，但未通过本项目测试；本次没有该状态。
- `PORTED_VERIFIED`：已复制/改写并通过来源、行为和独立性测试；本次没有该状态。
- `REFERENCE_ONLY`：只用于理解契约，不进入发行闭包。
- `EXCLUDED`：明确不进入产品。

本文件记录 M0 源码审计。当前提交没有把 DSH 源码复制到产品，因此不得将任何条目标记为 ported。

## 2. 固定来源与可复核性

审计使用 detached、只读工作副本，HEAD 精确等于固定 commit，且工作树干净。机器清单位于仓库根目录 `upstream-sources.json`；其中的 `git_tree_oid` 是该 commit 下对应目录的 Git tree object id，用于后续发现来源漂移。首次复制文件时还必须登记逐文件 SHA-256，不能只沿用目录 OID。

上游要求 Node `^22.19.0 || >=24.0.0`、pnpm `11.7.0`。本机 Node `v24.18.0`、pnpm `11.7.0` 满足源码审计和后续构建条件。

## 3. 运行时候选模块

| 上游路径 | Git tree OID | 作用 | 本项目处理 | 计划目标 |
|---|---|---|---|---|
| `packages/core/agent` | `081975b59b07e73cc78ff0bfd00f8c911b08e0ee` | Agent 合同 | 提取最小宿主无关合同 | `packages/runtime-core/agent` |
| `packages/core/agent-loop` | `bbc68ffe7572c0b5355101ea1ca5918d2a12b11f` | 流式 loop、turn/tool 驱动 | 源码移植候选；改接本项目 operation/event | `packages/runtime-core/agent-loop` |
| `packages/core/tools` | `fb6aeb8e9bf6787abe1b46d4bbc42800e40c707e` | 工具注册与调用合同 | 保留注册/结果合同，权限按写作域重写 | `packages/runtime-core/tools` |
| `packages/core/session` | `d0ff9dce1241a394ced5ab910ae5620c93de6f40` | Session 和事件模型 | 保留可复用类型；项目/运行语义由本项目定义 | `packages/runtime-core/session` |
| `packages/core/system-prompt` | `1d86b7d4047e59bb4c2497755638c4135e919b90` | system prompt 组合 | 只取组合机制，不继承 coding prompt | `packages/runtime-core/prompt` |
| `packages/core/scope` | `5e93d1be3e8d68172e72824a1bd1f2e22b9e4efd` | scope/生命周期 | 评估最小移植；不得扩大写作工具权限 | `packages/runtime-core/scope` |
| `packages/llm/llm` | `6d3b4e4af59561c37db78b4fef4303ff1014030a` | provider-neutral LLM 类型/流 | 保留有用接口，provider adapter 自主实现 | `packages/model-adapters/core` |
| `packages/session/session-persistence` | `e78b0bcb50d4e747962e326c51c20b93b1a492fa` | 持久化接口 | 参考并适配 append-only 事件契约 | `packages/runtime-core/persistence` |
| `packages/session/session-persistence-jsonl` | `ee3ae34865851f8de0815072c2ff3f6213de9b93` | JSONL 实现 | 测试/诊断参考；正式权威状态仍采用本项目 SQLite+事件设计 | 测试支持或不移植 |
| `packages/storage/storage*` | 见 `upstream-sources.json` | 通用存储抽象 | `REFERENCE_ONLY`，不直接决定领域 schema | ADR 输入 |

## 4. 保留、重写与排除

### 保留/移植候选

- Agent loop 中可独立验证的 turn、stream、tool-result 和取消边界。
- provider-neutral message/content/usage 类型，以及显式能力检查。
- Session 事件和投影视图中适合 append-only 重放的部分。
- 生命周期、注册表和测试夹具中能降低自研错误的普通机制。

### 必须由本项目重写

- `projectId → sessionId → runId → requestId/operationId` 的领域身份。
- SQLite schema、事务、project revision/CAS、ArtifactVersion/current pointer。
- 写作材料读取工具、路径授权、预算、事实核查和正式交付策略。
- provider 凭据引用、错误分类、未知结果和恢复协议。
- legacy writing pack 映射；不得把 coding-agent system prompt 当写作规则。

### 明确排除

- 把 DSH SDK、profile、CLI 或已运行的 DSH server 作为用户运行前提。
- 直接采用 `packages/bundle/base` 的全量 coding-agent 工具闭包。
- 默认启用 shell、终端、任意文件写入、插件安装、调度、遥测或外部反馈。
- 读取 `$DSH_HOME`、上游 credentials/settings 或官方账号状态作为本产品配置。
- 将上游 DeepSeek provider/onboarding 语义误当为本项目唯一 provider。

## 5. 依赖闭包判断

上游完整 `dsh-base`/`dsh-web-app` 组合递归依赖大量 shell、sandbox、插件、遥测、搜索和子 Agent 包。1.0 不全量搬仓，也不从发布包运行外部 DSH；采用“按能力切片 + 保留必要包边界 + 本项目组合”的方式：

1. 先以确定性 mock 验证本项目事件、tool call 和恢复合同。
2. 每引入一个上游源目录，记录 tree OID、实际文件 SHA-256、普通 npm 依赖、补丁和测试。
3. 从组合层移除不需要的能力，同时验证后端权限确实不存在；隐藏按钮不算裁剪。
4. 若某个上游抽象迫使引入不相关闭包，记录 ADR 后用小型本地合同替代；不因此改成外部 DSH 宿主。

Cordis、Schemastery 等上游 vendored 基础库仍需在实际引入时保留各自来源和 MIT 许可。浏览器/Node 普通依赖按本项目锁文件固定并生成发行 notice，不能照抄上游完整 notice 后声称都已分发。

## 6. 测试映射

| 来源能力 | 本项目最低测试 |
|---|---|
| Agent loop | 文本流、工具请求/结果、provider 错误、取消迟到结果、预算耗尽 |
| Session/event | seq 单调、重启重放、重复事件幂等、损坏尾部、未知 operation 恢复 |
| Tools/scope | 路径越界、只读授权、参数校验、未授权写入、输出过大 |
| LLM adapter | capability preflight、usage、流中断、超时、重试边界、错误分类 |
| Persistence | SQLite 事务、文件临时写+原子替换、current pointer、CAS 冲突 |
| Independence | 安装包/进程/网络不调用 dsh CLI/SDK/profile/server，不读取 `$DSH_HOME` |

上游测试可作为来源理解和移植对照，但本项目通过上游测试不等于满足写作领域契约。

## 7. 许可和更新流程

- 上游仓库在固定 commit 下为 MIT；实际复制的文件必须保留版权/许可头和来源登记。
- 当前 `THIRD_PARTY_NOTICES.md` 的“已分发 DSH 源码”部分为空，因为 M0 尚未复制上游代码。
- 首次 port 时必须同步更新 `upstream-sources.json`、逐文件 hash、notice 和锁文件许可扫描。
- 后续更新只通过专门 PR：比较固定 commit、挑选有关修复、复核许可/依赖、运行行为/安全/UI 测试，再由维护者决定合入。

## 8. WA-002 运行时部分完成判据

- [x] 固定上游仓库、commit、版本、许可和目录 OID。
- [x] 审计 session、agent-loop、tools、llm、system-prompt、scope、persistence/storage。
- [x] 区分移植、重写、参考和排除项。
- [x] 明确不依赖 SDK/profile/CLI/外部 DSH server。
- [x] 未复制源码，不编造 ported/verified 状态。

前端、Host/API、品牌、预览和视觉基线见 `FRONTEND_UPSTREAM_MAP.md` 与 `docs/testing/UI_BASELINE_PLAN.md`。
