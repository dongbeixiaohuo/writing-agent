# rc.46：标题选择自纠错、切换模型提速、术语中文化、会话悬停预览

日期：2026-09-26。范围：发布方案选择、凭据状态检查、用户可见文案、侧栏交互；不修改写作工作流、事实门禁、存量项目数据或凭据。

## 根因与证据（用户报告四项）

1. **标题选择后连续失败直至运行保护**：工作区留证——用户回复"2"后，导演连续约 10 次调用 `choose_publication`，均传入了**正文版本 id**（`b2bb6873…`）而非候选版本 id（`1c808c8e…`），校验以 `PUBLICATION_CANDIDATES_STALE` 拒绝；错误文案"候选版本或正文已变化"具有误导性（什么都没变，只是 id 传错），模型拿着同一个错误 id 反复重试，约 90 秒烧光请求预算。正文 id 在状态里远比候选 id 显眼，模型几乎必然选错。
2. **切换模型卡 4-5 秒**：切换链路包含两次凭据状态检查（`selectProvider` 验证 Key + `#changeProvider` 返回 `providerStatus('active')`），每次检查在 Windows 上是"可用性探测 + 读取"两次 PowerShell 启动（rc.38 实测单次检查约 2.5 秒），叠加 bridge 重建 ≈ 5 秒。
3. **对话里出现 central_revision / language_review / fact_check 等英文阶段名**：导演 reason 与回复同时给专家和用户看，旧提示词只禁了 C008/rework，未覆盖全部阶段 ID，用户看不懂。
4. **标题阶段十几轮请求偏慢**：留证显示其中约 8 次是模型在 `read_artifact_version` 被 `TOOL_PERMISSION_DENIED` 后原地重试同一读取（权限拒绝文案没有告诉模型"别再重试"），另有重复读取与两次导演参数错误；标题生成本身只产生 4 个候选，但噪音把轮次推高。选择后进入第 1 条的死循环。

## 修改

1. **选择自纠错**：`choose_publication` 的 `candidateVersionId` 改为可省略（省略时使用当前候选版本 id）；传入错误 id 时，错误文案直接给出正确值与辨析（"当前候选版本 id 是 publicationCandidates.id=…（不是正文 id …），请改用这个 id 重新调用"），模型下一次调用即可成功，不再循环。测试覆盖省略、错 id 自纠错文案。
2. **凭据检查缓存**：`CredentialBroker` 可用性探测按进程记忆一次（Windows 上每次探测都是一次 shell 启动）；`inspect` 增加 10 秒 TTL 缓存，save/delete/clearSession 精确失效。切换链路从 2 次探测 + 2 次读取降到 1 次读取（首次），估计 4-5 秒 → 约 1.5 秒，行为与安全性不变（请求的 resolve 仍实时读取）。
3. **术语中文化**：导演提示词新增硬性规则——与作者交流一律使用中文角色名（研究与证据/文章提纲/完整初稿/编辑审校/发布审校/读者审校/集中修订/语言终审/事实核查/标题专家），reason、提问和一切用户可见文字禁止英文阶段名与后台术语、禁止中英混写；`director_decide.reason` 字段描述同步声明（该字段同时给专家与用户）；作者对话流程的 `AUTHOR_REPLY_TOO_TECHNICAL` 检查扩展到全部阶段 ID。
4. **会话悬停预览**：侧栏会话行悬停/聚焦约 220ms 后，在行右侧浮出预览卡（最近 4 条消息、每条最多两行、去 Markdown 记号、用户消息标"你："）；数据直接复用快照中已有的 `timelineBySession`（无协议变更、无新增请求）；离开/点击/侧栏滚动即消失；pointer-events 为 none 不干扰操作。
5. **权限拒绝防重试**：`TOOL_PERMISSION_DENIED` 文案明确"本轮终审，不要重试同一工具或同一目标，只用 allowedTools 中的工具或提交当前结果"，切断模型的原地重试。

## 已验证

- author-conversation 31/31（省略 id 选择成功、错 id 自纠错文案）；凭据 6/6（缓存塌缩、失效、单次探测）；tools 14/14。
- Bridge 62/62、UI 78/78、Desktop 44/44；runtime 全套 254/254；runtime/web/desktop TypeScript 通过；生产构建与分发边界 PASS。

## 未验证边界与待办

- 切换模型提速的依据是链路与缓存设计 + rc.38 的 PowerShell 耗时实测；未在本机实测切换端到端耗时，安装后可体感复测。
- 术语中文化是提示词层约束，非程序拦截：模型仍可能偶发写出英文阶段名；导演 reason 与作者回复已有文案引导，未加硬过滤（避免误伤正常英文表述）。
- 悬停预览依赖快照中已构建的全量 timeline；目前预览为只读（不可点击跳转具体消息），长消息的 Markdown 仅做记号剥离不做渲染。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.46-x64.exe`；SHA256 `d8093184ddfe5d52fe083825559bf25c1453db56cf91ae85c49791d25b3bc55f`，已登记 `output/desktop/SHA256SUMS.txt`。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0、1189 ms（`output/rc46/desktop-smoke.json`）。
- 两处 `resources/app.asar` SHA256 一致：`e48c3ae07f480abc5e51c282bbbfb206dc2f35e5f0f6696ded6355161bfdd586`。
- 首次打包误用了 rc.45 组装的 dist/package（版本号未重打包），已重做 `build:desktop` 后重新出包并核对版本为 rc.46；教训：版本变更后必须先重跑 `npm run build:desktop` 再 electron-builder。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证，未触碰用户正在运行的已安装实例与真实凭据。
