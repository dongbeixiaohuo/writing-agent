"""
check_claude_runtime_sync.py - 检查 claude-runtime 与消费端目录是否精确同步。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True

try:
    from scripts.sync_claude_runtime import generated_files, render_target_bytes
except ModuleNotFoundError:
    from sync_claude_runtime import generated_files, render_target_bytes


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_CONTAINER = SCRIPT_DIR.parent
PROJECT_ROOT = SCRIPT_CONTAINER.parent if SCRIPT_CONTAINER.name == "claude-runtime" else SCRIPT_CONTAINER

SYNC_TARGETS = {
    "agents": [Path(".claude/agents"), Path("plugins/writing-agent/agents")],
    "skills": [Path(".claude/skills"), Path("plugins/writing-agent/skills")],
    "styles": [Path(".claude/styles"), Path("plugins/writing-agent/styles")],
    "workflows": [Path(".claude/workflows"), Path("plugins/writing-agent/workflows")],
    "scripts": [Path("scripts"), Path("plugins/writing-agent/scripts")],
    "templates": [Path("plugins/writing-agent/templates")],
}


def _is_ignored(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix == ".pyc"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _relative_files(root: Path, *, exclude_caches: bool) -> set[Path]:
    if not root.exists():
        return set()
    return {
        path.relative_to(root)
        for path in root.rglob("*")
        if path.is_file() and (not exclude_caches or not _is_ignored(path))
    }


def _check_package_version(project_root: Path) -> list[str]:
    package_path = project_root / "package.json"
    lock_path = project_root / "package-lock.json"
    if not package_path.exists() or not lock_path.exists():
        return []

    package = json.loads(package_path.read_text(encoding="utf-8"))
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    expected = package.get("version")
    locked_versions = (lock.get("version"), lock.get("packages", {}).get("", {}).get("version"))
    if locked_versions != (expected, expected):
        return ["changed: package-lock.json version"]
    return []


def find_runtime_drift(project_root: Path = PROJECT_ROOT) -> list[str]:
    runtime_root = project_root / "claude-runtime"
    drift: list[str] = []

    for directory, targets in SYNC_TARGETS.items():
        source_dir = runtime_root / directory
        source_files = _relative_files(source_dir, exclude_caches=True)

        for target_root in targets:
            target_dir = project_root / target_root
            target_kind = "plugin" if target_root.parts[:2] == ("plugins", "writing-agent") else "clone"
            target_files = _relative_files(target_dir, exclude_caches=False)
            for relative in sorted(source_files - target_files):
                drift.append(f"missing: {target_root.as_posix()}/{relative.as_posix()}")
            for relative in sorted(target_files - source_files):
                drift.append(f"extra: {target_root.as_posix()}/{relative.as_posix()}")
            for relative in sorted(source_files & target_files):
                expected = render_target_bytes(source_dir / relative, target_kind)
                if _sha256_bytes(expected) != _sha256(target_dir / relative):
                    drift.append(f"changed: {target_root.as_posix()}/{relative.as_posix()}")

    for target, expected in generated_files(project_root).items():
        relative = target.relative_to(project_root).as_posix()
        if not target.exists():
            drift.append(f"missing: {relative}")
        elif target.read_text(encoding="utf-8") != expected:
            drift.append(f"changed: {relative}")

    drift.extend(_check_package_version(project_root))
    return drift


def main() -> int:
    drift = find_runtime_drift(PROJECT_ROOT)
    if drift:
        for item in drift:
            print(item)
        print(f"FAIL: 共 {len(drift)} 处漂移")
        return 1

    print("PASS: claude-runtime 与消费端目录一致")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
