"""Safely register and verify writing-style profiles."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path


def _load_registry(style_root: Path) -> tuple[Path, dict]:
    registry_path = style_root / "style_registry.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ValueError(f"风格登记表不存在: {registry_path}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(f"风格登记表不是有效 JSON: {registry_path}") from exc
    if not isinstance(registry, dict) or not isinstance(registry.get("styles"), list):
        raise ValueError("风格登记表缺少 styles 数组")
    return registry_path, registry


def _profile_name(value: str) -> str:
    path = Path(value)
    if path.name != value or path.suffix != ".md" or value in {".", ".."}:
        raise ValueError("--profile 必须是 styles 根目录内的 .md 文件名")
    return value


def _write_registry_atomic(path: Path, registry: dict) -> None:
    content = json.dumps(registry, ensure_ascii=False, indent=2) + "\n"
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        newline="\n",
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
        delete=False,
    )
    temporary_path = Path(handle.name)
    try:
        with handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_path.replace(path)
    finally:
        temporary_path.unlink(missing_ok=True)


def register_profile(style_root: Path, profile: str) -> str:
    style_root = style_root.resolve()
    profile = _profile_name(profile)
    if not (style_root / profile).is_file():
        raise ValueError(f"风格档案不存在: {profile}")
    registry_path, registry = _load_registry(style_root)
    for entry in registry["styles"]:
        if isinstance(entry, dict) and entry.get("file") == profile:
            return "UNCHANGED"
    registry["styles"].append(
        {
            "name": Path(profile).stem,
            "file": profile,
            "verification_status": "legacy_unverified",
            "evidence_file": None,
        }
    )
    _write_registry_atomic(registry_path, registry)
    return "REGISTERED"


def verify_profile(
    style_root: Path,
    profile: str,
    evidence: str,
    *,
    blind_test_passed: bool,
) -> str:
    if not blind_test_passed:
        raise ValueError("升级 verified 前必须显式确认盲测已通过")
    style_root = style_root.resolve()
    profile = _profile_name(profile)
    if not (style_root / profile).is_file():
        raise ValueError(f"风格档案不存在: {profile}")
    evidence_value = Path(evidence)
    if evidence_value.is_absolute() or evidence_value.suffix != ".md":
        raise ValueError("--evidence 必须是 styles 根目录内的相对 .md 路径")
    if not evidence_value.parts or evidence_value.parts[0] != "_evidence":
        raise ValueError("证据文件必须位于 styles/_evidence 目录")
    evidence_root = (style_root / "_evidence").resolve()
    evidence_path = (style_root / evidence_value).resolve()
    try:
        evidence_root.relative_to(style_root)
        evidence_path.relative_to(evidence_root)
    except ValueError as exc:
        raise ValueError("证据文件不能越出 _evidence 目录") from exc
    if not evidence_path.is_file():
        raise ValueError(f"证据文件不存在: {evidence}")

    registry_path, registry = _load_registry(style_root)
    entry = next(
        (
            item
            for item in registry["styles"]
            if isinstance(item, dict) and item.get("file") == profile
        ),
        None,
    )
    if entry is None:
        raise ValueError(f"风格尚未登记，必须先执行 register: {profile}")
    entry["verification_status"] = "verified"
    entry["evidence_file"] = evidence_path.relative_to(style_root).as_posix()
    _write_registry_atomic(registry_path, registry)
    return "VERIFIED"


def resolve_style_root(workspace_root: Path) -> Path:
    workspace_root = workspace_root.resolve()
    candidates = (
        workspace_root / "claude-runtime" / "styles",
        workspace_root / ".claude" / "styles",
    )
    for candidate in candidates:
        if (candidate / "style_registry.json").is_file():
            return candidate.resolve()
    raise ValueError("未找到可写的风格登记表；请先运行工作区 bootstrap")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="安全维护写作风格状态登记表")
    subparsers = parser.add_subparsers(dest="command", required=True)
    register = subparsers.add_parser("register", help="登记新风格，默认标记为 legacy_unverified")
    register.add_argument("--style-root", required=True)
    register.add_argument("--profile", required=True)
    verify = subparsers.add_parser("verify", help="显式升级已完成证据与盲测的风格")
    verify.add_argument("--style-root", required=True)
    verify.add_argument("--profile", required=True)
    verify.add_argument("--evidence", required=True)
    verify.add_argument("--blind-test-passed", action="store_true")
    resolve = subparsers.add_parser("resolve-root", help="解析当前工作区应写入的风格根目录")
    resolve.add_argument("--workspace-root", default=".")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "register":
            result = register_profile(Path(args.style_root), args.profile)
        elif args.command == "verify":
            result = verify_profile(
                Path(args.style_root),
                args.profile,
                args.evidence,
                blind_test_passed=args.blind_test_passed,
            )
        elif args.command == "resolve-root":
            workspace_root = Path(args.workspace_root).resolve()
            print(resolve_style_root(workspace_root).relative_to(workspace_root).as_posix())
            return 0
        else:  # pragma: no cover - argparse guarantees the command
            raise ValueError(f"未知命令: {args.command}")
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}")
        return 1
    print(f"{result}: {args.profile}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
