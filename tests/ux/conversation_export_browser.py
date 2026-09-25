"""Actual UI and desktop host; native chooser/reveal are adapters, not OS automation."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
evidence = root / 'output' / 'conversation-export-browser'
evidence.mkdir(parents=True, exist_ok=True)
# The host picks a random loopback port and emits its readiness JSON. This cannot
# use with_server.py's fixed-port readiness check.
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/ux/conversation_export_fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
report = {'realModelCalls': 0, 'nativeDialog': 'adapter-only; manual desktop acceptance pending', 'checks': []}

def rpc(request):
    server.stdin.write(json.dumps(request, ensure_ascii=False) + '\n')
    server.stdin.flush()
    return json.loads(server.stdout.readline())

try:
    ready = json.loads(server.stdout.readline())
    report['workspace'] = ready['root']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1360, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.expose_binding('__fixtureRpc', lambda source, request: rpc(request))
        page.add_init_script("""(() => {
          const invoke = request => window.__fixtureRpc(request);
          const call = async (method,args) => { const response = await invoke({protocolVersion:PROTOCOL,method,args});
            if (!response.ok) throw Object.assign(new Error(response.error.message),{code:response.error.code});
            return response.result; };
          window.writingAgentDesktop = { invoke,
            subscribe: listener => { const timer=setInterval(async()=>{
              const result=await invoke({protocolVersion:PROTOCOL,method:'getSnapshot',args:[]});
              if(result.ok) listener(result.snapshot);
            },350); return ()=>clearInterval(timer); },
            savePublicationAs: input=>call('savePublicationAs',[input]),
            revealPublication: id=>call('revealPublication',[id]) };
        })();""".replace('PROTOCOL', str(ready['protocolVersion'])))
        page.goto(ready['origin'], wait_until='networkidle')
        card = page.get_by_role('region', name='文章导出')
        button = card.get_by_role('button', name='导出文章', exact=True)
        expect(button).to_be_enabled()
        button.click()  # No force-click; catches composer occlusion.
        expect(card.get_by_text('文章已导出。', exact=True)).to_be_visible()
        html = Path(ready['root']) / 'saved' / '夜跑随想.html'
        assert '<strong>放慢脚步</strong>' in html.read_text(encoding='utf-8')
        expect(card.get_by_text(str(html), exact=False)).to_be_visible()
        card.get_by_role('button', name='打开所在文件夹').click()
        assert rpc({'method': 'testReveal'})['path'] == str(html)
        report['checks'].append('main-conversation-html-save-readback-and-reveal-receipt')
        page.screenshot(path=str(evidence / '01-export-success.png'))

        page.set_viewport_size({'width': 960, 'height': 640})
        card.get_by_label('导出文件格式').select_option('txt')
        button.click()
        expect(card.get_by_text('夜跑随想.txt', exact=False)).to_be_visible()
        assert '**' not in (html.parent / '夜跑随想.txt').read_text(encoding='utf-8')
        report['checks'].append('txt-save-readback-at-960x640-without-force-click')
        rpc({'method': 'testChoice', 'args': ['cancel']})
        button.click()
        expect(card.get_by_text('已取消导出，没有保存新的文件。')).to_be_visible()
        expect(card.get_by_role('button', name='打开所在文件夹')).to_have_count(0)
        report['checks'].append('cancel-is-not-success')
        rpc({'method': 'testChoice', 'args': ['invalid']})
        button.click()
        expect(card.get_by_role('alert')).to_contain_text('选择工作区之外')
        report['checks'].append('save-error-is-actionable')
        rpc({'method': 'testChangeBody'})
        expect(button).to_be_disabled()
        expect(card.get_by_text('稿件已修改，需要重新核查当前版本后再导出。')).to_be_visible()
        report['checks'].append('edited-body-removes-ready-state')
        page.screenshot(path=str(evidence / '02-recheck-required.png'))
        assert not errors, errors
        report['pageErrors'] = errors
        report['status'] = 'PASS'
        browser.close()
finally:
    if server.poll() is None:
        server.communicate(input=json.dumps({'method': 'stop'})+'\n', timeout=15)
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
