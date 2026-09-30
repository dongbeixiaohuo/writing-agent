"""Replay two 'continue' turns in a packaged app; assert reply geometry, not DOM presence."""
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
requests = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(payload.get('model'))
        i = len(requests)
        chunks = [dict(choices=[dict(index=0, delta=dict(tool_calls=[dict(index=0, id=f'visibility-{i}', type='function', function=dict(name='respond_author', arguments=json.dumps(dict(reply='你想用哪一个标题？确认后继续核查。'), ensure_ascii=False)))]), finish_reason=None)]), dict(choices=[dict(index=0, delta={}, finish_reason='tool_calls')], usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))]
        body = ''.join('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers(); self.wfile.write(body.encode('utf-8'))

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc18-reply-visibility' / prepared['id']; evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], originalProjectWrites=0, realModelCalls=0, checks=[])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
        env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
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
            for width, height in [(1344, 866), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height))
                count = len(rpc('getSnapshot')['runRecords'])
                editor = page.get_by_role('textbox', name='写作指令', exact=True)
                editor.fill('继续'); editor.press('Enter')
                page.wait_for_function('async(n)=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&r.result.runRecords.length===n+1&&r.result.runRecords.at(-1).status==="completed"}', arg=count, timeout=20000)
                reply = page.locator('article').filter(has_text='好的，这组标题先保留。你想用哪一个？').last
                expect(reply).to_be_visible()
                metrics = reply.evaluate('(el)=>{const r=el.getBoundingClientRect();const f=document.querySelector("[data-conversation-feed]").getBoundingClientRect();return {top:r.top,bottom:r.bottom,feedTop:f.top,feedBottom:f.bottom,visible:r.top>=f.top-1&&r.bottom<=f.bottom+1}}')
                report['checks'].append(dict(width=width, height=height, **metrics))
                page.screenshot(path=str(evidence / f'reply-{width}.png'))
                assert metrics['visible'], 'Saved reply is outside the conversation viewport; user would think Enter did nothing'
                snapshot = rpc('getSnapshot')
                assert snapshot['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
                assert '你想用哪一个' in snapshot['runRecords'][-1]['replyPreview']
                assert any(r['runId']==sys.argv[3] and r['inputRequest']['kind']=='publication_selection' for r in snapshot['recoverableRuns'])
                if width == 1344:
                    page.locator('[data-conversation-feed]').evaluate('(el)=>{el.scrollTop-=300}')
                    expect(page.get_by_role('button', name='回到最新进度 ↓')).to_be_visible()
            page.get_by_role('button', name='运行记录', exact=False).click()
            expect(page.locator('article').filter(has_text='继续').first).to_contain_text('你想用哪一个')
            page.get_by_role('button', name='对话', exact=True).click()
            page.wait_for_function('()=>{const es=document.querySelectorAll("[data-conversation-message=assistant]");const e=es[es.length-1];if(!e)return false;const r=e.getBoundingClientRect(),f=document.querySelector("[data-conversation-feed]").getBoundingClientRect();return r.top>=f.top&&r.bottom<=f.bottom}')
            report.update(status='PASS', bodyUnchanged=True, didNotChooseForUser=True)
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15); server.shutdown()
        report['loopbackRequests'] = len(requests)
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
