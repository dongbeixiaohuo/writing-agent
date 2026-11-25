from __future__ import annotations

import unittest
import subprocess
import sys
from pathlib import Path

from scripts.generate_clean import build_body_stats, clean_markdown


FIXTURES = Path(__file__).parent / "fixtures"


class GenerateCleanTests(unittest.TestCase):
    def test_fh08_keeps_natural_headings_and_their_nested_body(self) -> None:
        source = "# 文章\n\n## 修改记录\n\n这一节是正式正文。\n\n### 修复空指针问题\n\n这个三级小节及其说明也应保留。\n\n## 写作备注\n\n这里讲写作备忘的方法。\n\n## 使用建议\n"
        self.assertEqual(clean_markdown(source), "文章\n修改记录\n这一节是正式正文。\n修复空指针问题\n这个三级小节及其说明也应保留。\n写作备注\n这里讲写作备忘的方法。\n使用建议")

    def test_fh08_excludes_the_separate_notes_file_from_body_stats(self) -> None:
        script = FIXTURES.parents[1] / "claude-runtime" / "scripts" / "generate_clean.py"
        notes = FIXTURES / "sample_draft_notes.md"
        result = subprocess.run([sys.executable, "-X", "utf8", str(script), "--stdout", str(notes)],
                                capture_output=True, encoding="utf-8", check=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "")

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
