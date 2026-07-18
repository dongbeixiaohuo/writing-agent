"""
split_draft_notes.py - 将旧稿件中内嵌的内部备注拆分为独立 notes 文件

用途：
1. 兼容历史稿件，把 `draft_v*.md` 中的 `写作备注 / 修改记录` 块拆到独立文件
2. 让正文文件回归纯正文，不再混入内部维护信息

示例：
  python scripts/split_draft_notes.py articles/职场边界与协作智慧/draft_v1.md
  python scripts/split_draft_notes.py --all
  python scripts/split_draft_notes.py --all --dry-run
"""

from __future__ import annotations

import argparse
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_CONTAINER = SCRIPT_DIR.parent
PROJECT_ROOT = SCRIPT_CONTAINER.parent if SCRIPT_CONTAINER.name == "claude-runtime" else SCRIPT_CONTAINER
ARTICLES_DIR = PROJECT_ROOT / 'articles'
NOTE_HEADINGS = ('## 写作备注', '## 修改记录')


def is_draft_file(path: Path) -> bool:
    return path.suffix.lower() == '.md' and path.name.startswith('draft') and not path.stem.endswith('_notes')


def notes_path_for(draft_path: Path) -> Path:
    return draft_path.with_name(f'{draft_path.stem}_notes.md')


def find_note_start(lines: list[str]) -> int | None:
    for index, line in enumerate(lines):
        stripped = line.strip()
        if any(stripped.startswith(heading) for heading in NOTE_HEADINGS):
            return index
    return None


def trim_body_lines(lines: list[str]) -> list[str]:
    trimmed = list(lines)

    while trimmed and not trimmed[-1].strip():
        trimmed.pop()

    if trimmed and trimmed[-1].strip() in {'---', '***', '==='}:
        trimmed.pop()

    while trimmed and not trimmed[-1].strip():
        trimmed.pop()

    return trimmed


def split_draft_notes(text: str) -> tuple[str, str | None]:
    lines = text.splitlines()
    note_start = find_note_start(lines)

    if note_start is None:
        return text, None

    body_lines = trim_body_lines(lines[:note_start])
    note_lines = lines[note_start:]

    body_text = '\n'.join(body_lines).rstrip() + '\n'
    notes_text = '\n'.join(note_lines).rstrip() + '\n'
    return body_text, notes_text


def process_file(path: Path, dry_run: bool) -> str:
    original = path.read_text(encoding='utf-8')
    body_text, notes_text = split_draft_notes(original)

    if notes_text is None:
        return f'SKIP {path}（未发现内嵌备注）'

    note_path = notes_path_for(path)
    if dry_run:
        return f'DRY  {path} -> {note_path}'

    path.write_text(body_text, encoding='utf-8')
    note_path.write_text(notes_text, encoding='utf-8')
    return f'OK   {path} -> {note_path}'


def collect_targets(target: str | None, process_all: bool) -> list[Path]:
    if process_all:
        return sorted(path for path in ARTICLES_DIR.rglob('draft*.md') if is_draft_file(path))

    if not target:
        raise ValueError('未提供输入文件路径')

    path = Path(target)
    if not path.is_absolute():
        path = PROJECT_ROOT / path

    if not path.exists():
        raise FileNotFoundError(f'文件不存在：{path}')

    if not is_draft_file(path):
        raise ValueError(f'只支持 draft 正文文件，当前路径不符合约定：{path}')

    return [path]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='将 draft 正文中的内嵌备注拆分到独立 *_notes.md 文件。')
    parser.add_argument('target', nargs='?', help='要处理的 draft 文件路径')
    parser.add_argument('--all', action='store_true', help='批量处理 articles/ 下所有 draft 正文文件')
    parser.add_argument('--dry-run', action='store_true', help='只显示将要处理的文件，不实际写入')
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    targets = collect_targets(args.target, args.all)

    for target in targets:
        print(process_file(target, dry_run=args.dry_run))


if __name__ == '__main__':
    main()
