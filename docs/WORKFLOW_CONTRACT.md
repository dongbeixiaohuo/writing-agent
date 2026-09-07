# 协作写作工作流契约（collab-v2）

运行时唯一源为 [claude-runtime](../claude-runtime/)。机器契约是 [collab_v2.json](../claude-runtime/workflows/collab_v2.json)，行为说明是 [workflow-producer](../claude-runtime/skills/workflow-producer/SKILL.md)。`.claude/`、根 `scripts/` 和插件内容由同步脚本生成。下表用于阅读，完整 inputs/outputs 以 JSON 为准。

| Stage | 职责 | 主要输出 |
|---|---|---|
| 1 | 简报、文体、读者新收获、作者素材与授权 | `01_theme.md` |
| 0 | 读取带来源与适用边界的历史经验 | `00_memory_packet.md` |
| 1.5 | 可被研究修正的判断 | `01b_position.md` |
| 2 | 支持材料、反证、来源与限制 | `02_scar_tissue.md`、`02_evidence_ledger.json` |
| 3 | 按文体编排结构与材料 | `03_outline.md` |
| 4 | 按传播目标设计读者价值，可记不适用 | `04_share_map.md` |
| 5 | 来源可辨认的细节和解释 | `05_concrete_library.md` |
| 5.5 | 差异化标题及分发文案，可暂定 | `04_title.md` |
| 5.8 | 适合文体的开头，可暂定 | `05c_opening_hook.md` |
| 6 | 主笔初稿 | `draft_v1.md`、`draft_v1_notes.md` |
| 7 | 写作工艺与声音评审，不改稿 | `editor_review.md` |
| 8 | 读者价值与发布风险，不改稿 | `pre_publish_review.md` |
| 9 | 成稿标题锁定后的平台读者测试 | `wechat_reader_test.md` |
| 9.5 | 主笔按汇总意见集中修订或保留 | `revision_result.md`，有改动才生成新正文与 notes |
| 10 | 语言诊断，只有收益明确才改 | `humanizer_review.md`，有改动才生成新正文与 notes |
| 11 | 可选配图，更新最新正文 | 图片与新正文（可选） |
| 10.5 | 对最终正文、标题及分发文案逐项核查 | `fact_check_snapshot.json`、`fact_claims.json`、`fact_check_report.md` |
| 12 | 明确项目并验证核查后生成纯文本 | `[正文文件名]_clean.txt` |
| 12.5 | 可选 HTML | `[正文文件名].html` |
| 13 | 保留来源的复盘，无差异也写原因 | `99_episode.md` |

B 的起步为 Stage 1 → Stage 0 → Stage 1.5。A 仅要求最小简报即可写 Markdown 草稿；需要正式导出时也要补齐最终标题、证据账本与事实核查。C 的选题池和交接来自 `modes.C`。Stage 14 为用户明确触发的发布后复盘，不改变正常终点 13。

## 互动与版本

默认自主推进，逐步共创可选。保留简报/素材、文章方向、整稿取舍的决定节点；既有明确授权不重复请求。配图、HTML 默认不启用，按简报中的要求处理。

JSON 的 `artifact_policy.provisional_title_and_opening_stages` 声明允许暂定的阶段；Stage 9 起必须使用最终锁定标题和已选分发文案。明确检查早期标题/开头使用 `--phase planning`，最终检查不能使用该参数。Stage 8 后重调标题设计师结合最新正文复核，并同步正文 H1。

三份评审各自注明正文版本，只给“必须修 / 可选 / 保留原样”。导演将意见与授权、被评正文 SHA-256 写入 `revision_brief.md`，主笔读取后集中执行。重大修订最多两轮；没有实质改动不创建新版本。论证、标题承诺或首屏改变后重跑标题复核和 Stage 9。

正文和备注分离，动态正文由 `run_manifest.json` 解析，不能按修改时间猜测。通过 `update_run_manifest.py` 记录 `latest_body_file`、`latest_notes_file`、`clean_source_file`。`conditional_outputs` 仅在有改动时检查。

## 事实核查与导出

`fact_check_gate.py snapshot` 在核查前固定正文、标题及证据账本的文件和 SHA-256。核查清单采用 `fact-check-v2`，必须引用本轮 snapshot_id 并声明正文/标题/分发文案完整覆盖。每条 claim 必须有位置、状态、风险、证据支持范围、来源定位和处理建议。复合断言拆开核查；没有事实时必须说明原因。

`update_run_manifest.py` 解析实际清单，拒绝损坏结构和输入变化，计算 passed/blocked，并生成报告。任何 UNSUPPORTED、CONTRADICTED、BROKEN_LINK、NEEDS_USER_SOURCE、partial/none 支持或红色风险均阻断，不允许改成黄色后放行。该脚本验证结构和一致性，来源是否真的支撑事实仍由事实核查 agent 核验；自动测试不代表已完成文章事实验证。

manifest 记录：

- `fact_check_schema`、`fact_check_status`、`fact_checked_at`
- `latest_fact_claims_file`、`latest_fact_check_report`
- `fact_checked_body_file/sha256`、`fact_checked_title_file/sha256`
- `fact_checked_claims_sha256`、`fact_checked_snapshot_sha256`、`fact_checked_report_sha256`

`publication_passed()` 重新读取全部材料，验证正文指针一致、标题最终状态和整组哈希。正文、标题、账本、快照、claims 或报告任意变化，旧核查失效。纯文本 Hook、直接清稿及 HTML 写入共同使用该校验。核查失败不覆盖已有导出，但已有旧文件也不能充当本轮交付成功。`--stdout/--stats` 为只读分析，不给予导出权限。

```powershell
python scripts/verify_required_files.py --project "[项目名]" --workflow .claude/workflows/collab_v2.json --stage 6 --mode B
python scripts/fact_check_gate.py snapshot --project "[项目名]"
# fact-checker 在此读取固定输入并生成 fact_claims.json
python scripts/update_run_manifest.py --project "[项目名]" --body "[当前正文].md" --title 04_title.md --fact-claims fact_claims.json --fact-report fact_check_report.md
python scripts/fact_check_gate.py check --project "[项目名]"
python scripts/auto_clean_hook.py --project "[项目名]"
```

旧 passed 状态不能迁移成已核查状态：对实际终稿重跑核查。历史 `articles/**` 和 demo 保持原状，只作样本，不作为新协议模板。独立的 Markdown 转换文件仍可使用通用转换器；`articles/` 项目内的导出必须有本项目核查。

## 记忆与质量评估

复盘明确区分 `user_edit / agent_suggestion / reader_feedback / publication_metric`；模型建议的重复不是用户偏好。真实发布数据通过 `record_publish_metrics.py` 追加到 `publication_metrics.jsonl`，保留观察窗口、流量来源和发布版本，未知保持 null，不写入 manifest。

[质量盲评工具](../evaluations/README.md) 使用 12 个固定简报和材料，对两套实际成稿随机换为 A/B 并收集人工评分。结构测试保证流程约束，盲评才用于判断文章是否更好；未收集评分时不得宣称质量提升已经验证。
