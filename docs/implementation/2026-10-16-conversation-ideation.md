# 轻量启发式对话实施计划

> 按 writing-plans、executing-plans 与 test-driven-development 执行。此任务与已有未提交 UI 改动共用当前工作区，主 Agent 顺序实施，不创建另一套客户端、不自动提交或发布。

**目标：** 作者没有思路时，主对话贡献具体线索并逐步找到角度，不只寒暄、追问或提前写作。

**架构：** 复用 intake 的公开流式回复与一次保存工具，增加可选、有界、仅供参考的启发状态；问题复用现有 questions。建议与反应不是作者授权，方案仍须独立确认。已进入写作的讨论保持当前阶段范围。

**技术：** TypeScript、现有 AgentRuntime、SQLite artifact、node:test。

## 1. 测试先行

- [x] 在 `packages/application/test/conversation-intake.test.ts` 添加真实应用/存储链路回归：首次没思路、连续不知道、拒绝建议、请助手推荐；检查发出的提示、工具集合、请求数、持久状态、重启恢复和未确认状态。
- [x] 在 `packages/application/test/intake-transition.test.ts` 检查意图提示对开放探索的边界，不把推荐要求当作方向确认。
- [x] 运行 `node --import tsx --test packages/application/test/conversation-intake.test.ts packages/application/test/intake-transition.test.ts`，先确认新增断言失败。

## 2. 最小实现

- [x] 新增 `packages/application/src/conversation-ideation.ts`，只承载启发规则、有界状态和合并：最多3个当前方向，最多6条用户反应，反应来源由程序绑定本轮已保存原文。
- [x] `conversation-intake.ts` 的现有保存工具增加可选 ideation；缺省保留，老记录缺字段按空状态读取；在作废方案/确认方案时保留参考状态。问题仍由 questions 保存，不复制全文材料。
- [x] `conversation-intent.ts` 明确开放讨论/推荐不等于已谈妥可执行方向；不新增分类调用。
- [x] `author-conversation.ts` 明确卡在段落或结尾时只围绕现有正文启发，不重开选题、不自动委派。

## 3. 验证与交付

- [x] 执行 conversation、legacy-parity、confirmation、bridge 回归与 runtime/web/desktop 类型检查，检查 `git diff --check`；脚本测试不等于真实模型语义验收。
- [x] 将桌面版本改为 `1.0.0-rc.87`，更新分发配置测试，执行 `npm run desktop:package`。
- [x] 检查分发边界、ASAR 与 staged checksum 一致性，在隔离临时目录运行 packaged smoke；不修改用户安装或用户数据库。
- [x] 安装包、校验值和测试说明放 `output/desktop`；说明未签名、尚未进行真实安装升级及真实模型对话验收的边界。

## 验证记录（2026-10-16，RC87）

- 新增测试先在缺少启发规则、状态 schema 和意图边界处失败，再实现并复测通过。
- conversation 102/102、legacy-parity 95/95、confirmation 27/27、bridge 139/139、desktop 80/80；runtime、web、desktop 类型检查和文档检查通过。
- NSIS x64 打包成功；分发边界13文件通过；ASAR中的12个 payload 文件与 staged SHA-256 一致，确认包含启发规则与持久状态实现。
- 隔离 packaged smoke：RC87 / 协议24 / ready / exit 0。仅验证隔离启动，不等同于真实模型语义、正常GPU、安装升级验收；没有读取或迁移用户数据库。
- 本次不提交、不推送、不发布。构建基线为 ccdc4cd7cb8aebb6c407d4be6d91a542f1d92a28 加当前工作区修改，保留已有的手动建项目入口删除改动。
