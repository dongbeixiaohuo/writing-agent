"""Compile Python source in memory without creating ``__pycache__`` files."""

from __future__ import annotations

import argparse
import tokenize
from pathlib import Path


def python_files(paths: list[Path]) -> list[Path]:
    files: set[Path] = set()
    for path in paths:
        if path.is_dir():
            files.update(
                candidate
                for candidate in path.rglob("*.py")
                if "__pycache__" not in candidate.parts
            )
        else:
            files.add(path)
    return sorted(files)


def check_syntax(paths: list[Path]) -> list[str]:
    errors: list[str] = []
    for path in python_files(paths):
        try:
            with tokenize.open(path) as source_file:
                source = source_file.read()
            compile(source, str(path), "exec")
        except (OSError, SyntaxError, UnicodeError) as exc:
            errors.append(f"{path}: {exc}")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="+", type=Path)
    args = parser.parse_args()

    errors = check_syntax(args.paths)
    if errors:
        for error in errors:
            print(error)
        return 1

    print(f"PASS: Python syntax ({len(python_files(args.paths))} files)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
