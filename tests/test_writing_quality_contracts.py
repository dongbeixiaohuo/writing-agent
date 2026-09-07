from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1] / "claude-runtime" / "agents"


def read(name: str) -> str:
    return (ROOT / f"{name}.md").read_text(encoding="utf-8")


class WritingQualityContractTests(unittest.TestCase):
    def test_brief_supports_authorized_default_voice_and_new_quality_fields(self):
        text = read("writing-clarifier")
        for field in ("文体", "读者新收获", "传播目标", "互动方式", "用户已授权代选"):
            self.assertIn(field, text)
        self.assertIn("默认作者自身表达", text)

    def test_position_requires_mode_and_falsifiability_not_a_target_for_every_article(self):
        text = read("position-engine")
        self.assertIn("争议评论以外禁止要求“打谁的脸”", text)
        self.assertIn("研究如何可能推翻/限制它", text)

    def test_research_keeps_provenance_and_counterclaims_in_existing_artifacts(self):
        text = read("research-expert")
        for token in ("user_firsthand", "source_verified", "illustrative", "counterclaims"):
            self.assertIn(token, text)
        self.assertIn("不得把推演写成采访、亲历、观察或统计事实", text)
        self.assertIn("宏观数据、制度背景和微观例证", text)
        self.assertIn("不得揣测人物内心", text)

    def test_late_title_and_opening_are_not_falsely_user_locked(self):
        title = read("title-designer")
        opening = read("opening-tournament")
        self.assertIn("Stage 9 前必须", title)
        self.assertIn("选择状态：暂定 / 已锁定", title)
        self.assertIn("确认状态：暂定 / 已锁定", opening)
        self.assertIn("用户明确要求原句时才一字不改", opening)

    def test_review_and_humanizer_contracts_prevent_forced_churn(self):
        editor = read("editor-review")
        reader = read("wechat-reader-test")
        humanizer = read("humanizer")
        self.assertIn("本阶段不修改正文", editor)
        self.assertIn("revision_brief.md", reader)
        self.assertIn("最多进行两轮重大修订", reader)
        self.assertIn("无需修改", humanizer)
        self.assertIn("humanizer_review.md", humanizer)

    def test_consolidated_revision_can_keep_the_same_body_and_recheck_promises(self):
        text = read("writing-executor")
        self.assertIn("Stage 9.5：集中修订或保留", text)
        self.assertIn("保持同一 `latest_body_file`", text)
        self.assertIn("被评正文文件及其 SHA-256", text)
        self.assertIn("不匹配即退回重新评审", text)
        self.assertIn("仅 Stage 6 执行", text)
        self.assertIn("账本为空不妨碍使用已定位的用户一手材料", text)

    def test_revision_and_review_do_not_impose_mechanical_style_or_sharing(self):
        executor = read("writing-executor")
        humanizer = read("humanizer")
        prepublish = read("pre-publish-review")
        self.assertIn("不要套固定句式、数量、标点或对比结构规则", executor)
        self.assertIn("不是自动修改理由", humanizer)
        self.assertIn("标题可能仍为暂定", prepublish)
        self.assertIn("“不适用”时明确跳过", prepublish)

    def test_structure_and_empathy_do_not_require_conflict_or_quotas(self):
        outline = read("outline-architect")
        empathy = read("empathy-designer")
        concretizer = read("concretizer")
        self.assertIn("不要求树立敌人", outline)
        self.assertIn("不得为传播重写文章骨架", empathy)
        self.assertIn("不要求每个概念或每种形式都出现", concretizer)

    def test_memory_does_not_promote_agent_changes_to_user_preferences(self):
        text = read("memory-loader") + read("edit-diff-learner")
        for token in ("user_edit", "agent_suggestion", "reader_feedback", "publication_metric"):
            self.assertIn(token, text)
        self.assertIn("不得归因给用户", text)


if __name__ == "__main__":
    unittest.main()
