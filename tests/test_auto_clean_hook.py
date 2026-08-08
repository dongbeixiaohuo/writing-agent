from __future__ import annotations

import json
import io
import hashlib
import importlib.util
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr
from pathlib import Path


RUNTIME_HOOK = Path(__file__).parents[1] / "claude-runtime" / "scripts" / "auto_clean_hook.py"
HOOK_SPEC = importlib.util.spec_from_file_location("runtime_auto_clean_hook", RUNTIME_HOOK)
assert HOOK_SPEC is not None and HOOK_SPEC.loader is not None
hook_module = importlib.util.module_from_spec(HOOK_SPEC)
HOOK_SPEC.loader.exec_module(hook_module)


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class AutoCleanHookTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.articles_dir = self.root / "articles"
        self.project_dir = self.articles_dir / "示例项目"
        self.project_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_auto_clean_hook_never_selects_notes_file(self) -> None:
        write(self.project_dir / "draft_final.md", "# 正文")
        time.sleep(0.05)
        write(self.project_dir / "draft_final_notes.md", "# 备注")

        original_articles_dir = hook_module.ARTICLES_DIR
        try:
            hook_module.ARTICLES_DIR = self.articles_dir
            picked = hook_module.find_latest_draft()
        finally:
            hook_module.ARTICLES_DIR = original_articles_dir

        self.assertEqual((self.project_dir / "draft_final.md").resolve(), picked.resolve())

    def test_manifest_clean_source_has_priority(self) -> None:
        write(self.project_dir / "draft_v3.md", "# 最新正文")
        write(self.project_dir / "draft_final.md", "# 旧终稿")
        write(
            self.project_dir / "run_manifest.json",
            json.dumps(
                {
                    "workflow_version": "collab-v2",
                    "latest_body_file": "draft_v3.md",
                    "clean_source_file": "draft_v3.md",
                    "status": "reviewed",
                },
                ensure_ascii=False,
            ),
        )

        original_articles_dir = hook_module.ARTICLES_DIR
        try:
            hook_module.ARTICLES_DIR = self.articles_dir
            picked = hook_module.resolve_clean_source({}, allow_legacy_fallback=True)
        finally:
            hook_module.ARTICLES_DIR = original_articles_dir

        self.assertEqual((self.project_dir / "draft_v3.md").resolve(), picked.resolve())

    def test_workspace_root_event_does_not_select_an_implicit_project(self) -> None:
        isolated_root = self.root / "workspace-a"
        isolated_articles = isolated_root / "articles"
        isolated_project = isolated_articles / "隔离项目"
        isolated_project.mkdir(parents=True, exist_ok=True)
        write(isolated_project / "draft_final.md", "# 插件工作区正文")

        picked = hook_module.resolve_clean_source({"workspace_root": str(isolated_root)})

        self.assertIsNone(picked)

    def test_legacy_fallback_must_be_explicitly_enabled(self) -> None:
        write(self.project_dir / "draft_final.md", "# 历史兼容正文")

        original_articles_dir = hook_module.ARTICLES_DIR
        try:
            hook_module.ARTICLES_DIR = self.articles_dir
            picked = hook_module.resolve_clean_source({}, allow_legacy_fallback=True)
        finally:
            hook_module.ARTICLES_DIR = original_articles_dir

        self.assertEqual((self.project_dir / "draft_final.md").resolve(), picked.resolve())

    def test_manifest_cannot_select_a_file_outside_its_project(self) -> None:
        outside = self.articles_dir / "outside.md"
        write(outside, "# 不应读取")
        manifest = self.project_dir / "run_manifest.json"
        write(
            manifest,
            json.dumps(
                {
                    "latest_body_file": "../outside.md",
                    "clean_source_file": "../outside.md",
                    "fact_check_status": "passed",
                },
                ensure_ascii=False,
            ),
        )

        self.assertIsNone(hook_module.resolve_clean_source_from_manifest(manifest))

    def test_event_file_path_cannot_escape_articles_directory(self) -> None:
        outside = self.root / "outside.md"
        write(outside, "# 不应读取")

        picked = hook_module.resolve_clean_source(
            {"workspace_root": str(self.root), "file_path": str(outside)}
        )

        self.assertIsNone(picked)

    def _run_hook_with_fact_status(self, fact_check_status: str, *, valid_hash: bool = True) -> Path:
        body_path = self.project_dir / "draft_v3_humanized.md"
        clean_path = self.project_dir / "draft_v3_humanized_clean.txt"
        write(body_path, "# 最终正文")
        write(
            self.project_dir / "run_manifest.json",
            json.dumps(
                {
                    "workflow_version": "collab-v2",
                    "latest_body_file": body_path.name,
                    "clean_source_file": body_path.name,
                    "fact_check_status": fact_check_status,
                    "fact_checked_body_file": body_path.name,
                    "fact_checked_body_sha256": (
                        hashlib.sha256(body_path.read_bytes()).hexdigest()
                        if valid_hash
                        else "0" * 64
                    ),
                },
                ensure_ascii=False,
            ),
        )

        generator = self.root / "fake_generate_clean.py"
        write(
            generator,
            """from pathlib import Path
import sys

source = Path(sys.argv[1])
target = source.with_name(source.stem + '_clean.txt')
target.write_text(source.read_text(encoding='utf-8'), encoding='utf-8')
""",
        )

        original_generator = hook_module.GENERATE_CLEAN
        original_stdin = sys.stdin
        try:
            hook_module.GENERATE_CLEAN = generator
            sys.stdin = io.StringIO(
                json.dumps(
                    {
                        "workspace_root": str(self.root),
                        "project_dir": self.project_dir.name,
                    },
                    ensure_ascii=False,
                )
            )
            with redirect_stderr(io.StringIO()):
                hook_module.main()
        finally:
            hook_module.GENERATE_CLEAN = original_generator
            sys.stdin = original_stdin

        return clean_path

    def test_auto_clean_hook_skips_when_fact_check_is_blocked(self) -> None:
        clean_path = self._run_hook_with_fact_status("blocked")

        self.assertFalse(clean_path.exists())

    def test_auto_clean_hook_generates_when_fact_check_passed(self) -> None:
        clean_path = self._run_hook_with_fact_status("passed")

        self.assertTrue(clean_path.exists())

    def test_auto_clean_hook_rejects_a_stale_fact_check_hash(self) -> None:
        clean_path = self._run_hook_with_fact_status("passed", valid_hash=False)

        self.assertFalse(clean_path.exists())

    def test_cli_project_argument_targets_only_requested_project(self) -> None:
        target_body = self.project_dir / "draft_v3_humanized.md"
        write(target_body, "# 目标项目正文")
        write(
            self.project_dir / "run_manifest.json",
            json.dumps(
                {
                    "latest_body_file": target_body.name,
                    "clean_source_file": target_body.name,
                    "fact_check_status": "passed",
                    "fact_checked_body_file": target_body.name,
                    "fact_checked_body_sha256": hashlib.sha256(target_body.read_bytes()).hexdigest(),
                },
                ensure_ascii=False,
            ),
        )

        other_project = self.articles_dir / "较新但非目标项目"
        other_body = other_project / "draft_v4_humanized.md"
        write(other_body, "# 其他项目正文")
        write(
            other_project / "run_manifest.json",
            json.dumps(
                {
                    "latest_body_file": other_body.name,
                    "clean_source_file": other_body.name,
                    "fact_check_status": "passed",
                    "fact_checked_body_file": other_body.name,
                    "fact_checked_body_sha256": hashlib.sha256(other_body.read_bytes()).hexdigest(),
                },
                ensure_ascii=False,
            ),
        )

        result = subprocess.run(
            [
                sys.executable,
                str(RUNTIME_HOOK),
                "--workspace-root",
                str(self.root),
                "--project",
                self.project_dir.name,
            ],
            input="",
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertTrue((self.project_dir / "draft_v3_humanized_clean.txt").exists())
        self.assertFalse((other_project / "draft_v4_humanized_clean.txt").exists())


if __name__ == "__main__":
    unittest.main()
