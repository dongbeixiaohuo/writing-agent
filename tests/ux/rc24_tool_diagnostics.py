"""Inspect a read-only backup in the packaged desktop; no real model or user writes."""
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
evidence = root / 'output/rc24-tool-diagnostics' / prepared['id']; evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], originalProjectWrites=0, realModelCalls=0, checks=[])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
        env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'),
        stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
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
            def rpc(method, args=None):
                r = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method,args=args or []))
                assert r['ok'], r
                return r['result']
            rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
            before = rpc('getSnapshot')
            run = next(r for r in before['runRecords'] if r['id'] == sys.argv[3])
            for width, height in [(1344, 866), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height))
                page.get_by_role('button', name='运行记录', exact=False).click()
                card = page.locator('article').filter(has=page.get_by_role('heading', name=run['displayInstruction'], exact=True))
                expect(card).to_have_count(1)
                details = card.locator('details').filter(has=page.locator('.run-diagnostics')).first
                if details.get_attribute('open') is None: details.locator(':scope > summary').click()
                diagnostics = card.locator('.run-diagnostics')
                assert '其他写作工具' not in diagnostics.inner_text(), 'Known intake tool still has a generic label'
                expect(diagnostics.locator('h4')).to_contain_text('执行段 1')
                expect(diagnostics.locator('h4')).to_contain_text('｜ 1 次模型请求')
                group = diagnostics.locator('.run-diagnostics-group').filter(has_text='保存需求交流')
                if group.get_attribute('open') is None: group.locator(':scope > summary').click()
                for text in ['respond_writing_intake', '待确认方案', '需求澄清助手（按运行类型）', '执行结果：']:
                    expect(group).to_contain_text(text)
                expect(group).to_contain_text('已保存待确认方案，尚未确认')
                group.scroll_into_view_if_needed()
                page.screenshot(path=str(evidence / f'tool-details-{width}.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                assert group.evaluate('(el)=>el.scrollWidth<=el.clientWidth+1')
                page.get_by_role('button', name='对话', exact=True).click()
                expect(page.locator('[data-conversation-feed]')).not_to_contain_text('respond_writing_intake')
                report['checks'].append(dict(width=width, namedTool=True, purpose=True, callerSource=True, actualResult=True, segmentSeparated=True, noOverflow=True, mainChatUnchanged=True))
            after = rpc('getSnapshot')
            assert after['runRecords'] == before['runRecords']
            assert after['revisionWorkspace']['bodyVersionId'] == before['revisionWorkspace']['bodyVersionId']
            report.update(status='PASS', historyUnchanged=True)
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(**report, evidence=str(evidence)), ensure_ascii=False))
