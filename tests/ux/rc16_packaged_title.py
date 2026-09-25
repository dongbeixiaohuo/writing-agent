"""Actual packaged Electron click, preload/IPC and SQLite; loopback-only model fixture."""
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
exe = Path(sys.argv[1]).resolve()
source = sys.argv[2]
run_id = sys.argv[3]
requests = []
titles = ['功劳不是放松标准的理由', '被需要，不等于有特权', '别让过去的贡献变成借口']
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'path': self.path, 'model': payload.get('model')})
        i = len(requests)
        if i == 1:
            name, args = 'delegate_author_expert', {'role': 'title', 'task': '只拟三个标题，正文不改，不代选'}
        elif i == 2:
            name, args = 'propose_publication_choices', {'candidates': [dict(title=t, opening=None, distributionCopy=None, rationale='隔离桌面传输验收候选，不代表真实模型质量。') for t in titles]}
        else:
            name, args = 'respond_author', {'reply': '三个新标题已经保存，请选择或继续提出意见；正文未改。'}
        chunks = [dict(id=f'fixture-{i}', object='chat.completion.chunk', choices=[dict(index=0, delta=dict(tool_calls=[dict(index=0, id=f'call-{i}', type='function', function=dict(name=name, arguments=json.dumps(args, ensure_ascii=False)))]), finish_reason=None)]),
                  dict(id=f'fixture-{i}', object='chat.completion.chunk', choices=[dict(index=0, delta={}, finish_reason='tool_calls')], usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))]
        body = ''.join('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        self.wfile.write(body.encode('utf-8'))

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', source, run_id, str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc16-title-desktop' / prepared['id']; evidence.mkdir(parents=True)
report = dict(realModelCalls=0, originalProjectWrites=0, workspace=prepared['root'], executable=str(exe))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); cdp_port = sock.getsockname()[1]
env = dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key')
process = subprocess.Popen([str(exe), f'--remote-debugging-port={cdp_port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=env,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
try:
    deadline = time.monotonic() + 25
    while True:
        try:
            with urlopen(f'http://127.0.0.1:{cdp_port}/json/version', timeout=1) as response: endpoint = json.load(response)['webSocketDebuggerUrl']
            break
        except Exception:
            if time.monotonic() >= deadline: raise
            time.sleep(.2)
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(endpoint)
        page = browser.contexts[0].pages[0]
        page.wait_for_load_state('networkidle')
        page.wait_for_function('!!window.writingAgentDesktop')
        def rpc(method, args):
            response = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method, args=args))
            assert response['ok'], response
            return response
        rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
        card = page.get_by_role('region', name='补充写作信息', exact=True)
        expect(card.get_by_role('heading')).to_contain_text('标题')
        feedback = '这不是标题，请重新拟三个，正文不要改'
        card.get_by_role('textbox').fill(feedback)
        card.get_by_role('button', name='发送意见', exact=True).click()
        expect(card.get_by_role('list', name='标题候选')).to_contain_text(titles[0], timeout=15000)
        expect(card.get_by_role('list', name='标题候选').get_by_role('listitem')).to_have_count(3)
        expect(card.get_by_role('textbox')).to_have_value('')
        expect(card.get_by_role('alert')).to_have_count(0)
        page.wait_for_function('async()=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&!r.result.activeRunId}')
        snapshot = rpc('getSnapshot', [])['result']
        assert snapshot['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
        assert any(r['runId'] == run_id and r['status'] == 'waiting_user' for r in snapshot['recoverableRuns'])
        assert any(m.get('role') == 'user' and m.get('body') == feedback for m in snapshot['timelineBySession'][prepared['sessionId']])
        page.reload(wait_until='networkidle')
        expect(card.get_by_role('list', name='标题候选')).to_contain_text(titles[0])
        card.scroll_into_view_if_needed(); page.screenshot(path=str(evidence / 'desktop-title-success.png'))
        report.update(status='PASS', exactFeedbackPersisted=True, threeCandidatesSaved=True, bodyUnchanged=True, waitingWorkflowPreserved=True, reloadPreserved=True, loopbackRequests=len(requests))
        browser.close()
finally:
    process.terminate(); process.wait(timeout=15)
    server.shutdown()
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
