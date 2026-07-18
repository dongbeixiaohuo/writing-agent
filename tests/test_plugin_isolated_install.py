from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = PROJECT_ROOT / "plugins" / "writing-agent"


@unittest.skipUnless(
    os.environ.get("RUN_PLUGIN_INSTALL_TEST") == "1",
    "设置 RUN_PLUGIN_INSTALL_TEST=1 才执行联网的插件隔离安装测试",
)
class PluginIsolatedInstallTests(unittest.TestCase):
    def test_plugin_bootstrap_and_html_tool_work_without_repository_workspace(self) -> None:
        npm = shutil.which("npm")
        node = shutil.which("node")
        if npm is None or node is None:
            self.skipTest("node/npm 不可用")

        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            workspace = root / "unrelated-workspace"
            plugin_data = root / "plugin-data"
            workspace.mkdir()
            bootstrap = subprocess.run(
                [
                    sys.executable,
                    str(PLUGIN_ROOT / "scripts" / "bootstrap_workspace.py"),
                    "--workspace-root",
                    str(workspace),
                    "--runtime-root",
                    str(PLUGIN_ROOT),
                    "--plugin-data",
                    str(plugin_data),
                ],
                cwd=workspace,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
                timeout=240,
            )
            self.assertEqual(0, bootstrap.returncode, bootstrap.stdout + bootstrap.stderr)
            self.assertTrue((workspace / "articles").is_dir())
            self.assertFalse((workspace / "scripts").exists())
            self.assertTrue((plugin_data / "node_modules" / "tsx").exists())
            self.assertTrue(
                (plugin_data / "runtime" / "scripts" / "export_markdown_to_html.ts").exists()
            )

            markdown = workspace / "articles" / "isolated.md"
            markdown.write_text("# 隔离插件测试\n\n这是一段正文。\n", encoding="utf-8")
            export = subprocess.run(
                [
                    npm,
                    "exec",
                    "--prefix",
                    str(plugin_data),
                    "--",
                    "tsx",
                    str(plugin_data / "runtime" / "scripts" / "export_markdown_to_html.ts"),
                    str(markdown),
                    "--theme",
                    "simple",
                ],
                cwd=workspace,
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=120,
            )
            self.assertEqual(0, export.returncode, export.stdout + export.stderr)
            payload = json.loads(export.stdout)
            html_path = Path(payload["htmlPath"])
            self.assertTrue(html_path.exists())
            self.assertIn("隔离插件测试", html_path.read_text(encoding="utf-8"))
            self.assertFalse(any((PLUGIN_ROOT / "scripts").rglob("*.pyc")))


if __name__ == "__main__":
    unittest.main()
