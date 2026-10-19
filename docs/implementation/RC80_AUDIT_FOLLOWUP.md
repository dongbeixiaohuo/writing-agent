# RC80 迁移审计后调整

> 发布追记（2026-10-20）：下述源码改动已与后续修复一起纳入 [RC87 公开候选](../launch/RC87_RELEASE_EXECUTION.md)。以下 2026-10-11 的 RC81/未发布描述保留当时范围，不作为当前下载状态；真实模型和人工验收限制仍适用。

更新：2026-10-11。范围是用户批准的迁移缺口与可靠性修复，不追求原版 Skill 的逐字/全功能复制。已发布版本仍是 [RC80](../launch/RC80_RELEASE_EXECUTION.md)；本文改动位于 `codex/rc80-audit-fixes`，桌面候选版本为 RC81。本文记录源码行为与回归范围，打包与启动证据单独保存在 `output/desktop`，不代表已公开发布、完成安装验证或真实 MiniMax 验收。

## 当前源码行为

| 项目 | 调整 | 回归入口 |
|---|---|---|
| 带链接的需求澄清 | 提案前必须尝试读取当轮显式 URL；每轮最多三个，失败/其余未读项由程序披露，不冒称已读 | `packages/application/test/intake-web.test.ts` |
| 亲历授权 | 否定、假设、转引、疑问不授予作者亲历授权；材料导入与简报使用同一规则 | `packages/application/test/conversation-materials.test.ts` |
| Local Web 会话 | 有效请求刷新会话 TTL；过期凭证通过同源页面重新引导并恢复同工作区可用选择；合并同时重连、拒收旧会话迟到快照；未知结果的写请求不自动重放 | `packages/client-bridge/test/web-bridge.test.ts`、`local-web-host.test.ts` |
| 模型验证标记 | 换模型撤销旧验证；测试结束只标记实际受测、仍相同的配置，不能给中途替换的模型贴可用标记 | `apps/desktop/test/provider-profile.test.ts`、`application-host.test.ts` |
| 提纲前背景补查 | 只在关键公开信息缺口时可用现有已启用搜索服务；最多两次查询尝试，失败/上限不暂停或反复重试，继续用已有材料并保留缺口；不占最终核查额度 | `packages/application/test/fact-search.test.ts`、`collaboration.test.ts` |
| 按需模拟读者重测 | 三个隔离请求同时读当前成稿及已选标题，程序拼接一次交流报告，不投票，不重跑写作/核查；正文或标题变化拒存旧版本结论 | `packages/application/test/author-conversation.test.ts` |
| 可观察性与文档 | 运行记录标明前置研究查询、实际服务、结果/失败层与上限；刷新过期的阶段和迁移说明 | `packages/client-bridge/test/trace-summary.test.ts`、`collaboration-presentation.test.ts` |

## 不变的产品边界

- 写公众号/今日头条等自媒体文章，不把事实核查变成逐句学术审查。按[轻量事实合同](../architecture/FACT_CHECK_CONTRACT.md)检查易错的重要事实；没有每点引用不等于错误，中低风险提示不阻断。
- 前置研究不是最终核查：提纲前补背景，成稿与标题确定后再检查高风险事实，不把研究摘录直接当成核查通过。
- 模拟读者只说普通感受，不冒充编辑、真实用户调研或长期偏好。重测可不做，不自动增加整轮流程。
- 配图仅简短 prompt 策划与确认，未接自动生图；不添加新付费服务。
- Electron IPC 没有 Local Web 会话 TTL，这次重连修改不替代桌面退出/恢复人工验收。HTTP(S) 读取仍保留公开网络、无凭据、无私网访问边界，不绕过登录验证。

## 验证与证据范围

确定性回归覆盖程序门禁、并发隔离、预算、配置竞争和重连顺序。验证入口为 `npm run check:runtime`、`npm run test:bridge`、`npm run test:ui`、`npm run test:desktop`、`npm run check:docs`，并对新增边界执行定向回归。

这些测试不能证明真实供应商会正确选择工具、网页一定可读、用户网络下的实际耗时或三请求限流情况。未使用客户项目作为夹具，未新增付费模型实测或远端发布。RC81 本地测试包的构建、校验与隔离启动不等同于安装/升级验收。人工测试仍应覆盖：真实链接澄清、否定亲历文本、测试期间切换模型、Local Web 放置过期/断线、关键背景不足时补查、完成后的读者重测。

当前行为对照维护源为 [桌面与 Skill 能力对照](../DESKTOP_SKILL_COMPARISON.md)、[阶段映射](../../packages/writing-pack/STAGE_MAPPING.md)、[模拟读者实现](READER_SIMULATION.md)。历史真实模型报告与 RC80 发布记录保留原日期/版本，不外推为这些新改动已经验收。
