from __future__ import annotations

import json
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = PROJECT_ROOT / "claude-runtime" / "skills"


class SkillPromptCaseTests(unittest.TestCase):
    def test_each_skill_has_balanced_machine_readable_eval_cases(self) -> None:
        expected_skills = {
            "workflow-producer",
            "style-modeler",
            "web-article-extractor",
        }
        discovered = {path.parent.name for path in SKILLS_ROOT.glob("*/test-prompts.json")}
        self.assertEqual(expected_skills, discovered)

        for skill_name in sorted(expected_skills):
            path = SKILLS_ROOT / skill_name / "test-prompts.json"
            cases = json.loads(path.read_text(encoding="utf-8"))
            self.assertIsInstance(cases, list, msg=skill_name)
            self.assertGreaterEqual(len(cases), 5, msg=skill_name)
            ids = [case.get("id") for case in cases]
            self.assertEqual(len(ids), len(set(ids)), msg=f"重复 id: {skill_name}")
            self.assertTrue(all(isinstance(case.get("prompt"), str) and case["prompt"].strip() for case in cases))
            self.assertTrue(all(isinstance(case.get("expected"), str) and case["expected"].strip() for case in cases))
            self.assertEqual(
                {"positive", "negative", "edge"},
                {case.get("kind") for case in cases},
                msg=f"{skill_name} 必须同时覆盖正向、负触发和边界场景",
            )


if __name__ == "__main__":
    unittest.main()
