"""Search feedback / typing latency in a real isolated packaged Electron app."""
import json, os, socket, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')
prepared=json.loads(subprocess.check_output(['node','--import','tsx','tests/ux/prepare_provider_settings.ts'],text=True,encoding='utf-8'))
label=sys.argv[2] if len(sys.argv)>2 else 'current'
evidence=Path('output/rc41/search')/label/prepared['id']
evidence.mkdir(parents=True)
report={'status':'FAIL','originalProjectWrites':0,'realModelCalls':0}
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
with (evidence/'stderr.log').open('wb') as stderr:
    process=subprocess.Popen([sys.argv[1],f'--remote-debugging-port={port}','--remote-debugging-address=127.0.0.1','--disable-gpu'],
        env=dict(os.environ,WRITING_AGENT_DESKTOP_TEST=prepared['id'],WRITING_AGENT_RC37_TEST_KEY='synthetic-key'),
        stdout=subprocess.DEVNULL,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        deadline=time.monotonic()+25
        while True:
            try:
                with urlopen(f'http://127.0.0.1:{port}/json/version',timeout=1) as response: endpoint=json.load(response)['webSocketDebuggerUrl']
                break
            except Exception:
                if time.monotonic()>deadline: raise
                time.sleep(.2)
        with sync_playwright() as p:
            browser=p.chromium.connect_over_cdp(endpoint)
            page=browser.contexts[0].pages[0]
            page.wait_for_load_state('networkidle')
            page.get_by_role('button',name='设置',exact=True).click()
            page.get_by_role('button',name='模型',exact=True).click()
            page.get_by_role('button',name='添加模型供应商',exact=True).click()
            search=page.get_by_label('搜索预置供应商',exact=True)
            search.fill('MiniMax')
            old_select=page.get_by_label('模型供应商',exact=True)
            if old_select.count(): old_select.select_option('cc-minimax')
            else: page.locator('button[data-provider-id="cc-minimax"]').click()
            if '--no-blur' in sys.argv:
                report['disabledBackdropFilters']=page.evaluate("""() => {
                  const elements=[...document.querySelectorAll('*')].filter(el=>getComputedStyle(el).backdropFilter!=='none');
                  for(const el of elements) el.style.backdropFilter='none';
                  return elements.length;
                }""")
            search.scroll_into_view_if_needed()
            search.evaluate("""el => {
              window.__searchFrames=[];
              el.addEventListener('input',()=>{const start=performance.now(), text=el.value;
                requestAnimationFrame(()=>requestAnimationFrame(()=>window.__searchFrames.push({text,ms:performance.now()-start})));});
            }""")
            for index,value in enumerate(['智', '智谱', '腾讯', '腾讯 国际', 'MiniMax', '千问', 'Z.AI', '智谱']):
                search.fill(value)
                page.wait_for_function('n=>window.__searchFrames.length>=n',arg=index+1)
            report['inputToPaintMs']=page.evaluate('window.__searchFrames')
            timings=sorted(item['ms'] for item in report['inputToPaintMs'])
            report['maxInputToPaintMs']=round(max(timings),1)
            report['nativeDropdownSelected']=old_select.input_value() if old_select.count() else None
            report['matchingHiddenOptions']=old_select.locator('option').all_text_contents() if old_select.count() else []
            results=page.locator('button[data-provider-id]')
            report['visibleMatchingChoices']=results.filter(has_text='智谱').count()
            page.screenshot(path=str(evidence/'search.png'))
            # Searching must expose usable matching results without another click.
            assert report['visibleMatchingChoices']>0, 'Search changed hidden options but exposed no matching choices'
            assert not results.filter(has_text='MiniMax').count(), 'Previous selection leaked into filtered results'
            expect(page.get_by_role('status').filter(has_text='找到')).to_be_visible()
            assert report['maxInputToPaintMs']<250, 'Typing stalled for more than 250ms'
            report['status']='PASS'
            browser.close()
    finally:
        process.terminate();process.wait(timeout=15)
        (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence),**report),ensure_ascii=False))
