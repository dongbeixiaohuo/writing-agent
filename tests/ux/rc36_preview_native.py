"""Packaged client: real local SSE -> temporary materials -> streamed final -> one checkpoint."""
import json, os, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
research_ready, research_release, outline_ready, outline_release = [threading.Event() for _ in range(4)]
requests, errors = [], []

class Provider(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_POST(self):
        try:
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            blocks = [b for m in body['messages'] for b in (m['content'] if isinstance(m['content'], list) else [dict(type='text',text=m['content'])])]
            raw = next(b['text'] for b in blocks if b['type']=='text' and '\nCOLLABORATION_STATE=' in b.get('text',''))
            state = json.loads(raw.split('\nCOLLABORATION_STATE=')[1])
            requests.append(dict(actor=state['actor']))
            self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
            def send(kind, **kw):
                self.wfile.write((f'event: {kind}\ndata: '+json.dumps(dict(type=kind,**kw),ensure_ascii=False)+'\n\n').encode()); self.wfile.flush()
            def end(reason):
                send('content_block_stop',index=0); send('message_delta',delta=dict(stop_reason=reason),usage=dict(output_tokens=120)); send('message_stop')
            def tool(name,args):
                send('content_block_start',index=0,content_block=dict(type='tool_use',id='t'+str(len(requests)),name=name,input={}))
                send('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=json.dumps(args,ensure_ascii=False))); end('tool_use')
            send('message_start',message=dict(id='r',type='message',role='assistant',content=[],model='offline-preview',usage=dict(input_tokens=10,output_tokens=0)))
            if state['actor']=='research':
                send('content_block_start',index=0,content_block=dict(type='tool_use',id='research',name='submit_writing_stage',input={}))
                raw = json.dumps(dict(stage='research',content=json.dumps(dict(claims=[],notes='临时素材：保留作者的安静感受，不虚构亲历。'),ensure_ascii=False)),ensure_ascii=False)
                cut = raw.index('安静')+2
                send('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=raw[:cut]))
                research_ready.set(); assert research_release.wait(40), 'preview was not observed'
                send('content_block_delta',index=0,delta=dict(type='input_json_delta',partial_json=raw[cut:])); end('tool_use'); return
            if state['actor']=='director':
                results=[json.loads(b['content']).get('result',{}) for b in blocks if b['type']=='tool_result']
                unread=next((v for v in state['inputVersionIds'] if not any(r.get('versionId')==v for r in results)),None)
                ready=state['ready'] or any(r.get('status')=='ready' for r in results)
                if not ready and unread: tool('read_artifact_version',dict(versionId=unread))
                elif not ready: tool('assess_writing_readiness',dict(status='ready',reason='纯感受材料充分',questions=[]))
                else: tool('director_decide',dict(action='dispatch',stage=state['nextStage'],reason='写短提纲并等待确认',questions=[]))
                return
            assert state['actor']=='outline', state['actor']
            send('content_block_start',index=0,content_block=dict(type='text',text=''))
            send('content_block_delta',index=0,delta=dict(type='text_delta',text='## 安静的节日\n\n先写节日里的距离感。'))
            outline_ready.set(); assert outline_release.wait(30), 'outline was not observed'
            send('content_block_delta',index=0,delta=dict(type='text_delta',text='\n\n再写允许自己不过节的轻松。\n\n结尾留一点温柔的自嘲。')); end('end_turn')
        except (BrokenPipeError,ConnectionResetError): pass
        except Exception as ex: errors.append(str(ex))

server=ThreadingHTTPServer(('127.0.0.1',0),Provider)
threading.Thread(target=server.serve_forever,daemon=True).start()
prepared=json.loads(subprocess.check_output(['node','--import','tsx','tests/ux/rc36_prepare_preview.ts',str(server.server_port)],cwd=root,text=True,encoding='utf-8'))
evidence=root/'output/rc36/native'/prepared['id']; evidence.mkdir(parents=True)
report=dict(status='FAIL',requests=requests,errors=errors,originalProjectWrites=0,realModelCalls=0)
with socket.socket() as sock: sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
with (evidence/'stderr.log').open('wb') as stderr:
    process=subprocess.Popen([sys.argv[1],f'--remote-debugging-port={port}','--remote-debugging-address=127.0.0.1','--disable-gpu'],env=dict(os.environ,WRITING_AGENT_DESKTOP_TEST=prepared['id'],WRITING_AGENT_RC36_KEY='not-real'),stdout=subprocess.DEVNULL,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline=time.monotonic()+30
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version',timeout=1) as response: endpoint=json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                assert time.monotonic()<deadline, 'client did not open'; time.sleep(.2)
        with sync_playwright() as p:
            browser=p.chromium.connect_over_cdp(endpoint); page=browser.contexts[0].pages[0]; page.wait_for_load_state('networkidle')
            def rpc(method,args=None):
                result=page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})',dict(method=method,args=args or [])); assert result['ok'],result; return result['result']
            rpc('selectSession',[prepared['projectId'],prepared['sessionId']]); page.set_viewport_size(dict(width=1200,height=850))
            expect(page.locator('[data-message-id] h3').filter(has_text='写作方向')).to_have_count(1)
            page.get_by_role('button',name='重试这一步',exact=True).click()
            assert research_ready.wait(15),errors
            preview=page.get_by_role('complementary',name='临时素材预览'); expect(preview).to_contain_text('临时素材：保留作者的安静',timeout=5000)
            assert 'claims' not in preview.inner_text(); assert rpc('getSnapshot')['liveReply'] is None
            page.screenshot(path=str(evidence/'temporary-material.png')); research_release.set()
            assert outline_ready.wait(15),errors
            live=page.get_by_role('article',name='正在生成的回复',exact=True); expect(live).to_contain_text('先写节日里的距离感。')
            expect(preview).to_have_count(0)
            snap=rpc('getSnapshot'); assert snap['materialProcessWorkspace']['outline'] is None
            report['firstPublicLength']=len(snap['liveReply']['text'])
            page.screenshot(path=str(evidence/'partial-final.png')); outline_release.set()
            expect(page.get_by_text('这个方向可以吗？确认后我继续写初稿，也可以直接告诉我怎么改。',exact=True)).to_be_visible(timeout=15000)
            expect(preview).to_have_count(0); expect(live).to_have_count(0)
            snap=rpc('getSnapshot'); assert len(snap['materialProcessWorkspace']['outline']['content'])>report['firstPublicLength']
            assert not any('临时素材' in item.get('body','') for item in snap['timelineBySession'][prepared['sessionId']])
            page.get_by_role('button',name='运行记录',exact=True).click()
            expect(page.get_by_text('写作流程 · 9 个阶段',exact=False)).to_be_visible()
            expect(page.get_by_text('去 AI 味与语言润色',exact=False).first).to_be_visible()
            expect(page.get_by_text('按平台模拟目标读者感受、弃读点与传播动机',exact=True)).to_be_visible()
            page.screenshot(path=str(evidence/'stage-records.png'))
            report['status']='PASS'; browser.close()
    finally:
        research_release.set(); outline_release.set(); process.terminate(); process.wait(timeout=10); server.shutdown()
        (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8'); print(json.dumps(dict(evidence=str(evidence),**report),ensure_ascii=False))
