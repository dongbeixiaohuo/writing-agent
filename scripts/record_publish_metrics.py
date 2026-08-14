"""Append a version-bound publication metrics record to a writing project."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_SOURCE_ROOT = SCRIPT_DIR.parent
if str(PROJECT_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_SOURCE_ROOT))

from scripts.claude_runtime_paths import workspace_articles_dir


METRICS_FILE = "publication_metrics.jsonl"
ALLOWED_METRIC_FIELDS = (
    "impressions",
    "opens",
    "complete_reads",
    "shares",
    "comments",
    "saves",
    "likes",
    "new_followers",
    "avg_read_seconds",
)
PENDING_METADATA_VALUES = ("待定", "等待用户", "未选择", "pending")


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
    if not resolved.is_dir():
        raise ValueError(f"项目目录不存在: {project_dir}")
    return resolved


def _project_file(project_dir: Path, value: str, field: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute():
        raise ValueError(f"{field} 必须是项目内相对路径: {value}")
    resolved = (project_dir / candidate).resolve()
    if resolved == project_dir or not _is_within(resolved, project_dir):
        raise ValueError(f"{field} 必须位于项目目录内: {value}")
    if not resolved.is_file():
        raise ValueError(f"{field} 对应文件不存在: {value}")
    return resolved


def _clean_metadata_value(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip().strip("| ").replace("**", "").replace("`", "").strip()
    cleaned = cleaned.strip("「」『』\"'")
    if not cleaned or any(marker.casefold() in cleaned.casefold() for marker in PENDING_METADATA_VALUES):
        return None
    return cleaned


def _extract_labeled_value(content: str, *labels: str) -> str | None:
    for label in labels:
        escaped = re.escape(label)
        line_match = re.search(
            rf"(?mi)^\s*(?:>\s*|-\s*)?(?:\*\*)?{escaped}(?:\*\*)?\s*[：:]\s*(.+?)\s*$",
            content,
        )
        if line_match:
            return _clean_metadata_value(line_match.group(1))
        table_match = re.search(
            rf"(?mi)^\s*\|\s*(?:\*\*)?{escaped}(?:\*\*)?\s*\|\s*(.*?)\s*\|\s*$",
            content,
        )
        if table_match:
            return _clean_metadata_value(table_match.group(1))
    return None


def _selected_variant(value: str | None, allowed: str) -> str | None:
    if value is None:
        return None
    custom = re.search(r"自定义", value, flags=re.IGNORECASE)
    if custom:
        return "自定义"
    match = re.search(rf"(?<![A-Za-z])([{allowed}])(?![A-Za-z])", value, flags=re.IGNORECASE)
    return match.group(1).upper() if match else None


def _title_formula(content: str, selected_candidate: str | None) -> str | None:
    if selected_candidate is None or selected_candidate == "自定义":
        return None
    lines = content.splitlines()
    marker = re.compile(
        rf"^\s*(?:#+\s*)?(?:\S+\s+)?{re.escape(selected_candidate)}(?:[.．、\s]|【|$)",
        flags=re.IGNORECASE,
    )
    any_candidate = re.compile(
        r"^\s*(?:#+\s*)?(?:\S+\s+)?[A-H](?:[.．、\s]|【|$)",
        flags=re.IGNORECASE,
    )
    in_selected_block = False
    for line in lines:
        if marker.search(line):
            in_selected_block = True
            continue
        if in_selected_block and any_candidate.search(line):
            break
        if in_selected_block:
            formula = _extract_labeled_value(line, "公式")
            if formula:
                return formula
    return None


def _optional_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _metadata_source(project_dir: Path, path: Path) -> dict | None:
    if not path.is_file():
        return None
    return {
        "file": path.relative_to(project_dir).as_posix(),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def extract_creative_metadata(
    project_dir: Path,
    title_path: Path,
    *,
    platform: str,
) -> dict:
    """Snapshot normalized creative choices without requiring legacy projects to backfill them."""
    opening_path = project_dir / "05c_opening_hook.md"
    share_path = project_dir / "04_share_map.md"
    theme_path = project_dir / "01_theme.md"

    title_content = _optional_text(title_path)
    opening_content = _optional_text(opening_path)
    share_content = _optional_text(share_path)
    theme_content = _optional_text(theme_path)

    selected_candidate = _selected_variant(
        _extract_labeled_value(title_content, "最终编号", "用户选择", "选择"),
        "ABCDEFGH",
    )
    opening_variant = _selected_variant(
        _extract_labeled_value(opening_content, "胜出方案", "最终选择", "用户选择", "选择"),
        "ABC",
    )

    source_paths = {
        "title": title_path,
        "opening": opening_path,
        "share_map": share_path,
        "theme": theme_path,
    }
    sources = {
        name: source
        for name, path in source_paths.items()
        if (source := _metadata_source(project_dir, path)) is not None
    }

    return {
        "schema_version": "1.0",
        "platform": platform,
        "title": {
            "selected_candidate": selected_candidate,
            "formula": _title_formula(title_content, selected_candidate),
        },
        "opening": {"selected_variant": opening_variant},
        "share": {
            "primary_motive": _extract_labeled_value(
                share_content,
                "主导社交货币",
                "终极分享引擎",
            )
        },
        "style": {
            "name": _extract_labeled_value(theme_content, "写作风格"),
            "verification_status": _extract_labeled_value(theme_content, "风格证据状态"),
        },
        "sources": sources,
    }


def _required_text(payload: dict, field: str) -> str:
    value = payload.get(field)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} 必须是非空字符串")
    return value.strip()


def _aware_datetime(value: str, field: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{field} 必须是 ISO 8601 时间") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError(f"{field} 必须包含时区偏移")
    return parsed


def _validate_metric_value(field: str, value: object) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"metrics.{field} 必须是非负数或 null")
    if value < 0:
        raise ValueError(f"metrics.{field} 不能为负数")
    return value


def _normalize_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("指标输入顶层必须是对象")

    platform = _required_text(payload, "platform")
    published_at = _required_text(payload, "published_at")
    observed_at = _required_text(payload, "observed_at")
    observation_window = _required_text(payload, "observation_window")
    published_time = _aware_datetime(published_at, "published_at")
    observed_time = _aware_datetime(observed_at, "observed_at")
    if observed_time < published_time:
        raise ValueError("observed_at 不能早于 published_at")

    traffic_sources = payload.get("traffic_sources")
    if (
        not isinstance(traffic_sources, list)
        or not traffic_sources
        or any(not isinstance(item, str) or not item.strip() for item in traffic_sources)
    ):
        raise ValueError("traffic_sources 必须是非空字符串数组")

    metrics = payload.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("metrics 必须是对象")
    unknown_fields = set(metrics) - set(ALLOWED_METRIC_FIELDS)
    if unknown_fields:
        raise ValueError(f"metrics 包含未知字段: {', '.join(sorted(unknown_fields))}")
    for required_field in ("impressions", "opens"):
        if required_field not in metrics:
            raise ValueError(f"metrics 必须包含 {required_field}；未知时传 null")

    normalized_metrics = {
        field: _validate_metric_value(field, metrics.get(field))
        for field in ALLOWED_METRIC_FIELDS
        if field in metrics
    }
    impressions = normalized_metrics.get("impressions")
    opens = normalized_metrics.get("opens")
    complete_reads = normalized_metrics.get("complete_reads")
    if impressions is not None and opens is not None and opens > impressions:
        raise ValueError("metrics.opens 不能大于 metrics.impressions")
    if opens is not None and complete_reads is not None and complete_reads > opens:
        raise ValueError("metrics.complete_reads 不能大于 metrics.opens")

    cover_ref = payload.get("cover_ref")
    if cover_ref is not None and (not isinstance(cover_ref, str) or not cover_ref.strip()):
        raise ValueError("cover_ref 必须是非空字符串或 null")
    notes = payload.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise ValueError("notes 必须是字符串或 null")
    publication_url = payload.get("publication_url")
    if publication_url is not None and (
        not isinstance(publication_url, str) or not publication_url.strip()
    ):
        raise ValueError("publication_url 必须是非空字符串或 null")

    return {
        "platform": platform,
        "published_at": published_at,
        "observed_at": observed_at,
        "observation_window": observation_window,
        "traffic_sources": [item.strip() for item in traffic_sources],
        "cover_ref": cover_ref.strip() if isinstance(cover_ref, str) else None,
        "publication_url": publication_url.strip() if isinstance(publication_url, str) else None,
        "metrics": normalized_metrics,
        "notes": notes,
    }


def _derived_metrics(metrics: dict) -> dict[str, float]:
    derived: dict[str, float] = {}
    impressions = metrics.get("impressions")
    opens = metrics.get("opens")
    complete_reads = metrics.get("complete_reads")
    if impressions not in (None, 0) and opens is not None:
        derived["open_rate"] = round(opens / impressions, 6)
    if opens not in (None, 0) and complete_reads is not None:
        derived["completion_rate"] = round(complete_reads / opens, 6)
    return derived


def _validate_existing_jsonl(metrics_path: Path) -> None:
    if not metrics_path.exists():
        return
    for line_number, raw_line in enumerate(metrics_path.read_text(encoding="utf-8").splitlines(), start=1):
        if not raw_line.strip():
            continue
        try:
            record = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"{METRICS_FILE} 第 {line_number} 行不是有效 JSON") from exc
        if not isinstance(record, dict):
            raise ValueError(f"{METRICS_FILE} 第 {line_number} 行必须是对象")


def record_publish_metrics(
    project_dir: Path,
    body_file: str,
    title_file: str,
    payload: dict,
    *,
    recorded_at: str | None = None,
) -> dict:
    project_dir = _validate_project_dir(project_dir)
    body_path = _project_file(project_dir, body_file, "body_file")
    title_path = _project_file(project_dir, title_file, "title_file")
    normalized = _normalize_payload(payload)

    recorded_at_value = recorded_at or datetime.now().astimezone().isoformat(timespec="seconds")
    _aware_datetime(recorded_at_value, "recorded_at")
    record = {
        "schema_version": "1.0",
        "record_id": str(uuid.uuid4()),
        "recorded_at": recorded_at_value,
        "platform": normalized["platform"],
        "published_at": normalized["published_at"],
        "observed_at": normalized["observed_at"],
        "observation_window": normalized["observation_window"],
        "traffic_sources": normalized["traffic_sources"],
        "artifacts": {
            "body_file": body_file,
            "body_sha256": hashlib.sha256(body_path.read_bytes()).hexdigest(),
            "title_file": title_file,
            "title_sha256": hashlib.sha256(title_path.read_bytes()).hexdigest(),
            "cover_ref": normalized["cover_ref"],
        },
        "publication_url": normalized["publication_url"],
        "creative_metadata": extract_creative_metadata(
            project_dir,
            title_path,
            platform=normalized["platform"],
        ),
        "metrics": normalized["metrics"],
        "derived_metrics": _derived_metrics(normalized["metrics"]),
        "notes": normalized["notes"],
    }

    metrics_path = project_dir / METRICS_FILE
    _validate_existing_jsonl(metrics_path)
    with metrics_path.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
    return record


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="追加记录发布后表现，并绑定标题/正文版本哈希")
    parser.add_argument("--workspace-root", help="工作区根目录，默认当前目录")
    parser.add_argument("--project", required=True, help="articles/ 下的项目目录名")
    parser.add_argument("--body", required=True, help="实际发布的正文文件名")
    parser.add_argument("--title", default="04_title.md", help="实际发布的标题文件名")
    parser.add_argument("--input", required=True, help="发布指标 JSON 输入文件")
    parser.add_argument("--recorded-at", help="记录时间；默认当前本地 ISO 时间")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    input_path = Path(args.input).resolve()
    try:
        payload = json.loads(input_path.read_text(encoding="utf-8"))
        project_dir = workspace_articles_dir(args.workspace_root) / args.project
        record = record_publish_metrics(
            project_dir,
            args.body,
            args.title,
            payload,
            recorded_at=args.recorded_at,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(record, ensure_ascii=False, indent=2))
    print(f"APPENDED: {project_dir / METRICS_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
