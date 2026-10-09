#!/usr/bin/env python3
"""检查合并后的产品文档契约；不执行应用、网络或视觉测试。"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse


def without_fences(text: str) -> str:
    return re.sub(r'^```[^\n]*\n.*?^```\s*$', '', text, flags=re.M | re.S)


ARCHIVE_ROOT = Path('docs/archive/2026-09-16-prd-v1.1-dsh-ui')
REPORT_PATH = Path('docs/testing/DOCUMENT_CHECKS.json')


def maintained_markdown(root: Path) -> list[Path]:
    files = [root / 'README.md', root / 'docs/README.md', root / 'packages/writing-pack/STAGE_MAPPING.md']
    for relative in ('docs/prd', 'docs/architecture', 'docs/implementation', 'docs/launch', 'docs/testing', 'docs/plans'):
        files.extend((root / relative).rglob('*.md'))
    return sorted({file.resolve() for file in files if file.is_file()})


def check(root: Path) -> dict:
    backlog_path = root / ARCHIVE_ROOT / 'BACKLOG.json'
    backlog = json.loads(backlog_path.read_text(encoding='utf-8'))
    tasks = backlog['tasks']
    ids = [task['id'] for task in tasks]
    assert len(set(ids)) == len(ids), '重复任务 ID'
    by_id = {task['id']: task for task in tasks}
    visited: set[str] = set()
    visiting: set[str] = set()

    def visit(task_id: str) -> None:
        assert task_id in by_id, f'未定义依赖 {task_id}'
        assert task_id not in visiting, f'循环依赖 {task_id}'
        if task_id in visited:
            return
        visiting.add(task_id)
        for dep in by_id[task_id]['depends_on']:
            visit(dep)
        visiting.remove(task_id)
        visited.add(task_id)

    for task_id in ids:
        visit(task_id)
    assert set(by_id) == {f'WA-{i:03d}' for i in range(1, 26)}
    assert 'WA-023' in by_id['WA-011']['depends_on']
    assert 'WA-010' not in by_id['WA-023']['depends_on']
    assert 'WA-025' in by_id['WA-018']['depends_on']

    prd_path = root / 'docs/prd/WRITING_AGENT_1_0_PRD.md'
    prd = prd_path.read_text(encoding='utf-8')
    ats = re.findall(r'^\| (AT-\d{2}) \|', prd, flags=re.M)
    assert len(ats) == len(set(ats)) == 38, '验收定义重复或数量不符'
    assert set(ats) == {f'AT-{i:02d}' for i in range(1, 39)}
    cr002 = (root / 'docs/implementation/CR002_INTERACTIVE_COLLABORATION.md').read_text(encoding='utf-8')
    collaboration_cases = re.findall(r'^\| (C02-\d{2}) \|', cr002, flags=re.M)
    assert len(collaboration_cases) == len(set(collaboration_cases)) == 14, 'CR-002 场景缺失或重复'
    assert set(collaboration_cases) == {f'C02-{i:02d}' for i in range(1, 15)}
    assert any('CR-002' in item for item in by_id['WA-010']['definition_of_done']), 'WA-010 缺少协作验收条件'
    requirements = set(re.findall(r'\b(?:F\d{2}|UI-\d{2}|IND-\d{2}|NFR-\d{2})\b', prd))
    sources = (root / 'docs/architecture/SOURCE_BASELINE.md').read_text(encoding='utf-8')
    source_ids = set(re.findall(r'^\*\*\[(S\d{2})\]', sources, flags=re.M))
    assert len(source_ids) == 17
    for task in tasks:
        assert set(task['requirements']) <= requirements, task['id']
        assert set(task['acceptance_test_ids']) <= set(ats), task['id']
        assert task['status'] in backlog['status_vocabulary']

    md_files = maintained_markdown(root)
    for file in md_files:
        text = file.read_text(encoding='utf-8')
        assert len(re.findall(r'^```', text, flags=re.M)) % 2 == 0, f'未闭合代码块 {file}'
        assert set(re.findall(r'\[(S\d{2})\]', text)) <= source_ids, f'未定义来源 {file}'
        prose = without_fences(text)
        for target in re.findall(r'\]\(([^)]+)\)', prose):
            target = target.strip().strip('<>')
            if urlparse(target).scheme:
                continue
            path_part, _, anchor = target.partition('#')
            if not path_part:
                continue
            resolved = (file.parent / unquote(path_part)).resolve()
            assert resolved.is_relative_to(root.resolve()), f'越界链接 {file}: {target}'
            assert resolved.exists(), f'缺失相对链接 {file}: {target}'

    archive_readme = (root / ARCHIVE_ROOT / 'README.md').read_text(encoding='utf-8')
    for marker in ('2026-09-16', '适用版本', '替代入口', '历史状态'):
        assert marker in archive_readme, f'历史归档缺少范围说明: {marker}'
    for archived in (root / ARCHIVE_ROOT).rglob('*.md'):
        text = archived.read_text(encoding='utf-8')
        assert len(re.findall(r'^```', text, flags=re.M)) % 2 == 0, f'未闭合代码块 {archived}'

    # 此处只检查已撤回的肯定式路线，历史说明和显式禁止仍允许出现。
    stale_phrases = [
        'M3 把同一个 runtime 和前端接入已有 Tauri 壳',
        '用既有 Tauri 壳分发同一 runtime 和 UI',
        'Web UI 与启动代码 | 有价值组件经审计再借鉴',
        '先保留旧 Tauri 路径，适配完成后再决定是否移动',
        '复用 React 建立本地 Web 工作台与传输边界',
    ]
    for file in md_files + [backlog_path]:
        text = file.read_text(encoding='utf-8')
        for phrase in stale_phrases:
            assert phrase not in text, f'残留旧路线: {file}'

    files = []
    report_files = set(md_files)
    report_files.update((root / ARCHIVE_ROOT).rglob('*'))
    report_files.update((prd_path, backlog_path, root / 'tests/check_document_pack.py'))
    for file in sorted(report_files):
        if not file.is_file() or file.resolve() == (root / REPORT_PATH).resolve() or '__pycache__' in file.parts:
            continue
        content = file.read_bytes()
        files.append({'path': file.relative_to(root).as_posix(), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    return {
        'document_version': 'consolidated-2026-10-05',
        'product_target_version': '1.0',
        'revision_id': 'CR-003',
        'checks': {
            'backlog_json_parse': 'PASS', 'task_count': len(tasks),
            'dependency_graph_acyclic': 'PASS', 'all_backlog_dependencies_resolved': 'PASS',
            'ui_track_parallel_and_joined': 'PASS', 'acceptance_scenarios': len(ats),
            'collaboration_acceptance_scenarios': len(collaboration_cases),
            'requirement_and_acceptance_ids_resolved': 'PASS',
            'markdown_code_fences_balanced': 'PASS', 'relative_document_links': 'PASS',
            'source_ids_resolved': 'PASS', 'known_superseded_positive_routes_removed': 'PASS',
            'historical_scope_and_replacement_declared': 'PASS',
        },
        'not_performed': [
            'application source transplantation', 'application tests', 'repository mutation',
            'installer build', 'live UI rendering or screenshots',
            'visual regression tests', 'real model execution', 'human usability experiment',
            'external URL availability validation'
        ],
        'files': files,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--write-report', action='store_true')
    args = parser.parse_args()
    report = check(args.root.resolve())
    if args.write_report:
        report_path = args.root / REPORT_PATH
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['checks'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
