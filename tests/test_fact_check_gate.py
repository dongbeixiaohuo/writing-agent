from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME = Path(__file__).resolve().parents[1] / "claude-runtime"
sys.path.insert(0, str(RUNTIME))
from scripts.fact_check_gate import publication_passed, snapshot_inputs
from scripts.update_run_manifest import update_run_manifest
from tests.fact_check_fixtures import approve, write_claims


class FactCheckGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "articles" / "probe"
        self.project.mkdir(parents=True)
        (self.project / "draft.md").write_text("# 测试稿\n\n这是我的感受。", encoding="utf-8")
        (self.project / "04_title.md").write_text("- 选择状态：已锁定\n- 最终标题：「测试稿」\n", encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def finalize(self, requested="passed"):
        return update_run_manifest(self.project, "draft.md", title_file="04_title.md",
                                   fact_check_status=requested, fact_claims_file="fact_claims.json",
                                   fact_check_report_file="fact_check_report.md")

    def claim(self, status="SUPPORTED", scope="full", risk="green"):
        return {"claim_id": "C001", "claim_text": "一项待核查的比例", "claim_type": "number",
                "location": "正文第1段", "status": status, "risk": risk, "support_scope": scope,
                "matched_evidence_id": None, "source_reference": "用户提供的材料第2页",
                "evidence_summary": "核查说明", "recommended_action": "保留或退回"}

    def test_no_facts_can_pass_with_explicit_coverage(self):
        approve(self.project, "draft.md")
        self.assertTrue(publication_passed(self.project))

    def test_red_or_unsupported_claim_cannot_be_overridden_by_passed(self):
        for status, scope, risk in [("CONTRADICTED", "none", "yellow"), ("UNSUPPORTED", "none", "yellow"),
                                    ("SUPPORTED", "partial", "green"), ("SUPPORTED", "full", "red"),
                                    ("BROKEN_LINK", "none", "yellow"), ("NEEDS_USER_SOURCE", "none", "yellow")]:
            with self.subTest(status=status, scope=scope, risk=risk):
                write_claims(self.project, "draft.md", claims=[self.claim(status, scope, risk)])
                self.assertEqual("blocked", self.finalize()["fact_check_status"])
                self.assertFalse(publication_passed(self.project))
                self.assertIn("blocked", (self.project / "fact_check_report.md").read_text(encoding="utf-8"))

    def test_malformed_claims_and_wrong_binding_are_rejected(self):
        payload = write_claims(self.project, "draft.md")
        for text in ["NOT JSON", "{}", json.dumps({**payload, "body_file": "other.md"}),
                     json.dumps({**payload, "snapshot_id": "old"}), json.dumps({**payload, "coverage": {}}),
                     json.dumps({**payload, "no_factual_claims_reason": ""})]:
            with self.subTest(text=text[:60]):
                (self.project / "fact_claims.json").write_text(text, encoding="utf-8")
                with self.assertRaises(ValueError):
                    self.finalize()

    def test_changed_input_during_review_cannot_receive_fresh_hash(self):
        write_claims(self.project, "draft.md")
        (self.project / "draft.md").write_text("# changed", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "已变化"):
            self.finalize()

    def test_all_inputs_and_outputs_are_bound_after_passing(self):
        for name in ["draft.md", "04_title.md", "02_evidence_ledger.json", "fact_claims.json", "fact_check_report.md", "fact_check_snapshot.json"]:
            with self.subTest(name=name):
                # Restore title/ledger to a valid baseline before each independent trial.
                (self.project / "04_title.md").write_text("选择状态：已锁定\n最终标题：「测试稿」", encoding="utf-8")
                (self.project / "02_evidence_ledger.json").write_text('{"claims": [], "notes": "无外部事实"}', encoding="utf-8")
                approve(self.project, "draft.md")
                target = self.project / name
                target.write_text(target.read_text(encoding="utf-8") + "\n ", encoding="utf-8")
                self.assertFalse(publication_passed(self.project))

    def test_supported_claim_needs_source_and_unique_id(self):
        for claims in [[{**self.claim(), "source_reference": ""}], [self.claim(), self.claim()],
                       [{**self.claim(), "source_reference": {"unverified": True}}],
                       [{**self.claim(), "matched_evidence_id": "E999"}]]:
            write_claims(self.project, "draft.md", claims=claims)
            with self.assertRaises(ValueError):
                self.finalize()

    def test_old_manifest_and_provisional_title_cannot_publish(self):
        (self.project / "run_manifest.json").write_text('{"fact_check_status":"passed"}', encoding="utf-8")
        self.assertFalse(publication_passed(self.project))
        (self.project / "04_title.md").write_text("选择状态：暂定\n最终标题：「测试稿」", encoding="utf-8")
        write_claims(self.project, "draft.md")
        with self.assertRaisesRegex(ValueError, "锁定"):
            self.finalize()

    def test_report_cannot_overwrite_body(self):
        write_claims(self.project, "draft.md")
        before = (self.project / "draft.md").read_bytes()
        with self.assertRaises(ValueError):
            update_run_manifest(self.project, "draft.md", title_file="04_title.md",
                                fact_claims_file="fact_claims.json", fact_check_report_file="draft.md")
        self.assertEqual(before, (self.project / "draft.md").read_bytes())

    def test_clean_cli_blocks_delivery_but_allows_read_only_stats(self):
        script = RUNTIME / "scripts/generate_clean.py"
        for arguments, expected in [([], 1), (["--stats", "--json"], 0), (["--stdout"], 0)]:
            result = subprocess.run([sys.executable, "-B", str(script), str(self.project / "draft.md"), *arguments], capture_output=True)
            self.assertEqual(expected, result.returncode, result.stderr)
        self.assertFalse((self.project / "draft_clean.txt").exists())
        approve(self.project, "draft.md")
        result = subprocess.run([sys.executable, "-B", str(script), str(self.project / "draft.md")], capture_output=True, env={**os.environ, "PYTHONUTF8": "1"})
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertTrue((self.project / "draft_clean.txt").exists())

    def test_snapshot_rejects_paths_outside_project(self):
        with self.assertRaises(ValueError):
            snapshot_inputs(self.project, "../outside.md")

    def test_report_cannot_overwrite_notes_or_existing_project_artifact(self):
        write_claims(self.project, "draft.md")
        for file_name, kwargs in [("notes.md", {"notes_file": "notes.md"}),
                                  ("outline.md", {}), ("draft.html", {"html_file": "draft.html"})]:
            with self.subTest(file=file_name):
                target = self.project / file_name
                target.write_text("保留原文件", encoding="utf-8")
                with self.assertRaises(ValueError):
                    update_run_manifest(self.project, "draft.md", title_file="04_title.md",
                                        fact_claims_file="fact_claims.json", fact_check_report_file=file_name, **kwargs)
                self.assertEqual("保留原文件", target.read_text(encoding="utf-8"))

    def test_snapshot_cannot_overwrite_its_own_input(self):
        write_claims(self.project, "draft.md")
        target = self.project / "fact_check_snapshot.json"
        original = target.read_bytes()
        with self.assertRaises(ValueError):
            snapshot_inputs(self.project, target.name)
        self.assertEqual(original, target.read_bytes())


if __name__ == "__main__":
    unittest.main()
