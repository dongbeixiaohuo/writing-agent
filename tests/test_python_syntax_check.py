from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
CHECKER = PROJECT_ROOT / "claude-runtime" / "scripts" / "check_python_syntax.py"


class PythonSyntaxCheckTests(unittest.TestCase):
    def run_checker(self, *paths: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(CHECKER), *(str(path) for path in paths)],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_valid_file_passes_without_writing_bytecode(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            source = Path(tempdir) / "valid.py"
            source.write_text("answer = 42\n", encoding="utf-8")

            result = self.run_checker(source)

            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            self.assertFalse((source.parent / "__pycache__").exists())

    def test_invalid_file_fails_with_the_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            source = Path(tempdir) / "invalid.py"
            source.write_text("if True print('broken')\n", encoding="utf-8")

            result = self.run_checker(source)

            self.assertNotEqual(0, result.returncode)
            self.assertIn(str(source), result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
