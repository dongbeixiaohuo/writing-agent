# rc.41：可见搜索、输入性能与 Responses 默认选项

日期：2026-09-26。范围仅供应商设置与静态目录；未修改协议适配器或写作流程。没有安装、发布、修改原项目或原模型配置，没有真实模型调用。

## 可复现根因

1. rc.40 搜索修改原生 select 的隐藏 options，但界面仍显示此前选中的 MiniMax。搜索“智谱”后没有任何直接可点击的匹配项，用户看不到筛选效果。
2. 同机真实打包客户端连续 8 次搜索输入，最高输入到画面更新 323.7 ms。仅移除全屏 backdrop blur 的对照组降到 134.6 ms，搜索问题仍按预期失败。1000 次单独目录过滤平均 0.039–0.045 ms，不是主要瓶颈。
3. 搜索状态原先在整个供应商表单内，输入会重渲染凭据和模型目录；现由独立选择组件管理，目录索引预计算，首批 12 条可展开。仅设置窗口去掉全屏模糊，其他模态框不变。

红测：`output/rc41/search/rc40-baseline/rc40-5515aa0e-3d69-42f0-858b-763ff75f8d2e/result.json`。
单变量对照：`output/rc41/search/rc40-no-blur/rc40-7c44363f-1778-41d0-92bc-ce202389861f/result.json`。

测试脚本 `tests/ux/provider_search_native.py` 支持旧/新控件，以真实 input 事件到两帧 requestAnimationFrame 测量；均为相同本机 `--disable-gpu` 软件渲染环境。数字是该样本的观察，不是所有机器的性能保证，也不是模型响应耗时。最初测试脚本的字符串 predicate 被 CSP 拒绝，已改用函数 predicate；该测试实现问题不记作产品缺陷。

## 行为约定

- 匹配数量、无结果提示和选择按钮直接可见；搜索不保存、不选中供应商、不更改 Key。旧选项不再混入不匹配的结果，现有配置单独展示。
- 资料未拆分地区的入口显示“不区分国内 / 国际”，不承诺全球可用或账号通用。
- 完整目录 110 项保留供旧配置识别；新选项 100 项。同地区、同服务和套餐的 10 组 Chat/Responses 只展示 Responses。智谱/Z.AI 通用 API 不被 Coding Plan 替代；Chat-only 和 Anthropic 不变。
- 已保存 Chat 仍可编辑；自定义 API 继续支持 Chat，不做静默迁移或失败后自动换端点。收录依据是指定 cc-switch 固定资料，不代表逐账号联网认证通过。

## 回归结果

- UI 单元测试 75 项、桌面测试 43 项通过。
- 来源/界面分发边界 12 项通过，派生文件哈希已同步；桌面分发边界 13 文件通过。
- Bridge/Web/Desktop 类型检查与生产构建通过；`git diff --check` 通过。
- 生产 renderer + 隔离真实 Host 浏览器 10 组通过：搜索结果、展开、组合过滤、零结果、回车不保存、套餐档位、Key 隔离、模型修改/重载、小窗口、旧 Chat 编辑不迁移。页面错误 0、外网请求 0。
- 浏览器证据：`output/playwright/provider-presets/result.json`、`00-zhipu-plan.png`。合成 Key 和合成连接测试，不是厂商 API 实测。

## 打包桌面验收

- rc.41 输入到更新 8 个样本：100.5、72.5、103.5、102.7、108.0、105.3、103.7、33.5 ms；最高 108.0 ms，低于回归阈值 250 ms。搜索结果可点击，不保留不匹配的旧选项。
- 绿测证据：`output/rc41/search/rc41-final/rc41-a3d71763-7587-466b-91e8-9859af7ba1a1/result.json`、`search.png`。
- 原生 IPC：设置列表 78 ms 可见；套餐过滤、旧等待项目换模型、保留当前会话、Key 复用、改变端点拒绝复用、预览零配置写入、重载后模型保持通过。页面错误 0。
- 证据：`output/rc41/native/rc41-0ffbf546-0c75-413d-b830-eea1de0147ad/result.json`。假 Key + loopback 端口 9 验证失败是预期负向结果。
- 启动 smoke：694 ms，ready、协议 20、退出码 0；证据 `output/rc41/desktop-smoke.json`。
- 测试副本与打包 `app.asar` SHA256 一致：`5b75c9b787cc7fef2d2971debb4dbf8b293d9268fdfcf02593018d666510ee2f`。沿用短 TEMP 路径启动，不宣称旧长 OneDrive 路径问题已修复。

## 交付边界

安装包 `output/desktop/Writing-Agent-Setup-1.0.0-rc.41-x64.exe`，111,490,000 字节，SHA256 `f6c7c0768c0d0f388033538b62a58d87dde8836587f708830fbc5a10315cb980`；同步 `SHA256SUMS.txt`。包未签名，Windows 可能提示未知发行者。

未执行安装器升级/卸载，未更改安装器逻辑，未发布 GitHub，未执行 commit。所有桌面测试隔离工作区，未停止用户现有程序；本次不改变整体写作业务验收结论。
