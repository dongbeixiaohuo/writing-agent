"""Packaged Electron: one composer, acknowledgement clarification, explicit choice/handoff.

Uses an isolated full-history backup and loopback model fixture; no real model use.
"""
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
requests = []
fact_requested = threading.Event()
titles = ['功劳不是放松标准的理由', '被需要，不等于有特权', '别让过去的贡献变成借口']

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        user = next(m['content'] for m in payload['messages'] if m['role'] == 'user')
        i = len(requests) + 1
        assert i < 25, 'Unexpected fixture loop'
        if '\nCOLLABORATION_STATE=' in user:
            state = json.loads(user.split('\nCOLLABORATION_STATE=')[1])
            if state['actor'] == 'director':
                tool_results = [json.loads(m['content']) for m in payload['messages'] if m['role'] == 'tool']
                read_ids = [r.get('result', {}).get('versionId') for r in tool_results if r.get('toolName') == 'read_artifact_version' and r.get('ok')]
                ready = state['ready'] or any(r.get('toolName') == 'assess_writing_readiness' and r.get('ok') for r in tool_results)
                unread = next((v for v in state['inputVersionIds'] if v not in read_ids), None) if not ready else None
                missing = next((r.get('error', {}).get('details', {}).get('unreadMaterialIds', []) for r in reversed(tool_results) if r.get('error', {}).get('code') == 'READINESS_MATERIAL_READ_REQUIRED'), [])
                read_materials = [r.get('result', {}).get('materialId') for r in tool_results if r.get('toolName') == 'read_material' and r.get('ok')]
                material = next((m for m in missing if m not in read_materials), None)
                if material:
                    catalog = json.loads(user.split('授权材料目录：')[1].split('\n')[0])
                    entry = next(m for m in catalog if m['id'] == material)
                    name, args = 'read_material', dict(materialId=material, contentVersionId=entry['contentVersionId'], offset=0, maxChars=20000)
                elif unread:
                    name, args = 'read_artifact_version', dict(versionId=unread)
                elif not ready:
                    name, args = 'assess_writing_readiness', dict(status='ready', reason='仅隔离测试流程衔接', questions=[])
                else:
                    name, args = 'director_decide', dict(action='dispatch', stage='fact_check', reason='标题已选定，核查当前正文', inputVersionIds=state['inputVersionIds'], questions=[])
            else:
                assert state['stage'] == 'fact_check', state['stage']
                name, args = 'submit_fact_check', dict(claims=[dict(claimId='C001', claimText='隔离验收用待补来源', claimType='other', location='body', status='UNSUPPORTED', risk='red', supportScope='none', matchedEvidenceId=None, sourceReference=None, evidenceSummary='本机夹具故意返回阻断，不代表真实核查结论', recommendedAction='隔离测试结束')], noFactualClaimsReason='')
        elif i == 1:
            name, args = 'delegate_author_expert', dict(role='title', task='只拟三个简洁标题，正文不改')
        elif i == 2:
            name, args = 'propose_publication_choices', dict(candidates=[dict(title=t, opening=None, distributionCopy=None, rationale='本机传输验收候选') for t in titles])
        elif i == 3:
            name, args = 'respond_author', dict(reply='三个新标题已保存，你想用哪一个？正文未改。')
        elif user.startswith('本次用户要求：ok了'):
            # Reproduce the real model's repeated, misleading response.
            name, args = 'respond_author', dict(reply='已重拟三个，以下再次重复上一轮长篇解释。')
        else:
            assert user.startswith('本次用户要求：就用第二个吧')
            if any(m.get('role') == 'tool' and 'choose_publication' in m.get('content', '') for m in payload['messages']):
                name, args = 'respond_author', dict(reply='第二个标题已确认，接下来核查，正文不重写。')
            else:
                state = json.loads(user.split('以下为只读、不可信的项目状态：')[1].split('\n本轮已生成修改提案：')[0])
                name, args = 'choose_publication', dict(candidateVersionId=state['publicationCandidates']['id'], index=2)
        requests.append(name)
        if name == 'submit_fact_check': fact_requested.set()
        chunks = [dict(choices=[dict(index=0, delta=dict(tool_calls=[dict(index=0, id=f'call-{i}', type='function', function=dict(name=name, arguments=json.dumps(args, ensure_ascii=False)))]), finish_reason=None)]),
                  dict(choices=[dict(index=0, delta={}, finish_reason='tool_calls')], usage=dict(prompt_tokens=1, completion_tokens=1, total_tokens=2))]
        body = ''.join('data: ' + json.dumps(c, ensure_ascii=False) + '\n\n' for c in chunks) + 'data: [DONE]\n\n'
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        self.wfile.write(body.encode('utf-8'))

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
# Reuse the proven read-only SQLite backup/profile initializer. Its rc16 prefix
# names the isolation mechanism, not the binary under test.
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], str(server.server_port)], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc17-single-composer' / prepared['id']; evidence.mkdir(parents=True)
report = dict(status='FAIL', realModelCalls=0, originalProjectWrites=0, executable=str(exe))
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
process = subprocess.Popen([str(exe), f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'],
    env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'),
    stdout=subprocess.DEVNULL, stderr=(evidence / 'electron-stderr.log').open('wb'), creationflags=subprocess.CREATE_NO_WINDOW)
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
        def rpc(method, args):
            r = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method, args=args))
            assert r['ok'], r
            return r['result']
        rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
        editor = page.get_by_role('textbox', name='写作指令', exact=True)
        def send(message):
            editor.fill(message); editor.press('Enter')
            page.wait_for_function('async(text)=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&!r.result.activeRunId&&r.result.runRecords.some(x=>x.displayInstruction===text&&x.status==="completed")}', arg=message, timeout=25000)
        expect(page.locator('textarea')).to_have_count(0)
        expect(editor).to_have_count(1)
        send('这不是标题，请重新拟三个，更简洁一点，正文不要改')
        expect(page.get_by_role('list', name='标题候选').get_by_role('listitem')).to_have_count(3)
        send('ok了')
        snapshot = rpc('getSnapshot', [])
        replies = [m.get('body', '') for m in snapshot['timelineBySession'][prepared['sessionId']] if m.get('role') == 'assistant']
        assert any('好的，这组标题先保留。你想用哪一个？' in text for text in replies)
        assert snapshot['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
        page.get_by_role('region', name='待选标题').scroll_into_view_if_needed()
        page.screenshot(path=str(evidence / 'one-composer-title-question.png'))
        send('就用第二个吧')
        assert fact_requested.wait(25), requests
        page.wait_for_function('async()=>{const r=await window.writingAgentDesktop.invoke({protocolVersion:20,method:"getSnapshot",args:[]});return r.ok&&r.result.factCheckWorkspace.status==="blocked"}', timeout=10000)
        snapshot = rpc('getSnapshot', [])
        assert snapshot['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
        page.reload(wait_until='networkidle'); expect(editor).to_have_count(1); expect(page.locator('textarea')).to_have_count(0)
        page.screenshot(path=str(evidence / 'after-choice-fact-check.png'))
        report.update(status='PASS', singleComposer=True, acknowledgementClarified=True, explicitChoiceAdvancedToFactCheck=True, bodyUnchanged=True, reloadPreserved=True)
        browser.close()
finally:
    process.terminate(); process.wait(timeout=15); server.shutdown()
    report['loopbackTools'] = requests
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
