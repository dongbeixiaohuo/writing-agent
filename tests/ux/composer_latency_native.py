"""Typing in a real long-history desktop copy. No submissions or live model use."""
import json, os, socket, subprocess, sys, time, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
exe, source, run_id, label = sys.argv[1:5]
streaming = '--streaming' in sys.argv
stress = '--stress' in sys.argv
class LocalModel(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers['Content-Length']))
        self.send_response(200); self.send_header('Content-Type','text/event-stream'); self.end_headers()
        try:
            for i in range(6000):
                delta = ('\n\n### 隔离预览\n\n' if i%10==0 else '') + '这是用于测量输入响应的本地流式片段，不会写入原项目。'
                args = ('{"reply":"' if i==0 else '') + json.dumps(delta,ensure_ascii=False)[1:-1]
                call = {'index':0,'function':{'arguments':args, **({'name':'respond_author'} if i==0 else {})}, **({'id':'typing-fixture','type':'function'} if i==0 else {})}
                self.wfile.write(('data: '+json.dumps({'choices':[{'index':0,'delta':{'tool_calls':[call]},'finish_reason':None}]},ensure_ascii=False)+'\n\n').encode()); self.wfile.flush(); time.sleep(.03)
        except (BrokenPipeError,ConnectionResetError): pass
server=ThreadingHTTPServer(('127.0.0.1',0),LocalModel); server.daemon_threads=True
threading.Thread(target=server.serve_forever,daemon=True).start()
prepared = json.loads(subprocess.check_output(['node','--import','tsx','tests/ux/rc16_prepare_electron.ts',source,run_id,str(server.server_port)],text=True,encoding='utf-8'))
evidence = Path('output/rc42/composer') / label / prepared['id']; evidence.mkdir(parents=True)
report = dict(status='FAIL', originalWrites=0, realRequests=0)
with socket.socket() as sock: sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
with (evidence/'stderr.log').open('wb') as stderr:
    process = subprocess.Popen([exe,f'--remote-debugging-port={port}','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],env=dict(os.environ,WRITING_AGENT_DESKTOP_TEST=prepared['id'],WRITING_AGENT_RC16_FIXTURE_KEY='fixture'),stdout=subprocess.DEVNULL,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline=time.monotonic()+30
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version',timeout=1) as response: endpoint=json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic()>deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser=p.chromium.connect_over_cdp(endpoint); page=browser.contexts[0].pages[0]; page.wait_for_load_state('networkidle')
            cdp=page.context.new_cdp_session(page)
            cdp.send('Emulation.setFocusEmulationEnabled',{'enabled':True})
            if stress: cdp.send('Emulation.setCPUThrottlingRate',{'rate':6})
            result=page.evaluate('(args)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:"selectSession",args})',[prepared['projectId'],prepared['sessionId']]); assert result['ok']
            editor=page.get_by_role('textbox',name='写作指令'); editor.wait_for(); editor.click()
            if streaming:
                editor.fill('请讨论这一段的表达，暂不改稿。'); editor.press('Enter')
                page.get_by_text('这是用于测量输入响应的本地流式片段',exact=False).first.wait_for(timeout=20000)
                assert page.get_by_role('button',name='停止生成',exact=True).is_visible(), 'Must measure while streaming, not after completion'
                page.wait_for_timeout(1500)
            page.evaluate('''() => {window.__typing=[]; window.__long=[];new PerformanceObserver(list=>window.__long.push(...list.getEntries().map(e=>e.duration))).observe({type:'longtask',buffered:false});}''')
            cdp.send('Profiler.enable'); cdp.send('Profiler.start')
            editor.evaluate('''el=>el.addEventListener('input',()=>{const start=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>window.__typing.push(performance.now()-start)));})''')
            action_times=[]
            for n, text in enumerate(['我','我想','我想改','我想改一下','我想改一下这段','我想改一下这段文字','继续讨论','暂不发送']):
                began=time.monotonic(); editor.fill(text); page.wait_for_function('n=>window.__typing.length>=n',arg=n+1,timeout=5000); action_times.append(round((time.monotonic()-began)*1000)); page.wait_for_timeout(80)
            profile=cdp.send('Profiler.stop')['profile']; (evidence/'profile.json').write_text(json.dumps(profile),encoding='utf-8')
            report.update(samples=page.evaluate('window.__typing'),longTasks=page.evaluate('window.__long'),messages=page.locator('[data-message-id]').count(),actionMs=action_times,cpuThrottle=6 if stress else 1)
            report['maxMs']=max(report['samples'])
            assert editor.inner_text()=='暂不发送'
            if streaming:
                assert page.get_by_role('button',name='停止生成',exact=True).is_visible()
                page.get_by_role('button',name='停止生成',exact=True).click()
            # Native background windows may be occluded; timing evidence does
            # not depend on Chromium producing a screenshot.
            assert report['maxMs']<150, 'Composer input is blocked >150ms'
            report['status']='PASS'; browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        server.shutdown()
        (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence),**report),ensure_ascii=False))
