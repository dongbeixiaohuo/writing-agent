# rc.53：提纲确认误判死循环、流式恢复、侧栏死入口清理

日期：2026-09-28。范围：共创提纲确认判定、bridge 流式刷新、侧栏 UI 清理；不修改事实核查口径、工作流阶段顺序、存量项目数据或凭据。

## 根因与证据（用户报告三项）

1. **提纲重复出三遍**（"程序员的悲歌"项目，run `811d74e1`，事件流实证）：作者在提纲确认点回复"方向可以"，命中的是 `OUTLINE_REWORK_REQUIRED`——确认判定是一个精确白名单正则（`^(?:确认|同意|继续|可以|好的|ok…)$`），"方向可以"不在其中，被当成"要求改提纲"。于是导演走 rework → 提纲及后续全部阶段作废 → 提纲专家重出一版 → 又回到提纲确认点。作者每确认一次就循环一次，还白烧一次 majorRevision 预算。
2. **提纲阶段 200 多秒没有流式**：`ConversationStreamPreview` 的 delta 收集和 `liveReply` 都正常，但 bridge 的 100ms 轮询有个"dirty 才重建快照"的省电优化——流式 delta 不产生任何持久化事件，所以 dirty 永远为 false，快照里的 `liveReply` 冻结到请求结束才刷新，用户看到的就是"一口气全出来"。
3. **侧栏"写作项目"行**：一个无 onClick 的静态按钮，只在有扩展 launcher 时作分组标题用；当前注册表不含任何 sidebar 扩展，纯占位。

## 修改

1. **提纲确认判定放宽**（`packages/application/src/collaboration.ts`）：新增 `outlineApproved()`——精确白名单照旧；另外 30 字以内、含肯定词（可以/确认/同意/认可/继续/没问题/好/行/ok）且不含改向词（改/换/调整/重写/重新/不要/别/不行/不对/但/不过/然而/删/增/补等）的短回复也算确认。"方向可以"从此直接放行进入初稿。
2. **流式恢复**（`packages/client-bridge/src/application-bridge.ts`）：`#refreshWhenDirty` 增加 ephemeral 流状态指纹（liveReply 文本长度/阶段 + liveActivity 相位/请求序号/工作预览长度）；指纹变化且距上次流式刷新 ≥200ms 时重建快照。无运行的空转 tick 仍然零成本。
3. **侧栏清理**（`WritingAgentShell.tsx`）：删除无作用的"写作项目"静态行；扩展 launcher 渲染保留。

## 已验证

- 新增回归测试：共创模式提纲确认点回复"方向可以"，提纲 artifact 保持 1 版不返工，运行进入初稿确认点。
- 全量：runtime 261、bridge 63、ui 78、desktop 44、conversation 67、legacy-parity 59 全绿；runtime/web/desktop 三端 TypeScript 通过。

## 未验证边界

- 确认判定是关键词启发式："还可以更好"这类含"可以"的模糊短句会被当成确认（用户仍可在初稿确认点再提修改）；带"但/改/换"等词的回复照旧返工。权宜取舍已在此记录。
- 流式刷新节流到 200ms 一档；快照重建在大型工作区约几十毫秒，流式期间约每秒 5 次重建，CPU 开销未在低端机上实测。
- 旧的"三遍提纲"项目里被作废重写的提纲版本留在历史版本中，不做清理。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.53-x64.exe`；SHA256 `283d9a3dc1cba97483aef94b55239c1df299032f6a148e51725a12f309345bf7`，已登记 `output/desktop/SHA256SUMS.txt`。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0（`output/rc53-desktop-smoke.json`）。
- 未运行安装器升级/卸载，流式效果未真机实测（装后开一轮写作即可看到逐字输出），未触碰用户正在运行的已安装实例与真实凭据。
