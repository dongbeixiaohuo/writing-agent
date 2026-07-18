from __future__ import annotations

import shutil
import subprocess
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class TypeScriptBuildTests(unittest.TestCase):
    def test_runtime_entrypoints_typecheck(self) -> None:
        npx = shutil.which("npx")
        if npx is None:
            self.skipTest("npx 不可用，跳过 TypeScript 类型检查")

        result = subprocess.run(
            [
                npx,
                "tsc",
                "--noEmit",
                "--module",
                "NodeNext",
                "--moduleResolution",
                "NodeNext",
                "--target",
                "ES2022",
                "--allowImportingTsExtensions",
                "--esModuleInterop",
                "--skipLibCheck",
                "claude-runtime/scripts/export_markdown_to_html.ts",
                "claude-runtime/scripts/generate_image.ts",
            ],
            cwd=PROJECT_ROOT,
            text=True,
            capture_output=True,
            timeout=120,
        )
        self.assertEqual(
            result.returncode,
            0,
            msg=f"TypeScript 类型检查失败:\n{result.stdout}\n{result.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
