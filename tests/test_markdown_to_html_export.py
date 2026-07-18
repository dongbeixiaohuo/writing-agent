from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = PROJECT_ROOT / "claude-runtime" / "scripts" / "export_markdown_to_html.ts"


def resolve_node_binary() -> str | None:
    node = shutil.which("node")
    if node:
        return node

    candidates = [
        Path("C:/nvm4w/nodejs/node.exe"),
        Path("C:/Program Files/nodejs/node.exe"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


class MarkdownToHtmlExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.markdown_path = self.root / "article.md"
        self.markdown_path.write_text(
            """---
title: 测试标题
author: 测试作者
description: 测试摘要
---
# 测试标题

这是一段中文正文，包含 **加粗** 和 [普通链接](https://example.com)。

这里还有一段 `行内代码`。

## 小节

- 列表一
- 列表二

```python
print("hello")
```
""",
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_export_script_generates_html_and_backup(self) -> None:
        node_binary = resolve_node_binary()
        if node_binary is None:
            self.skipTest("node 不可用，跳过 HTML 导出测试")

        command = [
            node_binary,
            "--import",
            "tsx",
            str(SCRIPT_PATH),
            str(self.markdown_path),
            "--theme",
            "modern",
            "--color",
            "red",
            "--cite",
        ]

        first = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        first_result = json.loads(first.stdout)

        html_path = Path(first_result["htmlPath"])
        self.assertTrue(html_path.exists())
        self.assertEqual("modern", first_result["theme"])
        self.assertTrue(first_result["citeEnabled"])
        self.assertTrue(html_path.name.endswith(".html"))

        html = html_path.read_text(encoding="utf-8")
        self.assertIn("<title>测试标题</title>", html)
        self.assertIn("引用链接", html)

        second = subprocess.run(
            command,
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        second_result = json.loads(second.stdout)

        self.assertIsNotNone(second_result["backupPath"])
        self.assertTrue(Path(second_result["backupPath"]).exists())

    def test_failed_export_keeps_existing_html_in_place(self) -> None:
        node_binary = resolve_node_binary()
        if node_binary is None:
            self.skipTest("node 不可用，跳过 HTML 导出测试")

        self.markdown_path.write_text(
            "# 测试标题\n\n![远程图](http://127.0.0.1:9/private.png)\n",
            encoding="utf-8",
        )
        html_path = self.markdown_path.with_suffix(".html")
        html_path.write_text("existing-html", encoding="utf-8")
        result = subprocess.run(
            [
                node_binary,
                "--import",
                "tsx",
                str(SCRIPT_PATH),
                str(self.markdown_path),
            ],
            cwd=PROJECT_ROOT,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=30,
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertEqual("existing-html", html_path.read_text(encoding="utf-8"))
        self.assertFalse(list(self.root.glob("article.html.bak-*")))

    def test_export_sanitizes_active_html_and_unsafe_links(self) -> None:
        node_binary = resolve_node_binary()
        if node_binary is None:
            self.skipTest("node 不可用，跳过 HTML 导出测试")

        self.markdown_path.write_text(
            "# 安全测试\n\n<script id=raw>alert(1)</script>\n\n"
            "[危险链接](javascript:alert(2))\n\n"
            '<link rel="stylesheet" href="https://evil.example/track.css">\n\n'
            '<style>@import url("https://evil.example/leak.css");</style>\n',
            encoding="utf-8",
        )
        result = subprocess.run(
            [
                node_binary,
                "--import",
                "tsx",
                str(SCRIPT_PATH),
                str(self.markdown_path),
                "--theme",
                "modern",
            ],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=True,
        )
        html = Path(json.loads(result.stdout)["htmlPath"]).read_text(encoding="utf-8")

        self.assertNotIn("<script id=raw>", html)
        self.assertNotIn("javascript:", html.lower())
        self.assertNotIn("evil.example", html.lower())
        self.assertNotIn("<link", html.lower())


if __name__ == "__main__":
    unittest.main()
