import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ADR_DIR = ROOT / "docs" / "architecture" / "adr"


class ArchitectureDecisionTests(unittest.TestCase):
    maxDiff = None

    ADR_EXPECTATIONS = {
        "0001-independent-source-runtime.md": (
            "Application Service",
            "next/runtime",
            "private=true",
            "writing-agent-app/src/**",
        ),
        "0002-storage-and-recovery.md": (
            "node:sqlite",
            "24.15.0",
            "PRAGMA journal_mode = WAL",
            "PRAGMA foreign_keys = ON",
            "backup",
        ),
        "0003-distribution-and-transport.md": (
            "Electron",
            "contextIsolation=true",
            "nodeIntegration=false",
            "GitHub Releases",
            "npm",
        ),
        "0004-legacy-migration-and-export-semantics.md": (
            "dry-run",
            "export.working_copy",
            "export.publication",
            "stale",
            "secrets",
        ),
        "0005-dsh-frontend-source-reuse.md": (
            "0d1f50007f9bca3f52b06e1c3074fa14d5fb0720",
            "writing-agent-app",
            "Slot",
            "protocolVersion",
            "WA-023",
        ),
    }

    REQUIRED_HEADINGS = (
        "## 状态",
        "## 决策",
        "## 约束",
        "## 证据",
        "## 备选方案与拒绝理由",
        "## 数据与安全影响",
        "## 测试与验收",
    )

    def test_required_adrs_are_accepted_and_complete(self):
        self.assertEqual(
            sorted(path.name for path in ADR_DIR.glob("*.md")),
            sorted(self.ADR_EXPECTATIONS),
        )

        for filename, required_fragments in self.ADR_EXPECTATIONS.items():
            with self.subTest(adr=filename):
                text = (ADR_DIR / filename).read_text(encoding="utf-8")
                self.assertIn("状态：Accepted", text)
                for heading in self.REQUIRED_HEADINGS:
                    self.assertIn(heading, text)
                positions = [text.index(heading) for heading in self.REQUIRED_HEADINGS]
                self.assertEqual(positions, sorted(positions))
                for fragment in required_fragments:
                    self.assertIn(fragment, text)

    def test_private_legacy_package_and_m0_command_are_explicit(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertTrue(package["private"])
        self.assertEqual(package["engines"]["node"], ">=18.17.0")
        m0_command = package["scripts"].get("check:m0", "")
        self.assertIn("tests/check_node_sqlite.mjs", m0_command)
        self.assertIn("tests.test_architecture_decisions", m0_command)
        self.assertIn("npm run check:runtime", m0_command)
        self.assertNotIn("publish", m0_command)

    def test_ci_keeps_legacy_lane_and_adds_node24_foundation_lane(self):
        workflow = (ROOT / ".github" / "workflows" / "packaging.yml").read_text(
            encoding="utf-8"
        )
        self.assertRegex(workflow, r"(?m)^  check:\s*$")
        self.assertRegex(workflow, r"(?m)^  m0-foundation:\s*$")
        self.assertIn('node-version: "20"', workflow)
        self.assertIn('node-version: "24.18.0"', workflow)
        self.assertIn("run: npm ci --ignore-scripts", workflow)
        self.assertIn("run: npm run check:m0", workflow)
        self.assertIn("contents: read", workflow)

        future_commands = (
            "test:contracts",
            "test:migration",
            "check:independence",
            "build:runtime",
            "check:ui-origin",
            "test:ui-contracts",
            "test:ui-visual",
        )
        for command in future_commands:
            with self.subTest(command=command):
                self.assertNotIn(command, workflow)

    def test_sqlite_smoke_script_has_recovery_and_integrity_probes(self):
        script = (ROOT / "tests" / "check_node_sqlite.mjs").read_text(
            encoding="utf-8"
        )
        for fragment in (
            'from "node:sqlite"',
            "defensive: true",
            "PRAGMA journal_mode = WAL",
            "PRAGMA foreign_keys = ON",
            "BEGIN IMMEDIATE",
            "PRAGMA quick_check",
            "await backup",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, script)


if __name__ == "__main__":
    unittest.main()
