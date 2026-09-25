"""Packaged client intake: real SSE transport, isolated workspace, no paid calls.

Usage: python tests/ux/rc32_intake_native.py EXE [cancel]
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

mode = 'cancel' if 'cancel' in sys.argv[2:] else 'save'
fixture_id = 'rc32-' + str(uuid.uuid4())
root = Path(tempfile.gettempdir()) / ('writing-agent-desktop-test-' + fixture_id)
(root / 'user-data').mkdir(parents=True)
evidence = Path(__file__).resolve().parents[2] / 'output/rc32-intake' / ('native-' + mode)
evidence.mkdir(parents=True, exist_ok=True)
partial, advance, saving, commit = [threading.Event() for _ in range(4)]
requests, errors = [], []
reply = '这个话题可以先聊清楚。\n\n你想写给自己看，还是给同样容易内耗的普通上班族看？\n\n你希望篇幅大约多少字？'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(dict(choice=body.get('tool_choice'), at=time.monotonic()))
            count = len(requests)
            if count == 2:
                assert body['tool_choice']['type'] == 'any', body['tool_choice']
                saving.set()
                assert commit.wait(35), 'save was not released'
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()

            def send(kind, **fields):
                self.wfile.write((f'event: {kind}\ndata: ' + json.dumps(dict(type=kind, **fields), ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()

            send('message_start', message=dict(id=f'offline-{count}', type='message', role='assistant', content=[], model='offline-intake', usage=dict(input_tokens=10, output_tokens=0)))
            if count == 1:
                assert body['tool_choice']['type'] == 'auto'
                send('content_block_start', index=0, content_block=dict(type='text', text=''))
                send('content_block_delta', index=0, delta=dict(type='text_delta', text=reply[:12]))
                partial.set()
                assert advance.wait(30), 'first preview was not released'
                for offset in range(12, len(reply), 6):
                    send('content_block_delta', index=0, delta=dict(type='text_delta', text=reply[offset:offset + 6]))
                    time.sleep(.12)
                reason = 'end_turn'
            else:
                args = dict(reply=reply if count == 2 else '收到，先按普通上班族、1000字继续聊方向，不开始正文。', summary='内耗主题，正在澄清写作方向', questions=[])
                send('content_block_start', index=0, content_block=dict(type='tool_use', id=f'save-{count}', name='respond_writing_intake', input={}))
                raw = json.dumps(args, ensure_ascii=False)
                for offset in range(0, len(raw), 20):
                    send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=raw[offset:offset + 20]))
                    time.sleep(.05)
                reason = 'tool_use'
            send('content_block_stop', index=0)
            send('message_delta', delta=dict(stop_reason=reason), usage=dict(output_tokens=100))
            send('message_stop')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            errors.append(str(error))


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
(root / 'user-data/provider.json').write_text(json.dumps(dict(schemaVersion=2, kind='anthropic_compatible', providerId='offline-intake', baseURL=f'http://127.0.0.1:{server.server_port}/v1', credentialRef='env:WRITING_AGENT_RC16_FIXTURE_KEY', model='offline-intake', tools='supported', usage='reported', allowInsecureHttp=True)), encoding='utf-8')
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
report = dict(status='FAIL', mode=mode, root=str(root), requests=requests, errors=errors, realModelCalls=0, originalProjectWrites=0)
with (evidence / 'stderr.log').open('wb') as log:
    proc = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=fixture_id, WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 30
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
            def replies(snapshot):
                return [item['body'] for item in snapshot['timelineBySession'].get(snapshot['selectedSessionId'], []) if item.get('kind') == 'message' and item.get('role') == 'assistant']
            (evidence / 'initial-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
            editor = page.get_by_role('textbox', name='写作指令', exact=True)
            expect(editor).to_be_editable()
            editor.fill('写一个人天天内耗怎么办')
            editor.press('Enter')
            assert partial.wait(15), errors
            live = page.get_by_role('article', name='正在生成的回复', exact=True)
            expect(live).to_be_visible()
            first = rpc('getSnapshot')
            assert first['liveReply']['text'] == reply[:12]
            assert first['previewDocument']['id'] is None
            page.evaluate('window.intakePreview=document.querySelector("[aria-label=正在生成的回复]")')
            page.screenshot(path=str(evidence / 'first-delta.png'))
            advance.set()
            assert saving.wait(20), errors
            page.wait_for_timeout(400)
            during = rpc('getSnapshot')
            assert during['liveReply']['text'] == reply, during.get('liveReply')
            assert during['liveReply']['phase'] == 'saving'
            assert during['liveReply']['id'] == first['liveReply']['id']
            assert page.evaluate('window.intakePreview===document.querySelector("[aria-label=正在生成的回复]")')
            assert during['conversationIntake']['phase'] == 'collecting'
            assert reply not in replies(during)
            page.screenshot(path=str(evidence / 'saving.png'))
            if mode == 'cancel':
                page.get_by_role('region', name='写作进行中').get_by_role('button', name='停止', exact=True).click()
            commit.set()
            deadline = time.monotonic() + 20
            while rpc('getSnapshot')['activeRunId']:
                assert time.monotonic() < deadline
                page.wait_for_timeout(100)
            after = rpc('getSnapshot')
            assert after['liveReply'] is None
            assert after['previewDocument']['id'] is None
            if mode == 'cancel':
                assert after['runRecords'][-1]['status'] == 'cancelled'
                assert reply not in replies(after)
            else:
                assert after['runRecords'][-1]['status'] == 'completed'
                assert replies(after).count(reply) == 1
                assert len(requests) == 2
                expect(page.locator('[data-message-id]').filter(has_text='这个话题可以先聊清楚。')).to_have_count(1)
                expect(editor).to_be_editable()
                editor.fill('普通上班族，1000字，先聊方向')
                editor.press('Enter')
                deadline = time.monotonic() + 20
                while len(requests) < 3 or rpc('getSnapshot')['activeRunId']:
                    assert time.monotonic() < deadline
                    page.wait_for_timeout(100)
                assert rpc('getSnapshot')['conversationIntake']['phase'] == 'collecting'
                assert len(requests) == 3
                page.reload()
                page.wait_for_load_state('networkidle')
                assert any(text.startswith('收到') for text in replies(rpc('getSnapshot')))
                assert len(requests) == 3
            page.screenshot(path=str(evidence / 'final.png'))
            assert not errors, errors
            report.update(status='PASS', streamedBeforeSave=True, samePreviewAcrossSave=True, noBodyCreated=True)
            browser.close()
    finally:
        advance.set(); commit.set()
        if proc.poll() is None:
            proc.terminate(); proc.wait(timeout=10)
        server.shutdown()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
