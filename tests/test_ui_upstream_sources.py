from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "upstream-sources.json"


class UiUpstreamSourceTests(unittest.TestCase):
    def setUp(self) -> None:
        registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
        self.upstream = registry["upstreams"][0]
        self.components = {item["id"]: item for item in self.upstream["components"]}

    def test_selected_source_slice_is_exact_and_complete(self) -> None:
        selected = (
            self.components["frontend-foundation"]["copied_files"]
            + self.components["frontend-shell-and-writing-surfaces"]["copied_files"]
        )
        self.assertEqual(len(selected), 10)
        registered_targets = set()

        for item in selected:
            target = ROOT / item["target_path"]
            self.assertTrue(target.is_file(), item["target_path"])
            self.assertTrue(item["exact_copy"], item["target_path"])
            digest = hashlib.sha256(target.read_bytes()).hexdigest()
            self.assertEqual(digest, item["sha256"], item["target_path"])
            registered_targets.add(target.resolve())

        actual_targets = {
            path.resolve()
            for path in (ROOT / "packages" / "ui" / "src" / "upstream").rglob("*")
            if path.is_file()
        }
        self.assertEqual(actual_targets, registered_targets)

    def test_derived_ui_does_not_import_legacy_or_external_dsh_runtime(self) -> None:
        roots = [
            ROOT / "apps" / "web" / "src",
            ROOT / "packages" / "client-bridge" / "src",
            ROOT / "packages" / "ui" / "src" / "brand",
            ROOT / "packages" / "ui" / "src" / "shell",
            ROOT / "packages" / "ui" / "src" / "theme",
            ROOT / "packages" / "writing-ui" / "src",
            ROOT / "packages" / "writing-ui" / "examples",
        ]
        forbidden = (
            "writing-agent-app",
            "@tauri-apps",
            "download.deepseek.com",
            "api.deepseek.com",
            "127.0.0.1:4173",
            "$DSH_HOME",
        )
        for base in roots:
            for path in base.rglob("*"):
                if not path.is_file() or path.suffix not in {".ts", ".tsx", ".css"}:
                    continue
                text = path.read_text(encoding="utf-8")
                for marker in forbidden:
                    if marker == "api.deepseek.com" and path == ROOT / "packages/client-bridge/src/provider-presets.ts":
                        continue  # User-selectable static catalog, not the DSH runtime.
                    self.assertNotIn(marker, text, f"{marker} in {path.relative_to(ROOT)}")

    def test_mock_is_explicit_and_production_requires_secure_local_host(self) -> None:
        entry = (ROOT / "apps" / "web" / "src" / "main.tsx").read_text(encoding="utf-8")
        mock = (ROOT / "packages" / "client-bridge" / "src" / "mock-bridge.ts").read_text(encoding="utf-8")
        self.assertIn("import.meta.env.MODE === 'mock'", entry)
        self.assertIn("await import('../../../packages/client-bridge/src/mock-bridge.ts')", entry)
        self.assertIn("await import('../../../packages/client-bridge/src/web-bridge.ts')", entry)
        self.assertIn("writing-agent-bootstrap-capability", entry)
        self.assertIn("LOCAL_HOST_BOOTSTRAP_MISSING", entry)
        self.assertIn("生产构建不会自动启用 Mock", entry)
        self.assertIn("mock: true", mock)
        self.assertIn("persistsUserProjects: false", mock)

    def test_local_web_host_is_loopback_random_port_and_checks_request_boundary(self) -> None:
        host = (ROOT / "packages" / "client-bridge" / "src" / "local-web-host.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn('const LOOPBACK_HOST = "127.0.0.1"', host)
        self.assertIn("server.listen(0, LOOPBACK_HOST", host)
        for marker in (
            "HOST_REJECTED",
            "ORIGIN_REJECTED",
            "CAPABILITY_REJECTED",
            "PROTOCOL_VERSION_MISMATCH",
            "STALE_CLIENT_GENERATION",
        ):
            self.assertIn(marker, host)

    def test_official_brand_module_remains_excluded(self) -> None:
        brand = self.components["official-brand-module"]
        self.assertEqual(brand["status"], "excluded")
        own_brand = (ROOT / "packages" / "ui" / "src" / "brand" / "BrandMark.tsx").read_text(encoding="utf-8")
        self.assertNotIn("DeepSeek", own_brand)

    def test_renderer_has_no_direct_provider_telemetry_or_active_html_escape_hatch(self) -> None:
        roots = [
            ROOT / "apps" / "web" / "src",
            ROOT / "packages" / "ui" / "src",
            ROOT / "packages" / "writing-ui" / "src",
            ROOT / "packages" / "writing-ui" / "examples",
        ]
        forbidden = (
            "dangerouslySetInnerHTML",
            "window.open(",
            "eval(",
            "new Function(",
            "fetch(",
            "XMLHttpRequest",
            "WebSocket(",
            "telemetry",
            "analytics",
            "sentry",
            "autoUpdater",
            "http://",
            "https://",
        )
        for base in roots:
            for path in base.rglob("*"):
                if not path.is_file() or path.suffix not in {".ts", ".tsx", ".js", ".jsx"}:
                    continue
                text = path.read_text(encoding="utf-8")
                for marker in forbidden:
                    self.assertNotIn(marker, text, f"{marker} in {path.relative_to(ROOT)}")

        bridge = (ROOT / "packages" / "client-bridge" / "src" / "web-bridge.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn('url.hostname !== "127.0.0.1"', bridge)
        self.assertIn('credentials: "same-origin"', bridge)
        self.assertNotIn("dangerouslySetInnerHTML", bridge)
        self.assertNotIn("http://api.", bridge)
        self.assertNotIn("https://api.", bridge)

        presets = (ROOT / "packages/client-bridge/src/provider-presets.ts").read_text(encoding="utf-8")
        for marker in ("fetch(", "XMLHttpRequest", "WebSocket(", "window.", "localStorage", "process.env"):
            self.assertNotIn(marker, presets)

    def test_local_host_disables_remote_scripts_navigation_and_embedding(self) -> None:
        host = (ROOT / "packages" / "client-bridge" / "src" / "local-web-host.ts").read_text(
            encoding="utf-8"
        )
        for directive in (
            "default-src 'self'",
            "script-src 'self'",
            "connect-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
            "form-action 'none'",
            'response.setHeader("x-frame-options", "DENY")',
            'response.setHeader("referrer-policy", "no-referrer")',
        ):
            self.assertIn(directive, host)

    def test_wa024_centralizes_brand_theme_and_writing_extensions(self) -> None:
        expected = (
            ROOT / "packages" / "ui" / "src" / "brand" / "config.ts",
            ROOT / "packages" / "ui" / "src" / "theme" / "config.ts",
            ROOT / "packages" / "ui" / "src" / "extensions" / "contracts.ts",
            ROOT / "packages" / "client-bridge" / "src" / "ui-settings-persistence.ts",
            ROOT / "packages" / "writing-ui" / "src" / "registry.ts",
            ROOT / "packages" / "writing-ui" / "src" / "WritingWorkbenchPanel.tsx",
            ROOT / "packages" / "writing-ui" / "examples" / "demo-sidebar-extension.tsx",
            ROOT / "apps" / "web" / "src" / "extension-demo.tsx",
            ROOT / "apps" / "web" / "extension-demo.html",
        )
        for path in expected:
            self.assertTrue(path.is_file(), path.relative_to(ROOT))

        shell = (ROOT / "packages" / "ui" / "src" / "shell" / "WritingAgentShell.tsx").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("function FactCheckPanel", shell)
        self.assertNotIn("function WritingRevisionPanel", shell)
        self.assertNotIn("DEMO_SIDEBAR_EXTENSION", shell)

        entry = (ROOT / "apps" / "web" / "src" / "main.tsx").read_text(encoding="utf-8")
        self.assertIn("createDefaultWritingUiRegistry", entry)
        self.assertNotIn("demo-sidebar-extension", entry)

        demo_entry = (ROOT / "apps" / "web" / "src" / "extension-demo.tsx").read_text(
            encoding="utf-8"
        )
        self.assertIn("DEMO_SIDEBAR_EXTENSION", demo_entry)
        self.assertIn("DEMO_THEME", demo_entry)
        self.assertIn("DEMO_BRAND", demo_entry)

        host_entry = (ROOT / "apps" / "web" / "server" / "main.ts").read_text(encoding="utf-8")
        self.assertIn("createFileUiSettingsPersistence", host_entry)
        self.assertIn("ui-settings.json", host_entry)

    def test_wa025_acceptance_assets_and_browser_fetch_boundary_exist(self) -> None:
        expected = (
            ROOT / "tests" / "ui-baseline" / "fixtures" / "wa025-content.json",
            ROOT / "tests" / "ui-baseline" / "fixtures" / "wa025-local-host.ts",
            ROOT / "tests" / "ui-baseline" / "scripts" / "wa025_ui_playwright.py",
            ROOT / "docs" / "testing" / "UI_BASELINE_RESULTS.md",
        )
        for path in expected:
            self.assertTrue(path.is_file(), path.relative_to(ROOT))

        fixture = json.loads(expected[0].read_text(encoding="utf-8"))
        self.assertEqual(fixture["fixtureId"], "wa025-ui-consistency-v1")
        self.assertNotEqual(
            fixture["primaryProject"]["id"], fixture["secondaryProject"]["id"]
        )

        script = expected[2].read_text(encoding="utf-8")
        self.assertIn("MAX_CHANGED_PIXEL_RATIO = 0.02", script)
        self.assertIn("MAX_MEAN_CHANNEL_DELTA = 2.0", script)
        self.assertIn("visual_failures == []", script)
        self.assertNotIn("mask_regions", script)

        bridge = (ROOT / "packages" / "client-bridge" / "src" / "web-bridge.ts").read_text(
            encoding="utf-8"
        )
        self.assertIn("globalThis.fetch.bind(globalThis)", bridge)


if __name__ == "__main__":
    unittest.main()
