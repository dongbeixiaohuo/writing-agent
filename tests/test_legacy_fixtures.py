from __future__ import annotations

import json
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / "claude-runtime"
FIXTURES = ROOT / "tests" / "fixtures" / "legacy"
sys.path.insert(0, str(RUNTIME))

from scripts.fact_check_gate import publication_passed, snapshot_inputs
from scripts.update_run_manifest import update_run_manifest


class LegacyFixtureTests(unittest.TestCase):
    def test_manifest_fixture_pointers_are_local_and_present(self) -> None:
        project = FIXTURES / "manifest-project"
        manifest = json.loads((project / "run_manifest.json").read_text(encoding="utf-8"))

        for key in ("latest_body_file", "latest_notes_file", "clean_source_file"):
            value = manifest[key]
            self.assertEqual(value, Path(value).name)
            self.assertTrue((project / value).is_file())

        self.assertEqual("stale", manifest["fact_check_status"])
        self.assertNotIn("api_key", json.dumps(manifest).lower())

    def test_legacy_unbound_pass_fails_closed(self) -> None:
        source = FIXTURES / "manifest-project"
        with tempfile.TemporaryDirectory() as temporary:
            project = Path(temporary) / "articles" / "fixture-project"
            shutil.copytree(source, project)
            shutil.copyfile(project / "legacy_unbound_pass.json", project / "run_manifest.json")

            self.assertFalse(publication_passed(project))

    def test_desktop_schema_matches_observed_table_contract(self) -> None:
        schema = (FIXTURES / "desktop-v0.1.0" / "schema.sql").read_text(encoding="utf-8")
        connection = sqlite3.connect(":memory:")
        try:
            connection.executescript(schema)
            tables = {
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
                )
            }
            self.assertEqual(
                {"app_settings", "exports", "model_profiles", "stage_outputs", "writing_projects"},
                tables,
            )

            output_columns = {
                row[1] for row in connection.execute("PRAGMA table_info(stage_outputs)")
            }
            self.assertTrue(
                {"project_id", "run_id", "stage_key", "version", "markdown", "structured_json", "artifact_path"}
                <= output_columns
            )
            self.assertEqual(0, connection.execute("PRAGMA user_version").fetchone()[0])
            self.assertEqual(0, connection.execute("PRAGMA foreign_keys").fetchone()[0])
        finally:
            connection.close()

    def test_desktop_project_fixture_is_synthetic_and_contains_no_secret(self) -> None:
        project = json.loads(
            (FIXTURES / "desktop-v0.1.0" / "project.json").read_text(encoding="utf-8")
        )
        self.assertEqual("deep", project["mode"])
        self.assertEqual("fixture-project-001", project["id"])
        serialized = json.dumps(project).lower()
        self.assertNotIn("api_key", serialized)
        self.assertNotIn("secret", serialized)
        self.assertNotIn("users\\dante", serialized)

    def test_static_fact_gate_cases_preserve_fail_closed_semantics(self) -> None:
        fixture = FIXTURES / "fact-gate-v2"
        cases = json.loads((fixture / "cases.json").read_text(encoding="utf-8"))

        for case in cases:
            with self.subTest(case=case["id"]), tempfile.TemporaryDirectory() as temporary:
                project = Path(temporary) / "articles" / "probe"
                shutil.copytree(fixture / "base", project)
                snapshot = snapshot_inputs(project, "draft.md", "04_title.md")
                raw = (fixture / case["input"]).read_text(encoding="utf-8")
                raw = raw.replace("__SNAPSHOT_ID__", snapshot["snapshot_id"])
                (project / "fact_claims.json").write_text(raw, encoding="utf-8")

                if case["expected"] == "error":
                    with self.assertRaises(ValueError):
                        update_run_manifest(
                            project,
                            "draft.md",
                            title_file="04_title.md",
                            fact_claims_file="fact_claims.json",
                            fact_check_report_file="fact_check_report.md",
                        )
                    self.assertFalse(publication_passed(project))
                    continue

                manifest = update_run_manifest(
                    project,
                    "draft.md",
                    title_file="04_title.md",
                    fact_claims_file="fact_claims.json",
                    fact_check_report_file="fact_check_report.md",
                )
                self.assertEqual(case["expected"], manifest["fact_check_status"])
                self.assertEqual(case["expected"] == "passed", publication_passed(project))


if __name__ == "__main__":
    unittest.main()
