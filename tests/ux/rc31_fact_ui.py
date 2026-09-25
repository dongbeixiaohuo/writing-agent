"""Read-only source backup; inspect the packaged client's fact-question presentation."""
import json
import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

exe, source, project, session = sys.argv[1:5]
fixture_id = 'rc31-' + str(uuid.uuid4())
root = Path(tempfile.gettempdir()) / ('writing-agent-desktop-test-' + fixture_id)
(root / 'user-data').mkdir(parents=True)
(root / 'workspace/.writing-agent').mkdir(parents=True)
with sqlite3.connect(Path(source).as_uri() + '?mode=ro', uri=True) as src:
    with sqlite3.connect(root / 'workspace/.writing-agent/workspace.sqlite3') as dst:
        src.backup(dst)
(root / 'user-data/provider.json').write_text(json.dumps(dict(schemaVersion=2, kind='anthropic_compatible', providerId='offline-inspection', baseURL='http://127.0.0.1:9/v1', credentialRef='env:WRITING_AGENT_RC16_FIXTURE_KEY', model='offline', tools='supported', usage='reported', allowInsecureHttp=True)), encoding='utf-8')
evidence = Path(__file__).resolve().parents[2] / 'output/rc31-dialogue/native'
evidence.mkdir(parents=True, exist_ok=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
with (evidence / 'stderr.log').open('wb') as log:
    proc = subprocess.Popen([exe, f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=fixture_id, WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as res:
                    endpoint = json.load(res)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic() > deadline:
                    raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(endpoint)
            page = browser.contexts[0].pages[0]
            page.wait_for_load_state('networkidle')
            def rpc(method, args=None):
                result = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method, args=args or []))
                assert result['ok'], result
                return result['result']
            rpc('selectSession', [project, session])
            page.get_by_role('button', name='运行记录', exact=False).click()
            page.get_by_role('button', name='对话', exact=True).click()
            snapshot = rpc('getSnapshot')
            assert snapshot['factCheckWorkspace']['status'] == 'blocked'
            assert any(r['stopReason'] == 'WRITING_INPUT_REQUIRED' for r in snapshot['recoverableRuns'])
            expect(page.locator('[data-gate-status="blocked"]')).to_have_count(0)
            expect(page.get_by_role('textbox')).to_have_count(1)
            expect(page.get_by_role('textbox')).to_be_enabled()
            for width, height in [(1054, 828), (1500, 960)]:
                page.set_viewport_size(dict(width=width, height=height))
                page.locator('[data-conversation-feed]').evaluate('(e)=>e.scrollTop=e.scrollHeight')
                page.screenshot(path=str(evidence / f'question-{width}.png'))
            report = dict(status='PASS', duplicateBlockerCards=0, composerCount=1, persistedGate='blocked', originalWrites=0, realModelCalls=0, root=str(root))
            (evidence / 'result.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
            print(json.dumps(report))
            browser.close()
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=10)
