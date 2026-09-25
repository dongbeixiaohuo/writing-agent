# 写作质量盲评

这是纯本地、人工评分的工具：不调用 LLM、网络服务，也不生成文章。`cases/writing_quality_cases.json` 是 12 个**合成评测夹具**，争议评论、解释分析、叙事观察、实用经验各 3 个。每例提供短材料、读者、篇幅、约束和观察点；它们不是用户、客户或公开来源的真实经历。材料刻意保留证据缺口，评测文章不得补造来源。正式 1.0 质量评估使用旧版、新版、简单基线三组同输入盲评；原 A/B 命令继续用于日常回归。

## 准备实际文章

单对比较可传 Markdown 正文，或传含 `run_manifest.json` 与 `latest_body_file` 的项目目录：

```powershell
py evaluations/writing_blind_review.py prepare --baseline <旧版正文或项目目录> --candidate <新版正文或项目目录> --out temp/blind-packet --key-out temp/blind-key.json --seed 20260907
```

整套评测要求两侧目录中每例都有 `<case-id>.md`，也可有同名项目目录及其 manifest。工具先验证全部 12 个输入；任一缺失则不会创建盲评包或 key：

```powershell
py evaluations/writing_blind_review.py prepare-suite --baseline-dir <旧版目录> --candidate-dir <新版目录> --cases evaluations/cases/writing_quality_cases.json --out temp/blind-suite --key-out temp/blind-suite-key.json --seed 20260907 --model <可选名称> --prompt-version <可选版本>
```

1.0 三组评测命令如下。三个目录必须使用同一份简报和材料；模型、采样参数和上下文预算也应保持一致，只改变被评估的流程或提示词：

```powershell
py evaluations/writing_blind_review.py prepare-three-way-suite --legacy-dir <旧版目录> --candidate-dir <新版目录> --simple-dir <简单基线目录> --cases evaluations/cases/writing_quality_cases.json --out temp/blind-three-way --key-out temp/blind-three-way-key.json --seed 20260907 --model <实际模型> --prompt-version "legacy=<版本>,candidate=<版本>,simple=<版本>"
```

三组会逐例随机映射为 A/B/C；盲评包包含 36 篇正文、统一简报、评分表和 rubric，保密 key 仍必须放在包外。

盲评包包含按例编号的 A/B 正文、`rubric.md`、`scores.csv` 和不含来源路径的 `packet.json`；整套评测还会附上 `briefs.json`，供评分人核对读者、材料与事实边界。已知版本、风格、来源路径、模型和提示词元信息会从正文头部剥离；实际标题、正文与引用保留。`key-out` 必须在包目录外，且不得已存在。key 记录映射、输入内容 SHA-256、随机 seed，以及可选 model/prompt version。省略 `--seed` 时随机生成；指定 seed 可复现。

两侧使用同一简报、材料、模型和生成参数，仅改变待比较的提示词或流程；`--prompt-version` 可记录两侧修订标识（如 `baseline=<revision>,candidate=<revision>`）。评分前不要向评审人提供 key。工具可以去除常见头部标签，但正文若自行透露版本身份，需在发给评审前另行检查。单对模式请同时提供不含版本信息的相同写作简报。

评分人将六个维度的 A/B 分别填为 1–5：信息增量、结构、具体细节、作者声音、阅读吸引力、事实可信度；`preferred` 填 A、B 或 TIE，重大事实错误填 yes/no。重大事实错误是独立否决项。

## 汇总

```powershell
py evaluations/writing_blind_review.py summarize --scores temp/blind-suite/scores.csv --key temp/blind-suite-key.json --out temp/blind-suite-summary.json
```

三组结果使用独立汇总命令：

```powershell
py evaluations/writing_blind_review.py summarize-three-way --scores temp/blind-three-way/scores.csv --key temp/blind-three-way-key.json --out temp/blind-three-way-summary.json
```

汇总拒绝未知、缺失、重复案例，非法分数和非法 key 映射；缺失评分不会按 0 处理。结果不得覆盖 scores 或 key 输入，输出映射回两版后的维度差异、偏好计数和事实错误否决计数。它只报告人工盲评描述统计，不宣称显著性、因果或真实发布效果。
