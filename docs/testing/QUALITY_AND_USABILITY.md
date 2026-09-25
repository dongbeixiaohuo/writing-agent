# Writing Agent 1.0 质量与易用性评估

日期：2026-09-19  
状态：`BLOCKED_EXTERNAL`。评测工具、12 例夹具、三组盲化和汇总逻辑已完成；另有一条 MiniMax-M3 代表性 Deep 成稿用于产品闭环验收，但它不属于正式三组盲评，人工评分和 5 人上手实验仍未执行。

## 1. 当前已完成

- 12 个合成案例：争议评论、解释分析、叙事观察、实用经验各 3 个。
- 每例固定材料、目标读者、篇幅、约束、观察点和证据缺口；不得补造作者经历或来源。
- PRD 所需三组对照：`legacy`、`candidate`、`simple_baseline`。
- 逐例随机 A/B/C；保密 key 在评审包外；输入正文记录 SHA-256。
- 六个 1–5 分维度：信息增量、结构、具体细节、作者声音、阅读吸引力、事实可信度。
- 重大事实错误独立否决；缺失/重复/非法评分 fail closed，不把缺失当 0。
- 汇总分别报告新版相对旧版和简单基线的描述性差异，不计算或暗示统计显著性。

自动验证：

```powershell
python -B -m unittest tests.test_writing_evaluation
```

结果：12/12 通过，包含三组 36 篇盲化、映射、否决和汇总测试。

## 2. 正式质量实验协议

三个 arm 对同一案例必须使用相同材料、简报、模型、采样参数、上下文预算和最大迭代次数：

1. `legacy`：冻结的旧版工作流/提示词。
2. `candidate`：`1.0.0-rc.5` 自有 runtime、writing pack、连续共创、主对话优先交互与可见两阶段升级。
3. `simple_baseline`：一次性简单写作提示，不含候选流程的多阶段机制。

不允许同时换模型后把差异归因于新 runtime；UI 来源、运行时、写作策略的变化分别记录。真实生成需要维护者明确费用授权，运行 manifest 要记录模型、端点类别、prompt revision、参数、usage 和停止原因，但不得保存 Key。

```powershell
py evaluations/writing_blind_review.py prepare-three-way-suite `
  --legacy-dir <旧版12例目录> `
  --candidate-dir <新版12例目录> `
  --simple-dir <简单基线12例目录> `
  --cases evaluations/cases/writing_quality_cases.json `
  --out temp/blind-three-way `
  --key-out temp/blind-three-way-key.json `
  --seed 20260918 `
  --model <实际同一模型> `
  --prompt-version "legacy=<rev>,candidate=<rev>,simple=<rev>"
```

评分结束后：

```powershell
py evaluations/writing_blind_review.py summarize-three-way `
  --scores temp/blind-three-way/scores.csv `
  --key temp/blind-three-way-key.json `
  --out temp/blind-three-way-summary.json
```

## 3. 当前质量结果

| 指标 | 当前值 |
|---|---|
| 已生成完整三组案例 | 0/12 |
| 已完成人工盲评案例 | 0/12 |
| 新版偏好数 | `unknown` |
| 六维均分/差值 | `unknown` |
| 重大事实错误否决数 | `unknown` |
| 模型/usage/成本 | `unknown` |

这些值未执行，不是 0 分或“无错误”。在真实数据产生前，不宣称新版本文章质量、阅读量、事实正确率或传播效果提升。

产品候选另有一条非盲评样例：两份材料、九阶段、三类审校、事实门禁、11 处局部修改和正式导出完整跑通。它证明产品能把审校问题暴露并 fail closed，也暴露了模型集中修订并不总能一次消除所有材料外推断；因此不能拿这一条样例代替 12 例质量结论。rc.5 包含的主对话与安装器专项回归只证明信息架构和交互闭环，同样不代替真实文章质量盲评。

## 4. 五人上手实验

统一任务：从安装包开始，配置一个已授权模型，导入合成材料，创建项目，得到第一版稿件，锁定一个段落、完成一次局部修改、查看核查状态并导出工作备份。观察者只在参与者明确卡住时记录帮助。

记录字段：

- 参与者编号和使用背景（不收集不必要身份信息）；
- 是否完成安装、模型配置、首稿、局部修改、恢复和备份；
- 首次可操作/首稿耗时；
- 阻塞步骤、错误原文、是否需要帮助；
- 是否愿意完成第二篇任务；
- 自愿反馈，不要求交私人文章全文或 API Key。

| 项目 | 当前值 |
|---|---|
| 目标参与者 | 5 |
| 实际参与者 | 0 |
| 完成首篇 | 0/0（未执行，不计算成功率） |
| 无帮助完成 | 0/0（未执行） |
| 阻塞记录 | 尚无真实参与者数据 |

## 5. 完成判据

WA-019 只有在 12 例三组正文真实存在、人工评分完整、重大事实错误单列，并且 5 人实验留下真实分母/阻塞记录后才能标为 `DONE`。评测工具完成不等于质量评估完成。
