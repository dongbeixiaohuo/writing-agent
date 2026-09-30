"""Packaged Anthropic SSE: real 60s boundary, stalled response, cancellation and UI."""
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
mode = sys.argv[4]
assert mode in ('long', 'cancel', 'first_timeout', 'idle_timeout')
requests = []
release = threading.Event()
received = threading.Event()
completed = threading.Event()


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        requests.append(time.monotonic())
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('request-id', 'local-rc26-request')
        self.end_headers()
        received.set()

        def send(kind, **fields):
            data = dict(type=kind, **fields)
            self.wfile.write((f'event: {kind}\ndata: ' + json.dumps(data, ensure_ascii=False) + '\n\n').encode())
            self.wfile.flush()

        try:
            if mode in ('cancel', 'first_timeout'):
                release.wait(240)
                return
            if mode == 'long' and release.wait(32):
                return
            send('message_start', message=dict(id='local-msg', type='message', role='assistant', content=[], model='offline-title-test', usage=dict(input_tokens=1, output_tokens=0)))
            send('content_block_start', index=0, content_block=dict(type='tool_use', id='local-tool', name='respond_writing_intake', input={}))
            data = json.dumps(dict(reply='我们可以从一个具体的生活片段聊起。再一起确定文章的角度，不必一次想清楚所有细节。', summary='继续讨论写作方向', questions=['你最近对什么事情有感触？'], proposal=None), ensure_ascii=False)
            if mode == 'idle_timeout':
                send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=data[:24]))
                release.wait(150)
                return
            size = (len(data) + 7) // 8
            for offset in range(0, len(data), size):
                send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=data[offset:offset + size]))
                if release.wait(5):
                    return
            send('content_block_stop', index=0)
            send('message_delta', delta=dict(stop_reason='tool_use'), usage=dict(output_tokens=60))
            send('message_stop')
            completed.set()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
args = ['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port), 'anthropic_compatible']
prepared = json.loads(subprocess.check_output(args, cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc26-waiting-experience' / (mode + '-' + prepared['id'])
evidence.mkdir(parents=True)
report = dict(status='FAIL', mode=mode, realModelCalls=0, originalProjectWrites=0, phases=[], widths=[])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline = time.monotonic() + 25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version', timeout=1) as response:
                    endpoint = json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic() >= deadline:
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

            page.set_viewport_size(dict(width=1054, height=828))
            page.get_by_role('button', name='新建项目', exact=True).click()
            editor = page.get_by_role('textbox', name='写作指令', exact=True)
            editor.fill('rc26隔离体验测试：不知道写什么，和我聊聊。')
            began = time.monotonic()
            editor.press('Enter')
            working = page.get_by_role('region', name='写作进行中', exact=True)
            expect(working).to_be_visible(timeout=5000)
            report['firstFeedbackSeconds'] = round(time.monotonic() - began, 3)
            expect(editor).to_be_focused()
            assert rpc('getSnapshot')['activeRunId']
            page.screenshot(path=str(evidence / 'initial.png'))
            if mode == 'cancel':
                expect(working.get_by_role('button', name='停止', exact=True)).to_be_in_viewport(ratio=1)
                working.get_by_role('button', name='停止', exact=True).click()
            if mode == 'long':
                seen_long = False
                seen_stream = False
                deadline = began + 100
                while not completed.is_set():
                    if time.monotonic() >= deadline:
                        raise AssertionError('long request did not complete')
                    snap = rpc('getSnapshot')
                    assert snap['activeRunId'], 'request was stopped while data kept arriving'
                    activity = snap.get('liveActivity')
                    if activity and activity['phase'] not in report['phases']:
                        report['phases'].append(activity['phase'])
                    elapsed = time.monotonic() - began
                    if elapsed >= 30 and not seen_long:
                        expect(working).to_contain_text('等待模型回复')
                        for width, height in [(1054, 828), (900, 650)]:
                            page.set_viewport_size(dict(width=width, height=height))
                            expect(working.get_by_role('button', name='停止', exact=True)).to_be_in_viewport(ratio=1)
                            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
                            page.screenshot(path=str(evidence / f'waiting-{width}.png'))
                            report['widths'].append(width)
                        seen_long = True
                    if elapsed >= 62 and not seen_stream:
                        expect(page.get_by_label('正在生成的回复', exact=True)).to_contain_text('具体的生活片段')
                        expect(working).to_contain_text('已收到模型数据')
                        page.screenshot(path=str(evidence / 'streaming-after-60s.png'))
                        seen_stream = True
                    page.wait_for_timeout(250)
                assert seen_long and seen_stream
            deadline = time.monotonic() + (215 if mode.endswith('timeout') else 15)
            while True:
                current = rpc('getSnapshot')
                status = current['runRecords'][0]['status'] if current['runRecords'] else None
                if not current['activeRunId'] and status in ('completed', 'waiting_user', 'cancelled', 'failed', 'budget_exhausted'):
                    break
                if time.monotonic() >= deadline:
                    raise AssertionError(f'run did not settle: {status}')
                page.wait_for_timeout(250)
            snapshot = rpc('getSnapshot')
            latest = snapshot['runRecords'][0]
            report.update(durationSeconds=round(time.monotonic() - began, 3), finalStatus=latest['status'], localRequests=len(requests))
            assert len(requests) == 1
            assert snapshot.get('liveReply') is None and snapshot.get('liveActivity') is None
            if mode == 'long':
                assert latest['status'] == 'completed', latest
                expect(editor).to_be_focused()
            elif mode == 'cancel':
                assert latest['status'] == 'cancelled', latest
                assert snapshot['previewDocument']['id'] is None
            else:
                phase = 'first_response' if mode == 'first_timeout' else 'stream_idle'
                assert snapshot['recoverableRuns'][0]['interruption']['timeoutPhase'] == phase
                text = '等待模型回复较久' if phase == 'first_response' else '模型回复中途停顿'
                expect(page.get_by_role('region', name='写作暂停', exact=True)).to_contain_text(text)
                request = latest['diagnostics']['segments'][-1]['modelRequests'][-1]
                assert request['transport']['phase'] == phase
                report['diagnostic'] = request
                assert snapshot['previewDocument']['id'] is None
            page.screenshot(path=str(evidence / 'settled.png'))
            report['status'] = 'PASS'
            browser.close()
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        release.set()
        process.terminate()
        process.wait(timeout=15)
        server.shutdown()
        server.server_close()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence), **report), ensure_ascii=False))
