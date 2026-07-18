from __future__ import annotations

import html
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKILL_SCRIPTS = PROJECT_ROOT / "claude-runtime" / "skills" / "web-article-extractor" / "scripts"


def find_chromium() -> Path | None:
    candidates = [
        Path("C:/Program Files/Google/Chrome/Application/chrome.exe"),
        Path("C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"),
        Path("C:/Program Files/Microsoft/Edge/Application/msedge.exe"),
        Path("C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"),
    ]
    return next((path for path in candidates if path.exists()), None)


class BrowserExtractionSmokeTests(unittest.TestCase):
    def test_vendored_readability_extracts_a_real_dom(self) -> None:
        browser = find_chromium()
        if browser is None:
            self.skipTest("Chrome/Edge 不可用，跳过真实浏览器抽取测试")

        readability = (SKILL_SCRIPTS / "Readability.js").read_text(encoding="utf-8")
        extractor = (SKILL_SCRIPTS / "readability_extractor.js").read_text(encoding="utf-8")
        paragraphs = "".join(
            f"<p>这是第{i}段真实测试正文，用于验证中文文章提取、段落保留和字数统计。"
            "文章应当在浏览器 DOM 中由本地 Readability 脚本解析，不能依赖 CDN 或伪造接口。</p>"
            for i in range(1, 31)
        )

        document = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>真实浏览器抽取测试</title>
<meta name="author" content="测试作者"><script>{readability}</script></head>
<body><nav>导航</nav><main><article><h1>真实浏览器抽取测试</h1>{paragraphs}</article></main>
<script>
const extracted = {extractor};
document.body.innerHTML = '<pre id="extraction-result"></pre>';
document.getElementById('extraction-result').textContent = JSON.stringify(extracted);
</script></body></html>"""

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            page = temp_root / "article.html"
            browser_profile = temp_root / "browser-profile"
            page.write_text(document, encoding="utf-8")
            result = subprocess.run(
                [
                    str(browser),
                    "--headless=new",
                    f"--user-data-dir={browser_profile}",
                    "--disable-background-networking",
                    "--disable-default-apps",
                    "--disable-extensions",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--virtual-time-budget=2000",
                    "--dump-dom",
                    page.as_uri(),
                ],
                text=True,
                encoding="utf-8",
                errors="replace",
                capture_output=True,
                timeout=30,
            )

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        match = re.search(
            r'<pre id="extraction-result">(.*?)</pre>',
            result.stdout,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(match, msg=result.stdout[-2000:])
        payload = json.loads(html.unescape(match.group(1)))
        self.assertTrue(payload["success"], msg=payload)
        self.assertEqual(payload["extractionMethod"], "readability-vendored")
        self.assertIn("真实浏览器抽取测试", payload["title"])
        self.assertIn("第30段真实测试正文", payload["content"])
        self.assertGreater(payload["wordCount"], 500)


if __name__ == "__main__":
    unittest.main()
