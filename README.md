# Writing Agent · 写稿 Agent

**把一个想法，写成一篇有自己声音的文章。**

Writing Agent 是一款开源 AI 写作助手，面向公众号文章、观点分析、个人随笔和经验分享。带上你的选题、材料和判断，和它一起找切口、写初稿、讨论修改，把文章一轮轮打磨出来。

**[下载 Windows 桌面版](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.98)** · [快速上手](#desktop-start) · [Claude Code 插件](#claude-code-skill) · [参与开发](#development) · [文档中心](docs/README.md)

Windows x64 公开测试版 · Claude Code Skill / 插件 · [MIT 开源](LICENSE)

<a id="desktop-app"></a>

## 写作的每一步，都可以一起琢磨

一篇文章的难处，常常藏在动笔前和初稿后：这个话题从哪里切入？哪些材料值得用？读者为什么要继续看？改完之后，还像不像自己说的话？

Writing Agent 把这些环节串成一段可以参与的写作过程：

**讨论方向 → 整理材料与提纲 → 写出初稿 → 审校与修改 → 确定标题、核查与导出**

### 先聊清楚，再动笔

只有一个模糊想法，也可以开始。助手会和你讨论主题、读者、观点与材料。在共创模式下，你可以逐步看成果、提问题、换方向，再决定是否继续。

比如，你可以这样说：

> 我想写一篇关于 AI 与职场关系的公众号文章。我的判断是，会用工具之外，还有一些能力会让人脱颖而出。先帮我找一个值得展开的切口。

写到一半，也可以随时接着讨论：

> 这个开头太像报告了。从一个具体的工作场景切入，保留我的判断。

### 把喜欢的写法，留在自己的风格库里

粘贴样文、导入 TXT / Markdown / DOCX，或读取网页与公众号文章，提取其中的结构、节奏、表达方式和示例。你可以编辑、试写、保存，再为不同项目选择合适的风格。

观点文可以直接有力，随笔可以舒展从容。常用写法有了自己的名字，下次写作就能接着用。

### 写完初稿，还有不同视角帮你挑问题

主笔负责展开文章，编辑关注结构和论证，发布审校检查容易引起误解的内容，三位模拟读者提供阅读感受。随后集中修订、打磨语言，再讨论标题和核对事实。

你可以接受建议，也可以追问理由、保留自己的表达。作者的取舍始终是这段协作的一部分。

### 改稿有来处，好句子找得回

方向、材料、阶段成果和稿件版本都保存在项目里。主对话用于讨论，“稿件与版本”用于阅读、比较修改和导出 TXT / HTML。中断后可以从已保存的进度继续，把精力留给文章本身。

### 模型和搜索，由你选择

内置常用模型服务的接入预设，涵盖 DeepSeek、智谱、MiniMax、千问、Kimi、OpenAI、Anthropic、Gemini 等，也支持自定义 API 与本地网关。

可以先用一个模型完成写作，也可以为策划、写作和审校分别分配模型。需要补充公开资料时，可开启 DeepSeek、Parallel 或 Tavily 搜索；手头已有材料，也能直接开始。

## 看看一篇文章是怎么写出来的

[《工资的一半，是你受的气折算的》](demo/工资的一半，是你受的气折算的/draft_v1_humanized.md)是一份 Claude Code 工作流示例。仓库保留了它从选题到成稿的过程，可以沿着每一步看看文章如何形成：

[选题](demo/工资的一半，是你受的气折算的/01_theme.md) → [素材与证据](demo/工资的一半，是你受的气折算的/02_evidence_ledger.json) → [提纲](demo/工资的一半，是你受的气折算的/03_outline.md) → [初稿](demo/工资的一半，是你受的气折算的/draft_v1.md) → [语言打磨](demo/工资的一半，是你受的气折算的/draft_v1_humanized.md)

<a id="rc-status"></a>

## 选择适合你的使用方式

| 入口 | 适合谁 | 怎么开始 |
|---|---|---|
| **Windows 桌面版** | 想通过界面和对话写作的用户 | 安装 App，连接自己的模型服务 |
| **Claude Code Skill / 插件** | 已在使用 Claude Code，喜欢文件工作区和可定制工作流的用户 | 安装插件，在写作目录中启动 Claude Code |

两种入口都在持续维护。原版用户可以继续使用熟悉的工作流，也欢迎体验桌面版。[功能对照与迁移说明](docs/DESKTOP_SKILL_COMPARISON.md)

<a id="desktop-start"></a>

## 开始写第一篇文章

**[直接下载 Windows x64 安装包](https://github.com/dongbeixiaohuo/writing-agent/releases/download/desktop-v1.0.0-rc.98/Writing-Agent-Setup-1.0.0-rc.98-x64.exe)** · [发布说明与校验文件](https://github.com/dongbeixiaohuo/writing-agent/releases/tag/desktop-v1.0.0-rc.98)

1. **安装 App**：下载安装包并运行，桌面版无需另装 Claude Code、Node.js 或 Python。
2. **连接模型**：进入“设置 → 模型”，选择服务商，填写自己的 API Key 和模型 ID，验证连接。
3. **说出想法**：点击“新建项目”，描述选题，也可以带上已有素材、参考文章和写作风格。
4. **一起改好**：查看阶段成果，在对话里提意见、确认标题，完成核查后导出文章。

项目和稿件保存在本机；写作所需的上下文会发送给你选择的模型服务。模型与搜索用量按各自服务商账户计费。当前桌面版为公开测试版，安装提示、备份与升级步骤见[桌面快速开始](docs/QUICKSTART_1_0.md)。

<a id="claude-code-skill"></a>

## 在 Claude Code 中使用

如果你喜欢在终端与文件工作区里写作，可以直接安装 Writing Agent 插件：

```sh
claude plugin marketplace add dongbeixiaohuo/writing-agent
claude plugin install writing-agent@writing-agent-marketplace
```

在准备写作的目录中启动 Claude Code，用自然语言提出需求：

> 我想写一篇关于工作节奏的文章，先和我讨论方向，再整理材料和提纲。

插件将选题、研究、风格、写作、审校与导出串在同一套工作流中，按文章保存材料和阶段文件，方便查看、修改和扩展。

需要已可用的 Claude Code、Node.js 和 Python 环境。安装、更新与工作流定制见 [Claude Code 使用指南](docs/CLAUDE_CODE_GUIDE.md)。

<a id="development"></a>

## 一起把这个写作工具做得更好

欢迎带着真实写作需求来交流：哪一段让你读不下去，哪一句不像你的口吻，哪条修改建议真正帮到了你。这些反馈会直接影响后续的写作体验。

也欢迎贡献模型接入、风格案例、审校方法和界面改进。[提交 Issue](https://github.com/dongbeixiaohuo/writing-agent/issues)时请附上版本、使用入口和复现步骤，并去掉材料中的隐私与 API Key。

### 从源码开始

开发环境使用 Node.js 24.18.0、Python 3.11。先启动带示例数据的界面预览：

```sh
git clone https://github.com/dongbeixiaohuo/writing-agent.git
cd writing-agent
npm ci
npm run ui:dev:mock
```

| 目录 | 内容 |
|---|---|
| `apps/desktop`、`apps/web` | 桌面入口与 Web 界面 |
| `packages/` | 写作流程、模型适配、存储与界面组件 |
| `claude-runtime/` | Claude Code Skill 与专家工作流维护源 |
| `demo/`、`evaluations/` | 写作样例与质量评估工具 |

运行检查：`npm run check:runtime`、`npm run check:ui`、`npm run check:desktop`。Windows 打包使用 `npm run desktop:package`，产物输出到 `output/desktop`。

继续阅读：[项目结构](docs/PROJECT_STRUCTURE.md) · [模型分组](docs/implementation/2026-11-06-model-groups.md) · [搜索设置](docs/QUICKSTART_1_0.md#3-选择是否联网核查) · [开发与发布文档](docs/README.md) · [更新记录](CHANGELOG.md)

## 开源与致谢

Writing Agent 采用 [MIT License](LICENSE)，欢迎使用、修改和贡献。

感谢一路试用和反馈的写作者，也感谢 [CC-Switch](https://github.com/farion1231/cc-switch) 等开源项目提供的参考。第三方代码和配置资料的来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
