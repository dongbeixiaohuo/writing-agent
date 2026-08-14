"""
verify_required_files.py - 校验项目阶段必需产物是否已真实落盘且非空。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_SOURCE_ROOT = SCRIPT_DIR.parent
if str(PROJECT_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_SOURCE_ROOT))

from scripts.claude_runtime_paths import workspace_articles_dir


ARTICLES_DIR = workspace_articles_dir()
DEFAULT_WORKFLOW = Path(".claude/workflows/collab_v2.json")


def theme_file_has_confirmed_style(content: str) -> bool:
    style_match = re.search(
        r"\|\s*\*{0,2}写作风格\*{0,2}\s*\|\s*([^|\r\n]+)\|",
        content,
    )
    if not style_match:
        return False

    style_value = style_match.group(1).strip().strip("*")
    if not style_value or any(marker in style_value for marker in ("待定", "未确认", "[风格")):
        return False

    compact = re.sub(r"\s+", "", content)
    return any(
        marker in compact
        for marker in (
            "风格确认状态：用户已确认",
            "风格确认状态:用户已确认",
            "用户已显式确认风格选择",
            "无指定风格（用户确认）",
            "无指定风格(用户确认)",
        )
    )


def title_file_is_locked(content: str) -> bool:
    lines = content.splitlines()
    selection_locked = False
    final_title_found = False

    for raw_line in lines:
        normalized = raw_line.strip().replace("**", "")
        if "选择状态" in normalized:
            selection_locked = "已锁定" in normalized and "待定" not in normalized
        if "最终标题" in normalized and ("：" in normalized or ":" in normalized):
            value = re.split(r"[:：]", normalized, maxsplit=1)[1].strip().strip("*").strip()
            final_title_found = bool(value and "待定" not in value and "[" not in value)

    if not final_title_found:
        for index, raw_line in enumerate(lines):
            if "## 最终标题" not in raw_line:
                continue

            for candidate in lines[index + 1 : index + 7]:
                stripped = candidate.strip()
                if not stripped:
                    continue
                normalized = stripped.replace("**", "")
                if "待定" in normalized:
                    break
                if "「" in normalized and "」" in normalized:
                    final_title_found = True
                    break

    return selection_locked and final_title_found


def distribution_copy_is_locked_if_declared(content: str) -> bool:
    if "平台分发文案候选" not in content:
        return True

    selection_value = ""
    final_value = ""
    for raw_line in content.splitlines():
        normalized = raw_line.strip().replace("**", "")
        if "分发文案选择" in normalized and ("：" in normalized or ":" in normalized):
            selection_value = re.split(r"[:：]", normalized, maxsplit=1)[1].strip()
        if "最终分发文案" in normalized and ("：" in normalized or ":" in normalized):
            final_value = re.split(r"[:：]", normalized, maxsplit=1)[1].strip()

    pending_markers = ("待定", "[候选", "[公众号", "[最终")
    return bool(
        selection_value
        and final_value
        and not any(marker in selection_value for marker in pending_markers)
        and not any(marker in final_value for marker in pending_markers)
    )


def opening_file_is_locked(content: str) -> bool:
    locked = "已锁定" in content or "锁定起手钩子" in content
    selected = re.search(
        r"(?:选择|赛马获胜方案)\s*[：:]\s*(?:A|B|C|自定义)(?:\b|\s|[-—–（(])",
        content,
        flags=re.IGNORECASE,
    )
    body_lines = [
        line.strip()
        for line in content.splitlines()
        if line.strip()
        and not line.lstrip().startswith(("#", ">", "```"))
        and line.strip() not in {"---", "***"}
    ]
    body = "".join(body_lines)
    placeholder = "[用户选定" in body or "此处输出" in body
    return locked and selected is not None and len(body) >= 50 and not placeholder


EVIDENCE_REQUIRED_FIELDS = (
    "evidence_id",
    "claim_type",
    "claim_text",
    "source_title",
    "source_publisher",
    "source_quote",
    "accessed_at",
    "reliability",
    "use_boundary",
    "verification_status",
)


def evidence_ledger_issue(content: str) -> str | None:
    try:
        ledger = json.loads(content)
    except json.JSONDecodeError:
        return "invalid_json"

    if not isinstance(ledger, dict) or not isinstance(ledger.get("claims"), list):
        return "invalid_evidence_ledger"

    claims = ledger["claims"]
    if not claims:
        notes = ledger.get("notes")
        return None if isinstance(notes, str) and notes.strip() else "invalid_evidence_ledger"

    seen_ids: set[str] = set()
    for claim in claims:
        if not isinstance(claim, dict):
            return "invalid_evidence_ledger"
        if any(not isinstance(claim.get(field), str) or not claim[field].strip() for field in EVIDENCE_REQUIRED_FIELDS):
            return "invalid_evidence_ledger"

        evidence_id = claim["evidence_id"].strip()
        if not re.fullmatch(r"E\d{3,}", evidence_id):
            return "invalid_evidence_ledger"
        if evidence_id in seen_ids:
            return "duplicate_evidence_id"
        seen_ids.add(evidence_id)

        if claim["reliability"].strip().lower() not in {"high", "medium", "low"}:
            return "invalid_evidence_ledger"

        source_url = claim.get("source_url")
        if source_url is not None:
            if not isinstance(source_url, str):
                return "invalid_evidence_ledger"
            parsed = urlparse(source_url)
            if parsed.scheme not in {"http", "https"} or not parsed.netloc:
                return "invalid_evidence_ledger"

    return None


def semantic_file_issue(file_name: str, content: str) -> str | None:
    if file_name == "01_theme.md" and not theme_file_has_confirmed_style(content):
        return "unconfirmed_style"
    if file_name == "02_evidence_ledger.json":
        return evidence_ledger_issue(content)
    if file_name == "04_title.md":
        if not title_file_is_locked(content):
            return "unlocked_title"
        if not distribution_copy_is_locked_if_declared(content):
            return "unlocked_distribution_copy"
    if file_name == "05c_opening_hook.md" and not opening_file_is_locked(content):
        return "unlocked_opening"
    return None


def find_file_issues(
    project_dir: Path,
    required_files: list[str],
    *,
    presence_only: bool = False,
) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []

    for file_name in required_files:
        target = project_dir / file_name
        if not target.exists():
            issues.append({"file": file_name, "reason": "missing"})
            continue

        if not target.is_file():
            issues.append({"file": file_name, "reason": "empty"})
            continue

        try:
            content = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            issues.append({"file": file_name, "reason": "invalid_encoding"})
            continue
        if not content.strip():
            issues.append({"file": file_name, "reason": "empty"})
            continue

        if not presence_only:
            reason = semantic_file_issue(file_name, content)
            if reason:
                issues.append({"file": file_name, "reason": reason})

    return issues


def verify_required_files(
    project_dir: Path,
    required_files: list[str],
    *,
    presence_only: bool = False,
) -> bool:
    return not find_file_issues(project_dir, required_files, presence_only=presence_only)


def _resolve_dynamic_inputs(project_dir: Path, required_files: list[str]) -> list[str]:
    placeholders = [item for item in required_files if item.startswith("[") and item.endswith("]")]
    if not placeholders:
        return required_files

    manifest_path = project_dir / "run_manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ValueError(f"动态输入需要 run_manifest.json: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError("run_manifest.json 不是有效 JSON") from exc
    if not isinstance(manifest, dict):
        raise ValueError("run_manifest.json 顶层必须是对象")

    resolved_inputs: list[str] = []
    project_root = project_dir.resolve()
    for item in required_files:
        if not (item.startswith("[") and item.endswith("]")):
            resolved_inputs.append(item)
            continue

        manifest_key = item[1:-1]
        if manifest_key != "latest_body_file":
            raise ValueError(f"不支持的动态输入占位符: {item}")
        value = manifest.get(manifest_key)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"run_manifest.json 缺少有效字段 {manifest_key}")

        candidate = Path(value)
        if candidate.is_absolute():
            raise ValueError(f"动态输入必须是项目内相对路径: {value}")
        resolved = (project_root / candidate).resolve()
        try:
            resolved.relative_to(project_root)
        except ValueError as exc:
            raise ValueError(f"动态输入越出项目目录: {value}") from exc
        resolved_inputs.append(candidate.as_posix())

    return resolved_inputs


def required_files_for_stage(
    workflow_path: Path,
    stage_id: str,
    mode: str,
    *,
    project_dir: Path | None = None,
) -> list[str]:
    contract = json.loads(workflow_path.read_text(encoding="utf-8"))
    normalized_stage_id = str(stage_id)
    stage = next(
        (item for item in contract.get("stages", []) if str(item.get("id")) == normalized_stage_id),
        None,
    )
    if stage is None:
        raise ValueError(f"工作流中不存在 Stage {normalized_stage_id}")

    required_files = list(stage.get("inputs", []))
    mode_contract = contract.get("modes", {}).get(mode, {})
    override = mode_contract.get("stage_overrides", {}).get(normalized_stage_id, {})
    if "inputs" in override:
        required_files = list(override["inputs"])
    if any(item.startswith("[") and item.endswith("]") for item in required_files):
        if project_dir is None:
            raise ValueError("解析动态阶段输入时必须提供 project_dir")
        required_files = _resolve_dynamic_inputs(project_dir, required_files)
    return required_files


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="校验项目目录中的阶段产物是否存在且非空")
    parser.add_argument("--workspace-root", help="工作区根目录，默认当前目录")
    parser.add_argument("--project", help="articles/ 下的项目目录名")
    parser.add_argument("--project-dir", help="项目绝对路径或相对路径")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--required", nargs="+", help="显式必需文件名列表")
    source.add_argument("--stage", help="从工作流契约读取该 Stage 的 inputs")
    parser.add_argument("--workflow", default=str(DEFAULT_WORKFLOW), help="工作流 JSON 路径")
    parser.add_argument("--mode", default="B", help="工作流模式，默认 B")
    parser.add_argument(
        "--presence-only",
        action="store_true",
        help="只校验文件已落盘且非空，不执行主题/标题/开头/证据账本语义门禁",
    )
    return parser


def resolve_project_dir(args: argparse.Namespace) -> Path:
    if args.project_dir:
        return Path(args.project_dir).resolve()
    if args.project:
        return (workspace_articles_dir(args.workspace_root) / args.project).resolve()
    raise SystemExit("必须提供 --project 或 --project-dir")


def main() -> int:
    args = build_parser().parse_args()
    project_dir = resolve_project_dir(args)
    try:
        required_files = args.required or required_files_for_stage(
            Path(args.workflow).resolve(),
            args.stage,
            args.mode,
            project_dir=project_dir,
        )
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"FAIL: 无法读取阶段契约：{exc}", file=sys.stderr)
        return 2

    issues = find_file_issues(project_dir, required_files, presence_only=args.presence_only)

    if issues:
        print(json.dumps({"project_dir": str(project_dir), "issues": issues}, ensure_ascii=False, indent=2))
        print("FAIL: 存在缺失、空文件、编码错误或语义门禁未通过")
        return 1

    print(
        json.dumps(
            {
                "project_dir": str(project_dir),
                "required": required_files,
                "stage": args.stage,
                "mode": args.mode if args.stage else None,
                "presence_only": args.presence_only,
                "status": "ok",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print("PASS: 必需产物已落盘并通过当前门禁")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
