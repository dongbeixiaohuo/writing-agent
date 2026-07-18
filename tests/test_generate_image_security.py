from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "claude-runtime" / "scripts" / "generate_image.ts"


def node_binary() -> str | None:
    return shutil.which("node") or (
        "C:/nvm4w/nodejs/node.exe" if Path("C:/nvm4w/nodejs/node.exe").exists() else None
    )


class GenerateImageSecurityTests(unittest.TestCase):
    def test_api_key_is_sent_in_header_and_proxy_is_not_logged_raw(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertNotIn("?key=${apiKey}", source)
        self.assertNotIn("${proxyUrl}", source)
        self.assertIn('"x-goog-api-key": apiKey', source)

    def test_redact_url_hides_credentials_and_query(self):
        node = node_binary()
        if node is None:
            self.skipTest("node is not available")
        script_url = SCRIPT.resolve().as_uri()
        expression = f"""
          import {{ redactUrl }} from {json.dumps(script_url)};
          console.log(redactUrl('http://user:secret@proxy.example:8080/path?token=abc'));
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
        self.assertEqual("http://proxy.example:8080/path", result.stdout.strip())

    def test_output_filename_cannot_escape_requested_directory(self):
        node = node_binary()
        if node is None:
            self.skipTest("node is not available")
        script_url = SCRIPT.resolve().as_uri()
        expression = f"""
          import {{ resolveOutputFile }} from {json.dumps(script_url)};
          for (const filename of ['../outside.png', '..\\\\outside.png', '/tmp/outside.png']) {{
            try {{
              resolveOutputFile('safe-output', filename);
              process.exitCode = 2;
            }} catch (error) {{
              console.log(error.message);
            }}
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
        self.assertEqual(3, len(result.stdout.strip().splitlines()))

    def test_remote_image_download_uses_hardened_downloader(self):
        source = SCRIPT.read_text(encoding="utf-8")
        self.assertIn("downloadFile", source)
        self.assertNotIn("async function downloadImage", source)


if __name__ == "__main__":
    unittest.main()
