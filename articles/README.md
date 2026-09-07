# articles 目录说明

每篇文章一个项目目录，当前正文以 `run_manifest.json -> latest_body_file` 为准。历史目录保持原状；新项目使用 [collab-v2 契约](../docs/WORKFLOW_CONTRACT.md)。

| 文件 | 作用 |
|---|---|
| `01_theme.md` | 文体、读者新收获、作者声音、素材来源与授权 |
| `00_memory_packet.md` | 有来源、有适用边界的记忆 |
| `01b_position.md` | 可被研究修正的判断 |
| `02_scar_tissue.md`、`02_evidence_ledger.json` | 真实素材、解释材料、来源、反证和边界 |
| `03_outline.md` | 按文体组织的结构与素材分配 |
| `04_share_map.md` | 与传播目标相符的读者价值，可为不适用 |
| `05_concrete_library.md` | 细节、解释、类比及来源类型 |
| `04_title.md`、`05c_opening_hook.md` | 早期暂定，成稿后复核标题和开头 |
| `draft_v1.md`、`draft_v1_notes.md` | 正文与内部备注分别保存 |
| `editor_review.md`、`pre_publish_review.md`、`wechat_reader_test.md` | 三份独立意见，不能直接改稿 |
| `revision_brief.md`、`revision_result.md` | 导演汇总取舍，主笔集中修订或保留 |
| `humanizer_review.md` | 表达诊断；需要改动才生成新正文 |
| `draft_vN_illustrated.md` | 配图后的新正文，如有 |
| `fact_check_snapshot.json` | 核查前固定的正文、标题和证据账本 |
| `fact_claims.json`、`fact_check_report.md` | 逐项核查清单与脚本计算的报告 |
| `run_manifest.json` | 当前版本、导出来源和核查绑定 |
| `[正文文件名]_clean.txt`、`[正文文件名].html` | 纯文本与可选 HTML 出口 |
| `99_episode.md` | 带来源的复盘，无差异也写原因 |
| `publication_metrics.jsonl`、`performance_reviews/` | 用户明确要求时才记录的发布后真实数据与分析 |

可以手动编辑草稿并指定“基于这个版本继续”，agent 应记录改动来源。不要把内部备注写进正文，不要手动把事实状态设成 passed。正文、标题、账本或核查结果变动后，重新核查并生成导出；旧 `_clean.txt` 或 HTML 文件存在不代表当前稿可交付。

```powershell
python scripts/fact_check_gate.py check --project "[项目名]"
python scripts/auto_clean_hook.py --project "[项目名]"
```

纯文本统一通过显式项目的 Hook 生成。默认不配图、不导出 HTML，有明确要求时再处理。最终稿不要求固定名为 draft_最终稿.md；真实最新文件由 manifest 指向，避免多个“最终版”含义冲突。
