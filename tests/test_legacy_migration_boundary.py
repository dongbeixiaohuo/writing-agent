import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MIGRATION_SOURCE = ROOT / "packages" / "legacy-migration" / "src" / "index.ts"
CLI_SOURCE = ROOT / "apps" / "cli" / "src" / "migration-command.ts"


class LegacyMigrationBoundaryTests(unittest.TestCase):
    def test_runtime_does_not_depend_on_the_old_desktop_or_tauri(self):
        sources = {
            MIGRATION_SOURCE: MIGRATION_SOURCE.read_text(encoding="utf-8"),
            CLI_SOURCE: CLI_SOURCE.read_text(encoding="utf-8"),
        }
        forbidden = ("writing-agent-app", "@tauri-apps", "App.tsx", "src-tauri")
        for path, text in sources.items():
            with self.subTest(path=path.name):
                for fragment in forbidden:
                    self.assertNotIn(fragment, text)
                imports = re.findall(r'from\s+["\']([^"\']+)["\']', text)
                self.assertTrue(imports)
                self.assertTrue(all("writing-agent-app" not in item for item in imports))

    def test_source_and_secret_boundaries_are_explicit(self):
        text = MIGRATION_SOURCE.read_text(encoding="utf-8")
        self.assertIn("new DatabaseSync(databasePath, { readOnly: true", text)
        self.assertIn("PRAGMA query_only = ON", text)
        self.assertIn("credentialDisposition", text)
        self.assertIn("excluded_requires_explicit_consent", text)
        self.assertIn('"legacy_unknown"', text)
        self.assertIn('"not_checked"', text)
        self.assertNotIn("secrets.json", text)

    def test_migration_checks_and_operator_docs_are_wired(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("packages/legacy-migration/test/legacy-migration.test.ts", package["scripts"]["test:migration"])
        self.assertIn("apps/cli/test/migration-cli.test.ts", package["scripts"]["test:migration"])
        self.assertIn("npm run test:migration", package["scripts"]["check:runtime"])

        guide = ROOT / "docs" / "implementation" / "LEGACY_MIGRATION_GUIDE.md"
        results = ROOT / "docs" / "testing" / "MIGRATION_RESULTS.md"
        self.assertTrue(guide.is_file())
        self.assertTrue(results.is_file())
        guide_text = guide.read_text(encoding="utf-8")
        for fragment in ("migrate scan", "migrate apply", "migrate rollback", "旧 `passed`", "Key"):
            self.assertIn(fragment, guide_text)


if __name__ == "__main__":
    unittest.main()
