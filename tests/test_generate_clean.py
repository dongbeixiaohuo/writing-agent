from __future__ import annotations

import unittest
from pathlib import Path

from scripts.generate_clean import build_body_stats, clean_markdown


FIXTURES = Path(__file__).parent / "fixtures"


class GenerateCleanTests(unittest.TestCase):
    def test_generate_clean_strips_metadata_and_internal_notes(self) -> None:
        source_text = (FIXTURES / "sample_draft.md").read_text(encoding="utf-8")

        cleaned = clean_markdown(source_text)

        self.assertIn("第一段正文。", cleaned)
        self.assertIn("第二段正文，带一点强调和链接文字。", cleaned)
        self.assertIn("第三段正文。", cleaned)
        self.assertNotIn("创建时间", cleaned)
        self.assertNotIn("写作备注", cleaned)
        self.assertNotIn("修改记录", cleaned)
        self.assertNotIn("这段不应进入 clean 结果", cleaned)

    def test_generate_clean_stats_report_body_chars_only(self) -> None:
        source_text = (FIXTURES / "sample_draft.md").read_text(encoding="utf-8")
        body_text = clean_markdown(source_text)

        stats = build_body_stats(source_text, body_text)

        self.assertEqual(len(body_text), stats["body_chars"])
        self.assertGreater(stats["excluded_chars"], 0)
        self.assertLess(stats["body_chars"], stats["total_chars"])


if __name__ == "__main__":
    unittest.main()
