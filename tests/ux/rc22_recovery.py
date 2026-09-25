"""Verify packaged recovery UX on an isolated copy, with only a local failure fixture."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
requests = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        requests.append(self.path)
        body = json.dumps({'error': {'message': 'Isolated recovery test: intentionally rejected', 'type': 'authentication_error'}}).encode()
        self.send_response(401)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc22-recovery' / prepared['id']
evidence.mkdir(parents=True)
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
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as response:
                    endpoint = json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic() >= deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser = p.chromium.connect_over_cdp(endpoint)
            page = browser.contexts[0].pages[0]
            page.wait_for_load_state('networkidle')

            def rpc(method, args=None):
                result = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method, args=args or []))
                assert result['ok'], result
                return result['result']

            rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
            before = rpc('getSnapshot')
            for width, height in [(1344, 866), (1054, 828), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height))
                page.get_by_role('button', name='运行记录', exact=False).click()
                page.get_by_role('button', name='对话', exact=True).click()
                card = page.get_by_role('region', name='写作暂停', exact=True)
                expect(card).to_contain_text('已收到你的回复')
                expect(card).to_contain_text('模型响应超时')
                expect(card.locator('[aria-label="本阶段成果"]')).to_have_count(0)
                button = card.get_by_role('button', name='重试这一步', exact=True)
                page.screenshot(path=str(evidence / f'recovery-{width}.png'))
                report['layout'] = page.locator('[data-conversation-feed]').evaluate('(el)=>({top:el.scrollTop,height:el.clientHeight,total:el.scrollHeight,card:el.querySelector("[data-conversation-recovery]")?.getBoundingClientRect().toJSON()})')
                expect(button).to_be_in_viewport(ratio=1)
                assert button.evaluate('(el)=>{const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}')
                assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                page.screenshot(path=str(evidence / f'recovery-{width}.png'))
                report['checks'].append(dict(width=width, acceptedReply=True, timeoutExplained=True, retryUnobscured=True))
            assert requests == [], 'opening the recovery view must not auto-retry'
            page.get_by_role('button', name='重试这一步', exact=True).click()
            deadline = time.monotonic() + 20
            while not requests:
                if time.monotonic() >= deadline: raise AssertionError('retry did not reach the isolated provider')
                page.wait_for_timeout(100)
            page.wait_for_function('async()=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok && !r.result.activeRunId}')
            after = rpc('getSnapshot')
            assert len(requests) == 1
            assert len(after['runRecords']) == len(before['runRecords'])
            assert after['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
            report.update(status='PASS', localFixtureRequests=len(requests), noAutoRetry=True, sameRunResumed=True, bodyUnchanged=True)
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        server.shutdown(); server.server_close()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
