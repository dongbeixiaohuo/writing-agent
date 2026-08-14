from __future__ import annotations

import json
import hashlib
import tempfile
import time
import unittest
import sys
from pathlib import Path

RUNTIME_ROOT = Path(__file__).resolve().parents[1] / "claude-runtime"
sys.path.insert(0, str(RUNTIME_ROOT))

from scripts.auto_clean_hook import find_latest_draft, resolve_clean_source, resolve_clean_source_from_manifest
from scripts.update_run_manifest import update_run_manifest


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class RunManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.articles_dir = self.root / "articles"
        self.project_dir = self.articles_dir / "测试项目"
        self.project_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_update_run_manifest_writes_latest_body_and_notes(self) -> None:
        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v2.md",
            notes_file="draft_v2_notes.md",
            status="reviewed",
            workflow_version="collab-v2",
        )

        manifest_path = self.project_dir / "run_manifest.json"
        self.assertTrue(manifest_path.exists())
        self.assertEqual("draft_v2.md", manifest["latest_body_file"])
        self.assertEqual("draft_v2_notes.md", manifest["latest_notes_file"])
        self.assertEqual("draft_v2.md", manifest["clean_source_file"])

    def test_update_run_manifest_can_record_html_export(self) -> None:
        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v3_humanized.md",
            status="html-exported",
            workflow_version="collab-v2",
            html_file="draft_v3_humanized.html",
            html_source_file="draft_v3_humanized.md",
            html_theme="grace",
        )

        self.assertEqual("draft_v3_humanized.html", manifest["latest_html_file"])
        self.assertEqual("draft_v3_humanized.md", manifest["html_source_file"])
        self.assertEqual("grace", manifest["html_theme"])

    def test_update_run_manifest_invalidates_fact_check_for_a_changed_body(self) -> None:
        old_body = self.project_dir / "draft_v3.md"
        write(old_body, "# 旧正文")
        manifest_path = self.project_dir / "run_manifest.json"
        manifest_path.write_text(
            json.dumps(
                {
                    "fact_check_status": "passed",
                    "latest_fact_check_report": "fact_check_report.md",
                    "fact_checked_body_file": old_body.name,
                    "fact_checked_body_sha256": hashlib.sha256(old_body.read_bytes()).hexdigest(),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        write(self.project_dir / "draft_v4.md", "# 已修改正文")

        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v4.md",
            status="reviewed",
        )

        self.assertEqual("stale", manifest["fact_check_status"])
        self.assertEqual("fact_check_report.md", manifest["latest_fact_check_report"])

    def test_update_run_manifest_treats_legacy_unbound_pass_as_stale(self) -> None:
        write(self.project_dir / "draft_v3.md", "# 正文")
        (self.project_dir / "run_manifest.json").write_text(
            json.dumps({"fact_check_status": "passed"}, ensure_ascii=False),
            encoding="utf-8",
        )

        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v3.md",
            status="reviewed",
        )

        self.assertEqual("stale", manifest["fact_check_status"])

    def test_update_run_manifest_records_fact_check_body_hash(self) -> None:
        body = self.project_dir / "draft_v3_humanized.md"
        title = self.project_dir / "04_title.md"
        write(body, "# 已核查正文\n\n内容")
        write(title, "## 最终锁定\n- 选择状态：已锁定\n- 最终标题：「已核查标题」\n")
        write(self.project_dir / "fact_claims.json", "{}")
        write(self.project_dir / "fact_check_report.md", "# 报告")

        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file=body.name,
            title_file=title.name,
            status="fact-checked",
            fact_check_status="passed",
            fact_claims_file="fact_claims.json",
            fact_check_report_file="fact_check_report.md",
            fact_checked_at="2026-08-08T12:00:00+08:00",
        )

        self.assertEqual("passed", manifest["fact_check_status"])
        self.assertEqual(body.name, manifest["fact_checked_body_file"])
        self.assertEqual(hashlib.sha256(body.read_bytes()).hexdigest(), manifest["fact_checked_body_sha256"])
        self.assertEqual(title.name, manifest["fact_checked_title_file"])
        self.assertEqual(hashlib.sha256(title.read_bytes()).hexdigest(), manifest["fact_checked_title_sha256"])
        self.assertEqual("fact_claims.json", manifest["latest_fact_claims_file"])
        self.assertEqual("fact_check_report.md", manifest["latest_fact_check_report"])
        self.assertEqual("2026-08-08T12:00:00+08:00", manifest["fact_checked_at"])

    def test_fact_check_update_preserves_existing_notes_file(self) -> None:
        body = self.project_dir / "draft_v3_humanized.md"
        title = self.project_dir / "04_title.md"
        write(body, "# 已核查正文")
        write(title, "## 最终锁定\n- 选择状态：已锁定\n- 最终标题：「标题」\n")
        write(self.project_dir / "draft_v3_notes.md", "# 备注")
        write(self.project_dir / "fact_claims.json", "{}")
        write(self.project_dir / "fact_check_report.md", "# 报告")
        update_run_manifest(
            project_dir=self.project_dir,
            body_file=body.name,
            notes_file="draft_v3_notes.md",
            status="humanized",
        )

        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file=body.name,
            title_file=title.name,
            status="fact-checked",
            fact_check_status="passed",
            fact_claims_file="fact_claims.json",
            fact_check_report_file="fact_check_report.md",
        )

        self.assertEqual("draft_v3_notes.md", manifest["latest_notes_file"])

    def test_update_run_manifest_invalidates_fact_check_when_locked_title_changes(self) -> None:
        body = self.project_dir / "draft_v3_humanized.md"
        title = self.project_dir / "04_title.md"
        write(body, "# 已核查标题\n\n正文")
        write(title, "## 最终锁定\n- 选择状态：已锁定\n- 最终标题：「旧标题」\n")
        write(self.project_dir / "fact_claims.json", "{}")
        write(self.project_dir / "fact_check_report.md", "# 报告")
        update_run_manifest(
            project_dir=self.project_dir,
            body_file=body.name,
            title_file=title.name,
            status="fact-checked",
            fact_check_status="passed",
            fact_claims_file="fact_claims.json",
            fact_check_report_file="fact_check_report.md",
        )

        write(title, "## 最终锁定\n- 选择状态：已锁定\n- 最终标题：「新标题」\n")
        manifest = update_run_manifest(
            project_dir=self.project_dir,
            body_file=body.name,
            status="reviewed",
        )

        self.assertEqual("stale", manifest["fact_check_status"])
        self.assertEqual("body_or_title_changed_or_unbound", manifest["fact_check_stale_reason"])

    def test_update_run_manifest_rejects_project_outside_articles(self) -> None:
        outside_project = self.root / "outside-project"

        with self.assertRaises(ValueError):
            update_run_manifest(
                project_dir=outside_project,
                body_file="draft_v1.md",
                status="drafted",
            )

        self.assertFalse((outside_project / "run_manifest.json").exists())

    def test_update_run_manifest_rejects_paths_outside_project(self) -> None:
        with self.assertRaises(ValueError):
            update_run_manifest(
                project_dir=self.project_dir,
                body_file="../outside.md",
                status="drafted",
            )

    def test_hook_prefers_explicit_clean_source_from_manifest(self) -> None:
        write(self.project_dir / "draft_v2.md", "# 正文")
        write(self.project_dir / "draft_final.md", "# 旧终稿")
        update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v2.md",
            notes_file="draft_v2_notes.md",
            status="reviewed",
        )

        manifest_path = self.project_dir / "run_manifest.json"
        resolved = resolve_clean_source_from_manifest(manifest_path)

        self.assertEqual((self.project_dir / "draft_v2.md").resolve(), resolved)

    def test_hook_ignores_notes_file_even_if_newer(self) -> None:
        write(self.project_dir / "draft_final.md", "# 正文")
        time.sleep(0.05)
        write(self.project_dir / "draft_final_notes.md", "内部备注")

        from scripts import auto_clean_hook as hook_module

        original_articles_dir = hook_module.ARTICLES_DIR
        try:
            hook_module.ARTICLES_DIR = self.articles_dir
            picked = find_latest_draft()
        finally:
            hook_module.ARTICLES_DIR = original_articles_dir

        self.assertEqual((self.project_dir / "draft_final.md").resolve(), picked.resolve())

    def test_resolve_clean_source_uses_latest_manifest_before_fallback(self) -> None:
        write(self.project_dir / "draft_v3.md", "# 正文")
        update_run_manifest(
            project_dir=self.project_dir,
            body_file="draft_v3.md",
            notes_file="draft_v3_notes.md",
            status="reviewed",
        )

        from scripts import auto_clean_hook as hook_module

        original_articles_dir = hook_module.ARTICLES_DIR
        try:
            hook_module.ARTICLES_DIR = self.articles_dir
            resolved = resolve_clean_source({}, allow_legacy_fallback=True)
        finally:
            hook_module.ARTICLES_DIR = original_articles_dir

        self.assertEqual((self.project_dir / "draft_v3.md").resolve(), resolved.resolve())

    def test_update_run_manifest_workspace_root_round_trip(self) -> None:
        from scripts.claude_runtime_paths import workspace_articles_dir

        workspace_articles = workspace_articles_dir(self.root)
        project_dir = workspace_articles / "插件项目"
        manifest = update_run_manifest(
            project_dir=project_dir,
            body_file="draft_v1.md",
            notes_file="draft_v1_notes.md",
            status="drafted",
        )

        manifest_path = project_dir / "run_manifest.json"
        self.assertTrue(manifest_path.exists())
        self.assertEqual("draft_v1.md", manifest["latest_body_file"])


if __name__ == "__main__":
    unittest.main()
