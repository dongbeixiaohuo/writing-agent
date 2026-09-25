"""Packaged Electron + slow local SSE: verify real first-chunk UX, not a typing animation."""
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
mode = sys.argv[4] if len(sys.argv) > 4 else 'tool'
assert mode in ['tool', 'text']
release = threading.Event()
requests = []
completed = []
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        number = len(requests) + 1; requests.append(time.monotonic())
        first = '{"reply":"先从一个具体的生活片段聊起。'
        data = dict(reply='先从一个具体的生活片段聊起。\n\n可以写想象中的自己与当下的落差，结尾轻轻和解。你觉得怎样？', summary='待确认的写作方向', questions=[], proposal=dict(
            brief=dict(topic='与想象中的自己和解', genre='narrative_observation', audience='普通成年人', targetCharacters=1000, constraints=['不虚构亲历'], voice='第二人称（建议，可调整）', styleReference=None, platform=None, publicationGoal='not_applicable'),
            assumptions=['genre 选 narrative_observation，因为轻散文', 'targetCharacters=1000 来自用户消息 6', 'platform 设为 null', '结尾轻微和解是我根据交流推导的建议'], sourceQuotes=[]))
        serialized = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
        assert serialized.startswith(first)
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        def send(delta, finish=None):
            chunk = dict(choices=[dict(index=0, delta=delta, finish_reason=finish)])
            self.wfile.write(('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\n').encode()); self.wfile.flush()
        try:
            if mode == 'text': send(dict(content='先从一个具体的生活片段聊起。'))
            else: send(dict(tool_calls=[dict(index=0, id=f'call-{number}', type='function', function=dict(name='respond_writing_intake', arguments=first))]))
            if not release.wait(25): return
            if mode == 'text':
                send(dict(content='\n\n可以写想象中的自己与当下的落差，结尾轻轻和解。你觉得怎样？'))
                send(dict(tool_calls=[dict(index=0, id=f'call-{number}', type='function', function=dict(name='respond_writing_intake', arguments=serialized))]))
            else: send(dict(tool_calls=[dict(index=0, function=dict(arguments=serialized[len(first):]))]))
            send({}, 'tool_calls')
            self.wfile.write(b'data: [DONE]\n\n'); self.wfile.flush(); completed.append(number)
        except (BrokenPipeError, ConnectionResetError): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
evidence = root / f'output/streaming-interaction-{mode}' / prepared['id']; evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], mode=mode, originalProjectWrites=0, realModelCalls=0, checks=[])
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
            for width, height in [(1344, 866), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height)); release.clear()
                page.get_by_role('button', name='新建项目', exact=True).click()
                editor = page.get_by_role('textbox', name='写作指令', exact=True)
                editor.fill(f'rc20交互验证{width}：想写与想象中的自己和解')
                began = time.monotonic(); editor.press('Enter')
                live = page.get_by_label('正在生成的回复', exact=True)
                expect(live).to_contain_text('先从一个具体的生活片段聊起。', timeout=15000)
                first_seen = time.monotonic()
                assert len(completed) < len(requests), 'Provider must still be held before completion'
                expect(editor).to_be_focused(); expect(editor).to_be_editable()
                page.keyboard.type('先不要确认，我还想调整')
                expect(editor).to_have_text('先不要确认，我还想调整')
                count = len(requests); editor.press('Enter'); assert len(requests) == count
                page.screenshot(path=str(evidence / f'streaming-{width}.png'))
                release.set()
                page.wait_for_function('async()=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&r.result.activeRunId===null}', timeout=15000)
                expect(live).to_have_count(0)
                expect(editor).to_be_focused(); expect(editor).to_have_text('先不要确认，我还想调整')
                direction = page.get_by_label('确认写作方向', exact=True)
                expect(direction.get_by_role('heading', name='写作方向', exact=True)).to_be_visible()
                text = direction.inner_text()
                assert all(value not in text for value in ['genre', 'targetCharacters', 'narrative_observation', 'null', '用户消息 6'])
                assert '结尾轻微和解' in text
                page.screenshot(path=str(evidence / f'direction-{width}.png'))
                snapshot = rpc('getSnapshot'); current_project = snapshot['selectedProjectId']
                project = next(p for p in snapshot['projects'] if p['id'] == current_project)
                # A project-scoped new conversation must not create another project.
                if width == 900:
                    page.get_by_role('button', name='展开侧边栏', exact=True).click()
                new_chat = page.get_by_role('button', name=f'在项目“{project["name"]}”中新建对话', exact=True)
                new_chat.click()
                release.clear()
                editor.fill('在这个项目开一个新对话，先讨论，不确认方案')
                editor.press('Enter')
                expect(live).to_contain_text('先从一个具体的生活片段聊起。', timeout=15000)
                assert rpc('getSnapshot')['selectedProjectId'] == current_project
                assert len(rpc('getSnapshot')['projects']) == len(snapshot['projects'])
                assert rpc('getSnapshot')['selectedSessionId'] != snapshot['selectedSessionId']
                release.set()
                page.wait_for_function('async()=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&r.result.activeRunId===null}', timeout=15000)
                expect(editor).to_be_focused()
                report['checks'].append(dict(width=width, realPartialBeforeFinish=True, firstVisibleSeconds=round(first_seen-began, 3), focusAndDraftPreserved=True, readableDirection=True, newConversationScoped=True))
            report.update(status='PASS', loopbackRequests=len(requests)); browser.close()
    finally:
        release.set(); process.terminate(); process.wait(timeout=15); server.shutdown()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
