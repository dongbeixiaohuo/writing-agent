"""Packaged desktop retry on a read-only backup, using a local SSE fixture only."""
import json
import os
import socket
import sqlite3
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
errors = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            raw = next(m['content'] for m in body['messages'] if '\nCOLLABORATION_STATE=' in (m.get('content') or ''))
            state = json.loads(raw.split('\nCOLLABORATION_STATE=', 1)[1])
            results = [json.loads(m['content']).get('result', {}) for m in body['messages'] if m['role'] == 'tool']
            ready = state['ready'] or any(r.get('status') == 'ready' for r in results)
            unread = next((v for v in state['inputVersionIds'] if not any(r.get('versionId') == v for r in results)), None)
            if state['actor'] == 'director':
                if not ready and unread:
                    name, args = 'read_artifact_version', dict(versionId=unread)
                elif not ready:
                    name, args = 'assess_writing_readiness', dict(status='ready', reason='复用已保存的研究和已确认的方向', questions=[])
                else:
                    name, args = 'director_decide', dict(action='dispatch', stage='outline', reason='本分支只应在旧版本中出现', inputVersionIds=state['inputVersionIds'], questions=[])
            else:
                assert state['actor'] == 'outline', state['actor']
                name, args = 'submit_writing_stage', dict(stage='outline', content='# 节奏不均衡中的自洽\n\n## 观察当下\n从日常节奏切入，不虚构亲历。\n\n## 理解接受\n讨论安时处顺式的接受，不编造书中原话。\n\n## 回到自己\n以克制的和解收束，约 1000 字。')
            requests.append(dict(actor=state['actor'], tool=name))
            frames = [dict(id=f'local-{len(requests)}', choices=[dict(index=0, delta=dict(tool_calls=[dict(index=0, id=f'call-{len(requests)}', type='function', function=dict(name=name, arguments=json.dumps(args, ensure_ascii=False)))]), finish_reason=None)]), dict(choices=[dict(index=0, delta={}, finish_reason='tool_calls')])]
            response = ''.join('data: ' + json.dumps(frame, ensure_ascii=False) + '\n\n' for frame in frames) + 'data: [DONE]\n\n'
            encoded = response.encode()
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            errors.append(str(error))
            self.send_error(500)


def persisted(db_path, run_id):
    with sqlite3.connect(Path(db_path).as_uri() + '?mode=ro', uri=True) as db:
        run = db.execute('SELECT project_id,status,stop_reason FROM runs WHERE id=?', (run_id,)).fetchone()
        versions = db.execute('SELECT id,kind,logical_key,content_hash FROM artifact_versions WHERE project_id=? ORDER BY id', (run[0],)).fetchall()
        seq = db.execute('SELECT MAX(project_seq) FROM events WHERE run_id=?', (run_id,)).fetchone()[0]
        return dict(projectId=run[0], status=run[1], stopReason=run[2], versions=versions, lastSeq=seq)


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
db_path = Path(prepared['root']) / 'workspace/.writing-agent/workspace.sqlite3'
initial = persisted(db_path, prepared['runId'])
source_before = persisted(sys.argv[2], prepared['runId'])
evidence = root / 'output/rc25-retry-assignment' / prepared['id']
evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], realModelCalls=0, requests=requests, fixtureErrors=errors)
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

            rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
            before = rpc('getSnapshot')
            page.set_viewport_size(dict(width=1054, height=828))
            page.get_by_role('button', name='运行记录', exact=False).click()
            page.get_by_role('button', name='对话', exact=True).click()
            button = page.get_by_role('button', name='重试这一步', exact=True)
            expect(button).to_be_in_viewport(ratio=1)
            page.screenshot(path=str(evidence / 'before-retry.png'))
            assert not requests, 'viewing recovery must not automatically retry'
            button.click()
            deadline = time.monotonic() + 30
            while not requests or rpc('getSnapshot')['activeRunId']:
                if time.monotonic() >= deadline:
                    raise AssertionError('retry failed to settle')
                page.wait_for_timeout(100)
            after = rpc('getSnapshot')
            final = persisted(db_path, prepared['runId'])
            page.screenshot(path=str(evidence / 'after-retry.png'))
            report.update(finalStatus=final['status'], stopReason=final['stopReason'], addedVersions=[v[:3] for v in final['versions'] if v not in initial['versions']])
            assert not errors, errors
            assert final['stopReason'] == 'CO_CREATION_CHECKPOINT', report
            assert len(after['runRecords']) == len(before['runRecords']), 'must resume the same run'
            assert after['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id'], 'must not auto-start drafting'
            research = lambda values: [v for v in values if v[1] == 'evidence' or v[2] == f"workflow:{prepared['runId']}:research"]
            assert research(initial['versions']) and research(initial['versions']) == research(final['versions'])
            assert any(r['actor'] == 'outline' for r in requests)
            assert not any(r['actor'] == 'research' or r['tool'] in ('read_material', 'director_decide') for r in requests), 'must reuse the already assigned outline task'
            assert persisted(sys.argv[2], prepared['runId']) == source_before, 'original project changed'
            report.update(status='PASS', sameRunResumed=True, researchUnchanged=True, noRedispatch=True, noMaterialRereads=True, bodyUnchanged=True, originalProjectUnchanged=True, noAutoRetry=True)
            browser.close()
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        process.terminate()
        process.wait(timeout=15)
        server.shutdown()
        server.server_close()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence), **report), ensure_ascii=False))
