# WA-007 工具注册、参数校验与最小权限验证结果

状态：`PASS_LOCAL`  
日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- 在 `packages/runtime/tools` 建立不可热安装的 `ToolRegistry`。工具在注册时固定 name、version、description、JSON Schema、effect 与权限；`schemaSnapshots()` 返回带稳定 hash 的只读快照，供 WA-008 保存实际请求 schema。
- 工具调用按固定顺序执行：确认工具存在 → 核对 raw/parsed 参数一致 → Ajv 参数校验 → 验证应用签发权限及 project/run scope → 检查取消 → 校验目标/版本 → 执行 → 校验 JSON 输出及字节上限。模型参数不能创建或扩大权限。
- 权限通过进程内不可伪造的 `ToolPermissionGrant` 签发，并绑定一个 project/run；错误权限对象、跨项目/跨 run grant、未授权权限均在业务工具执行前失败。
- 首批只注册 `list_project_materials`、`read_material`、`read_artifact_version`，没有 shell、进程执行、正式导出或外部写入工具。材料列表不返回源绝对路径；材料读取绑定 `contentVersionId`、限制单次字符数，并把内容标记为 `instructionAuthority: none`。
- `read_artifact_version` 通过现有 `StoragePort` 读取不可变版本；本机测试连接真实 SQLite 存储完成项目创建、版本提交和工具读取，不只使用接口替身。
- `AuthorizedPathPolicy` 只允许工作区或单个显式导入路径，拒绝路径穿越、敏感文件、符号链接/junction 逃逸和目录读取；错误不回显绝对路径。
- `NetworkAccessPolicy` 默认只允许 HTTPS，拒绝 URL 内嵌凭据、localhost、私网、链路本地、元数据/保留地址、IPv4-mapped IPv6 绕过及混合公私 DNS 结果；每个绝对或相对重定向目标重新解析和检查。
- `extractUntrustedWebText` 不执行 HTML，移除 script/style/iframe/object 等活动内容，只返回纯文本并保留 `external_untrusted`/`instructionAuthority: none` 标记。普通提示注入文本仍作为可见材料数据保留，不被解释为授权。
- `BundledModuleHost` 仅接收启动时给定的内部模块，没有在线安装/热注册 API；启动前拒绝缺失依赖、循环依赖和重名模块，激活时拒绝重名 service，失败时逆序清理，正常 stop/dispose 至多执行一次。

本项没有实现 agent loop、材料持久化、网页实际抓取/搜索、写入型稿件工具、请求快照落盘、诊断包或正式导出；这些属于 WA-008、WA-010 及后续任务。

## 2. TDD 记录

按公开 seam 完成四条竖切：

1. 先写 ToolRegistry/schema snapshot/权限顺序测试，初始失败为 `src/index.js` 不存在；补最小注册与执行合同后转绿。
2. 先写材料列表、限长读取、跨项目拒绝和版本读取测试，初始失败为缺少 `createBuiltinReadTools`；补三个只读工具，并增加真实 SQLite 版本读取集成测试。
3. 先写路径、网络、危险 HTML 与异常脱敏测试，初始失败为安全策略入口不存在；实现后又以新增负向用例暴露 IPv4-mapped IPv6 绕过和相对重定向不支持，分别改为双 `BlockList` 地址族校验与逐跳 URL 解析。
4. 先写模块依赖、重名、逆序清理和 dispose-once 测试，初始失败为模块宿主不存在；补最小 bundled module lifecycle，并阻止 activate 完成后的 service 热注册。

材料 `contentVersionId` 冲突用例先于实现加入；旧 schema 因额外字段被 Ajv 拒绝，随后实现版本绑定并转绿。

## 3. 需求与验收映射

| 条目 | 本地证据 | 结果 |
|---|---|---|
| F04 | schema/version 快照、参数→权限→目标顺序、应用签发 scope、首批只读工具、无 shell、内部模块启动/清理 | `PASS_LOCAL_FOUNDATION`；写入型与联网工具待后续能力按相同边界注册 |
| AT-02 | `read_material` 和 `read_artifact_version` 可安全执行，工具 call ID/result envelope 保持一致 | `PARTIAL_PASS`：agent loop 与稿件提交仍待 WA-008/WA-010 |
| AT-18 | 临时真实文件系统验证 traversal、`.env`、外部目录和 Windows junction/symlink 逃逸均阻断；显式导入只授权单个文件 | `PASS_LOCAL_POLICY`；实际导入流程待 F01 接入 |
| AT-19 | HTTPS/DNS/私网/metadata/IPv6/redirect 负向测试及 HTML 活动内容移除、提示文本无授权 | `PARTIAL_PASS`：策略通过；尚无实际网页抓取器和连接地址 pinning 验收 |
| AT-25 | 未预期异常不进入 tool result，路径、Key 和原异常消息不外泄；材料列表隐藏 sourceReference | `PARTIAL_PASS`：工具诊断边界通过；完整诊断包仍未实现 |

## 4. 验证命令

### `npm run check:runtime`

结果：PASS。

- TypeScript `strict` / `noEmit`：PASS。
- Node test runner：51 项通过，0 失败；其中 WA-007 新增 24 项。
- WA-007 覆盖注册/权限 8 项、材料/版本 6 项、路径/网络/不可信内容/诊断 6 项、模块生命周期 4 项。

所有网络安全测试使用注入的确定性 DNS 结果，没有访问外网；材料测试使用合成内容；真实存储测试只在系统临时目录创建并删除本地 SQLite 工作区。

## 5. 来源、依赖与限制

- 本项依据 PRD/RUNTIME_CONTRACTS 自主实现，没有复制 DSH 源文件；`upstream-sources.json` 中 runtime contracts 仍保持 `audited_planned`，不虚报 `ported_verified`。
- `packages/runtime/tools` 声明仓库已锁定的 `ajv@8.20.0` 与 `cheerio@1.0.0`；没有新增 shell、插件加载器、网络 SDK或生产依赖版本。
- `MaterialReadPort` 是后续 Application Service/材料存储的明确边界；目前没有把材料临时塞入 artifact 表或擅自升级 SQLite schema。
- 网络策略只负责目标决策和逐跳复检；真正的抓取器还必须绑定已检查地址、限制响应大小/类型/重定向次数并记录抓取快照，不能仅凭本项宣称 AT-19 全部完成。
- 尚未运行远端 CI、真实网页、真实私人材料或发行包诊断测试；这些结果不能由本机策略测试代替。
