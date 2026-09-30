# ADR-0003：同源 Web、Electron 桌面分发与受限传输

## 状态

- 状态：Accepted
- 日期：2026-09-16
- 对应任务：WA-004
- 决策范围：Web/桌面/CLI transport、进程边界、Windows 分发与更新策略

## 决策

1.0 只维护一套由 DSH 源码派生的 Web UI 和一套版本化 client bridge。Web 与桌面加载同一构建产物、调用同一 Application Service 契约；CLI 直接调用服务接口。不得为桌面再维护第二套页面或恢复旧 Tauri UI。

桌面默认且唯一的新路线是移植 DSH `apps/desktop` 中有用的 Electron 最小壳：保留窗口、受限 renderer、preload/IPC、host 生命周期和 Windows 打包思路；删除 DSH runtime/profile、插件安装、官方更新、账户和上传链。Electron 版本与实际源码闭包在 WA-023/WA-017 固定；若打包实测证明路线不可行，必须新 ADR 和维护者批准，不能自动回退旧 Tauri。

transport 由 `packages/client-bridge` 的同一协议定义，最少包括：

```ts
interface BridgeHandshake {
  protocolVersion: string;
  clientBuild: string;
  runtimeBuild: string;
  capabilities: readonly string[];
}
```

- **Desktop：** Electron main/utility process 拥有 Application Service；preload 通过 `contextBridge` 暴露小型 allowlist。renderer 使用 typed bridge，不获得 Node、文件路径或任意 IPC channel。
- **Local Web：** Application Service 只监听 `127.0.0.1` 的随机端口；静态资源与 API 同源，启动时生成短期会话 capability，校验 Origin/Host，不允许远程绑定。命令使用版本化 HTTP/RPC，持久事件使用带序号的流或 WebSocket，并能按 `projectSeq` 补读。
- **CLI：** 进程内调用同一 Application Service；输出格式可以不同，领域错误码、operation 和门禁结果必须相同。

bridge 显式映射 `workspaceId → projectId → sessionId → runId → artifactVersionId`。每个写命令携带 `operationId` 和适用的 expected revision；重连只补读，不自动重启 run。协议版本不兼容时拒绝操作并提示刷新/升级，不能让旧静态资源静默写新 schema。

Windows 是 1.0 首个桌面发行目标。WA-017 以本仓库 GitHub Releases 提供自包含安装包，优先使用 Electron 的 NSIS 安装目标；签名状态、hash 和 smoke test 随 Release 记录。安装身份固定为 `appId=com.dongbeixiaohuo.writingagent` 与 NSIS GUID `c03d2689-78a4-57b7-813e-a5d1cf38cbb8`，后续版本必须原位调用旧卸载器、只留下一个安装项并保留 AppData/Workspace；不得通过改名或改 `appId` 让用户手工卸载。没有自有签名更新基础设施前禁用自动更新，只显示手动下载入口。当前根包保持 `private: true`，应用分发不等于 npm 发布，也不提前宣传 `web`、`run` 等未实现命令。

## 约束

- Electron 必须 `contextIsolation=true`、`nodeIntegration=false`、启用 sandbox（若具体窗口能力无法启用须逐项说明）、preload 无动态 `require`/任意 channel。
- 自定义协议、文件预览和导出路径都经规范化与 workspace allowlist；禁止 renderer 传任意路径让 main 读取。
- 禁止任意导航、`window.open` 和 shell 打开；外链只允许显式用户操作、HTTPS allowlist 与确认后的系统浏览器。
- Content Security Policy 默认拒绝内联脚本、远程代码和不受控 frame。HTML 预览不执行用户、模型或网页材料脚本。
- Web 不作为局域网/公网服务器承诺；远程部署、账户、多租户和 TLS 终止不在 1.0 范围。
- desktop 与 Web 的 mock 只能用于 WA-023 确定性 UI 测试，必须显著标识，正式构建默认关闭且不能写真实项目。
- 安装包不携带 DSH CLI、Claude Code、旧 Tauri sidecar 或官方更新/遥测端点。

## 证据

- `docs/architecture/FRONTEND_UPSTREAM_MAP.md` 已固定 DSH Electron 壳的 OID、可保留和必须排除范围。
- 需求包 `FRONTEND_REUSE_PLAN.md` 要求同源前端、默认评估 Electron 最小壳、受限 IPC 和 Windows 自包含包。
- `RUNTIME_CONTRACTS.md` 要求桌面使用受限 IPC/自有协议、CLI 直调 Application Service、UI 不直接写数据库/文件。
- 旧 `writing-agent-app` 的 Tauri 启动链与 1.0 工作流和数据契约不兼容，只保留迁移参考。
- 当前仓库通过 GitHub Releases 分发历史预览；根包为 private，尚无可验证的 1.0 npm CLI。

## 备选方案与拒绝理由

1. **继续使用旧 Tauri 壳。** 拒绝。它会重新引入旧页面、Rust 命令和双写数据链，且违背同源 DSH UI 决定。
2. **桌面 renderer 直接访问 localhost 服务。** 不作为默认。虽可减少 adapter，但扩大 CSRF/端口暴露面；桌面以受限 IPC 适配同一协议更可控。
3. **Electron renderer 开启 Node。** 拒绝。不可信材料、Markdown 和模型输出进入 UI，Node 权限会把渲染漏洞升级为本机代码执行。
4. **直接采用 DSH 完整 desktop bundle。** 拒绝。会携带 profile/plugin/runtime/官方更新等无关能力，并依赖外部产品语义。
5. **首版建立自动更新服务。** 拒绝。签名、回滚、端点安全和差分更新需要独立验收；手动 Release 足以完成首版闭环。
6. **将应用发布到 npm 并以全局 CLI 为主入口。** 暂不选。名称、支持矩阵和实际命令尚未实现，提前承诺会产生错误安装路径。

## 数据与安全影响

- provider Key 留在 main/runtime 的凭据边界，不经过 renderer、Web localStorage、URL 或 bridge 日志。
- Desktop IPC 与 Web transport 共用 schema/授权，但分别做威胁测试；transport 只搬运命令和投影，不下放领域判断。
- capability token 仅存内存、短期有效，不写日志；Web 启动 URL 不持久化秘密查询参数。
- installer、静态资源和 bundled runtime 记录 hash；来源许可随安装包交付。
- crash/退出顺序先停止接受新命令，再持久取消/待恢复状态、关闭服务和数据库，最后销毁窗口；窗口关闭不等于运行成功。

## 测试与验收

- 同一协议夹具分别跑 in-process、Web transport 和 Electron IPC adapter，比较成功结果、错误码、取消、重连及版本不兼容行为。
- Electron 自动测试检查 `contextIsolation`、`nodeIntegration`、sandbox、preload allowlist、自定义协议路径、导航和外链策略。
- Web 测试检查只绑定 loopback、随机端口、Origin/Host/capability、无 token 日志以及断线补读。
- 打包 smoke test 在干净 Windows 用户环境验证安装、首次启动、创建 workspace、重启恢复、卸载不删除用户 workspace；从上一正式候选升级还必须验证旧目录被替换、GUID/安装路径稳定、只剩一个卸载项且 AppData/Workspace 不丢失。
- 构建产物扫描拒绝 DSH/Claude CLI 可执行依赖、官方更新/反馈/遥测端点、旧 Tauri 资源和 mock 默认开关。
- Release 前验证安装包 hash、签名状态、许可证清单和手动升级/回退说明；未做的测试明确标 `SKIPPED_ENV` 或阻断发布。
