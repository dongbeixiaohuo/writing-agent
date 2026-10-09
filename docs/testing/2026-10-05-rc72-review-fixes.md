# RC72 独立审查修复记录

日期：2026-10-05，提交前验证更新于 2026-10-06。适用范围：基于 `7b0bbec4` 的本地修复，已纳入 RC73 本地测试包；不代表已公开发布或通过真实模型及安装验收。

## 修复与回归对应

| 审查项 | 本次调整 | 主要回归位置 |
|---|---|---|
| P0-1 桌面确认回执遗漏 | Electron bridge 原样透传 `checkpointApproval`，不把点击确认变成新的作者原话 | `apps/desktop/test/desktop-bridge.test.ts` |
| P1-2 核查拒绝先改变标题 | 在标题和快照写入前执行同一纯事实策略预校验；持久化之后仍评估真实版本，不降低门禁 | `packages/application/test/fact-check-application.test.ts` |
| P1-3 GPU／界面退出不可定位 | 启动前注册进程退出日志；主界面异常停止给出本地提示后按正常路径退出；不自动重启或禁用 GPU | `apps/desktop/test/startup.test.ts` |
| P2-4 恢复后看不到本轮搜索 | 检索目录包含当前 run 抽取前后的成功来源定位；长原文留在 SQLite，按需本地读取，不重塞历史对话 | `packages/application/test/fact-context.test.ts` |
| P2-5 核查重试重置成果与额度 | `resumeFactCheck` 续接原 run，并检查任务用途、项目、会话和可恢复状态；不取消旧 run 后新建 | `packages/application/test/fact-search-integration.test.ts`、`packages/client-bridge/test/application-bridge.test.ts` |
| P2-6 未发送查询也消耗额度 | 授权拒绝、授权等待超时和授权窗口失败不计搜索额度；内存计数和持久事件重放使用同一规则 | `packages/application/test/fact-search.test.ts` |
| P2-7 错误归因依赖文案 | 截断按 `MODEL_OUTPUT_TRUNCATED` 判断，不从 message 猜测；未知原因不引导为连接故障；已知范围／核查输入错误安全透传到桌面与 UI | `packages/client-bridge/test/collaboration-presentation.test.ts`、`apps/desktop/test/rpc-host.test.ts` |
| P2-8 检查点缺活动任务预检 | 另一任务运行时，在切换会话及发送作者回复之前拒绝继续；不改变等待项或产生多余回执 | `packages/client-bridge/test/collaboration-presentation.test.ts` |

## 重试与搜索语义

- 核查的“重试这一步”保留原任务编号、已抽取条目、完整本地搜索记录以及已用额度。只刷新显式重试所需的模型循环 allowance，不清空累计使用记录或搜索次数。
- 模拟回归先耗尽 6 次搜索、重建应用服务再重试：仍在 verify，6 条来源可按 `read_fact_record` 回读，搜索工具不再提供；后续提交不产生第 7 次网络搜索，也不重复全文抽取。
- 6 次指本轮逻辑搜索上限（含已授权的失败／未决请求），不是 HTTP 数量或费用保证。Parallel 握手和已启用服务之间的回退可能涉及多个 HTTP 请求。缓存读取及明确未获授权、未发送的三类失败不计次数。
- 正文、证据或所选标题改变后，旧抽取绑定仍失效，不能把旧核查结论复用给新稿。主动发起全新的核查任务与续接旧任务是不同操作。
- 旧记录仅保存 `MODEL_RESPONSE_INVALID` 时，保留这个已知错误类别；没有结构化截断证据就不根据一句文字改判。未知错误仍可查看原本的安全运行详情。

## 验证边界与协作

修复采用先复现缺陷、再修改实现的回归方式；SQLite 临时工作区、合成 provider 和假 fetch 隔离于用户数据。未使用真实 API Key，没有付费模型／搜索调用，也没有覆盖用户项目或自动关闭安全保护。

启动诊断由 1 个 `gpt-6.1-sol` / `high` 子 Agent 独立处理，原因是文件和验收范围与核查状态路径可分离；确认、核查与搜索连续性由主 Agent 实施，主 Agent 检查启动 diff 并复跑桌面测试。没有可用的独立 token／费用记录，不估算节省额度。

验证入口：

```powershell
npm run test:desktop
npm run test:confirmation
node --import tsx --test packages/application/test/fact-check-application.test.ts packages/application/test/fact-context.test.ts packages/application/test/fact-search.test.ts packages/application/test/fact-search-integration.test.ts packages/client-bridge/test/application-bridge.test.ts
node --import tsx --test packages/client-bridge/test/collaboration-presentation.test.ts apps/desktop/test/rpc-host.test.ts
npx tsc --noEmit -p tsconfig.runtime.json
npx tsc --noEmit -p apps/desktop/tsconfig.json
npx tsc --noEmit -p apps/web/tsconfig.json
npm run check:docs
```

本次本地执行：专项核查与 bridge 53 项、诊断呈现与 RPC 38 项、桌面 60 项、确认恢复 21 项、写作流程／模型工具契约／UI 文案 137 项均通过。RPC 同时包含在诊断与桌面套件中，不将这些套件数字简单相加当作独立测试数。runtime、desktop、web 三个 TypeScript 检查均通过；`npm run build:desktop` 和桌面分发边界检查通过。构建仍有现有的 Markdown 混合静态／动态导入和大 chunk 提示，不影响本次构建结果，也没有据此重构无关模块。

2026-10-05 已生成未签名的 RC73 本地测试安装包，最终 EXE 放在 `output/desktop` 根目录，未上传远端。从安装包提取的 exe 和 app.asar 与构建目录哈希一致，主进程与 preload 内容也与当前构建一致；本地 TEMP 路径的隔离 smoke 通过，实际版本为 `1.0.0-rc.73`、协议为 23。OneDrive 构建路径下的 smoke 未完成：日志记录 GPU 与 Renderer 的 `crashed`、退出代码 `-2147483645`，以及 `DESKTOP_RENDERER_FAILED`。这两次测试均为禁用 GPU 的 smoke，尚不能确定正常 GPU 路径的根因，也不能称为实机安装验收。

2026-10-06 提交前复验：桌面套件 60 项、核查／搜索／bridge／诊断呈现专项 94 项均通过；runtime 与 desktop TypeScript、文档契约／相对链接及差异空白检查通过。未重新调用真实模型或搜索服务。

待实际验收：新安装包的安装／升级、正常 GPU 路径的 OneDrive 与本地短路径对照，以及真实 MiniMax 的完整共创与核查流程。smoke 会禁用 GPU，不能作为上述正常 GPU 验收证据；具体做法见[桌面发布手册](../launch/DESKTOP_RELEASE_RUNBOOK.md)。
