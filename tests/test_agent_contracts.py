from __future__ import annotations

import json
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class AgentContractTests(unittest.TestCase):
    def test_root_router_matches_narrow_skill_trigger_scope(self) -> None:
        routing = (PROJECT_ROOT / "CLAUDE.md").read_text(encoding="utf-8")

        self.assertIn(".claude/skills/workflow-producer/SKILL.md", routing)
        self.assertIn("需要多阶段产物", routing)
        self.assertIn("简单润色、校对、翻译", routing)
        self.assertNotIn("否则一概送交", routing)

    def test_research_agents_do_not_require_web_search_prime(self) -> None:
        research_expert = (PROJECT_ROOT / ".claude/agents/research-expert.md").read_text(encoding="utf-8")
        topic_research = (PROJECT_ROOT / ".claude/agents/topic-research.md").read_text(encoding="utf-8")

        self.assertNotIn("web-search-prime", research_expert)
        self.assertNotIn("web-search-prime", topic_research)

    def test_title_designer_uses_eight_candidates_and_persists_title_file(self) -> None:
        content = (PROJECT_ROOT / ".claude/agents/title-designer.md").read_text(encoding="utf-8")

        self.assertIn("设计8个候选标题", content)
        self.assertIn("A/B/C/D/E/F/G/H", content)
        self.assertIn("04_title.md", content)

    def test_workflow_contract_requires_title_file_before_stage_6(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        title_stage = next(stage for stage in contract["stages"] if stage["id"] == "5.5")
        writing_stage = next(stage for stage in contract["stages"] if stage["id"] == "6")

        self.assertIn("04_title.md", title_stage["outputs"])
        self.assertIn("04_title.md", writing_stage["inputs"])

    def test_review_stages_require_locked_title_protection(self) -> None:
        editor_review = (PROJECT_ROOT / ".claude/agents/editor-review.md").read_text(encoding="utf-8")
        pre_publish_review = (PROJECT_ROOT / ".claude/agents/pre-publish-review.md").read_text(encoding="utf-8")
        humanizer = (PROJECT_ROOT / ".claude/agents/humanizer.md").read_text(encoding="utf-8")

        self.assertIn("04_title.md", editor_review)
        self.assertIn("04_title.md", pre_publish_review)
        self.assertIn("不得直接改标题", editor_review)
        self.assertIn("不得直接改标题", pre_publish_review)
        self.assertIn("标题", humanizer)
        self.assertIn("原样保留", humanizer)

    def test_writing_flow_collects_case_domain_boundaries(self) -> None:
        writing_clarifier = (PROJECT_ROOT / ".claude/agents/writing-clarifier.md").read_text(encoding="utf-8")
        writing_executor = (PROJECT_ROOT / ".claude/agents/writing-executor.md").read_text(encoding="utf-8")

        self.assertIn("案例领域边界", writing_clarifier)
        self.assertIn("案例领域边界", writing_executor)
        self.assertIn("不得默认使用互联网", writing_executor)

    def test_active_agents_do_not_hardcode_it_examples_as_default(self) -> None:
        research_expert = (PROJECT_ROOT / ".claude/agents/research-expert.md").read_text(encoding="utf-8")
        empathy_designer = (PROJECT_ROOT / ".claude/agents/empathy-designer.md").read_text(encoding="utf-8")

        self.assertNotIn("外包程序员很累", research_expert)
        self.assertNotIn("外包就是一块破抹布", empathy_designer)
        self.assertIn("除非主题本身就是科技", research_expert)
        self.assertIn("除非主题本身就是科技", empathy_designer)

    def test_styles_must_not_inherit_author_industry_examples(self) -> None:
        jiubian = (PROJECT_ROOT / ".claude/styles/jiubian.md").read_text(encoding="utf-8")
        sanbiaobiao = (PROJECT_ROOT / ".claude/styles/sanbiaobiao.md").read_text(encoding="utf-8")

        self.assertIn("不继承作者行业背景", jiubian)
        self.assertIn("不继承作者行业背景", sanbiaobiao)
        self.assertIn("不得默认举互联网", jiubian)
        self.assertIn("不得默认举互联网", sanbiaobiao)

    def test_finalization_stages_are_not_silently_skipped(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        workflow_producer = (PROJECT_ROOT / ".claude/skills/workflow-producer/SKILL.md").read_text(encoding="utf-8")
        edit_diff_learner = (PROJECT_ROOT / ".claude/agents/edit-diff-learner.md").read_text(encoding="utf-8")

        memory_stage = next(stage for stage in contract["stages"] if stage["id"] == "0")
        review_stage = next(stage for stage in contract["stages"] if stage["id"] == "13")

        self.assertNotIn("optional", memory_stage)
        self.assertNotIn("optional", review_stage)
        self.assertIn("Stage 1 → Stage 0 → Stage 1.5", workflow_producer)
        self.assertIn("Stage 13 完成前", workflow_producer)
        self.assertIn("跳过也要落盘", edit_diff_learner)

    def test_opening_tournament_cannot_auto_select_opening(self) -> None:
        opening_tournament = (PROJECT_ROOT / ".claude/agents/opening-tournament.md").read_text(encoding="utf-8")

        self.assertIn("禁止自行推荐后直接选定某一款", opening_tournament)
        self.assertIn("禁止在用户回复 A/B/C 前写入 `05c_opening_hook.md`", opening_tournament)
        self.assertIn("不能默认选择 B", opening_tournament)

    def test_style_modeler_requires_kernel_and_validation(self) -> None:
        style_modeler = (PROJECT_ROOT / ".claude/skills/style-modeler/SKILL.md").read_text(encoding="utf-8")
        style_core_reference = PROJECT_ROOT / ".claude/skills/style-modeler/references/style-core-and-validation.md"

        self.assertTrue(style_core_reference.exists())
        self.assertIn("证据账本", style_modeler)
        self.assertIn("风格内核", style_modeler)
        self.assertIn("仿写验证", style_modeler)
        self.assertIn("反向修正", style_modeler)
        self.assertIn("形似陷阱", style_core_reference.read_text(encoding="utf-8"))

    def test_fact_evidence_ledger_flows_from_research_to_writing(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        research_stage = next(stage for stage in contract["stages"] if stage["id"] == "2")
        writing_stage = next(stage for stage in contract["stages"] if stage["id"] == "6")
        research_expert = (PROJECT_ROOT / ".claude/agents/research-expert.md").read_text(encoding="utf-8")
        writing_executor = (PROJECT_ROOT / ".claude/agents/writing-executor.md").read_text(encoding="utf-8")

        self.assertIn("02_evidence_ledger.json", research_stage["outputs"])
        self.assertIn("02_evidence_ledger.json", writing_stage["inputs"])
        self.assertIn("02_evidence_ledger.json", research_expert)
        self.assertIn("evidence_id", research_expert)
        self.assertIn("没有证据", writing_executor)
        self.assertIn("事实性内容", writing_executor)

    def test_fact_checker_runs_after_optional_illustration_before_final_outputs(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        workflow_producer = (PROJECT_ROOT / ".claude/skills/workflow-producer/SKILL.md").read_text(encoding="utf-8")
        fact_checker_path = PROJECT_ROOT / ".claude/agents/fact-checker.md"

        stage_ids = [stage["id"] for stage in contract["stages"]]
        fact_stage = next(stage for stage in contract["stages"] if stage["id"] == "10.5")
        illustration_stage = next(stage for stage in contract["stages"] if stage["id"] == "11")

        self.assertLess(stage_ids.index("10"), stage_ids.index("11"))
        self.assertLess(stage_ids.index("11"), stage_ids.index("10.5"))
        self.assertLess(stage_ids.index("10.5"), stage_ids.index("12"))
        self.assertIn("01_theme.md", illustration_stage["inputs"])
        self.assertIn("[latest_body_file]", illustration_stage["inputs"])
        self.assertEqual(fact_stage["agent"], "fact-checker")
        self.assertIn("fact_claims.json", fact_stage["outputs"])
        self.assertIn("fact_check_report.md", fact_stage["outputs"])
        self.assertTrue(fact_checker_path.exists())

        fact_checker = fact_checker_path.read_text(encoding="utf-8")
        self.assertIn("SUPPORTED", fact_checker)
        self.assertIn("CONTRADICTED", fact_checker)
        self.assertIn("BROKEN_LINK", fact_checker)
        self.assertIn("NEEDS_USER_SOURCE", fact_checker)
        self.assertIn("红色问题", fact_checker)
        self.assertIn("配图完成后", workflow_producer)
        self.assertIn("禁止进入 Stage 12", workflow_producer)

    def test_review_stages_have_context_and_non_overlapping_responsibilities(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        editor_stage = next(stage for stage in contract["stages"] if stage["id"] == "7")
        pre_publish_stage = next(stage for stage in contract["stages"] if stage["id"] == "8")
        expected_inputs = {"01_theme.md", "00_memory_packet.md", "04_title.md", "[latest_body_file]"}

        self.assertTrue(expected_inputs.issubset(set(editor_stage["inputs"])))
        self.assertTrue(expected_inputs.issubset(set(pre_publish_stage["inputs"])))
        self.assertEqual(
            ["01_theme.md", "[latest_body_file]"],
            contract["modes"]["A"]["stage_overrides"]["7"]["inputs"],
        )

        editor = (PROJECT_ROOT / ".claude/agents/editor-review.md").read_text(encoding="utf-8")
        pre_publish = (PROJECT_ROOT / ".claude/agents/pre-publish-review.md").read_text(encoding="utf-8")
        reader_test = (PROJECT_ROOT / ".claude/agents/wechat-reader-test.md").read_text(encoding="utf-8")

        self.assertIn("写作工艺与风格保真", editor)
        self.assertIn("读者价值与发布风险", pre_publish)
        self.assertIn("平台行为", reader_test)
        self.assertNotIn("AI味道残留", pre_publish)
        self.assertNotIn("无第一人称", pre_publish)
        self.assertNotIn("XX/25", pre_publish)
        self.assertIn("禁止为了作者声音新增第一人称亲历", pre_publish)

    def test_fun_dimension_is_conditional_and_evidence_bound(self) -> None:
        empathy = (PROJECT_ROOT / ".claude/agents/empathy-designer.md").read_text(encoding="utf-8")
        editor = (PROJECT_ROOT / ".claude/agents/editor-review.md").read_text(encoding="utf-8")

        self.assertIn("趣味谈资", empathy)
        self.assertIn("不得为了好玩编造", empathy)
        self.assertIn("趣味张力", editor)
        self.assertIn("不强制搞笑", editor)

    def test_reader_test_can_reopen_title_only_with_user_confirmation(self) -> None:
        reader_test = (PROJECT_ROOT / ".claude/agents/wechat-reader-test.md").read_text(encoding="utf-8")
        title_designer = (PROJECT_ROOT / ".claude/agents/title-designer.md").read_text(encoding="utf-8")

        self.assertIn("返回 Stage 5.5", reader_test)
        self.assertIn("重新执行 Stage 9", reader_test)
        self.assertIn("用户明确锁定", reader_test)
        self.assertIn("策略语义去重", title_designer)
        self.assertIn("点击理由相同", title_designer)

    def test_research_records_attempts_for_planned_external_facts_without_search_quota(self) -> None:
        research = (PROJECT_ROOT / ".claude/agents/research-expert.md").read_text(encoding="utf-8")

        self.assertIn("外部事实需求清单", research)
        self.assertIn("research_requirement", research)
        self.assertIn("research_attempts", research)
        self.assertIn("不得按固定搜索次数", research)

    def test_performance_review_compares_normalized_creative_metadata_across_projects(self) -> None:
        performance = (PROJECT_ROOT / ".claude/agents/performance-review.md").read_text(encoding="utf-8")

        self.assertIn("creative_metadata", performance)
        self.assertIn("所有历史项目", performance)
        self.assertIn("标题公式", performance)
        self.assertIn("开头方案", performance)
        self.assertIn("主导社交货币", performance)
        self.assertIn("相关性不是因果", performance)

    def test_article_illustrator_is_platform_aware_and_uses_available_tools(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        illustration_stage = next(stage for stage in contract["stages"] if stage["id"] == "11")
        illustrator = (PROJECT_ROOT / ".claude/agents/article-illustrator.md").read_text(encoding="utf-8")

        self.assertIn("01_theme.md", illustration_stage["inputs"])
        self.assertIn("[latest_body_file]", illustration_stage["inputs"])
        self.assertNotIn("GenerateImage", illustrator)
        self.assertNotIn("corporate memphis", illustrator.lower())
        self.assertNotIn("程序员站在分岔路口", illustrator)
        self.assertIn("发布平台", illustrator)
        self.assertIn("不得把 16:9 写死", illustrator)
        self.assertIn("![描述](images/[文件名])", illustrator)

    def test_gold_sentence_and_title_length_rules_are_consistent(self) -> None:
        executor = (PROJECT_ROOT / ".claude/agents/writing-executor.md").read_text(encoding="utf-8")
        editor = (PROJECT_ROOT / ".claude/agents/editor-review.md").read_text(encoding="utf-8")
        pre_publish = (PROJECT_ROOT / ".claude/agents/pre-publish-review.md").read_text(encoding="utf-8")
        opening = (PROJECT_ROOT / ".claude/agents/opening-tournament.md").read_text(encoding="utf-8")

        self.assertIn("删除空心金句", executor)
        self.assertNotIn("**5. 删除金句**", executor)
        self.assertEqual(1, executor.count("揭示前有破折号？→ 删除它"))
        self.assertIn("带场景、代价或立场", editor)
        self.assertIn("带场景、代价或立场", pre_publish)
        self.assertNotIn("15-25字", pre_publish)
        self.assertNotIn("《三表猫风》", opening)


if __name__ == "__main__":
    unittest.main()
