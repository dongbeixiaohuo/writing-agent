"""
bootstrap_workspace.py - 为 plugin 用户在当前工作区补齐最小运行目录。
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_SOURCE_ROOT = SCRIPT_DIR.parent
if str(PROJECT_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_SOURCE_ROOT))

from scripts.claude_runtime_paths import resolve_runtime_root, resolve_workspace_root


def _copy_tree(src: Path, dst: Path) -> None:
    if not src.exists():
        return

    for source_path in src.rglob("*"):
        if "__pycache__" in source_path.parts or source_path.suffix == ".pyc":
            continue
        relative = source_path.relative_to(src)
        target_path = dst / relative
        if source_path.is_dir():
            target_path.mkdir(parents=True, exist_ok=True)
            continue
        target_path.parent.mkdir(parents=True, exist_ok=True)
        if target_path.exists():
            continue
        shutil.copy2(source_path, target_path)


def _sync_managed_tree(src: Path, dst: Path) -> None:
    """精确刷新插件自有数据目录；该目录不承载用户文件。"""
    dst.mkdir(parents=True, exist_ok=True)
    source_files = {
        path.relative_to(src)
        for path in src.rglob("*")
        if path.is_file() and "__pycache__" not in path.parts and path.suffix != ".pyc"
    }
    target_files = {
        path.relative_to(dst)
        for path in dst.rglob("*")
        if path.is_file()
    }

    for relative in source_files:
        source_path = src / relative
        target_path = dst / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = target_path.with_name(f".{target_path.name}.tmp")
        temporary_path.unlink(missing_ok=True)
        shutil.copy2(source_path, temporary_path)
        temporary_path.replace(target_path)

    for relative in target_files - source_files:
        (dst / relative).unlink(missing_ok=True)

    for target_dir in sorted(
        (path for path in dst.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        try:
            target_dir.rmdir()
        except OSError:
            pass


def _dependency_digest(runtime_root: Path) -> str:
    digest = hashlib.sha256()
    for filename in ("package.json", "package-lock.json"):
        manifest = runtime_root / filename
        if not manifest.is_file():
            raise FileNotFoundError(f"插件运行时缺少依赖清单: {manifest}")
        digest.update(filename.encode("utf-8"))
        digest.update(b"\0")
        digest.update(manifest.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _atomic_copy(source: Path, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.tmp")
    temporary.unlink(missing_ok=True)
    shutil.copy2(source, temporary)
    temporary.replace(target)


def prepare_plugin_runtime(
    runtime_root: Path,
    plugin_data: Path,
    *,
    command_runner=subprocess.run,
) -> Path:
    """把可执行脚本与依赖安装到持久的 CLAUDE_PLUGIN_DATA。"""
    runtime_root = runtime_root.resolve()
    plugin_data = plugin_data.resolve()
    plugin_data.mkdir(parents=True, exist_ok=True)

    _sync_managed_tree(runtime_root / "scripts", plugin_data / "runtime" / "scripts")
    expected_digest = _dependency_digest(runtime_root)
    stamp_path = plugin_data / ".writing-agent-dependencies.sha256"
    current_digest = stamp_path.read_text(encoding="utf-8").strip() if stamp_path.exists() else ""
    if current_digest == expected_digest:
        return plugin_data / "runtime"

    for filename in ("package.json", "package-lock.json"):
        _atomic_copy(runtime_root / filename, plugin_data / filename)

    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("未找到 npm，无法安装 Writing Agent 插件运行时依赖")
    stamp_path.unlink(missing_ok=True)
    command_runner(
        [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
        cwd=plugin_data,
        check=True,
    )
    stamp_path.write_text(expected_digest + "\n", encoding="utf-8")
    return plugin_data / "runtime"


def bootstrap_workspace(
    workspace_root: Path,
    runtime_root: Path,
    *,
    include_scripts: bool = True,
) -> list[Path]:
    created: list[Path] = []

    articles_dir = workspace_root / "articles"
    articles_dir.mkdir(parents=True, exist_ok=True)
    created.append(articles_dir)

    _copy_tree(runtime_root / "styles", workspace_root / ".claude" / "styles")
    _copy_tree(runtime_root / "workflows", workspace_root / ".claude" / "workflows")
    if include_scripts:
        _copy_tree(runtime_root / "scripts", workspace_root / "scripts")

    return created


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="为当前工作区补齐 Writing Agent 最小运行目录")
    parser.add_argument("--workspace-root", help="工作区根目录，默认当前目录")
    parser.add_argument("--runtime-root", help="运行时根目录，默认自动推导")
    parser.add_argument(
        "--plugin-data",
        help="Claude 插件持久数据目录；提供时会刷新脚本并按锁文件安装依赖",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()
    workspace_root = resolve_workspace_root(args.workspace_root)
    runtime_root = resolve_runtime_root(
        runtime_root=args.runtime_root,
        workspace_root=workspace_root,
        script_file=__file__,
    )
    created = bootstrap_workspace(
        workspace_root,
        runtime_root,
        include_scripts=not bool(args.plugin_data),
    )
    if args.plugin_data:
        plugin_runtime = prepare_plugin_runtime(runtime_root, Path(args.plugin_data))
        created.append(plugin_runtime)
    for path in created:
        print(f"READY {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
