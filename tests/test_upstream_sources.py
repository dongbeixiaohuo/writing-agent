from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "upstream-sources.json"
NOTICE = ROOT / "THIRD_PARTY_NOTICES.md"
HEX40 = re.compile(r"^[0-9a-f]{40}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")


class UpstreamSourceRegistryTests(unittest.TestCase):
    def test_registry_status_and_provenance_are_consistent(self) -> None:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        allowed = set(registry["status_values"])
        self.assertTrue(allowed)

        for upstream in registry["upstreams"]:
            self.assertRegex(upstream["commit"], HEX40)
            component_ids: set[str] = set()
            has_ported_source = False

            for component in upstream["components"]:
                self.assertNotIn(component["id"], component_ids)
                component_ids.add(component["id"])
                self.assertIn(component["status"], allowed)

                for unit in component["source_units"]:
                    self.assertFalse(Path(unit["path"]).is_absolute())
                    self.assertRegex(unit["git_tree_oid"], HEX40)

                copied = component.get("copied_files", [])
                if component["status"].startswith("ported_"):
                    self.assertTrue(copied, component["id"])
                    has_ported_source = True

                for item in copied:
                    self.assertFalse(Path(item["source_path"]).is_absolute())
                    self.assertFalse(Path(item["target_path"]).is_absolute())
                    self.assertRegex(item["sha256"], HEX64)

            self.assertEqual(has_ported_source, upstream["distribution_included"])

    def test_notice_matches_fixed_source_and_current_distribution_state(self) -> None:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        notice = NOTICE.read_text(encoding="utf-8")

        for upstream in registry["upstreams"]:
            self.assertIn(upstream["commit"], notice)
            if not upstream["distribution_included"]:
                self.assertIn("None at the M0 audit baseline", notice)
            else:
                self.assertIn("Writing Agent now distributes a selected UI source slice", notice)
                self.assertIn("Copyright (c) 2026 DeepSeek", notice)
                self.assertIn("Permission is hereby granted, free of charge", notice)
                self.assertIn("Writing Agent is not an official DeepSeek product", notice)


if __name__ == "__main__":
    unittest.main()
