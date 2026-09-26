"""Production renderer + isolated real desktop profiles; no live APIs/user data."""
import json
from pathlib import Path
import subprocess
import sys
from playwright.sync_api import sync_playwright, expect

sys.stdout.reconfigure(encoding='utf-8')

root = Path(__file__).resolve().parents[2]
evidence = root / 'output/playwright/provider-presets'
evidence.mkdir(parents=True, exist_ok=True)
# with_server.py cannot expose this fixture's stdin RPC and random-port readiness.
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/ux/provider_presets_fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
report = {'realModelCalls': 0, 'credentialBackend': 'isolated in-memory', 'connectionProbe': 'synthetic', 'checks': []}

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
            if (!response.ok) throw new Error(response.error.code);
            return response.result; };
          window.writingAgentDesktop = { invoke,
            subscribe: listener => { const timer=setInterval(async()=>{
              const result=await invoke({protocolVersion:PROTOCOL,method:'getSnapshot',args:[]});
              if(result.ok) listener(result.snapshot);
            },200); return ()=>clearInterval(timer); },
            providerStatus: mode=>call('providerStatus',[mode]),
            providerDetails: id=>call('providerDetails',[id]),
            configureProvider: input=>call('configureProvider',[input]),
            selectProvider: (id,model)=>call('selectProvider',[id,model]),
            listProviderModels: input=>call('listProviderModels',[input]),
            testProviderConnection: ()=>call('testProviderConnection',[]) };
        })();""".replace('PROTOCOL', str(ready['protocolVersion'])))
        page.goto(ready['origin'], wait_until='networkidle')
        def button(name): return page.get_by_role('button', name=name, exact=True)
        def field(name): return page.get_by_label(name, exact=True)
        def choose(preset_id): page.locator(f'button[data-provider-id="{preset_id}"]').click()
        button('设置').click()
        button('模型').click()
        report['initialControls'] = page.get_by_role('dialog').inner_text()
        button('添加模型供应商').click()
        results = field('供应商搜索结果')
        expect(page.get_by_role('status').filter(has_text='找到 100 个')).to_be_visible()
        assert results.get_by_role('button').count() == 12
        button('显示更多（已显示 12 / 100）').click()
        assert results.get_by_role('button').count() == 24
        field('搜索预置供应商').fill('智谱 国内 Coding')
        assert results.get_by_role('button').count() == 2
        assert results.locator('[data-provider-id="zhipu-coding-chat"]').count() == 0
        choose('cc-zhipu-glm')
        expect(field('预设连接信息')).to_contain_text('国内站')
        expect(field('预设连接信息')).to_contain_text('Coding Plan')
        expect(field('预设连接信息')).to_contain_text('OpenAI Responses')
        page.screenshot(path=str(evidence/'00-zhipu-plan.png'))
        field('搜索预置供应商').fill('腾讯')
        field('筛选账号地区').select_option('international')
        field('筛选服务类型').select_option('token')
        # Filtering exposes only matches and leaves the editor unchanged until selection.
        expect(field('预设连接信息')).to_contain_text('智谱')
        assert results.locator('[data-provider-id="cc-zhipu-glm"]').count() == 0
        for edition in ['个人版', '企业专业版 Pro', '企业轻量版 Lite']:
            expect(results).to_contain_text(edition)
        choose('cc-tencent-token-plan-enterprise-lite-intl')
        expect(field('预设连接信息')).to_contain_text('企业轻量版 Lite')
        assert page.locator('#provider-model-catalog option').all_text_contents() == ['']
        assert page.locator('#provider-model-catalog option').get_attribute('value') == 'auto'
        choose('cc-tencent-token-plan-enterprise-pro-intl')
        assert page.locator('#provider-model-catalog option').count() > 1
        expect(field('预设连接信息')).to_contain_text('选择预设不会变更套餐')
        field('筛选账号地区').select_option('')
        field('筛选服务类型').select_option('')
        field('搜索预置供应商').fill('千问 国内 Coding')
        choose('qwen-cn-coding-anthropic')
        expect(field('预设连接信息')).to_contain_text('Anthropic Messages')
        expect(field('预设连接信息')).to_contain_text('coding.dashscope')
        field('搜索预置供应商').fill('BytePlus')
        choose('cc-byteplus')
        expect(field('预设连接信息')).to_contain_text('国际站')
        expect(field('预设连接信息')).to_contain_text('Coding Plan')
        field('搜索预置供应商').fill('AICoding')
        choose('cc-aicoding')
        expect(field('预设连接信息')).to_contain_text('不区分国内 / 国际')
        expect(field('预设连接信息')).to_contain_text('第三方中转')
        report['checks'].append('region-product-filters-zhipu-qwen-byteplus-tencent-editions-and-unknown-relay-region')
        field('搜索预置供应商').fill('腾讯')
        expect(results).to_contain_text('腾讯混元')
        choose('cc-hy3-tokenhub')
        expect(field('预设连接信息')).to_contain_text('OpenAI Responses')
        expect(field('预设连接信息')).to_contain_text('https://tokenhub.tencentmaas.com/v1')
        expect(field('模型 ID 1')).to_be_empty()
        assert page.locator('#provider-model-catalog option[value="hy3"]').count() == 1
        field('搜索预置供应商').fill('AtlasCloud')
        choose('cc-atlascloud')
        expect(field('预设连接信息')).to_contain_text('OpenAI Chat Completions')
        field('搜索预置供应商').fill('不存在的供应商-123')
        expect(page.get_by_text('没有匹配的预设，可以清空筛选或使用自定义模型 API。')).to_be_visible()
        assert results.get_by_role('button').count() == 0
        button('清空筛选').click()
        expect(field('搜索预置供应商')).to_be_empty()
        assert results.get_by_role('button').count() == 12
        field('搜索预置供应商').fill('MiniMax')
        field('搜索预置供应商').press('Enter')
        assert rpc({'method':'testStats'})['saves'] == 0
        choose('cc-minimax')
        expect(field('预设连接信息')).to_contain_text('OpenAI Responses')
        field('API Key').fill('fixture-unsaved-key')
        page.screenshot(path=str(evidence/'00-responses-preset.png'))
        choose('minimax-cn')
        expect(field('API Key')).to_be_empty()
        expect(field('预设连接信息')).to_contain_text('Anthropic Messages')
        assert rpc({'method':'testStats'})['saves'] == 0
        report['checks'].append('100-preferred-presets-visible-search-pagination-empty-state-enter-no-save')
        field('API Key').fill('fixture-dummy-key')
        field('模型 ID 1').fill('MiniMax-M3')
        choose('minimax-global')
        expect(field('API Key')).to_be_empty()
        expect(field('模型 ID 1')).to_be_empty()
        assert rpc({'method':'testStats'})['saves'] == 0
        report['checks'].append('preset-switch-clears-unsaved-key-and-model')
        choose('minimax-cn')
        field('供应商显示名称').fill('MiniMax · 国内')
        button('保存并验证连接').click()
        expect(page.get_by_role('alert')).to_contain_text('请填写模型名称')
        field('模型 ID 1').fill('MiniMax-M3')
        field('API Key').fill('fixture-dummy-key')
        button('保存并验证连接').click()
        expect(button('编辑 MiniMax · 国内')).to_be_enabled()
        expect(page.get_by_role('dialog')).to_contain_text('连接验证通过')
        expect(field('MiniMax · 国内 的配置类型')).to_contain_text('API / Token Plan 共用入口')
        profile = rpc({'method':'testReadProfile'})
        assert profile['schemaVersion'] == 3
        assert profile['profiles'][0]['config']['model'] == 'MiniMax-M3'
        assert 'fixture-dummy-key' not in json.dumps(profile)
        page.screenshot(path=str(evidence/'01-provider-list.png'))
        report['checks'].append('save-preset-real-profile-without-plaintext-key')
        button('编辑 MiniMax · 国内').click()
        expect(field('API Key')).to_be_empty()
        expect(field('供应商显示名称')).to_have_value('MiniMax · 国内')
        expect(page.get_by_text('修改模型名称不需要重新填写 Key。')).to_be_visible()
        button('添加模型').click()
        field('模型 ID 2').fill('replacement-model')
        field('使用第 2 个模型').check()
        button('获取可用模型').click()
        expect(page.get_by_role('alert')).to_contain_text('可以直接填写')
        button('保存并验证连接').click()
        expect(field('MiniMax · 国内 的模型')).to_have_value('replacement-model')
        assert rpc({'method':'testStats'})['credentialCount'] == 1
        report['checks'].append('add-and-select-model-without-key-reentry-catalog-failure-fallback')
        button('添加模型供应商').click()
        page.get_by_role('tab', name='自定义模型 API').click()
        field('供应商显示名称').fill('我的网关')
        field('API 地址').fill('https://private.example.test/v1')
        field('API 协议').select_option('openai_responses')
        field('模型 ID 1').fill('private-model')
        field('API Key').fill('fixture-private-key')
        field('API 地址').fill('https://private.example.test/custom/v1')
        expect(field('API Key')).to_be_empty()
        field('API Key').fill('fixture-private-key')
        page.set_viewport_size({'width':960,'height':640})
        button('保存并验证连接').scroll_into_view_if_needed()
        expect(button('关闭设置')).to_be_in_viewport()
        page.screenshot(path=str(evidence/'02-custom-editor.png'))
        button('通用').click()
        button('模型').click()
        expect(field('供应商显示名称')).to_have_value('我的网关')
        button('保存并验证连接').click()
        expect(button('编辑 我的网关')).to_be_enabled()
        assert len(rpc({'method':'testReadProfile'})['profiles']) == 2
        assert rpc({'method':'testReadProfile'})['profiles'][1]['config']['kind'] == 'openai_responses'
        assert rpc({'method':'testStats'})['credentialCount'] == 2
        report['checks'].append('custom-provider-independent-key-small-window-draft-kept')
        field('MiniMax · 国内 的模型').select_option('MiniMax-M3')
        button('使用此模型').click()
        expect(page.get_by_role('status').filter(has_text='已切换为 MiniMax-M3')).to_be_visible()
        button('关闭设置').click()
        page.set_viewport_size({'width':1360,'height':900})
        page.reload(wait_until='networkidle')
        page.screenshot(path=str(evidence/'03-after-reload.png'))
        report['reloadText'] = page.locator('body').inner_text()
        previous_reads = rpc({'method':'testStats'})['credentialReads']
        button('设置').click()
        button('模型').click()
        expect(field('MiniMax · 国内 的模型')).to_have_value('MiniMax-M3')
        expect(page.get_by_role('dialog')).to_contain_text('我的网关')
        assert rpc({'method':'testStats'})['credentialReads'] == previous_reads
        expect(page.get_by_role('dialog')).not_to_contain_text('未找到可用 Key')
        report['checks'].append('settings-list-does-not-read-keys-or-mislabel-unchecked-keys-as-missing')
        report['checks'].append('provider-model-selection-persists-after-reload')
        button('编辑 MiniMax · 国内').click()
        expect(page.get_by_text('修改模型名称不需要重新填写 Key。')).to_be_visible()
        assert rpc({'method':'testStats'})['credentialReads'] == previous_reads + 1
        page.get_by_role('tab', name='自定义模型 API').click()
        field('API 地址').fill('https://different.example.test/v1')
        button('保存并验证连接').click()
        expect(page.get_by_role('alert')).to_contain_text('请填写此供应商的 API Key')
        button('取消').click()
        assert rpc({'method':'providerStatus'})['result']['baseURL'] == 'https://api.minimax.cn/anthropic/v1'
        rpc({'method':'testFailProbe'})
        button('验证连接').click()
        expect(page.get_by_role('alert')).to_contain_text('API Key 无效')
        report['checks'].append('changed-endpoint-never-reuses-old-key-failed-probe-not-success')
        # A Chat entry hidden from NEW choices must remain editable without migration.
        assert rpc({'method':'configureProvider', 'args':[{'profileId':None, 'displayName':'旧 Chat 配置',
            'kind':'openai_compatible', 'providerId':'deepseek', 'baseURL':'https://api.deepseek.com',
            'model':'legacy-model', 'tools':'supported', 'usage':'reported',
            'apiKey':'fixture-legacy-key', 'persistence':'system'}]})['ok']
        page.reload(wait_until='networkidle')
        button('设置').click()
        button('模型').click()
        button('编辑 旧 Chat 配置').click()
        expect(field('预设连接信息')).to_contain_text('此配置使用已保存的 Chat Completions 协议')
        expect(field('API Key')).to_be_empty()
        field('搜索预置供应商').fill('DeepSeek')
        assert results.locator('[data-provider-id="deepseek"]').count() == 0
        assert results.locator('[data-provider-id="cc-deepseek"]').count() == 1
        field('模型 ID 1').fill('legacy-replacement')
        button('保存并验证连接').click()
        expect(button('编辑 旧 Chat 配置')).to_be_enabled()
        preserved = rpc({'method':'testReadProfile'})['profiles'][-1]
        assert preserved['config']['kind'] == 'openai_compatible'
        assert preserved['config']['model'] == 'legacy-replacement'
        assert preserved['config']['baseURL'] == 'https://api.deepseek.com'
        assert rpc({'method':'testStats'})['credentialCount'] == 3
        report['checks'].append('hidden-legacy-chat-search-and-edit-do-not-migrate-protocol-address-or-key')
        assert not errors, errors
        assert not external, external
        report.update(status='PASS', pageErrors=errors, externalRendererRequests=external)
        browser.close()
except Exception:
    report['status'] = 'FAIL'
    raise
finally:
    if server.poll() is None:
        server.communicate(input=json.dumps({'method':'stop'})+'\n', timeout=15)
    (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
