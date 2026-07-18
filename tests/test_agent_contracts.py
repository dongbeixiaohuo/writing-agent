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

    def test_fact_checker_is_mandatory_before_final_outputs(self) -> None:
        contract = json.loads((PROJECT_ROOT / ".claude/workflows/collab_v2.json").read_text(encoding="utf-8"))
        workflow_producer = (PROJECT_ROOT / ".claude/skills/workflow-producer/SKILL.md").read_text(encoding="utf-8")
        fact_checker_path = PROJECT_ROOT / ".claude/agents/fact-checker.md"

        stage_ids = [stage["id"] for stage in contract["stages"]]
        fact_stage = next(stage for stage in contract["stages"] if stage["id"] == "10.5")

        self.assertLess(stage_ids.index("10"), stage_ids.index("10.5"))
        self.assertLess(stage_ids.index("10.5"), stage_ids.index("11"))
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
        self.assertIn("禁止进入 Stage 11", workflow_producer)


if __name__ == "__main__":
    unittest.main()
