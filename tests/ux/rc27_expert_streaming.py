"""Packaged Electron + real Anthropic SSE wire format; replay read-only incident outputs.

Only fresh TEMP workspaces and local HTTP are used. No paid calls or original writes.
Usage: python tests/ux/rc27_expert_streaming.py EXE SOURCE_DB plain|content_first|cancel
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
mode = sys.argv[3]
inline_confirmation = '--inline-confirmation' in sys.argv[4:]
reviews = '--reviews' in sys.argv[4:]
stepwise = '--stepwise' in sys.argv[4:]
protected_run = '--protected' in sys.argv[4:]
harness_text = '--harness-text' in sys.argv[4:]
app_path = sys.argv[sys.argv.index('--app') + 1] if '--app' in sys.argv else None
target = 'review_editor' if reviews else 'outline'
label = '编辑审校' if reviews else '文章提纲'
assert mode in ('plain', 'content_first', 'cancel')
requests = []
errors = []
partial = threading.Event()
advance = threading.Event()
saving = threading.Event()
commit = threading.Event()
replay = {}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            blocks = [b for m in body['messages'] for b in (m['content'] if isinstance(m['content'], list) else [dict(type='text', text=m['content'])])]
            raw = next((b['text'] for b in blocks if b['type'] == 'text' and '\nCOLLABORATION_STATE=' in b['text']), None)
            discussion = stepwise and raw is None
            state = dict(actor='review_editor', ready=True, inputVersionIds=[]) if discussion else json.loads(raw.split('\nCOLLABORATION_STATE=', 1)[1])
            results = [json.loads(b['content']).get('result', {}) for b in blocks if b['type'] == 'tool_result']
            ready = state['ready'] or any(r.get('status') == 'ready' for r in results)
            unread = next((v for v in state['inputVersionIds'] if not any(r.get('versionId') == v for r in results)), None)
            requests.append(dict(actor=state['actor'], discussion=discussion, at=time.monotonic()))
            if reviews and state['actor'] == 'director':
                names = [tool['name'] for tool in body['tools']]
                requests[-1].update(ready=ready, canDispatch='director_decide' in names)
                time.sleep(.8)
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()

            def send(kind, **fields):
                self.wfile.write((f'event: {kind}\ndata: ' + json.dumps(dict(type=kind, **fields), ensure_ascii=False) + '\n\n').encode())
                self.wfile.flush()

            def end(reason):
                send('content_block_stop', index=0)
                send('message_delta', delta=dict(stop_reason=reason), usage=dict(output_tokens=100))
                send('message_stop')

            send('message_start', message=dict(id='local', type='message', role='assistant', content=[], model='offline-expert-replay', usage=dict(input_tokens=10, output_tokens=0)))
            if discussion:
                assert 'ACTOR=review_editor' in str(body['system'])
                assert 'respond_author' not in [tool['name'] for tool in body['tools']]
                send('content_block_start', index=0, content_block=dict(type='text', text=''))
                send('content_block_delta', index=0, delta=dict(type='text_delta', text='第二条保留原表达，我已调整这轮建议。你认可后我们再交给发布审校专家；正文尚未修改。'))
                end('end_turn')
                return
            if state['actor'] == 'director':
                assert reviews or not ready, 'saved assignment must not be dispatched again'
                name, args = ('director_decide', dict(action='dispatch', stage=state['nextStage'], reason='按已确认正文审校', questions=[])) if ready else ('read_artifact_version', dict(versionId=unread)) if unread else ('assess_writing_readiness', dict(status='ready', reason='继续已绑定的专家任务', questions=[]))
                send('content_block_start', index=0, content_block=dict(type='tool_use', id=f't{len(requests)}', name=name, input={}))
                send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=json.dumps(args, ensure_ascii=False)))
                end('tool_use')
                return
            if reviews and state['actor'] in ('review_publish', 'review_reader'):
                if stepwise:
                    send('content_block_start', index=0, content_block=dict(type='text', text=''))
                    for text in ['## 本轮结论\n\n', '发布风险较低。\n\n', '### 优先讨论\n\n建议缩短标题，保留正文。']:
                        send('content_block_delta', index=0, delta=dict(type='text_delta', text=text))
                        time.sleep(.2)
                    end('end_turn')
                    return
                send('content_block_start', index=0, content_block=dict(type='tool_use', id='save-' + state['actor'], name='submit_writing_stage', input={}))
                raw = json.dumps(dict(content='## 审校建议\n\n建议保留当前的克制表达，减少重复说明。', stage=state['stage']), ensure_ascii=False)
                for offset in range(0, len(raw), 15):
                    send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=raw[offset:offset+15]))
                    time.sleep(.3)
                end('tool_use')
                return
            assert state['actor'] == target, state
            if harness_text:
                assert 'submit_writing_stage' not in [tool['name'] for tool in body['tools']]
            attempt = sum(r['actor'] == target for r in requests)
            if mode != 'content_first' and attempt == 1:
                send('content_block_start', index=0, content_block=dict(type='text', text=''))
                send('content_block_delta', index=0, delta=dict(type='text_delta', text=replay['plain'][:160]))
                partial.set()
                assert advance.wait(25), 'test did not release first partial'
                if mode == 'cancel':
                    return
                for offset in range(160, len(replay['plain']), 400):
                    send('content_block_delta', index=0, delta=dict(type='text_delta', text=replay['plain'][offset:offset+400]))
                    time.sleep(.3)
                end('end_turn')
                return
            send('content_block_start', index=0, content_block=dict(type='tool_use', id='save-outline', name='submit_writing_stage', input={}))
            # Deliberately put stage AFTER the entire content string.
            raw = json.dumps(dict(content=replay['saved'], stage=target), ensure_ascii=False)
            send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=raw[:190]))
            if mode == 'content_first':
                partial.set()
                assert advance.wait(25), 'test did not release content-first partial'
            else:
                saving.set()
                assert commit.wait(55), 'test did not release save'
            for offset in range(190, len(raw), 400):
                send('content_block_delta', index=0, delta=dict(type='input_json_delta', partial_json=raw[offset:offset+400]))
                time.sleep(.2)
            end('tool_use')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:
            errors.append(str(error))


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc27_prepare_expert.ts', sys.argv[2], str(server.server_port), 'protected' if protected_run else 'reviews' if reviews else 'outline'], cwd=root, text=True, encoding='utf-8'))
replay.update(json.loads((Path(prepared['root']) / 'replay.json').read_text(encoding='utf-8')))
if harness_text:
    replay['saved'] = replay['plain']
evidence = root / ('output/stepwise/native' if stepwise else 'output/stream-stage/native' if harness_text else 'output/rc30-protected-recovery' if protected_run else 'output/rc29-review-streaming' if reviews else 'output/rc28-inline-confirmation' if inline_confirmation else 'output/rc27-expert-streaming') / (mode + '-' + prepared['id'])
evidence.mkdir(parents=True)
report = dict(status='FAIL', mode=mode, realModelCalls=0, originalProjectWrites=0, requests=requests, errors=errors, lengths=[], replayLengths=[len(replay['plain']), len(replay['saved'])])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1]] + ([app_path] if app_path else []) + [f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
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
            page.set_viewport_size(dict(width=1054, height=828))
            page.get_by_role('button', name='运行记录', exact=False).click()
            page.get_by_role('button', name='对话', exact=True).click()
            before = rpc('getSnapshot')
            body_before = before['revisionWorkspace']['bodyVersionId']
            def target_artifact(snapshot):
                workspace = snapshot['materialProcessWorkspace']
                return next((a for a in workspace['reviews'] if a['stage'] == target), None) if reviews else workspace['outline']
            if protected_run:
                assert before['recoverableRuns'][0]['status'] == 'budget_exhausted'
                page.screenshot(path=str(evidence / 'protected-recovery.png'))
            page.get_by_role('button', name='继续未完成步骤' if protected_run else '重试这一步', exact=True).click()
            assert partial.wait(10), errors
            live = page.get_by_role('article', name='正在生成的回复', exact=True)
            expect(live).to_be_visible(timeout=5000)
            preview = rpc('getSnapshot')['liveReply']
            assert 0 < len(preview['text']) < 250, preview
            assert target_artifact(rpc('getSnapshot')) is None, 'partial output was committed'
            if reviews:
                activity = rpc('getSnapshot')['liveActivity']
                report['segmentStartedAt'] = activity['segmentStartedAt']
                assert activity['startedAt'] > activity['segmentStartedAt'], 'expert did not retain director start time'
                expect(page.get_by_role('region', name='写作进行中')).to_contain_text('本轮已用时')
                expect(page.get_by_role('button', name='运行记录', exact=False)).to_contain_text('本轮')
                report['initialOrdinal'] = activity['requestOrdinal']
            page.evaluate('window.rc27Node=document.querySelector("[aria-label=正在生成的回复]")')
            report['previewId'] = preview['id']
            report['lengths'].append(len(preview['text']))
            page.screenshot(path=str(evidence / 'first-delta.png'))
            if mode == 'cancel':
                page.get_by_role('region', name='写作进行中', exact=True).get_by_role('button', name='停止', exact=True).click()
                advance.set()
                expect(live).to_have_count(0)
                cancelled = rpc('getSnapshot')
                assert cancelled['runRecords'][0]['status'] == 'cancelled'
                assert target_artifact(cancelled) is None
                assert cancelled.get('liveReply') is None
                report['cancelledWithoutSaving'] = True
            else:
                advance.set()
                if mode == 'plain' and not harness_text:
                    assert saving.wait(15), errors
                    page.wait_for_timeout(500)
                    snap = rpc('getSnapshot')
                    assert snap['liveReply']['text'] == replay['plain'], 'full preview was lost or rewound during save request'
                    expect(live).to_contain_text('正在保存')
                    assert target_artifact(snap) is None
                    report['savingScrollTop'] = page.locator('[data-conversation-feed]').evaluate('(e)=>e.scrollTop')
                    page.screenshot(path=str(evidence / 'saving-without-rewind.png'))
                    commit.set()
                deadline = time.monotonic() + 20
                while True:
                    snap = rpc('getSnapshot')
                    if reviews and snap.get('liveActivity'):
                        activity = snap['liveActivity']
                        assert activity['segmentStartedAt'] == report['segmentStartedAt'], 'segment clock reset'
                        assert activity['requestOrdinal'] >= report['initialOrdinal']
                        report['lastOrdinal'] = activity['requestOrdinal']
                    if reviews:
                        assert len(snap['runRecords']) == len(before['runRecords']), 'continuation created another logical task'
                    if snap.get('liveReply'):
                        report['lengths'].append(len(snap['liveReply']['text']))
                        if mode == 'content_first' and len(snap['liveReply']['text']) > 900 and not report.get('readerScrollPreserved'):
                            feed = page.locator('[data-conversation-feed]')
                            feed.hover()
                            page.mouse.wheel(0, -5000)
                            page.wait_for_timeout(450)
                            assert feed.evaluate('(e)=>e.scrollTop') < 100, 'streaming pulled the reader down after deliberate upward scroll'
                            expect(page.get_by_role('button', name='回到最新进度 ↓', exact=True)).to_be_visible()
                            page.get_by_role('button', name='回到最新进度 ↓', exact=True).click()
                            report['readerScrollPreserved'] = True
                    if not snap['activeRunId'] and snap['runRecords'][0]['status'] == 'waiting_user':
                        break
                    assert time.monotonic() < deadline, 'expert did not reach confirmation checkpoint'
                    page.wait_for_timeout(100)
                saved = page.locator('[data-message-id]').filter(has_text=label + ' · 已保存')
                expect(saved).to_have_count(1)
                assert page.evaluate('(id)=>window.rc27Node===Array.from(document.querySelectorAll("[data-message-id]")).find(n=>n.dataset.messageId===id)', preview['id']), 'saved artifact replaced its preview DOM node'
                assert target_artifact(snap)['content'] == replay['saved']
                assert snap['revisionWorkspace']['bodyVersionId'] == body_before, 'must not change the body during review'
                assert snap['runRecords'][0]['stopReason'] == 'CO_CREATION_CHECKPOINT'
                if inline_confirmation:
                    expect(page.get_by_role('region', name='共创决策', exact=True)).to_have_count(0)
                    expect(page.get_by_role('region', name='本阶段成果', exact=True)).to_have_count(0)
                    expect(saved).to_contain_text('这个方向可以吗？确认后我继续写初稿，也可以直接告诉我怎么改。')
                    expect(page.get_by_role('textbox', name='写作指令', exact=True)).to_be_editable()
                    assert page.get_by_text('等待你的确认', exact=True).count() == 0
                    report['inlineConfirmationOnly'] = True
                page.wait_for_timeout(350)
                report['savedScrollTop'] = page.locator('[data-conversation-feed]').evaluate('(e)=>e.scrollTop')
                if mode == 'plain' and not harness_text:
                    assert report['savedScrollTop'] >= report['savingScrollTop'] - 100, 'saving jumped back to the beginning of the outline'
                page.screenshot(path=str(evidence / 'saved.png'))
                if inline_confirmation:
                    count_before_reload = len(requests)
                    page.reload()
                    page.wait_for_load_state('networkidle')
                    rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
                    page.get_by_role('button', name='运行记录', exact=False).click()
                    page.get_by_role('button', name='对话', exact=True).click()
                    expect(page.get_by_role('region', name='共创决策', exact=True)).to_have_count(0)
                    expect(page.get_by_role('region', name='本阶段成果', exact=True)).to_have_count(0)
                    expect(page.get_by_text('这个方向可以吗？确认后我继续写初稿，也可以直接告诉我怎么改。', exact=True)).to_have_count(1)
                    expect(page.get_by_role('textbox', name='写作指令', exact=True)).to_be_editable()
                    assert len(requests) == count_before_reload
                    report['reopenedWithoutDuplicatesOrRequests'] = True
                    page.screenshot(path=str(evidence / 'reopened.png'))
                if stepwise:
                    assert {a['stage'] for a in snap['materialProcessWorkspace']['reviews']} == {'review_editor'}
                    expect(saved.locator('[data-expert-stage="review_editor"]')).to_contain_text('编辑审校专家')
                    expect(saved).to_contain_text('确认后才交给发布审校专家')
                    composer = page.get_by_role('textbox', name='写作指令', exact=True)
                    expect(composer).to_have_count(1)
                    composer.fill('第二条不改，先解释一下')
                    composer.press('Enter')
                    expect(page.get_by_text('第二条保留原表达，我已调整这轮建议。你认可后我们再交给发布审校专家；正文尚未修改。', exact=True)).to_be_visible(timeout=15000)
                    assert not any(r['actor'] in ('review_publish', 'review_reader') for r in requests)
                    assert rpc('getSnapshot')['revisionWorkspace']['bodyVersionId'] == body_before
                    page.screenshot(path=str(evidence / 'review-discussion.png'))
                    composer.fill('ok')
                    composer.press('Enter')
                    expect(page.get_by_text('发布审校的建议你认可吗？可以先讨论、调整；确认后才交给读者审校专家。', exact=True)).to_be_visible(timeout=20000)
                    assert any(r['actor'] == 'review_publish' for r in requests)
                    assert not any(r['actor'] == 'review_reader' for r in requests)
                    page.reload()
                    page.wait_for_load_state('networkidle')
                    rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
                    expect(page.locator('[data-expert-stage="review_publish"]')).to_contain_text('发布审校专家')
                    assert rpc('getSnapshot')['revisionWorkspace']['bodyVersionId'] == body_before
                    page.screenshot(path=str(evidence / 'next-expert-waiting.png'))
                    report.update(stepwiseHandoff=True, discussionStayedWithEditor=True, oneComposer=True, restartPreserved=True)
                elif reviews:
                    assert all(r['canDispatch'] == r['ready'] for r in requests if r['actor'] == 'director'), 'readiness must control advertised tools'
                    assert report['lastOrdinal'] > report['initialOrdinal']
                    assert {a['stage'] for a in snap['materialProcessWorkspace']['reviews']} == {'review_editor', 'review_publish', 'review_reader'}
                    expect(page.get_by_text('这些审校建议你认可吗？确认后我按建议修订；你也可以说明哪些要保留或调整。', exact=True)).to_have_count(1)
                report.update(sameDomNode=True, exactlyOneSavedTarget=True, bodyUnchanged=True)
                if harness_text:
                    assert sum(r['actor'] == target and not r.get('discussion') for r in requests) == 1, 'saving must not request another model call'
            assert not errors, errors
            report['status'] = 'PASS'
            browser.close()
    except Exception as error:
        report['error'] = str(error)
        raise
    finally:
        advance.set()
        commit.set()
        process.terminate()
        process.wait(timeout=15)
        server.shutdown()
        server.server_close()
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence), **report), ensure_ascii=False))
