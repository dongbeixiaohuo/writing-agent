"""Production renderer + isolated real profile; no live provider/OS keychain."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
evidence = root / 'output/playwright/provider-presets'
evidence.mkdir(parents=True, exist_ok=True)
# Random-port host readiness + stdin RPC cannot use with_server.py's fixed port.
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/ux/provider_presets_fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
report = {'realModelCalls': 0, 'credentialBackend': 'isolated in-memory', 'connectionProbe': 'synthetic result', 'checks': []}

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
        errors, external = [], []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.on('request', lambda request: external.append(request.url) if not request.url.startswith(ready['origin']) else None)
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
            },500); return ()=>clearInterval(timer); },
            providerStatus: ()=>call('providerStatus',[]),
            configureProvider: input=>call('configureProvider',[input]),
            testProviderConnection: ()=>call('testProviderConnection',[]) };
        })();""".replace('PROTOCOL', str(ready['protocolVersion'])))
        page.goto(ready['origin'], wait_until='networkidle')
        page.get_by_role('button', name='设置', exact=True).click()
        page.get_by_role('button', name='模型', exact=True).click()
        # Inspect actual rendered controls before exercising the new selector.
        report['initialControls'] = page.locator('label').all_text_contents()
        selector = page.get_by_label('模型供应商', exact=True)
        expect(selector).to_be_visible(timeout=5000)
        selector.select_option('minimax-cn')
        expect(page.get_by_text('https://api.minimax.cn/anthropic/v1', exact=True)).to_be_visible()
        expect(page.get_by_label('服务类型', exact=True)).to_have_count(0)
        expect(page.get_by_label('模型名称', exact=True)).to_be_empty()
        page.get_by_label('API Key', exact=True).fill('fixture-dummy-key')
        page.get_by_label('模型名称', exact=True).fill('MiniMax-M3')
        # Switching region cannot silently send the old key/model to a new host.
        selector.select_option('minimax-global')
        expect(page.get_by_label('API Key', exact=True)).to_be_empty()
        expect(page.get_by_label('模型名称', exact=True)).to_be_empty()
        assert rpc({'method': 'testStats'})['saves'] == 0
        assert rpc({'method': 'testStats'})['probes'] == 0
        report['checks'].append('preset-selection-fills-transport-only-clears-key-and-model-no-network-or-save')
        selector.select_option('minimax-cn')
        page.get_by_role('button', name='保存并验证连接', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('请填写模型名称')
        page.get_by_label('模型名称', exact=True).fill('MiniMax-M3')
        page.get_by_label('API Key', exact=True).fill('fixture-dummy-key')
        page.get_by_role('button', name='保存并验证连接', exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('连接验证通过')
        expect(page.get_by_label('API Key', exact=True)).to_be_empty()
        profile = rpc({'method': 'testReadProfile'})
        assert profile['baseURL'] == 'https://api.minimax.cn/anthropic/v1'
        assert profile['model'] == 'MiniMax-M3'
        assert 'fixture-dummy-key' not in json.dumps(profile)
        assert rpc({'method': 'testStats'})['saves'] == 1
        report['checks'].append('key-and-model-only-save-real-profile-without-key-and-show-probe-result')
        expect(page.get_by_role('button', name='关闭设置', exact=True)).to_be_in_viewport()
        expect(page.get_by_role('navigation', name='设置分类')).to_be_in_viewport()
        page.screenshot(path=str(evidence / '01-preset.png'))
        # Verify saved-config checking isn't offered as if it checks this draft.
        selector.select_option('openai')
        expect(page.get_by_role('button', name='验证已保存配置', exact=True)).to_be_disabled()
        report['checks'].append('changed-draft-cannot-present-saved-config-probe-as-new-config-success')
        selector.select_option('custom')
        expect(page.get_by_label('服务类型', exact=True)).to_be_visible()
        page.get_by_label('服务类型', exact=True).select_option('anthropic_compatible')
        page.get_by_label('API 地址（HTTPS）', exact=True).fill('https://private.example.test/v1')
        page.get_by_label('模型名称', exact=True).fill('private-model')
        page.get_by_label('API Key', exact=True).fill('fixture-private-key')
        # Manual endpoint edits also clear a key already entered.
        page.get_by_label('API 地址（HTTPS）', exact=True).fill('https://private.example.test/custom/v1')
        expect(page.get_by_label('API Key', exact=True)).to_be_empty()
        page.get_by_label('API Key', exact=True).fill('fixture-private-key')
        page.get_by_role('button', name='保存并验证连接', exact=True).click()
        expect(page.get_by_role('status')).to_contain_text('连接验证通过')
        report['checks'].append('custom-protocol-endpoint-model-save-and-key-reset-on-address-change')
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name='设置', exact=True).click()
        page.get_by_role('button', name='模型', exact=True).click()
        expect(selector).to_have_value('custom')
        expect(page.get_by_label('API 地址（HTTPS）', exact=True)).to_have_value('https://private.example.test/custom/v1')
        expect(page.get_by_label('模型名称', exact=True)).to_have_value('private-model')
        expect(page.get_by_label('API Key', exact=True)).to_be_empty()
        report['checks'].append('existing-custom-profile-reloads-unchanged-without-key-echo')
        rpc({'method': 'testFailProbe'})
        page.get_by_role('button', name='验证已保存配置', exact=True).click()
        expect(page.get_by_role('alert')).to_contain_text('API Key 无效')
        report['checks'].append('failed-validation-remains-visible-and-is-not-success')
        page.set_viewport_size({'width': 960, 'height': 640})
        selector.select_option('qwen-cn')
        expect(page.get_by_label('API Key', exact=True)).to_be_visible()
        expect(page.get_by_label('模型名称', exact=True)).to_be_visible()
        page.get_by_role('button', name='保存并验证连接', exact=True).scroll_into_view_if_needed()
        expect(page.get_by_role('button', name='关闭设置', exact=True)).to_be_in_viewport()
        expect(page.get_by_role('button', name='通用', exact=True)).to_be_in_viewport()
        page.screenshot(path=str(evidence / '02-small-window.png'))
        page.get_by_role('button', name='通用', exact=True).click()
        # Switching settings sections must not throw away an unsaved selection.
        page.get_by_role('button', name='模型', exact=True).click()
        expect(selector).to_have_value('qwen-cn')
        report['checks'].append('small-window-controls-accessible-and-draft-survives-section-switch')
        assert not errors, errors
        assert not external, external
        report.update(status='PASS', pageErrors=errors, externalRendererRequests=external)
        browser.close()
finally:
    if server.poll() is None:
        server.communicate(input=json.dumps({'method': 'stop'})+'\n', timeout=15)
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
