from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "legacy" / "fact-gate-v2"
RUNTIME = ROOT / "claude-runtime"
sys.path.insert(0, str(RUNTIME))

from scripts.fact_check_gate import assess_claims, snapshot_inputs  # noqa: E402


class FactCheckTypeScriptDifferentialTests(unittest.TestCase):
    def test_python_and_typescript_make_the_same_gate_decision(self):
        cases = json.loads((FIXTURE_ROOT / "cases.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(case=case["id"]), tempfile.TemporaryDirectory() as temp:
                project = Path(temp) / "project"
                shutil.copytree(FIXTURE_ROOT / "base", project)
                snapshot = snapshot_inputs(
                    project,
                    "draft.md",
                    "04_title.md",
                    "02_evidence_ledger.json",
                )
                raw_claims = (FIXTURE_ROOT / case["input"]).read_text(encoding="utf-8")
                raw_claims = raw_claims.replace("__SNAPSHOT_ID__", snapshot["snapshot_id"])
                (project / "fact_claims.json").write_text(raw_claims, encoding="utf-8")

                try:
                    python_assessment = assess_claims(
                        project,
                        "draft.md",
                        "04_title.md",
                        "fact_claims.json",
                    )
                    python_result = {
                        "outcome": python_assessment["status"],
                        "blockers": python_assessment["blockers"],
                    }
                except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
                    python_result = {"outcome": "error", "blockers": []}

                oracle_input = {
                    "snapshotId": snapshot["snapshot_id"],
                    "bodyContent": (project / "draft.md").read_text(encoding="utf-8"),
                    "titleContent": (project / "04_title.md").read_text(encoding="utf-8"),
                    "evidenceContent": (
                        project / "02_evidence_ledger.json"
                    ).read_text(encoding="utf-8"),
                    "rawClaims": raw_claims,
                }
                completed = subprocess.run(
                    [
                        "node",
                        "--import",
                        "tsx",
                        str(ROOT / "tests" / "fact_check_ts_oracle.ts"),
                    ],
                    cwd=ROOT,
                    input=json.dumps(oracle_input, ensure_ascii=False),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=20,
                    check=False,
                )
                self.assertEqual(0, completed.returncode, completed.stderr)
                typescript_result = json.loads(completed.stdout)
                self.assertEqual(python_result["outcome"], typescript_result["outcome"])
                if python_result["outcome"] != "error":
                    self.assertEqual(python_result["blockers"], typescript_result["blockers"])


if __name__ == "__main__":
    unittest.main()
