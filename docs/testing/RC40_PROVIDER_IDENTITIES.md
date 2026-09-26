# rc.40：供应商地区、套餐与协议身份

日期：2026-09-26。范围仅模型配置目录、设置界面及新套餐的认证默认值；不改写作工作流。未安装到用户现有应用，未改原项目、原配置或 Key，未发布到 GitHub。

## 根因和修复

rc.39 用名称正则猜测套餐/国际站，用“协议+地址”归并条目。因而把 AICoding 误归为套餐，漏标智谱 Coding Plan 和 BytePlus，合并腾讯个人/企业档位，并漏掉千问国内 Coding Plan。

本版使用显式身份目录，区分供应商、账号地区、服务类型、档位、接入渠道和请求协议。地区未提供则标明未知；不以域名猜数据驻留。110 个配置选项保留不同套餐身份，新增 5 个智谱/Z.AI/千问协议选项。MiniMax 标明国内 Token Plan、国际 Coding Plan 与 API 共用入口，实际权益和扣费由 Key 决定。

设置支持地区/套餐筛选和多关键词搜索；提供“协议不是套餐”的说明。旧显示名称保留；卡片显示“预设参考”，不是已验证的订阅权益。只有共用地址且没有匹配 ID 的旧配置保持自定义。已修改地址不继续借用预设套餐说明/模型目录。

## 自动验证

- UI 测试 73 项、桌面测试 43 项通过。新增身份/协议/档位覆盖、共用地址歧义、搜索过滤、精确地址下 Bearer 认证及旧认证保留回归。
- Chat / Responses / Anthropic 本地适配器 20 项通过。
- 来源与 UI 边界 12 项通过，包括固定来源派生文件哈希核对。
- Bridge、Web、Desktop 类型检查通过；生产构建与桌面分发 13 文件边界通过。
- 浏览器生产 renderer + 隔离真实 Host：9 组检查通过，页面错误 0、renderer 外网请求 0。使用合成 Key 和合成连接验证，不是厂商付费调用。
  - 智谱国内 Coding 三协议可搜索；千问国内 Coding、BytePlus 国际 Coding、未知地区 AICoding 正确显示。
  - 腾讯国际三档分别可选，Lite 只有源目录的 `auto` 示例，不混入 Pro 模型。
  - 筛选保留当前项、不写配置；选择另一预设清空未保存 Key/模型。
  - 编辑旧显示名称、留空复用同端点 Key、换模型、重开设置后保持。
  - 自定义 Responses、小窗口操作、变更端点不能复用 Key、列表不读 Key 保持正常。

浏览器证据：`output/playwright/provider-presets/result.json`、`00-zhipu-plan.png`、`01-provider-list.png`。

## 打包成品实测

- NSIS x64 构建成功，产物 `output/desktop/Writing-Agent-Setup-1.0.0-rc.40-x64.exe`，111,487,547 字节。
- 安装包 SHA256：`cba23451881a7810d0237bed72c91b88465ba08112e4137f7f9311d2ede6030a`；同步到 `output/desktop/SHA256SUMS.txt`。
- unpacked `app.asar` 与用于启动验证的短 TEMP 路径副本哈希一致：`eb650b5ddfa7541f57fe61ac674b0718ae486109fd65bb11cda9aca167c05b97`。沿用 rc.37 已记录的长 OneDrive 路径运行规避方式，不把本次短路径通过当成长路径问题已修复。
- 原生 Electron/真实 preload/IPC 检查通过：列表 93 ms 可见；智谱套餐搜索、腾讯国际 Lite 目录、旧等待会话换模型、Key 复用、端点变更拒绝、预览零配置写入、刷新保持，页面错误 0。假 Key 配合 loopback 端口 9 的连接失败是预期负向验证。
- 证据：`output/rc40/native/rc40-f9139f7d-4aad-4ebf-9d03-f9ce974864e6/result.json`。
- 启动 smoke 729 ms，ready、协议 20、退出码 0；证据 `output/rc40/desktop-smoke.json`。

测试进程使用独立临时工作区，不操作已安装的 Writing Agent 进程。原项目写入和真实模型请求均为 0。安装包仍未签名，Windows 可能显示发行者未知提示。

## 边界

- 新套餐没有对应真实账号，本版验证静态来源、应用协议映射和交互，不声称全量供应商均已联网验证。
- 套餐规则、地区可用性、扣费方式及允许应用范围以供应商和用户账号为准；“连接验证通过”不证明套餐适用性。
- KAT-Coder 专属接入点、Azure 资源模板、OAuth 登录不做伪一键支持；自定义模型入口保留。
- 未执行安装器升级/卸载；未改变安装器逻辑。桌面成品检查另见下方实测记录。
