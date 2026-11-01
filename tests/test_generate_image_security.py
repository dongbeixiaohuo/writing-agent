from __future__ import annotations

import json
import base64
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "claude-runtime" / "scripts" / "generate_image.ts"


def node_binary() -> str | None:
    return shutil.which("node") or (
        "C:/nvm4w/nodejs/node.exe" if Path("C:/nvm4w/nodejs/node.exe").exists() else None
    )


class GenerateImageSecurityTests(unittest.TestCase):
    def test_compatible_image_response_with_and_without_proxy(self):
        node = node_binary()
        if node is None:
            self.skipTest("node is not available")
        calls = []
        image = b"fixture-image-bytes"

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_CONNECT(self):
                calls.append(("CONNECT", self.path))
                self.send_response(200)
                self.end_headers()
                self.close_connection = False

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append(("POST", self.path, self.headers["Authorization"], body))
                payload = json.dumps({"data": [{"b64_json": base64.b64encode(image).decode()}]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for use_proxy in (False, True):
                with self.subTest(proxy=use_proxy), tempfile.TemporaryDirectory() as output:
                    calls.clear()
                    env = {key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")}
                    endpoint = f"http://127.0.0.1:{server.server_port}"
                    env.update(GEMINI_API_KEY="fixture-key", GEMINI_API_BASE="http://image.invalid/v1" if use_proxy else endpoint + "/v1", IMAGE_MODEL="fixture-model")
                    if use_proxy:
                        env["HTTPS_PROXY"] = endpoint
                    result = subprocess.run([node, "--import", "tsx", str(SCRIPT), "--prompt", "fixture prompt", "--output", output, "--filename", "image.png"], cwd=PROJECT_ROOT, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
                    self.assertEqual(0, result.returncode, f"{result.stderr}\nRequests: {calls}")
                    self.assertEqual(image, (Path(output) / "image.png").read_bytes())
                    self.assertEqual([("POST", "/v1/images/generations", "Bearer fixture-key", {"model": "fixture-model", "prompt": "fixture prompt"})], [call for call in calls if call[0] == "POST"])
                    self.assertEqual(use_proxy, any(call[0] == "CONNECT" for call in calls))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

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
