"""
sync_claude_runtime.py - 将 claude-runtime 同步到项目兼容层和插件目录。
"""

from __future__ import annotations

import copy
import json
import shutil
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SCRIPT_CONTAINER = SCRIPT_DIR.parent
PROJECT_ROOT = SCRIPT_CONTAINER.parent if SCRIPT_CONTAINER.name == "claude-runtime" else SCRIPT_CONTAINER

SYNC_DIRS = ("agents", "skills", "styles", "workflows", "scripts")
PLUGIN_EXTRA_DIRS = ("templates",)
# Keep the sentinel split so syncing this helper cannot rewrite its own constant.
SCRIPT_ROOT_TOKEN = b"{{WRITING_AGENT_" + b"SCRIPTS}}"


def _is_ignored(path: Path) -> bool:
    return "__pycache__" in path.parts or path.suffix == ".pyc"


def render_target_bytes(source_path: Path, target_kind: str) -> bytes:
    content = source_path.read_bytes()
    if SCRIPT_ROOT_TOKEN not in content:
        return content
    if target_kind == "plugin":
        replacement = b"${CLAUDE_PLUGIN_ROOT}/scripts"
    elif target_kind == "clone":
        replacement = b"scripts"
    else:
        raise ValueError(f"未知同步目标类型: {target_kind}")
    return content.replace(SCRIPT_ROOT_TOKEN, replacement)


def _sync_tree(src: Path, dst: Path, *, target_kind: str) -> None:
    if not src.exists():
        return

    dst.mkdir(parents=True, exist_ok=True)
    source_files = {
        source_path.relative_to(src)
        for source_path in src.rglob("*")
        if source_path.is_file() and not _is_ignored(source_path)
    }

    for relative in source_files:
        source_path = src / relative
        target_path = dst / relative
        target_path.parent.mkdir(parents=True, exist_ok=True)
        source_content = source_path.read_bytes()
        rendered = render_target_bytes(source_path, target_kind)
        if rendered == source_content:
            shutil.copy2(source_path, target_path)
        else:
            target_path.write_bytes(rendered)

    target_files = {
        target_path.relative_to(dst)
        for target_path in dst.rglob("*")
        if target_path.is_file()
    }
    for relative in target_files - source_files:
        (dst / relative).unlink()

    for target_dir in sorted(
        (path for path in dst.rglob("*") if path.is_dir()),
        key=lambda path: len(path.parts),
        reverse=True,
    ):
        try:
            target_dir.rmdir()
        except OSError:
            pass


def _load_package(project_root: Path) -> dict:
    package_json = project_root / "package.json"
    if not package_json.exists():
        return {}
    package = json.loads(package_json.read_text(encoding="utf-8"))
    if not isinstance(package, dict):
        raise ValueError(f"package.json 顶层必须是对象: {package_json}")
    return package


def _load_package_version(project_root: Path) -> str:
    return str(_load_package(project_root).get("version", "0.8.0"))


def render_json(payload: dict) -> str:
    return json.dumps(payload, ensure_ascii=False, indent=2) + "\n"


def build_plugin_hooks(runtime_root: Path) -> dict:
    hooks_source = runtime_root / "hooks" / "hooks.json"
    hooks = {"hooks": {}}
    if hooks_source.exists():
        loaded = json.loads(hooks_source.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError(f"hooks.json 顶层必须是对象: {hooks_source}")
        hooks = copy.deepcopy(loaded)

    for matchers in hooks.get("hooks", {}).values():
        for matcher in matchers:
            for hook in matcher.get("hooks", []):
                command = hook.get("command")
                if isinstance(command, str) and command.startswith("python scripts/"):
                    script = command.removeprefix("python scripts/")
                    hook["command"] = (
                        f'python "${{CLAUDE_PLUGIN_ROOT}}/scripts/{script}" '
                        '--workspace-root "${CLAUDE_PROJECT_DIR}"'
                    )

    session_start = {
        "hooks": [
            {
                "type": "command",
                "command": (
                    'python "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap_workspace.py" '
                    '--workspace-root "${CLAUDE_PROJECT_DIR}" '
                    '--runtime-root "${CLAUDE_PLUGIN_ROOT}" '
                    '--plugin-data "${CLAUDE_PLUGIN_DATA}"'
                ),
                "timeout": 180,
            }
        ]
    }
    hooks.setdefault("hooks", {})["SessionStart"] = [session_start]
    return hooks


def build_plugin_manifest(project_root: Path) -> dict:
    return {
        "name": "writing-agent",
        "version": _load_package_version(project_root),
        "displayName": "Writing Agent",
        "description": "可中断、可复盘的多阶段中文文章写作工作流",
        "author": {
            "name": "dongbeixiaohuo",
            "url": "https://github.com/dongbeixiaohuo",
        },
        "homepage": "https://github.com/dongbeixiaohuo/writing-agent",
        "repository": "https://github.com/dongbeixiaohuo/writing-agent",
        "license": "MIT",
        "keywords": ["claude-code", "writing", "workflow", "chinese"],
    }


def build_marketplace() -> dict:
    return {
        "name": "writing-agent-marketplace",
        "owner": {"name": "dongbeixiaohuo"},
        "description": "Writing Agent 的 Claude Code 插件市场",
        "plugins": [
            {
                "name": "writing-agent",
                "source": "./plugins/writing-agent",
                "description": "可中断、可复盘的多阶段中文文章写作工作流",
                "category": "Productivity",
            }
        ],
    }


def build_plugin_package(project_root: Path) -> dict:
    root_package = _load_package(project_root)
    dependencies = dict(root_package.get("dependencies", {}))
    tsx_version = root_package.get("devDependencies", {}).get("tsx")
    if tsx_version:
        dependencies["tsx"] = tsx_version

    return {
        "name": "writing-agent-plugin-runtime",
        "version": _load_package_version(project_root),
        "private": True,
        "type": "module",
        "engines": dict(root_package.get("engines", {"node": ">=18.17.0"})),
        "dependencies": dependencies,
    }


def build_plugin_lock(project_root: Path) -> dict:
    lock_path = project_root / "package-lock.json"
    if lock_path.exists():
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        if not isinstance(lock, dict):
            raise ValueError(f"package-lock.json 顶层必须是对象: {lock_path}")
        lock = copy.deepcopy(lock)
    else:
        lock = {"lockfileVersion": 3, "requires": True, "packages": {}}

    package = build_plugin_package(project_root)
    lock["name"] = package["name"]
    lock["version"] = package["version"]
    lock.setdefault("packages", {})[""] = {
        "name": package["name"],
        "version": package["version"],
        "dependencies": package["dependencies"],
        "engines": package["engines"],
    }
    return lock


def generated_files(project_root: Path) -> dict[Path, str]:
    runtime_root = project_root / "claude-runtime"
    plugin_root = project_root / "plugins" / "writing-agent"
    generated: dict[Path, str] = {
        plugin_root / "hooks" / "hooks.json": render_json(build_plugin_hooks(runtime_root)),
        plugin_root / ".claude-plugin" / "plugin.json": render_json(build_plugin_manifest(project_root)),
        plugin_root / "package.json": render_json(build_plugin_package(project_root)),
        plugin_root / "package-lock.json": render_json(build_plugin_lock(project_root)),
        project_root / ".claude-plugin" / "marketplace.json": render_json(build_marketplace()),
    }
    hooks_source = runtime_root / "hooks" / "hooks.json"
    if hooks_source.exists():
        generated[project_root / ".claude" / "settings.json"] = hooks_source.read_text(encoding="utf-8")
    return generated


def _write_generated_files(project_root: Path) -> None:
    for target, content in generated_files(project_root).items():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")


def sync_runtime_assets(project_root: Path = PROJECT_ROOT) -> list[str]:
    runtime_root = project_root / "claude-runtime"
    if not runtime_root.exists():
        raise FileNotFoundError(f"缺少运行时事实源目录: {runtime_root}")

    synced_targets: list[str] = []

    for directory in SYNC_DIRS:
        source_dir = runtime_root / directory
        if not source_dir.exists():
            continue

        if directory != "scripts":
            project_target = project_root / ".claude" / directory
        else:
            project_target = project_root / "scripts"
        _sync_tree(source_dir, project_target, target_kind="clone")
        synced_targets.append(str(project_target))

        plugin_target = project_root / "plugins" / "writing-agent" / directory
        _sync_tree(source_dir, plugin_target, target_kind="plugin")
        synced_targets.append(str(plugin_target))

    for directory in PLUGIN_EXTRA_DIRS:
        source_dir = runtime_root / directory
        if not source_dir.exists():
            continue
        plugin_target = project_root / "plugins" / "writing-agent" / directory
        _sync_tree(source_dir, plugin_target, target_kind="plugin")
        synced_targets.append(str(plugin_target))

    _write_generated_files(project_root)
    return synced_targets


def main() -> int:
    synced_targets = sync_runtime_assets(PROJECT_ROOT)
    for target in synced_targets:
        print(f"SYNCED {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
