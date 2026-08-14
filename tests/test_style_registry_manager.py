from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (
    PROJECT_ROOT
    / "claude-runtime"
    / "skills"
    / "style-modeler"
    / "scripts"
    / "manage_style_registry.py"
)


class StyleRegistryManagerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.style_root = Path(self.tempdir.name) / "styles"
        self.style_root.mkdir()
        (self.style_root / "已有风格.md").write_text("# 已有风格\n", encoding="utf-8")
        (self.style_root / "新风格.md").write_text("# 新风格\n", encoding="utf-8")
        (self.style_root / "style_registry.json").write_text(
            json.dumps(
                {
                    "schema_version": "1.0",
                    "statuses": {
                        "verified": "verified",
                        "legacy_unverified": "legacy",
                    },
                    "styles": [
                        {
                            "name": "已有风格",
                            "file": "已有风格.md",
                            "verification_status": "verified",
                            "evidence_file": "_evidence/已有风格_evidence.md",
                        }
                    ],
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

    def run_cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *args],
            cwd=PROJECT_ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            timeout=30,
        )

    def register_new_profile(self) -> None:
        result = self.run_cli(
            "register",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)

    def write_new_evidence(self) -> None:
        evidence_dir = self.style_root / "_evidence"
        evidence_dir.mkdir(exist_ok=True)
        (evidence_dir / "新风格_evidence.md").write_text(
            "# 新风格证据\n\n- 两篇独立样本\n",
            encoding="utf-8",
        )

    def write_registry(self, style_root: Path) -> None:
        style_root.mkdir(parents=True, exist_ok=True)
        (style_root / "style_registry.json").write_text(
            '{"schema_version":"1.0","styles":[]}\n',
            encoding="utf-8",
        )

    def test_register_adds_new_profile_as_legacy_without_changing_existing_entry(self) -> None:
        result = self.run_cli(
            "register",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        registry = json.loads(
            (self.style_root / "style_registry.json").read_text(encoding="utf-8")
        )
        by_file = {entry["file"]: entry for entry in registry["styles"]}
        self.assertEqual("verified", by_file["已有风格.md"]["verification_status"])
        self.assertEqual(
            {
                "name": "新风格",
                "file": "新风格.md",
                "verification_status": "legacy_unverified",
                "evidence_file": None,
            },
            by_file["新风格.md"],
        )

    def test_verify_rejects_missing_evidence_without_changing_status(self) -> None:
        self.register_new_profile()

        result = self.run_cli(
            "verify",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
            "--evidence",
            "_evidence/新风格_evidence.md",
            "--blind-test-passed",
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("证据文件不存在", result.stdout + result.stderr)
        registry = json.loads(
            (self.style_root / "style_registry.json").read_text(encoding="utf-8")
        )
        entry = next(item for item in registry["styles"] if item["file"] == "新风格.md")
        self.assertEqual("legacy_unverified", entry["verification_status"])
        self.assertIsNone(entry["evidence_file"])

    def test_verify_requires_explicit_blind_test_attestation(self) -> None:
        self.register_new_profile()
        self.write_new_evidence()

        result = self.run_cli(
            "verify",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
            "--evidence",
            "_evidence/新风格_evidence.md",
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("必须显式确认盲测已通过", result.stdout + result.stderr)

    def test_verify_upgrades_registered_profile_after_explicit_attestation(self) -> None:
        self.register_new_profile()
        self.write_new_evidence()

        result = self.run_cli(
            "verify",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
            "--evidence",
            "_evidence/新风格_evidence.md",
            "--blind-test-passed",
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        registry = json.loads(
            (self.style_root / "style_registry.json").read_text(encoding="utf-8")
        )
        entry = next(item for item in registry["styles"] if item["file"] == "新风格.md")
        self.assertEqual("verified", entry["verification_status"])
        self.assertEqual("_evidence/新风格_evidence.md", entry["evidence_file"])

    def test_verify_rejects_files_outside_evidence_directory(self) -> None:
        self.register_new_profile()

        result = self.run_cli(
            "verify",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
            "--evidence",
            "新风格.md",
            "--blind-test-passed",
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("_evidence", result.stdout + result.stderr)

    def test_verify_rejects_evidence_path_that_traverses_out_of_evidence_directory(self) -> None:
        self.register_new_profile()

        result = self.run_cli(
            "verify",
            "--style-root",
            str(self.style_root),
            "--profile",
            "新风格.md",
            "--evidence",
            "_evidence/../新风格.md",
            "--blind-test-passed",
        )

        self.assertNotEqual(0, result.returncode)
        self.assertIn("越出 _evidence", result.stdout + result.stderr)

    def test_resolve_root_prefers_canonical_runtime_in_development_repository(self) -> None:
        workspace = Path(self.tempdir.name) / "development-workspace"
        canonical = workspace / "claude-runtime" / "styles"
        clone = workspace / ".claude" / "styles"
        self.write_registry(canonical)
        self.write_registry(clone)

        result = self.run_cli(
            "resolve-root",
            "--workspace-root",
            str(workspace),
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual("claude-runtime/styles", result.stdout.strip())

    def test_resolve_root_uses_workspace_styles_for_installed_plugin(self) -> None:
        workspace = Path(self.tempdir.name) / "plugin-workspace"
        clone = workspace / ".claude" / "styles"
        self.write_registry(clone)

        result = self.run_cli(
            "resolve-root",
            "--workspace-root",
            str(workspace),
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertEqual(".claude/styles", result.stdout.strip())


if __name__ == "__main__":
    unittest.main()
