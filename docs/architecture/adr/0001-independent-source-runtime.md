# ADR-0001：自主源码运行时与应用边界

## 状态

- 状态：Accepted
- 日期：2026-09-16
- 对应任务：WA-004
- 决策范围：1.0 新运行时、代码组织、普通库边界、分支与发布身份

## 决策

Writing Agent 1.0 在现有仓库内建设自主维护的 TypeScript 运行时。所有写操作必须经过 `Application Service`；CLI、Web 和桌面端只提供不同入口，不各自实现业务规则。

目标模块边界如下：

```text
apps/cli ─────────────┐
apps/web ─ client bridge ─┐
apps/desktop ─ transport ─┼─> Application Service
                          │      ├─ writing-core
                          │      └─ runtime-core
                          └────────> storage / model-adapters / capabilities
```

1. `packages/writing-core` 保存项目、版本、Decision、修订、事实门禁和导出领域规则；不得依赖 React、Electron、Tauri、DSH CLI、Claude Agent SDK 或具体 provider。
2. `packages/runtime-core` 实现 session、run、agent loop、工具、预算、取消和恢复；只通过领域命令提交内容，不硬编码 legacy Stage 或文件名。
3. `packages/storage` 实现 StoragePort、事务、事件、不可变内容和投影；SQLite 选择见 ADR-0002。
4. `packages/model-adapters` 每个 provider 独立实现同一能力接口；浏览器和 UI 不直连 provider。
5. `packages/client-bridge` 提供版本化命令、查询、事件和 transport 接口；UI 不写数据库或正文文件。
6. DSH 的 runtime、Host、SDK、CLI、profile 和外部服务不进入执行依赖。对 DSH 的使用是固定 commit 下的源码审计与选择性移植，前端规则见 ADR-0005。

普通底层库采用以下边界：

- TypeScript 负责新模块的静态契约；Zod 负责外部输入、持久化边界和 transport 的运行时校验。
- 优先使用 Node 标准库和 SQLite，不复制 DSH 对等基础设施。
- Cordis 只允许保留在 DSH UI 源码闭包或经测试证明有价值的模块生命周期适配层；它不是 `writing-core` 的必需依赖，也不能成为运行外部 DSH 插件的入口。
- 新 runtime 的服务装配先使用显式工厂和依赖图。若后续确需通用容器，必须通过独立变更证明生命周期、循环依赖和 dispose 语义，并保持核心接口不依赖容器类型。

仓库继续保留 `main`，1.0 集成使用 `next/runtime`，按可独立验收的竖切面形成小 PR。当前根包 `name=writing-agent` 且 `private=true`；在名称所有权、安装入口和发行物实际验证前，不公开宣称 npm 包或尚不存在的命令可用。根 legacy 包的 Node `>=18.17.0` 暂不改变，新 runtime 在自己的 workspace 包中声明更高要求。

## 约束

- `claude-runtime/` 仍是 legacy 行为规则的唯一维护源；迁移期间不得破坏其镜像同步和现有发行。
- 普通用户的 1.0 路径不得要求安装 Claude Code、DSH CLI 或任何外部 Agent 宿主。
- 领域状态只以 Application Service 提交后的存储事实为准；React state、流式 token 和导出文件不是第二事实源。
- 来源移植必须固定 commit、保留许可、登记 source hash 和差异；不能以依赖外部运行程序代替源码自主维护。
- 新模块不能 import `writing-agent-app/src/**`、旧全局 CSS 或旧 Tauri 启动链。
- 公共命令、包名、URL、自动更新和 Release 均以真实实现及验收为准，ADR 不等于已发布能力。

## 证据

- `docs/architecture/BASELINE_AUDIT.md` 证明 legacy 与旧桌面是两条不兼容执行链，旧桌面缺少持久事件、CAS、幂等和恢复协议。
- `docs/architecture/UPSTREAM_MAP.md` 记录 DSH runtime 仅作源码参考，不采用其 SDK/CLI/profile。
- 需求包 `docs/implementation/RUNTIME_CONTRACTS.md` 明确 Application Service 是唯一修改和事务边界。
- 根 `package.json` 当前为 `private: true`，并只声明 legacy 的 Node 要求和命令。
- 固定 DSH 来源及许可已登记在 `upstream-sources.json` 与 `THIRD_PARTY_NOTICES.md`。

## 备选方案与拒绝理由

1. **继续扩展旧 Tauri 应用。** 拒绝。它的阶段、文件和持久化契约与 1.0 不同，复用会同时继承双写、凭据和 UI 债务。
2. **把 1.0 做成 DSH 插件/profile 或调用 DSH CLI。** 拒绝。普通用户将依赖外部宿主，领域边界和恢复语义也无法由本项目控制。
3. **继续以 Claude Agent SDK 为执行器。** 拒绝。它不能满足 provider 独立、普通用户仅配置 API 即可运行和自主恢复的目标。
4. **完全重写 DSH UI。** 拒绝。用户已明确选择 DSH 前端源码作为唯一新 UI 基线，仿写会丢失页面、Slot 和交互闭包。
5. **立即引入通用插件平台和热更新。** 拒绝。1.0 只需要内部模块组合；在线安装和第三方隔离会扩大安全与发布范围。

## 数据与安全影响

- UI 和 provider 均不能越过 Application Service 写入，从结构上统一权限、CAS、幂等、事实门禁和审计事件。
- 凭据仅以安全存储引用进入 adapter；日志、事件、诊断包和 SQLite 业务表不得保存明文 API Key。
- 模块装配默认静态、随发行构建；不从网络下载并执行 UI/runtime 代码。
- 来源层与自有领域层分开，便于补丁审计、许可交付和上游升级对比。
- 旧数据只作为显式迁移输入，不会因启动新版而被原地写入。

## 测试与验收

- 架构测试检查五份 ADR 的必需章节、核心边界、当前 `private` 状态和 CI 分轨。
- 依赖检查拒绝新 runtime 引入 DSH CLI/SDK、Claude Agent SDK、旧 UI/Tauri 路径或浏览器直连 provider。
- Application Service 合同测试从 CLI、Web bridge 和 desktop transport 运行同一命令夹具，并比较事件与错误语义。
- 生命周期测试覆盖依赖缺失、循环、初始化失败逆序释放和 dispose 至多一次。
- 每个竖切 PR 同时提供领域合同、存储合同及入口适配测试；仅页面可点击不计完成。

