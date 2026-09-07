"""Planning choices must remain usable without weakening final publication gates."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "claude-runtime"


class PublicationStageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "articles" / "staging"
        self.project.mkdir(parents=True)
        contract = json.loads((RUNTIME / "workflows/collab_v2.json").read_text(encoding="utf-8"))
        writing = next(stage for stage in contract["stages"] if stage["id"] == "6")
        for name in writing["inputs"]:
            self.write(name, "已有实质材料")
        self.write("01_theme.md", "| **写作风格** | 无指定风格（用户授权代选） |\n风格确认状态：用户已授权代选\n")
        self.write("02_evidence_ledger.json", '{"claims": [], "notes": "仅使用作者感受，无外部事实"}')
        self.write("04_title.md", "选择状态：暂定\n最终标题：「下午的安静」\n")
        self.write("05c_opening_hook.md", "# 开头\n> 确认状态：暂定\n\n" + "这是从用户自述中提取的安静开头，没有夸张的情绪或结论。" * 4)
        self.write("draft_v1.md", "# 下午的安静\n\n我愿意留一点时间给自己。")
        self.write("run_manifest.json", '{"latest_body_file":"draft_v1.md"}')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, content):
        (self.project / name).write_text(content, encoding="utf-8")

    def check(self, *args):
        return subprocess.run(
            [sys.executable, "-B", str(RUNTIME / "scripts/verify_required_files.py"),
             "--project-dir", str(self.project), "--workflow", str(RUNTIME / "workflows/collab_v2.json"), *args],
            capture_output=True, text=True, encoding="utf-8", env={**os.environ, "PYTHONUTF8": "1"}, timeout=15)

    def test_authorized_style_and_real_provisional_choices_allow_writing(self):
        result = self.check("--stage", "6", "--mode", "B")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_provisional_title_cannot_enter_reader_test_or_override_final_phase(self):
        for args in [("--stage", "9"), ("--stage", "9", "--phase", "planning"),
                     ("--required", "04_title.md")]:
            result = self.check(*args)
            self.assertNotEqual(0, result.returncode, result.stdout)
        self.write("04_title.md", "选择状态：已锁定\n最终标题：「下午的安静」\n确认来源：导演成稿复核\n")
        result = self.check("--stage", "9")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_provisional_placeholders_are_not_real_choices(self):
        self.write("04_title.md", "选择状态：暂定\n最终标题：[待填]\n")
        self.assertNotEqual(0, self.check("--stage", "6").returncode)
        self.write("04_title.md", "选择状态：暂定\n最终标题：「下午的安静」\n")
        self.write("05c_opening_hook.md", "确认状态：暂定\n[用户选定后再写]\n")
        self.assertNotEqual(0, self.check("--stage", "6").returncode)

    def test_final_opening_accepts_fourth_genre_option(self):
        self.write("05c_opening_hook.md", "# 开头\n> 确认状态：已锁定\n> 选择：D - 低声观察\n\n" + "这段开头来自作者记录的真实观察，不需要用刺激的语言证明它值得阅读。" * 3)
        result = self.check("--required", "05c_opening_hook.md")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_lightweight_revision_does_not_require_full_collaboration_tree(self):
        for file in self.project.glob("*"):
            if file.name not in {"01_theme.md", "draft_v1.md", "run_manifest.json"}:
                file.unlink()
        self.write("editor_review.md", "保留原样，没有需要修改的问题。")
        self.write("revision_brief.md", "仅按模式 A 汇总本稿的审稿意见。")
        result = self.check("--stage", "9.5", "--mode", "A")
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def test_final_gate_rejects_mixed_status_and_placeholder_distribution(self):
        for title in ["选择状态：暂定 / 已锁定\n最终标题：「下午的安静」",
                      "选择状态：已锁定\n最终标题：「下午的安静」\n分发文案选择：S1\n最终分发文案：已确认"]:
            self.write("04_title.md", title)
            self.assertNotEqual(0, self.check("--stage", "9").returncode)


if __name__ == "__main__":
    unittest.main()
