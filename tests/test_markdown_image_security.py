from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
IMAGES_TS = (
    PROJECT_ROOT
    / "claude-runtime"
    / "scripts"
    / "vendor"
    / "markdown-to-html-core"
    / "src"
    / "images.ts"
)


class MarkdownImageSecurityTests(unittest.TestCase):
    def test_remote_downloader_blocks_loopback_before_connecting(self):
        node = shutil.which("node") or "C:/nvm4w/nodejs/node.exe"
        if not Path(node).exists():
            self.skipTest("node is not available")
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / "image.png"
            expression = f"""
              import {{ downloadFile }} from {json.dumps(IMAGES_TS.resolve().as_uri())};
              try {{
                await downloadFile('http://127.0.0.1:9/private.png', {json.dumps(str(destination))});
                process.exitCode = 2;
              }} catch (error) {{
                console.log(error.message);
              }}
            """
            result = subprocess.run(
                [node, "--import", "tsx", "--input-type=module", "--eval", expression],
                cwd=PROJECT_ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

            self.assertEqual(0, result.returncode, result.stderr)
            self.assertIn("Blocked unsafe", result.stdout)
            self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
