from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STYLE_SCRIPTS = PROJECT_ROOT / "claude-runtime" / "skills" / "style-modeler" / "scripts"


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, STYLE_SCRIPTS / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class StyleFingerprintTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module("style_fingerprint", "style_fingerprint.py")

    def analyze_text(self, text: str) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.md"
            path.write_text(text, encoding="utf-8")
            return self.module.analyze([path])

    def test_even_sentence_count_uses_statistical_median(self):
        result = self.analyze_text(
            "一。\n\n"
            "二二。\n\n"
            f"{'长' * 100}。\n\n"
            f"{'很' * 101}。\n"
        )

        self.assertEqual(51.0, result["median_sentence_len"])

    def test_wrapped_lines_are_one_paragraph_until_blank_line(self):
        result = self.analyze_text(
            "这是第一段的第一行，\n"
            "这是第一段的第二行。\n\n"
            "这是第二段。\n"
        )

        self.assertEqual(2, result["paragraphs"])

    def test_paired_ellipsis_and_dash_are_counted_once(self):
        text = "甲……乙——丙。"
        result = self.analyze_text(text)
        expected = round(1 / len(text) * 1000, 2)

        self.assertEqual(expected, result["ellipsis_per_1k_chars"])
        self.assertEqual(expected, result["dash_per_1k_chars"])


class NormalizeStyleFrontmatterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(
            "normalize_style_frontmatter", "normalize_style_frontmatter.py"
        )

    def test_dry_run_reports_change_without_rewriting_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "legacy.md"
            original = "# 风格名称：测试风格\n\n**作者**：测试作者\n"
            path.write_text(original, encoding="utf-8")

            changed = self.module.normalize_file(
                path,
                default_date="2026-07-18",
                refresh_existing=False,
                dry_run=True,
            )

            self.assertTrue(changed)
            self.assertEqual(original, path.read_text(encoding="utf-8"))

    def test_refresh_existing_updates_last_updated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "style.md"
            path.write_text(
                "---\nauthor: \"测试作者\"\nsource_count: 1\n"
                "last_updated: 2025-01-01\n---\n\n# 风格名称：测试风格\n",
                encoding="utf-8",
            )

            self.module.normalize_file(
                path,
                default_date="2026-07-18",
                refresh_existing=True,
                dry_run=False,
            )

            self.assertIn("last_updated: 2026-07-18", path.read_text(encoding="utf-8"))


class StyleSkillContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.skill_path = PROJECT_ROOT / "claude-runtime" / "skills" / "style-modeler" / "SKILL.md"
        cls.skill = cls.skill_path.read_text(encoding="utf-8")

    def test_plugin_safe_script_paths_are_used(self):
        self.assertIn(
            "${CLAUDE_SKILL_DIR}/scripts/style_fingerprint.py",
            self.skill,
        )
        self.assertIn(
            "${CLAUDE_SKILL_DIR}/scripts/normalize_style_frontmatter.py",
            self.skill,
        )
        self.assertNotIn(".claude/skills/style-modeler/scripts", self.skill)

    def test_stable_features_require_independent_samples(self):
        self.assertIn("至少 2 篇独立样本", self.skill)
        self.assertIn("单篇样本", self.skill)

    def test_mixed_authors_are_checked_before_combining_samples(self):
        self.assertIn("作者锚点不一致", self.skill)

    def test_blind_validation_uses_multiple_pairs_and_confidence(self):
        self.assertIn("至少 3 组", self.skill)
        self.assertIn("无法判断", self.skill)
        self.assertIn("置信度", self.skill)

    def test_style_registry_lifecycle_is_explicit_and_uses_the_manager(self):
        self.assertIn(
            '${CLAUDE_SKILL_DIR}/scripts/manage_style_registry.py',
            self.skill,
        )
        self.assertNotIn(
            '{{WRITING_AGENT_SCRIPTS}}/manage_style_registry.py',
            self.skill,
        )
        self.assertIn("manage_style_registry.py\" resolve-root", self.skill)
        self.assertIn("manage_style_registry.py\" register", self.skill)
        self.assertIn("manage_style_registry.py\" verify", self.skill)
        self.assertIn("legacy_unverified", self.skill)
        self.assertIn("--blind-test-passed", self.skill)
        self.assertIn("登记状态", self.skill)
        self.assertIn(
            "无论最终保持 `legacy_unverified` 还是升级为 `verified`",
            self.skill,
        )

    def test_output_template_is_progressively_disclosed(self):
        self.assertIn("references/style-output-template.md", self.skill)
        self.assertLess(len(self.skill.splitlines()), 250)

        template = (
            self.skill_path.parent / "references" / "style-output-template.md"
        ).read_text(encoding="utf-8")
        expected = [
            "01. 作者画像与核心人格",
            "02. 思维内核与论证逻辑",
            "03. 创作路径还原",
            "04. 互动设计",
            "05. 开头模式",
            "06. 段落过渡模式",
            "07. 句式与节奏",
            "08. 词汇指纹",
            "09. 修辞手法",
            "10. 结尾模式",
            "11. 格式与排版",
            "12. 独特习惯与招牌动作",
            "13. 反AI特征",
            "14. 典型段落模板",
            "15. 禁忌清单",
        ]
        headings = [
            line.removeprefix("## ")
            for line in template.splitlines()
            if any(line.startswith(f"## {number:02d}.") for number in range(1, 16))
        ]
        self.assertEqual(expected, headings)


if __name__ == "__main__":
    unittest.main()
