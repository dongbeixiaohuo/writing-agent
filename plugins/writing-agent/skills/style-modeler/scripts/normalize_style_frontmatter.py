#!/usr/bin/env python3
"""Normalize legacy style files by ensuring YAML front matter exists."""

from __future__ import annotations

import argparse
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path


METADATA_PATTERNS = (
    re.compile(r"^\*\*作者\*\*[:：]\s*(.+?)\s*$"),
    re.compile(r"^\*\*公众号\*\*[:：]\s*(.+?)\s*$"),
    re.compile(r"^\*\*样本数量\*\*[:：]\s*(\d+)"),
    re.compile(r"^\*\*(创建时间|更新时间)\*\*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$"),
)


@dataclass
class FrontMatter:
    author: str
    source_count: int | None
    last_updated: str


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    if not text.startswith("---\n"):
        return {}, text

    end = text.find("\n---\n", 4)
    if end == -1:
        return {}, text

    raw = text[4:end]
    body = text[end + 5 :]
    data: dict[str, str] = {}
    for line in raw.splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"')
    return data, body


def extract_author(body: str, fallback: str) -> str:
    match = re.search(r"^\*\*作者\*\*[:：]\s*(.+?)\s*$", body, re.MULTILINE)
    if match:
        return match.group(1).strip()

    title_match = re.search(r"^#\s*风格名称[:：]\s*(.+?)\s*$", body, re.MULTILINE)
    if title_match:
        title = title_match.group(1).strip()
        bracket_match = re.search(r"[（(]([^()（）]+)[）)]", title)
        if bracket_match:
            return bracket_match.group(1).strip()
        title = re.sub(r"(风格|风)$", "", title).strip()
        return title or fallback

    return fallback


def extract_source_count(body: str) -> int | None:
    match = re.search(r"^\*\*样本数量\*\*[:：]\s*(\d+)", body, re.MULTILINE)
    return int(match.group(1)) if match else None


def extract_last_updated(body: str, default_date: str) -> str:
    match = re.search(r"^\*\*(创建时间|更新时间)\*\*[:：]\s*(\d{4}-\d{2}-\d{2})\s*$", body, re.MULTILINE)
    return match.group(2) if match else default_date


def strip_legacy_header_metadata(body: str) -> str:
    lines = body.splitlines()
    if not lines:
        return body

    result: list[str] = []
    index = 0

    while index < len(lines) and lines[index].strip() == "":
        index += 1

    if index < len(lines) and lines[index].startswith("# "):
        result.append(lines[index])
        index += 1

    while index < len(lines) and lines[index].strip() == "":
        result.append(lines[index])
        index += 1

    if index < len(lines) and lines[index].strip() == "---":
        index += 1
        while index < len(lines) and lines[index].strip() == "":
            index += 1

    metadata_found = False
    while index < len(lines):
        line = lines[index]
        if any(pattern.match(line) for pattern in METADATA_PATTERNS):
            metadata_found = True
            index += 1
            continue
        if metadata_found and line.strip() in {"", "---"}:
            index += 1
            continue
        break

    result.extend(lines[index:])
    normalized = "\n".join(result).strip() + "\n"
    return normalized


def build_frontmatter(meta: FrontMatter) -> str:
    source_count = "null" if meta.source_count is None else str(meta.source_count)
    author = meta.author.replace('"', '\\"')
    return (
        "---\n"
        f'author: "{author}"\n'
        f"source_count: {source_count}\n"
        f"last_updated: {meta.last_updated}\n"
        "---\n\n"
    )


def normalize_file(
    path: Path,
    default_date: str,
    refresh_existing: bool,
    dry_run: bool = False,
) -> bool:
    original = path.read_text(encoding="utf-8")
    existing_meta, body = parse_frontmatter(original)
    body_author = extract_author(body, path.stem)
    author = body_author if refresh_existing or not existing_meta.get("author") else existing_meta.get("author")
    source_count_raw = existing_meta.get("source_count")
    body_source_count = extract_source_count(body)
    if refresh_existing and body_source_count is not None:
        source_count = body_source_count
    else:
        source_count = int(source_count_raw) if source_count_raw and source_count_raw.isdigit() else body_source_count
    last_updated = (
        default_date
        if refresh_existing
        else existing_meta.get("last_updated") or extract_last_updated(body, default_date)
    )
    clean_body = strip_legacy_header_metadata(body)

    normalized = build_frontmatter(
        FrontMatter(author=author, source_count=source_count, last_updated=last_updated)
    ) + clean_body

    if normalized == original:
        return False

    if dry_run:
        return True

    temporary_path = path.with_suffix(path.suffix + ".tmp")
    temporary_path.write_text(normalized, encoding="utf-8")
    temporary_path.replace(path)
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize style front matter.")
    parser.add_argument(
        "paths",
        nargs="*",
        help="Style files or directories. Defaults to .claude/styles",
    )
    parser.add_argument(
        "--date",
        default=str(date.today()),
        help="Fallback last_updated date in YYYY-MM-DD format.",
    )
    parser.add_argument(
        "--refresh-existing",
        action="store_true",
        help="Refresh author and source_count from legacy body metadata when possible.",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Report files that would change without rewriting them.",
    )
    args = parser.parse_args()

    targets = [Path(p) for p in args.paths] if args.paths else [Path(".claude/styles")]
    files: list[Path] = []
    for target in targets:
        if target.is_dir():
            files.extend(sorted(target.glob("*.md")))
        elif target.is_file():
            files.append(target)

    changed = 0
    for file_path in files:
        if normalize_file(file_path, args.date, args.refresh_existing, dry_run=args.check):
            changed += 1
            action = "would normalize" if args.check else "normalized"
            print(f"{action}: {file_path}")

    suffix = "would be updated" if args.check else "updated"
    print(f"done: {changed}/{len(files)} files {suffix}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
