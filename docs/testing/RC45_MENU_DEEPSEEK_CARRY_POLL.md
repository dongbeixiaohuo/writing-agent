# rc.45：切换菜单修复、DeepSeek 专项适配、跨 run 阶段承接、轮询门控

日期：2026-09-26。范围：模型快捷切换、DeepSeek 请求适配、协作写作恢复语义、后台轮询性能；不修改事实门禁、存量项目数据或凭据。

## 根因与证据（用户报告四项 + 自查发现一项）

1. **快捷切换菜单显示"没有已保存 Key 的模型可切换"**（实际正在使用 MiniMax）：rc.38 的 `providerStatus('summary')` 刻意不做凭据读取，`configured` 恒为 false、`credentialChecked` 恒为 false；rc.44 的新菜单按 `configured` 过滤导致空列表。菜单打开本身不慢（summary 为本地读取），用户感知的等待还包含切换时的 bridge 重建（rc.37 设计）——已补"正在切换模型"进行态提示。
2. **DeepSeek 运行失败**：rc.44 的上游摘要直接给出原因——`Thinking mode does not support this tool_choice`。deepseek-flash 默认开启 thinking 模式，而本应用的连接探测与阶段提交始终使用 `tool_choice="required"`，DeepSeek thinking 模式拒绝该取值。补充更正：该错误来自用户仍保存为 **Responses 协议**的配置（request_id 格式与 DeepSeek 官方网关一致，证明 `/responses` 端点存在并解析了请求）——rc.43 文档推测的"DeepSeek 不支持 Responses"并不准确，rc.43 早晨的两次 HTTP 400 真实原因同样是 thinking + tool_choice；rc.43 选择 Chat 作为可验证主路径的决定仍然成立，但不支持 Responses 的叙述以此为准。
3. **语言终审暂停后回复"继续"，写作从提纲重来**：工作区事件留证——新 run 的 `completedStages=[]`（阶段完成按 run 记录），导演先说"下一步：language_review"，随即按契约"新 run 即使已有稿件修改，也应从 research 按原流程推进"（`collaboration.ts` 提示词 + `DIRECTOR_STAGE_INVALID`/`DIRECTOR_REWORK_NOT_AVAILABLE` 双重强制）重走研究→提纲。不是 rc.42 修复导致阶段丢失；rc.42 的可恢复暂停只覆盖"同一 run 内的等待恢复"，用户当时是手动停止了死循环 run，属于取消，不在其范围。
4. **对话打字比外部应用卡**：用用户真实工作区（7 项目 / 64 run / 3280 事件）实测——bridge 每 100ms 的轮询会重建全部项目投影，**每次 40.2ms**，另有 `#replace` 的全量快照两次 JSON.stringify；即空闲时也持续烧掉约半个 CPU 核，且随数据量增长。这是 rc.42 合成输入测量（12.4ms）覆盖不到的后台成本：合成 fill 不占 CPU 时表现正常，真实 IME 输入与后台重建争抢时才表现为卡顿。

## 修改

1. **快捷菜单**：过滤改为 `configured || credentialChecked === false`（summary 下"未检查"按"已保存过 Key"处理；`selectProvider` 仍由 Host 实际验证，缺 Key 会在菜单内给出明确错误）；新增"正在切换模型，请稍候…"进行态。
2. **DeepSeek 专项适配**（rc.39 预留的"服务商额外契约专项适配"路径）：openai-compatible 适配器新增 `extraBody`（厂商请求字段，只追加不覆盖协议字段，快照与实际请求一体构建）；`cc-deepseek` 与 `deepseek` 预设声明 `thinking: {type: 'disabled'}`（本应用全程 `tool_choice="required"`，thinking 模式不可用）；桌面 `providerConfigForInput` 按 authHeader 同款规则注入/保留；`loadDesktopProviderCatalog` 对仍精确匹配预设的存量配置做**只读填充**（不改文件，改过地址的配置不借用）。
3. **跨 run 阶段承接**：`SessionStore` 增加 `listRuns`（唯一实现 WorkspaceStorage 已具备）；workflow 工厂在 `progress()` 首次访问时做幂等播种——同会话中最近一个 failed/cancelled/interrupted 且有标记的 run，其连续完成前缀（跳过 fact_check，它留在项目级门禁）以本 run 名义写入标记并指向同一产物版本。承接标记是本 run 自己的产物：rework/失效/下游 CAS 与新生标记完全同规则。导演提示词补充例外说明；`initialContextIds`、drafted 判定等既有读取路径自然一致。已完成 run、其他会话、无标记 run 均不承接。
4. **轮询门控**：`WritingApplicationService.hasProjectEventsAfter(projectId, seq)`（只读新事件，不重建投影）；bridge 在 `#buildSnapshot` 时记录各项目 `latestProjectSeq`，轮询 tick 先探测（无新事件且项目集合未变则跳过重建），探测异常时 fail-open 走原有全量刷新与 offline 报告。实测 tick 成本 **40.2ms → 0.11ms**（同一真实工作区）。

## 已验证

- 适配器 24/24（extraBody 合入请求体且不覆盖协议字段、快照一致）；provider-config 6/6；presets 16/16（DeepSeek 两个预设均带 thinking-disabled）；desktop 45/45（只读填充、同 transport 保留、改地址不借用）。
- 承接：同会话取消 run 的 research+outline 被承接、nextStage=draft、不重复 outline 提交、产物版本一致、fact_check 不承接；已完成 run 不承接；跨会话不承接。协作套件 46/46。
- 门控：spy 断言空闲 tick 零投影重建、新事件后下一 tick 恰好重建并发布；bridge 62/62。
- UI 78/78；runtime 全套 254/254；runtime/web/desktop TypeScript 通过；生产构建与分发边界 PASS。

## 未验证边界与待办

- DeepSeek Chat + thinking-disabled 未经真实账号验证：适配依据是上游错误原文（"Thinking mode does not support this tool_choice"）与 DeepSeek 官方 thinking 开关文档；用户安装后用真实 Key 保存并验证连接即可当场确认。 Responses 协议配置不消费 extraBody（cc-deepseek 已是 Chat）。
- 承接目前只覆盖同一项目同一会话内的连续前缀；跨会话/跨项目续写不在范围。承接后导演可见 completedStages 非空（含承接），提示词已说明；若用户在两次 run 之间于流程外改过正文，既有 expectedBodyVersionId 检查仍会先停机确认。
- 打字卡顿：门控消除了已实测的最大后台成本（每 100ms 40ms 投影重建）；真实中文输入法候选窗、200% 缩放、整机负载下的体感仍需用户复测。rc.42 已声明未完成的 CPU 限速原生压力测试仍未完成。

## 打包验证（已完成）

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.45-x64.exe`；SHA256 `5df3b42473fbbe676b42699bf59d961311497e5b09ed7b4b02050b6e92fde89c`，已登记 `output/desktop/SHA256SUMS.txt`。
- 成品 smoke：短 TEMP 路径启动 ready、协议 20、退出码 0、1378 ms（`output/rc45/desktop-smoke.json`）；长 OneDrive 路径直启仍会触发已知 GPU 崩溃，沿用既有规避。
- 两处 `resources/app.asar` SHA256 一致：`c824b40643022d29c600866e7df33fef5ba619497fccb8099b0b225b6231743b`。
- 未运行安装器升级/卸载，未做浏览器/原生交互验证，未触碰用户正在运行的已安装实例与真实凭据。
- **用户存量 DeepSeek 配置的处理路径**（安装后一次性手动步骤）：当前保存的配置仍是 Responses 协议（rc.43 更正预设时存量不迁移），只读填充只覆盖 Chat 协议配置，因此需要：编辑 DeepSeek 配置 → 自定义设置 → 修改协议或使用自定义 API → API 协议选 OpenAI Chat Completions → 重新输入 Key → 保存并验证连接。保存时预设自动注入 thinking-disabled，连接验证应通过。
