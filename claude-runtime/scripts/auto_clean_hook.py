"""
auto_clean_hook.py - 自动生成纯净版的 Hook 脚本
触发时机：由 Claude Code Hook 在 Subagent 结束时自动调用
功能：根据显式项目或正文来源生成 _clean.txt；旧的全局回退必须人工开启
"""

import os
import sys
import json
import argparse
import hashlib
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_SOURCE_ROOT = SCRIPT_DIR.parent
if str(PROJECT_SOURCE_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_SOURCE_ROOT))

from scripts.claude_runtime_paths import resolve_workspace_root, workspace_articles_dir

# 默认工作区根目录。plugin 模式可通过事件里的 workspace_root 覆盖。
PROJECT_ROOT = resolve_workspace_root()
ARTICLES_DIR = workspace_articles_dir(PROJECT_ROOT)
GENERATE_CLEAN = Path(__file__).resolve().parent / 'generate_clean.py'
MANIFEST_NAME = 'run_manifest.json'


def find_latest_draft(articles_dir: Path | None = None):
    """在 articles/ 下所有项目文件夹中，找到最近修改的定稿文件"""
    candidates = []
    articles_dir = articles_dir or ARTICLES_DIR

    if not articles_dir.exists():
        return None

    for project_dir in articles_dir.iterdir():
        if not project_dir.is_dir():
            continue
        # 跳过特殊目录
        if project_dir.name.startswith('_'):
            continue

        # 在项目目录中查找可能是定稿的文件
        for f in project_dir.glob('*.md'):
            name_lower = f.name.lower()
            if name_lower.endswith('_notes.md'):
                continue
            # 匹配这些模式的文件被认为是定稿候选
            is_final = any(keyword in name_lower for keyword in [
                'final',        # draft_final.md
                'humanized',    # draft_v4_humanized.md
                '最终稿',       # xxx_最终稿.md
            ])
            if is_final:
                candidates.append(f)

    if not candidates:
        return None

    # 按修改时间排序，取最新的
    candidates.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return candidates[0]


def _normalize_candidate(
    path_value,
    base_dir: Path | None = None,
    allowed_root: Path | None = None,
):
    if not path_value:
        return None

    candidate = Path(path_value)
    if not candidate.is_absolute():
        if base_dir is not None:
            candidate = base_dir / candidate
        else:
            candidate = PROJECT_ROOT / candidate
    candidate = candidate.resolve()

    if allowed_root is not None:
        allowed_root = allowed_root.resolve()
        try:
            candidate.relative_to(allowed_root)
        except ValueError:
            return None

    if not candidate.exists():
        return None
    if candidate.name.lower().endswith('_notes.md'):
        return None
    return candidate


def find_latest_manifest(articles_dir: Path | None = None):
    articles_dir = articles_dir or ARTICLES_DIR
    manifests = list(articles_dir.glob(f'*/{MANIFEST_NAME}'))
    if not manifests:
        return None
    manifests.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    return manifests[0]


def resolve_clean_source_from_manifest(manifest_path: Path):
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except Exception:
        return None

    project_dir = manifest_path.parent
    for key in ('clean_source_file', 'latest_body_file'):
        resolved = _normalize_candidate(
            manifest.get(key),
            base_dir=project_dir,
            allowed_root=project_dir,
        )
        if resolved is not None:
            return resolved
    return None


def resolve_clean_source(event_data: dict, *, allow_legacy_fallback: bool = False):
    workspace_root_value = event_data.get("workspace_root")
    workspace_root = resolve_workspace_root(workspace_root_value) if workspace_root_value else None
    articles_dir = workspace_articles_dir(workspace_root) if workspace_root else ARTICLES_DIR
    candidate_base_dir = workspace_root or PROJECT_ROOT

    direct_keys = ('clean_source_file', 'body_file', 'file_path', 'path')
    for key in direct_keys:
        resolved = _normalize_candidate(
            event_data.get(key),
            base_dir=candidate_base_dir,
            allowed_root=articles_dir,
        )
        if resolved is not None:
            return resolved

    project_dir = event_data.get('project_dir')
    if project_dir:
        project_manifest = _normalize_candidate(
            project_dir,
            base_dir=articles_dir,
            allowed_root=articles_dir,
        )
        if project_manifest is not None and project_manifest.is_dir():
            manifest_path = project_manifest / MANIFEST_NAME
            if manifest_path.exists():
                resolved = resolve_clean_source_from_manifest(manifest_path)
                if resolved is not None:
                    return resolved

    if allow_legacy_fallback:
        latest_manifest = find_latest_manifest(articles_dir)
        if latest_manifest is not None:
            resolved = resolve_clean_source_from_manifest(latest_manifest)
            if resolved is not None:
                return resolved

        return find_latest_draft(articles_dir)

    return None


def has_clean_version(draft_path: Path) -> bool:
    """检查是否已经有对应的 _clean.txt，且比原稿更新"""
    clean_path = draft_path.parent / (draft_path.stem + '_clean.txt')
    if not clean_path.exists():
        return False
    # 如果 clean.txt 比源稿新，说明已经处理过了，不重复
    return clean_path.stat().st_mtime >= draft_path.stat().st_mtime


def fact_check_passed(draft_path: Path) -> bool:
    """只有绑定到当前正文内容哈希的事实核查结果才允许生成纯净版。"""
    manifest_path = draft_path.parent / MANIFEST_NAME
    try:
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return False
    if manifest.get('fact_check_status') != 'passed':
        return False

    checked_file = manifest.get('fact_checked_body_file')
    checked_hash = manifest.get('fact_checked_body_sha256')
    if not isinstance(checked_file, str) or not isinstance(checked_hash, str):
        return False

    checked_path = Path(checked_file)
    if checked_path.is_absolute():
        return False
    checked_path = (draft_path.parent / checked_path).resolve()
    if checked_path != draft_path.resolve():
        return False

    actual_hash = hashlib.sha256(draft_path.read_bytes()).hexdigest()
    return actual_hash == checked_hash.lower()


def main(event_data_override: dict | None = None, *, allow_legacy_fallback: bool = False) -> int:
    # 读取 hook 传入的事件信息（如果有的话）
    if event_data_override is not None:
        event_data = event_data_override
    else:
        try:
            event_data = json.loads(sys.stdin.read()) if not sys.stdin.isatty() else {}
        except Exception:
            event_data = {}

    # 优先根据显式路径 / run_manifest.json 找到正文来源
    latest_draft = resolve_clean_source(event_data, allow_legacy_fallback=allow_legacy_fallback)

    if latest_draft is None:
        # 没有找到定稿文件，静默退出
        return 0

    if not fact_check_passed(latest_draft):
        print("跳过生成：事实核查未通过，或结果未绑定当前正文哈希", file=sys.stderr)
        return 0

    if has_clean_version(latest_draft):
        # 已经有最新的 clean 版本了，不重复生成
        return 0

    # 调用 generate_clean.py 生成纯净版
    import subprocess
    env = os.environ.copy()
    env['PYTHONIOENCODING'] = 'utf-8'
    result = subprocess.run(
        [sys.executable, str(GENERATE_CLEAN), str(latest_draft)],
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        env=env
    )

    if result.returncode == 0:
        # 输出到 stderr（hook 的 stdout 可能被 Claude Code 拦截）
        print(result.stdout, file=sys.stderr)
    else:
        print(f"生成失败: {result.stderr}", file=sys.stderr)
    return result.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="在事实核查通过后生成项目纯净版")
    parser.add_argument("--workspace-root", help="工作区根目录，默认当前目录")
    parser.add_argument("--project", help="articles/ 下的目标项目名")
    parser.add_argument(
        "--legacy-fallback",
        action="store_true",
        help="显式启用跨 articles/ 查找最近正文的旧兼容行为（默认禁用）",
    )
    return parser


if __name__ == '__main__':
    args = build_parser().parse_args()
    event_data = None
    if args.workspace_root or args.project:
        event_data = {}
        if args.workspace_root:
            event_data['workspace_root'] = args.workspace_root
        if args.project:
            event_data['project_dir'] = args.project
    raise SystemExit(main(event_data, allow_legacy_fallback=args.legacy_fallback))
