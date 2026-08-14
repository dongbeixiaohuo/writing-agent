"""
update_run_manifest.py - 更新项目运行态 manifest。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_SOURCE_ROOT = SCRIPT_DIR.parent
if str(PROJECT_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_SOURCE_ROOT))

from scripts.claude_runtime_paths import resolve_workspace_root, workspace_articles_dir


PROJECT_ROOT = resolve_workspace_root()
ARTICLES_DIR = workspace_articles_dir(PROJECT_ROOT)


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
    except ValueError:
        return False
    return True


def _validate_project_dir(project_dir: Path) -> Path:
    resolved = project_dir.resolve()
    if not any(parent.name.casefold() == "articles" for parent in resolved.parents):
        raise ValueError(f"project_dir 必须位于 articles/ 下: {project_dir}")
    return resolved


def _validate_project_file(project_dir: Path, value: str | None, field: str) -> None:
    if value is None:
        return

    candidate = Path(value)
    if candidate.is_absolute():
        raise ValueError(f"{field} 必须是项目内的相对路径: {value}")

    resolved = (project_dir / candidate).resolve()
    if resolved == project_dir or not _is_within(resolved, project_dir):
        raise ValueError(f"{field} 必须位于项目目录内: {value}")


def _project_file_path(project_dir: Path, value: str, field: str, *, must_exist: bool = False) -> Path:
    _validate_project_file(project_dir, value, field)
    resolved = (project_dir / value).resolve()
    if must_exist and not resolved.is_file():
        raise ValueError(f"{field} 对应的项目文件不存在: {value}")
    return resolved


def body_sha256(project_dir: Path, body_file: str) -> str:
    body_path = _project_file_path(project_dir, body_file, "body_file", must_exist=True)
    return hashlib.sha256(body_path.read_bytes()).hexdigest()


def project_file_sha256(project_dir: Path, file_name: str, field: str) -> str:
    file_path = _project_file_path(project_dir, file_name, field, must_exist=True)
    return hashlib.sha256(file_path.read_bytes()).hexdigest()


def _fact_binding_matches(manifest: dict, project_dir: Path, body_file: str) -> bool:
    checked_file = manifest.get("fact_checked_body_file")
    checked_hash = manifest.get("fact_checked_body_sha256")
    checked_title_file = manifest.get("fact_checked_title_file")
    checked_title_hash = manifest.get("fact_checked_title_sha256")
    if not all(
        isinstance(value, str)
        for value in (checked_file, checked_hash, checked_title_file, checked_title_hash)
    ):
        return False

    try:
        checked_path = _project_file_path(project_dir, checked_file, "fact_checked_body_file")
        body_path = _project_file_path(project_dir, body_file, "body_file", must_exist=True)
        title_path = _project_file_path(
            project_dir,
            checked_title_file,
            "fact_checked_title_file",
            must_exist=True,
        )
    except ValueError:
        return False

    if checked_path != body_path:
        return False
    return (
        hashlib.sha256(body_path.read_bytes()).hexdigest() == checked_hash.lower()
        and hashlib.sha256(title_path.read_bytes()).hexdigest() == checked_title_hash.lower()
    )


def update_run_manifest(
    project_dir: Path,
    body_file: str,
    title_file: str | None = None,
    notes_file: str | None = None,
    status: str = "drafted",
    workflow_version: str = "collab-v2",
    clean_source_file: str | None = None,
    html_file: str | None = None,
    html_source_file: str | None = None,
    html_theme: str | None = None,
    fact_check_status: str | None = None,
    fact_claims_file: str | None = None,
    fact_check_report_file: str | None = None,
    fact_checked_at: str | None = None,
) -> dict:
    project_dir = _validate_project_dir(project_dir)
    for field, value in (
        ("body_file", body_file),
        ("title_file", title_file),
        ("notes_file", notes_file),
        ("clean_source_file", clean_source_file),
        ("html_file", html_file),
        ("html_source_file", html_source_file),
        ("fact_claims_file", fact_claims_file),
        ("fact_check_report_file", fact_check_report_file),
    ):
        _validate_project_file(project_dir, value, field)

    if fact_check_status is not None:
        if fact_check_status not in {"passed", "blocked"}:
            raise ValueError("fact_check_status 只能是 passed 或 blocked")
        if not title_file:
            raise ValueError("记录事实核查结果时必须提供 title_file")
        if not fact_claims_file or not fact_check_report_file:
            raise ValueError("记录事实核查结果时必须提供 fact_claims_file 和 fact_check_report_file")
        _project_file_path(project_dir, title_file, "title_file", must_exist=True)
        _project_file_path(project_dir, fact_claims_file, "fact_claims_file", must_exist=True)
        _project_file_path(project_dir, fact_check_report_file, "fact_check_report_file", must_exist=True)

    project_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = project_dir / "run_manifest.json"

    manifest: dict = {}
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            raise ValueError(f"run_manifest.json 顶层必须是对象: {manifest_path}")
        manifest.update(existing)

    if (
        fact_check_status is None
        and manifest.get("fact_check_status") in {"passed", "blocked"}
        and not _fact_binding_matches(manifest, project_dir, body_file)
    ):
        manifest["fact_check_status"] = "stale"
        manifest["fact_check_stale_reason"] = "body_or_title_changed_or_unbound"

    runtime_update = {
        "workflow_version": workflow_version,
        "latest_body_file": body_file,
        "clean_source_file": clean_source_file or body_file,
        "status": status,
    }
    if notes_file is not None or fact_check_status is None or "latest_notes_file" not in manifest:
        runtime_update["latest_notes_file"] = notes_file
    manifest.update(runtime_update)

    if html_file:
        manifest["latest_html_file"] = html_file
    if html_source_file:
        manifest["html_source_file"] = html_source_file
    if html_theme:
        manifest["html_theme"] = html_theme

    if fact_check_status is not None:
        manifest.update(
            {
                "latest_fact_claims_file": fact_claims_file,
                "latest_fact_check_report": fact_check_report_file,
                "fact_check_status": fact_check_status,
                "fact_checked_body_file": body_file,
                "fact_checked_body_sha256": body_sha256(project_dir, body_file),
                "fact_checked_title_file": title_file,
                "fact_checked_title_sha256": project_file_sha256(project_dir, title_file, "title_file"),
                "fact_checked_at": fact_checked_at or datetime.now().astimezone().isoformat(timespec="seconds"),
            }
        )
        manifest.pop("fact_check_stale_reason", None)

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="更新 articles 项目的 run_manifest.json")
    parser.add_argument("--workspace-root", help="工作区根目录，默认当前目录")
    parser.add_argument("--project", required=True, help="项目目录名（位于 articles/ 下）")
    parser.add_argument("--body", required=True, help="最新正文文件名")
    parser.add_argument("--title", help="本轮事实核查的锁定标题文件名")
    parser.add_argument("--notes", help="最新备注文件名")
    parser.add_argument("--status", default="drafted", help="当前项目状态")
    parser.add_argument("--workflow-version", default="collab-v2", help="协议版本")
    parser.add_argument("--clean-source", help="显式 clean 来源文件名，默认等于 body")
    parser.add_argument("--html", help="最新导出的 HTML 文件名")
    parser.add_argument("--html-source", help="用于导出 HTML 的正文文件名")
    parser.add_argument("--html-theme", help="HTML 导出使用的版式主题")
    parser.add_argument("--fact-check-status", choices=("passed", "blocked"), help="绑定到当前正文与锁定标题的事实核查结果")
    parser.add_argument("--fact-claims", help="事实清单文件名")
    parser.add_argument("--fact-report", help="事实核查报告文件名")
    parser.add_argument("--fact-checked-at", help="事实核查时间，默认当前本地 ISO 时间")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    project_dir = workspace_articles_dir(args.workspace_root) / args.project
    manifest = update_run_manifest(
        project_dir=project_dir,
        body_file=args.body,
        title_file=args.title,
        notes_file=args.notes,
        status=args.status,
        workflow_version=args.workflow_version,
        clean_source_file=args.clean_source,
        html_file=args.html,
        html_source_file=args.html_source,
        html_theme=args.html_theme,
        fact_check_status=args.fact_check_status,
        fact_claims_file=args.fact_claims,
        fact_check_report_file=args.fact_report,
        fact_checked_at=args.fact_checked_at,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
