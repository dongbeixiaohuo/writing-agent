"""Isolated desktop deletion regression. No production workspace or model calls."""
import json, os, socket, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

prepared = json.loads(subprocess.check_output(['node','--import','tsx','tests/ux/prepare_delete_project.ts'],text=True))
evidence = Path('output/delete-project') / prepared['id']
evidence.mkdir(parents=True)
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0))
    port=sock.getsockname()[1]
report={'status':'FAIL','originalProjectWrites':0,'modelCalls':0}
with (evidence/'stderr.log').open('wb') as stderr:
    process=subprocess.Popen([sys.argv[1],f'--remote-debugging-port={port}','--remote-debugging-address=127.0.0.1','--disable-gpu'],env=dict(os.environ,WRITING_AGENT_DESKTOP_TEST=prepared['id']),stdout=subprocess.DEVNULL,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline=time.monotonic()+25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version',timeout=1) as response:
                    endpoint=json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic()>deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser=p.chromium.connect_over_cdp(endpoint)
            page=browser.contexts[0].pages[0]
            page.wait_for_load_state('networkidle')
            subprocess.check_call(['node','--import','tsx','tests/ux/prepare_delete_project.ts',prepared['root']])
            def rpc(method,args=[]):
                return page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,...x})',dict(method=method,args=args))
            report['rawFailure']=rpc('deleteProject',['executing','正在写作项目'])
            report['crossBridgeFailure']=page.evaluate('''async()=>{try{await window.writingAgentDesktop.deleteProject('executing','正在写作项目');return null}catch(e){return {message:e.message,code:e.code||null}}}''')
            report['buttons']=page.get_by_role('button').evaluate_all('(els)=>els.map(e=>({text:e.textContent,label:e.getAttribute("aria-label"),title:e.title}))')
            if '--probe' not in sys.argv:
                assert report['rawFailure']['error']['code']=='PROJECT_DELETE_RUN_ACTIVE',report
                page.get_by_role('button',name='删除项目“正在写作项目”',exact=True).click()
                dialog=page.get_by_role('dialog')
                dialog.get_by_role('textbox').fill('正在写作项目')
                dialog.get_by_role('button',name='永久删除项目',exact=True).click()
                dialog.get_by_text('这个项目仍在写作中。请先停止该项目的任务，再删除；其他项目不受影响。',exact=True).wait_for()
                page.screenshot(path=str(evidence/'active-error.png'))
                dialog.get_by_role('button',name='取消',exact=True).click()
                assert rpc('selectSession',['waiting','s-waiting'])['ok']
                page.get_by_role('button',name='删除项目“待删除确认项目”',exact=True).click()
                dialog=page.get_by_role('dialog')
                dialog.get_by_role('textbox').fill('wrong')
                assert dialog.get_by_role('button',name='永久删除项目',exact=True).is_disabled()
                dialog.get_by_role('textbox').fill('待删除确认项目')
                dialog.get_by_role('button',name='永久删除项目',exact=True).click()
                dialog.wait_for(state='hidden')
                snapshot=rpc('getSnapshot')['result']
                assert sorted(x['id'] for x in snapshot['projects'])==['executing','other']
                page.reload();page.wait_for_load_state('networkidle')
                snapshot=rpc('getSnapshot')['result']
                assert sorted(x['id'] for x in snapshot['projects'])==['executing','other']
                page.screenshot(path=str(evidence/'deleted.png'))
                report.update(status='PASS',reloadPreserved=True,otherProjectsPreserved=True,deletedSelectedProject=True)
            else: report['status']='PROBED'
            browser.close()
    finally:
        process.terminate();process.wait(timeout=15)
        (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'evidence':str(evidence),'status':report['status'],'rawFailure':report.get('rawFailure'),'crossBridgeFailure':report.get('crossBridgeFailure')},ensure_ascii=False))
