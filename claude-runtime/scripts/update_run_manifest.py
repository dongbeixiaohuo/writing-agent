"""
update_run_manifest.py - 更新项目运行态 manifest。
"""

from __future__ import annotations

import argparse
import json
import sys
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


def update_run_manifest(
    project_dir: Path,
    body_file: str,
    notes_file: str | None = None,
    status: str = "drafted",
    workflow_version: str = "collab-v2",
    clean_source_file: str | None = None,
    html_file: str | None = None,
    html_source_file: str | None = None,
    html_theme: str | None = None,
) -> dict:
    project_dir = _validate_project_dir(project_dir)
    for field, value in (
        ("body_file", body_file),
        ("notes_file", notes_file),
        ("clean_source_file", clean_source_file),
        ("html_file", html_file),
        ("html_source_file", html_source_file),
    ):
        _validate_project_file(project_dir, value, field)

    project_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = project_dir / "run_manifest.json"

    manifest: dict = {}
    if manifest_path.exists():
        existing = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            raise ValueError(f"run_manifest.json 顶层必须是对象: {manifest_path}")
        manifest.update(existing)

    manifest.update(
        {
            "workflow_version": workflow_version,
            "latest_body_file": body_file,
            "latest_notes_file": notes_file,
            "clean_source_file": clean_source_file or body_file,
            "status": status,
        }
    )

    if html_file:
        manifest["latest_html_file"] = html_file
    if html_source_file:
        manifest["html_source_file"] = html_source_file
    if html_theme:
        manifest["html_theme"] = html_theme

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
    parser.add_argument("--notes", help="最新备注文件名")
    parser.add_argument("--status", default="drafted", help="当前项目状态")
    parser.add_argument("--workflow-version", default="collab-v2", help="协议版本")
    parser.add_argument("--clean-source", help="显式 clean 来源文件名，默认等于 body")
    parser.add_argument("--html", help="最新导出的 HTML 文件名")
    parser.add_argument("--html-source", help="用于导出 HTML 的正文文件名")
    parser.add_argument("--html-theme", help="HTML 导出使用的版式主题")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    project_dir = workspace_articles_dir(args.workspace_root) / args.project
    manifest = update_run_manifest(
        project_dir=project_dir,
        body_file=args.body,
        notes_file=args.notes,
        status=args.status,
        workflow_version=args.workflow_version,
        clean_source_file=args.clean_source,
        html_file=args.html,
        html_source_file=args.html_source,
        html_theme=args.html_theme,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
