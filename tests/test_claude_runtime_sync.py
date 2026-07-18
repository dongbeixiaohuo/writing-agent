from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "claude-runtime"
sys.path.insert(0, str(RUNTIME_ROOT))

from scripts.check_claude_runtime_sync import find_runtime_drift
from scripts.bootstrap_workspace import bootstrap_workspace, prepare_plugin_runtime
from scripts.sync_claude_runtime import render_target_bytes, sync_runtime_assets


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class BootstrapWorkspaceTests(unittest.TestCase):
    def test_bootstrap_preserves_existing_user_files_and_copies_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            runtime_root = root / "runtime"
            workspace_root = root / "workspace"
            write(runtime_root / "scripts" / "shared.py", "plugin\n")
            write(runtime_root / "scripts" / "missing.py", "new\n")
            write(runtime_root / "styles" / "shared.md", "plugin style\n")
            write(runtime_root / "workflows" / "flow.json", "{}\n")
            write(workspace_root / "scripts" / "shared.py", "user\n")
            write(workspace_root / ".claude" / "styles" / "shared.md", "user style\n")

            bootstrap_workspace(workspace_root, runtime_root)

            self.assertEqual("user\n", (workspace_root / "scripts" / "shared.py").read_text(encoding="utf-8"))
            self.assertEqual(
                "user style\n",
                (workspace_root / ".claude" / "styles" / "shared.md").read_text(encoding="utf-8"),
            )
            self.assertEqual("new\n", (workspace_root / "scripts" / "missing.py").read_text(encoding="utf-8"))
            self.assertTrue((workspace_root / ".claude" / "workflows" / "flow.json").exists())

    def test_plugin_mode_does_not_copy_runtime_scripts_into_user_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            runtime_root = root / "runtime"
            workspace_root = root / "workspace"
            write(runtime_root / "scripts" / "tool.py", "print('plugin')\n")

            bootstrap_workspace(workspace_root, runtime_root, include_scripts=False)

            self.assertFalse((workspace_root / "scripts" / "tool.py").exists())
            self.assertTrue((workspace_root / "articles").is_dir())

    def test_plugin_runtime_is_refreshed_and_dependencies_are_installed_once_per_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            runtime_root = root / "plugin"
            plugin_data = root / "plugin-data"
            write(runtime_root / "scripts" / "tool.ts", "export const version = 2;\n")
            write(runtime_root / "package.json", '{"name":"test","version":"1.0.0"}\n')
            write(
                runtime_root / "package-lock.json",
                '{"name":"test","version":"1.0.0","lockfileVersion":3,"packages":{}}\n',
            )
            write(plugin_data / "runtime" / "scripts" / "tool.ts", "stale\n")
            write(plugin_data / "runtime" / "scripts" / "removed.ts", "stale\n")
            calls: list[tuple[list[str], Path]] = []

            def fake_runner(command, *, cwd, check):
                self.assertTrue(check)
                calls.append((list(command), Path(cwd)))

            prepare_plugin_runtime(runtime_root, plugin_data, command_runner=fake_runner)
            prepare_plugin_runtime(runtime_root, plugin_data, command_runner=fake_runner)

            self.assertEqual(
                "export const version = 2;\n",
                (plugin_data / "runtime" / "scripts" / "tool.ts").read_text(encoding="utf-8"),
            )
            self.assertFalse((plugin_data / "runtime" / "scripts" / "removed.ts").exists())
            self.assertEqual(1, len(calls))
            self.assertEqual(plugin_data, calls[0][1])
            self.assertIn("ci", calls[0][0])

            write(runtime_root / "package.json", '{"name":"test","version":"1.0.1"}\n')
            prepare_plugin_runtime(runtime_root, plugin_data, command_runner=fake_runner)
            self.assertEqual(2, len(calls))


class ClaudeRuntimeSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.runtime_root = self.root / "claude-runtime"

        write(self.runtime_root / "agents" / "writing-executor.md", "# agent\n")
        write(self.runtime_root / "skills" / "workflow-producer" / "SKILL.md", "# skill\n")
        write(self.runtime_root / "styles" / "jiubian.md", "# style\n")
        write(self.runtime_root / "workflows" / "collab_v2.json", json.dumps({"stages": []}, ensure_ascii=False))
        write(self.runtime_root / "hooks" / "hooks.json", json.dumps({"hooks": {}}, ensure_ascii=False))
        write(self.runtime_root / "scripts" / "init_workspace.py", "print('ok')\n")
        write(self.runtime_root / "templates" / "README.md", "# template\n")
        write(
            self.root / "package.json",
            json.dumps(
                {
                    "name": "writing-agent",
                    "version": "1.2.3",
                    "dependencies": {"cheerio": "1.0.0"},
                    "devDependencies": {"tsx": "^4.20.3"},
                }
            ),
        )
        write(
            self.root / "package-lock.json",
            json.dumps(
                {
                    "name": "writing-agent",
                    "version": "1.2.3",
                    "lockfileVersion": 3,
                    "requires": True,
                    "packages": {
                        "": {
                            "name": "writing-agent",
                            "version": "1.2.3",
                            "dependencies": {"cheerio": "1.0.0"},
                            "devDependencies": {"tsx": "^4.20.3"},
                        }
                    },
                }
            ),
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_sync_copies_runtime_assets_to_both_targets(self) -> None:
        sync_runtime_assets(self.root)

        self.assertTrue((self.root / ".claude" / "agents" / "writing-executor.md").exists())
        self.assertTrue((self.root / "plugins" / "writing-agent" / "agents" / "writing-executor.md").exists())
        self.assertTrue((self.root / "plugins" / "writing-agent" / ".claude-plugin" / "plugin.json").exists())
        self.assertTrue((self.root / ".claude-plugin" / "marketplace.json").exists())

    def test_sync_renders_script_root_for_clone_and_plugin_consumers(self) -> None:
        write(
            self.runtime_root / "agents" / "path-aware.md",
            'python "{{WRITING_AGENT_SCRIPTS}}/verify_required_files.py" --project demo\n',
        )

        sync_runtime_assets(self.root)

        clone_agent = (self.root / ".claude" / "agents" / "path-aware.md").read_text(
            encoding="utf-8"
        )
        plugin_agent = (
            self.root / "plugins" / "writing-agent" / "agents" / "path-aware.md"
        ).read_text(encoding="utf-8")
        self.assertIn('python "scripts/verify_required_files.py"', clone_agent)
        self.assertIn(
            'python "${CLAUDE_PLUGIN_ROOT}/scripts/verify_required_files.py"',
            plugin_agent,
        )
        self.assertNotIn("{{WRITING_AGENT_SCRIPTS}}", clone_agent + plugin_agent)
        self.assertEqual([], find_runtime_drift(self.root))

    def test_synced_checker_does_not_create_its_own_cache_drift(self) -> None:
        production_scripts = RUNTIME_ROOT / "scripts"
        for filename in ("check_claude_runtime_sync.py", "sync_claude_runtime.py"):
            write(
                self.runtime_root / "scripts" / filename,
                (production_scripts / filename).read_text(encoding="utf-8"),
            )
        sync_runtime_assets(self.root)

        result = subprocess.run(
            [sys.executable, str(self.root / "scripts" / "check_claude_runtime_sync.py")],
            cwd=self.root,
            capture_output=True,
            text=True,
            check=False,
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertFalse((self.root / "scripts" / "__pycache__").exists())

    def test_check_reports_drift_when_consumer_differs(self) -> None:
        sync_runtime_assets(self.root)
        write(self.root / ".claude" / "agents" / "writing-executor.md", "# changed\n")

        drift = find_runtime_drift(self.root)

        self.assertTrue(any(".claude/agents/writing-executor.md" in item for item in drift))

    def test_check_reports_stale_extra_files(self) -> None:
        sync_runtime_assets(self.root)
        write(self.root / ".claude" / "agents" / "stale.md", "# stale\n")

        drift = find_runtime_drift(self.root)

        self.assertIn("extra: .claude/agents/stale.md", drift)

    def test_sync_removes_stale_managed_files(self) -> None:
        sync_runtime_assets(self.root)
        source = self.runtime_root / "agents" / "writing-executor.md"
        source.unlink()

        sync_runtime_assets(self.root)

        self.assertFalse((self.root / ".claude" / "agents" / "writing-executor.md").exists())
        self.assertFalse((self.root / "plugins" / "writing-agent" / "agents" / "writing-executor.md").exists())

    def test_cache_artifacts_are_reported_and_removed_from_mirrors(self) -> None:
        sync_runtime_assets(self.root)
        cache_file = (
            self.root
            / "plugins"
            / "writing-agent"
            / "scripts"
            / "__pycache__"
            / "stale.cpython-311.pyc"
        )
        write(cache_file, "stale cache")

        drift = find_runtime_drift(self.root)

        self.assertIn(
            "extra: plugins/writing-agent/scripts/__pycache__/stale.cpython-311.pyc",
            drift,
        )

        sync_runtime_assets(self.root)

        self.assertFalse(cache_file.exists())
        self.assertFalse(cache_file.parent.exists())

    def test_check_covers_hooks_and_generated_manifests(self) -> None:
        sync_runtime_assets(self.root)
        write(self.root / ".claude" / "settings.json", json.dumps({"hooks": {"changed": []}}))
        write(
            self.root / "plugins" / "writing-agent" / ".claude-plugin" / "plugin.json",
            json.dumps({"name": "changed"}),
        )

        drift = find_runtime_drift(self.root)

        self.assertTrue(any(".claude/settings.json" in item for item in drift))
        self.assertTrue(any("plugins/writing-agent/.claude-plugin/plugin.json" in item for item in drift))

    def test_generated_manifests_match_current_strict_schema_shape(self) -> None:
        sync_runtime_assets(self.root)

        plugin_manifest = json.loads(
            (self.root / "plugins" / "writing-agent" / ".claude-plugin" / "plugin.json").read_text(
                encoding="utf-8"
            )
        )
        marketplace = json.loads(
            (self.root / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8")
        )

        self.assertEqual("1.2.3", plugin_manifest["version"])
        self.assertEqual("Writing Agent", plugin_manifest["displayName"])
        self.assertNotIn("interface", plugin_manifest)
        self.assertNotIn("agents", plugin_manifest)
        self.assertNotIn("skills", plugin_manifest)
        self.assertNotIn("hooks", plugin_manifest)
        self.assertEqual({"name": "dongbeixiaohuo"}, marketplace["owner"])
        self.assertEqual("Writing Agent 的 Claude Code 插件市场", marketplace["description"])
        self.assertEqual("./plugins/writing-agent", marketplace["plugins"][0]["source"])
        self.assertNotIn("interface", marketplace)
        self.assertNotIn("policy", marketplace)

        hooks = json.loads(
            (self.root / "plugins" / "writing-agent" / "hooks" / "hooks.json").read_text(
                encoding="utf-8"
            )
        )
        session_hook = hooks["hooks"]["SessionStart"][0]["hooks"][0]
        self.assertIn('${CLAUDE_PLUGIN_ROOT}', session_hook["command"])
        self.assertIn('${CLAUDE_PLUGIN_DATA}', session_hook["command"])
        self.assertIn('${CLAUDE_PROJECT_DIR}', session_hook["command"])
        self.assertGreaterEqual(session_hook["timeout"], 180)

    def test_plugin_package_declares_runtime_dependencies(self) -> None:
        sync_runtime_assets(self.root)

        plugin_package = json.loads(
            (self.root / "plugins" / "writing-agent" / "package.json").read_text(encoding="utf-8")
        )

        self.assertEqual("1.2.3", plugin_package["version"])
        self.assertEqual("1.0.0", plugin_package["dependencies"]["cheerio"])
        self.assertEqual("^4.20.3", plugin_package["dependencies"]["tsx"])

        plugin_lock = json.loads(
            (self.root / "plugins" / "writing-agent" / "package-lock.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual("1.2.3", plugin_lock["version"])
        self.assertEqual("^4.20.3", plugin_lock["packages"][""]["dependencies"]["tsx"])
        self.assertNotIn("devDependencies", plugin_lock["packages"][""])

    def test_check_reports_package_lock_version_mismatch(self) -> None:
        write(
            self.root / "package-lock.json",
            json.dumps(
                {
                    "name": "writing-agent",
                    "version": "1.2.2",
                    "packages": {"": {"name": "writing-agent", "version": "1.2.2"}},
                }
            ),
        )
        sync_runtime_assets(self.root)

        drift = find_runtime_drift(self.root)

        self.assertIn("changed: package-lock.json version", drift)


class PackageMetadataTests(unittest.TestCase):
    repository_root = Path(__file__).resolve().parents[1]

    def test_package_is_private_and_has_a_bounded_pack_scope(self) -> None:
        package = json.loads((self.repository_root / "package.json").read_text(encoding="utf-8"))

        self.assertIs(True, package["private"])
        self.assertEqual(
            [
                "claude-runtime/",
                "plugins/writing-agent/",
                ".claude-plugin/",
                "scripts/",
                "!**/__pycache__/**",
                "!**/*.pyc",
            ],
            package["files"],
        )

    def test_package_exposes_cross_platform_aggregate_checks(self) -> None:
        package = json.loads((self.repository_root / "package.json").read_text(encoding="utf-8"))

        self.assertIn("check", package["scripts"])
        self.assertIn("check:plugin", package["scripts"])
        self.assertEqual(">=18", package["engines"]["node"])

    def test_package_and_lock_versions_match(self) -> None:
        package = json.loads((self.repository_root / "package.json").read_text(encoding="utf-8"))
        lock = json.loads((self.repository_root / "package-lock.json").read_text(encoding="utf-8"))

        self.assertEqual(package["version"], lock["version"])
        self.assertEqual(package["version"], lock["packages"][""]["version"])
        self.assertIn("tsx", package["dependencies"])
        self.assertIn("tsx", lock["packages"][""]["dependencies"])

    def test_skill_directory_names_match_frontmatter_names(self) -> None:
        skills_root = self.repository_root / "claude-runtime" / "skills"
        mismatches = []
        for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue
            name_line = next(
                (
                    line
                    for line in skill_file.read_text(encoding="utf-8").splitlines()
                    if line.startswith("name:")
                ),
                "",
            )
            declared_name = name_line.partition(":")[2].strip()
            if declared_name != skill_dir.name:
                mismatches.append(f"{skill_dir.name} != {declared_name}")

        self.assertEqual([], mismatches)

    def test_sync_helper_does_not_rewrite_its_own_token_definition(self) -> None:
        source_path = (
            self.repository_root
            / "claude-runtime"
            / "scripts"
            / "sync_claude_runtime.py"
        )

        rendered = render_target_bytes(source_path, "clone").decode("utf-8")

        self.assertNotIn('SCRIPT_ROOT_TOKEN = b"scripts"', rendered)
        self.assertIn('b"{{WRITING_AGENT_" + b"SCRIPTS}}"', rendered)


if __name__ == "__main__":
    unittest.main()
