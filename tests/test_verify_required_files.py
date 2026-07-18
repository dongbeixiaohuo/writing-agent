from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from scripts.verify_required_files import find_file_issues, verify_required_files


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class VerifyRequiredFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.project_dir = Path(self.tempdir.name) / "articles" / "测试项目"
        self.project_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_verify_required_files_passes_when_all_files_exist_and_nonempty(self) -> None:
        write(self.project_dir / "04_share_map.md", "# share map")
        write(self.project_dir / "05_concrete_library.md", "# concrete library")
        write(self.project_dir / "05c_opening_hook.md", "# opening hook")

        issues = find_file_issues(
            self.project_dir,
            ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
        )

        self.assertEqual([], issues)
        self.assertTrue(
            verify_required_files(
                self.project_dir,
                ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
            )
        )

    def test_verify_required_files_reports_missing_and_empty_files(self) -> None:
        write(self.project_dir / "04_share_map.md", "# share map")
        write(self.project_dir / "05_concrete_library.md", "   \n")

        issues = find_file_issues(
            self.project_dir,
            ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
        )

        self.assertEqual(
            [
                {"file": "05_concrete_library.md", "reason": "empty"},
                {"file": "05c_opening_hook.md", "reason": "missing"},
            ],
            issues,
        )
        self.assertFalse(
            verify_required_files(
                self.project_dir,
                ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
            )
        )

    def test_verify_required_files_rejects_unlocked_title_file(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题候选与锁定结果

## 最终锁定
- **选择状态**：待定
- **最终编号**：待定
- **最终标题**：待定
""",
        )

        issues = find_file_issues(self.project_dir, ["04_title.md"])

        self.assertEqual(
            [{"file": "04_title.md", "reason": "unlocked_title"}],
            issues,
        )
        self.assertFalse(verify_required_files(self.project_dir, ["04_title.md"]))

    def test_verify_required_files_accepts_locked_title_file(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题确认

## 最终标题

**「你的大脑\"默认设置\"是什么时候的？答案很残忍」**
""",
        )

        issues = find_file_issues(self.project_dir, ["04_title.md"])

        self.assertEqual([], issues)
        self.assertTrue(verify_required_files(self.project_dir, ["04_title.md"]))



if __name__ == "__main__":
    unittest.main()
