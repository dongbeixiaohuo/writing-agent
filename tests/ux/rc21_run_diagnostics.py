"""Packaged desktop, isolated read-only backup of the reported rc.19 run. No provider calls."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], '9'], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc21-run-diagnostics' / prepared['id']
evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], runId=sys.argv[3], originalProjectWrites=0, realModelCalls=0, checks=[])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as r: endpoint = json.load(r)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic() >= deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(endpoint)
            page = browser.contexts[0].pages[0]; page.wait_for_load_state('networkidle')
            def rpc(method, args=[]):
                r = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method,args=args))
                assert r['ok'], r
                return r['result']
            rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
            snapshot = rpc('getSnapshot')
            run = next(r for r in snapshot['runRecords'] if r['id'] == sys.argv[3])
            segments = run['diagnostics']['segments']
            assert len(segments) == 4
            assert sum(len(s['modelRequests']) for s in segments) == 33
            assert sum(g['count'] for s in segments for g in s['toolGroups']) == 96
            reads = [g for s in segments for g in s['toolGroups'] if g['toolName'] == 'read_material']
            assert sum(g['completed'] for g in reads) == 66
            assert sum(g['failed'] for g in reads) == 1
            assert any(len(d.get('reason') or '') > 240 for s in segments for d in s['decisions'])
            assert any(g['targets'][0]['id'] != '未记录 ID' for s in segments for g in s['toolGroups'] if g['toolName'] == 'read_artifact_version')
            for width, height in [(1344, 866), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height))
                expect(page.locator('[data-conversation-feed]')).not_to_contain_text('读取参考材料')
                page.get_by_role('button', name='运行记录', exact=False).click()
                card = page.locator('article').filter(has_text='33 / 64').filter(has_text='96 / 96')
                expect(card).to_have_count(1)
                detail = card.locator('details').filter(has=page.locator('.run-diagnostics')).first
                detail.locator(':scope > summary').click()
                diagnostics = card.locator('.run-diagnostics')
                expect(diagnostics.locator('.run-diagnostics-segment')).to_have_count(4)
                diagnostics.locator('.run-diagnostics-segment').first.scroll_into_view_if_needed()
                expect(diagnostics.locator('.run-diagnostics-models[open]')).to_have_count(0)
                page.screenshot(path=str(evidence / f'overview-{width}.png'))
                materials = diagnostics.locator('.run-diagnostics-group').filter(has_text='读取参考材料').first
                materials.locator(':scope > summary').click()
                expect(materials).to_contain_text('需求对话')
                expect(materials).to_contain_text('版本')
                assert materials.locator('li').count() == 15
                materials.scroll_into_view_if_needed()
                page.screenshot(path=str(evidence / f'materials-{width}.png'))
                materials.locator(':scope > summary').click()
                task = diagnostics.locator('.run-diagnostics-reason').first
                task.locator(':scope > summary').click()
                assert len(task.inner_text()) > 240
                task.locator(':scope > summary').click()
                timeout = diagnostics.locator('.run-diagnostics-models').filter(has_text='TIMEOUT')
                expect(timeout).to_have_count(1)
                timeout.locator(':scope > summary').click()
                timeout.get_by_text('TIMEOUT', exact=False).scroll_into_view_if_needed()
                expect(timeout).to_contain_text('结果未知')
                page.screenshot(path=str(evidence / f'timeout-{width}.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.get_by_role('button', name='对话', exact=True).click()
                report['checks'].append(dict(width=width, groupedReads=True, longTaskRetained=True, individualRequests=True, timeoutVisible=True, noPageOverflow=True))
            after = rpc('getSnapshot')
            assert after['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
            report.update(status='PASS', segments=4, modelRequests=33, toolCalls=96, successfulMaterialReads=66, failedMaterialReads=1, bodyUnchanged=True)
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
