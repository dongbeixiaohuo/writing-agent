#!/usr/bin/env python3
"""检查交接文档一致性；不执行应用、网络或视觉测试。"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse


def without_fences(text: str) -> str:
    return re.sub(r'^```[^\n]*\n.*?^```\s*$', '', text, flags=re.M | re.S)


def check(root: Path) -> dict:
    backlog_path = root / 'docs/implementation/BACKLOG.json'
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

    prd = (root / 'docs/prd/WRITING_AGENT_1_0_PRD.md').read_text(encoding='utf-8')
    ats = re.findall(r'^\| (AT-\d{2}) \|', prd, flags=re.M)
    assert len(ats) == len(set(ats)) == 38, '验收定义重复或数量不符'
    assert set(ats) == {f'AT-{i:02d}' for i in range(1, 39)}
    cr002 = (root / 'docs/implementation/CR002_INTERACTIVE_COLLABORATION.md').read_text(encoding='utf-8')
    collaboration_cases = re.findall(r'^\| (C02-\d{2}) \|', cr002, flags=re.M)
    assert len(collaboration_cases) == len(set(collaboration_cases)) == 14, 'CR-002 场景缺失或重复'
    assert set(collaboration_cases) == {f'C02-{i:02d}' for i in range(1, 15)}
    assert any('CR-002' in item for item in by_id['WA-010']['definition_of_done']), 'WA-010 缺少协作验收条件'
    requirements = set(re.findall(r'\b(?:F\d{2}|UI-\d{2}|IND-\d{2}|NFR-\d{2})\b', prd))
    sources = (root / 'docs/research/SOURCE_BASELINE.md').read_text(encoding='utf-8')
    source_ids = set(re.findall(r'^\*\*\[(S\d{2})\]', sources, flags=re.M))
    assert len(source_ids) == 17
    for task in tasks:
        assert set(task['requirements']) <= requirements, task['id']
        assert set(task['acceptance_test_ids']) <= set(ats), task['id']
        assert task['status'] in backlog['status_vocabulary']

    md_files = list(root.rglob('*.md'))
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
                assert not anchor or f'id="{anchor}"' in text, f'未知锚点 {file}: {anchor}'
                continue
            resolved = (file.parent / unquote(path_part)).resolve()
            assert resolved.is_relative_to(root.resolve()), f'越界链接 {file}: {target}'
            assert resolved.exists(), f'缺失相对链接 {file}: {target}'

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
    for file in sorted(root.rglob('*')):
        if not file.is_file() or file.name == 'DOCUMENT_CHECKS.json' or '__pycache__' in file.parts:
            continue
        content = file.read_bytes()
        files.append({'path': file.relative_to(root).as_posix(), 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest()})
    return {
        'document_version': '1.1',
        'product_target_version': '1.0',
        'revision_id': 'CR-002',
        'checks': {
            'backlog_json_parse': 'PASS', 'task_count': len(tasks),
            'dependency_graph_acyclic': 'PASS', 'all_backlog_dependencies_resolved': 'PASS',
            'ui_track_parallel_and_joined': 'PASS', 'acceptance_scenarios': len(ats),
            'collaboration_acceptance_scenarios': len(collaboration_cases),
            'requirement_and_acceptance_ids_resolved': 'PASS',
            'markdown_code_fences_balanced': 'PASS', 'relative_document_links': 'PASS',
            'source_ids_resolved': 'PASS', 'known_superseded_positive_routes_removed': 'PASS',
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
        (args.root / 'DOCUMENT_CHECKS.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report['checks'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
