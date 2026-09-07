# 协作写作快速参考

机器契约：[collab_v2.json](../claude-runtime/workflows/collab_v2.json)。完整行为：[workflow-producer](../claude-runtime/skills/workflow-producer/SKILL.md)。字段和迁移说明：[WORKFLOW_CONTRACT.md](WORKFLOW_CONTRACT.md)。

1. 明确文体、读者新收获、作者声音和真实素材。默认自主推进；用户可以改为逐步共创，已授权的选择不用重复确认。
2. 装载有来源的记忆，研究支持与反证，再编排结构。说明性情景不冒充采访或亲历。
3. 标题与开头先暂定，写出初稿后再复核；Stage 9 前锁定最终标题和分发文案。
4. 主编、发布前和读者测试分别提意见；导演合并 `revision_brief.md`，主笔在 Stage 9.5 集中修订。允许保留原稿，最多两轮重大改动。
5. Humanizer 先诊断，有具体收益才改。可选配图完成后核查最终版本。
6. 事实核查固定输入快照，脚本计算结果。无来源、矛盾、部分支持和未补证的问题一律阻断。
7. 通过后生成 `_clean.txt`，按要求额外导出 HTML，最后写 `99_episode.md`。模拟读者结果不能当真实发布效果。

常用命令（仓库根目录）：

```powershell
# 写初稿前；模式 A 使用 --mode A
python scripts/verify_required_files.py --project "[项目名]" --workflow .claude/workflows/collab_v2.json --stage 6 --mode B
# 早期方案；Stage 9 起不得以 planning 代替最终检查
python scripts/verify_required_files.py --project "[项目名]" --required 04_title.md 05c_opening_hook.md --phase planning
# 只读字数统计
python scripts/generate_clean.py --stats "articles/[项目名]/[当前正文].md"
# 先由 fact-checker 创建快照和清单，再检查当前交付资格
python scripts/fact_check_gate.py check --project "[项目名]"
python scripts/auto_clean_hook.py --project "[项目名]"
```

当前正文以 manifest 为准。`draft_v*.md` 只放标题、元信息和正文，notes 保存内部说明。标题、正文、账本、快照、核查清单或报告发生变化后需重新核查；旧同名导出文件不是当前通过证明。

HTML 为可选：A=default、B=grace、C=simple、D=modern、N=不导出。配图与 HTML 未要求时默认跳过；有选择就直接使用，不在子 agent 中再次询问。

Stage 13 无差异也记录原因。可选 Stage 14 仅由用户明确触发，用追加式发布指标账本做同口径观察。历史文章和 demo 的旧协议不迁移，新项目使用当前模板。
