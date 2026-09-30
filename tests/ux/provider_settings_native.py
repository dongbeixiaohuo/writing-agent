"""Packaged Electron IPC + legacy migration + waiting-project switch; no live API."""
import json, os, socket, subprocess, sys, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

prepared = json.loads(subprocess.check_output(['node','--import','tsx','tests/ux/prepare_provider_settings.ts'],text=True,encoding='utf-8'))
evidence = Path('output/rc41/native') / prepared['id']
evidence.mkdir(parents=True)
report = dict(status='FAIL', originalProjectWrites=0, realModelCalls=0, connectionProbe='loopback port 9, expected failure')
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
with (evidence/'stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1],f'--remote-debugging-port={port}','--remote-debugging-address=127.0.0.1','--disable-gpu'],
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
            errors=[];page.on('pageerror',lambda error: errors.append(str(error)))
            def rpc(method,args=[]):
                return page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,...x})',dict(method=method,args=args))
            assert rpc('selectSession',['old','s-old'])['ok']
            before=rpc('getSnapshot')['result']
            # The model pill itself is now a discoverable settings entry.
            settings_start = time.monotonic()
            page.get_by_role('button',name='切换模型，当前 fixture · MiniMax-M3',exact=True).click()
            expect(page.get_by_role('button',name='编辑 fixture',exact=True)).to_be_visible()
            report['settingsListVisibleMs'] = round((time.monotonic()-settings_start)*1000, 1)
            page.get_by_role('button',name='编辑 fixture',exact=True).click()
            expect(page.get_by_label('API Key',exact=True)).to_be_empty()
            expect(page.get_by_label('API 协议',exact=True).locator('option[value="openai_responses"]')).to_have_text('OpenAI Responses')
            page.get_by_role('button',name='添加模型',exact=True).click()
            page.get_by_label('模型 ID 2',exact=True).fill('synthetic-replacement')
            page.get_by_label('使用第 2 个模型',exact=True).check()
            page.get_by_role('button',name='保存并验证连接',exact=True).click()
            expect(page.get_by_role('button',name='编辑 fixture',exact=True)).to_be_enabled(timeout=30000)
            after=rpc('getSnapshot')['result']
            assert after['selectedProjectId']=='old' and after['selectedSessionId']=='s-old'
            assert after['generation']>before['generation']
            assert after['settings']['providerLabel']=='fixture · synthetic-replacement'
            assert after['recoverableRuns'][0]['runId']=='waiting-run'
            page.get_by_role('button',name='编辑 fixture',exact=True).click()
            page.get_by_label('API 地址',exact=True).fill('https://different.example.test/v1')
            page.get_by_role('button',name='保存并验证连接',exact=True).click()
            expect(page.get_by_role('alert')).to_contain_text('请填写此供应商的 API Key')
            page.get_by_role('button',name='取消',exact=True).click()
            page.get_by_role('button',name='添加模型供应商',exact=True).click()
            search=page.get_by_label('搜索预置供应商',exact=True)
            def choose(preset_id): page.locator(f'button[data-provider-id="{preset_id}"]').click()
            search.fill('智谱 国内 Coding')
            assert page.locator('button[data-provider-id]').count()==2
            choose('zhipu-coding-anthropic')
            expect(page.get_by_label('预设连接信息',exact=True)).to_contain_text('国内站')
            expect(page.get_by_label('预设连接信息',exact=True)).to_contain_text('Coding Plan')
            expect(page.get_by_label('预设连接信息',exact=True)).to_contain_text('Anthropic Messages')
            page.screenshot(path=str(evidence/'zhipu-coding-plan.png'))
            search.fill('腾讯')
            page.get_by_label('筛选账号地区',exact=True).select_option('international')
            page.get_by_label('筛选服务类型',exact=True).select_option('token')
            choose('cc-tencent-token-plan-enterprise-lite-intl')
            expect(page.get_by_label('预设连接信息',exact=True)).to_contain_text('企业轻量版 Lite')
            assert page.locator('#provider-model-catalog option').count()==1
            assert page.locator('#provider-model-catalog option').get_attribute('value')=='auto'
            page.get_by_label('筛选账号地区',exact=True).select_option('')
            page.get_by_label('筛选服务类型',exact=True).select_option('')
            report['packagedPlanFiltersAndEditions']=True
            page.get_by_label('搜索预置供应商',exact=True).fill('MiniMax')
            choose('cc-minimax')
            expect(page.get_by_label('预设连接信息',exact=True)).to_contain_text('OpenAI Responses')
            expect(page.get_by_label('API Key',exact=True)).to_be_empty()
            expect(page.get_by_label('模型 ID 1',exact=True)).to_be_empty()
            assert len(rpc('providerStatus',['summary'])['result']['profiles']) == 1
            page.screenshot(path=str(evidence/'responses-preset.png'))
            page.get_by_role('button',name='取消',exact=True).click()
            report['newPresetPreviewDoesNotChangeSavedConfig'] = True
            page.screenshot(path=str(evidence/'saved-provider.png'))
            page.get_by_role('button',name='关闭设置',exact=True).click()
            expect(page.get_by_role('button',name='切换模型，当前 fixture · synthetic-replacement',exact=True)).to_be_visible()
            page.reload();page.wait_for_load_state('networkidle')
            status=rpc('providerStatus')['result']
            assert status['model']=='synthetic-replacement'
            assert status['profiles'][0]['models']==['MiniMax-M3','synthetic-replacement']
            profile=json.loads((Path(prepared['root'])/'user-data/provider.json').read_text(encoding='utf-8'))
            assert profile['schemaVersion']==3
            assert 'synthetic-key' not in json.dumps(profile)
            assert not errors, errors
            report.update(status='PASS', savedModel=status['model'], selectedSessionKept=True,
                newerSnapshotAccepted=True, legacyKeyReused=True, endpointChangeRejected=True, pageErrors=errors)
            browser.close()
    finally:
        process.terminate();process.wait(timeout=15)
        (evidence/'result.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(dict(evidence=str(evidence),**report),ensure_ascii=False))
