"""Read-only original DB clone: verify packaged chat, manuscript reader and diagnostics."""
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
prepared = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'tests/ux/rc16_prepare_electron.ts', sys.argv[2], sys.argv[3], '9'], cwd=root, text=True, encoding='utf-8'))
evidence = root / 'output/rc19-conversation-presentation' / prepared['id']
evidence.mkdir(parents=True)
report = dict(status='FAIL', executable=sys.argv[1], originalProjectWrites=0, realModelCalls=0, checks=[])
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
with (evidence / 'electron-stderr.log').open('wb') as stderr:
    process = subprocess.Popen([sys.argv[1], f'--remote-debugging-port={port}', '--remote-debugging-address=127.0.0.1', '--disable-gpu'], env=dict(os.environ, WRITING_AGENT_DESKTOP_TEST=prepared['id'], WRITING_AGENT_RC16_FIXTURE_KEY='not-a-real-key'), stdout=subprocess.DEVNULL, stderr=stderr, creationflags=subprocess.CREATE_NO_WINDOW)
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
            def rpc(method, args=[]):
                r = page.evaluate('(x)=>window.writingAgentDesktop.invoke({protocolVersion:20,method:x.method,args:x.args})', dict(method=method,args=args))
                assert r['ok'], r
                return r['result']
            rpc('selectSession', [prepared['projectId'], prepared['sessionId']])
            for width, height in [(1344, 866), (900, 650)]:
                page.set_viewport_size(dict(width=width, height=height))
                link = page.get_by_role('button', name='查看当前稿件', exact=True)
                expect(link).to_be_visible(); link.scroll_into_view_if_needed()
                feed = page.locator('[data-conversation-feed]')
                expect(feed).not_to_contain_text('读取参考材料')
                expect(feed).not_to_contain_text('已自动纠正')
                expect(feed.get_by_label('导出文件格式', exact=True)).to_have_count(0)
                page.screenshot(path=str(evidence / f'conversation-{width}.png'))
                link.click()
                reader = page.get_by_label('稿件阅读', exact=True)
                expect(reader).to_be_visible()
                snapshot = rpc('getSnapshot')
                expect(reader.locator('h1').first).to_have_text(snapshot['previewDocument']['title'])
                expect(reader.locator('p').first).to_contain_text('当前版本已通过核查')
                assert reader.locator('p').count() > 3
                page.screenshot(path=str(evidence / f'reader-{width}.png'))
                page.get_by_role('tab', name='导出与备份', exact=True).click()
                export = page.get_by_label('文章导出', exact=True)
                expect(export).to_be_visible()
                expect(export.get_by_role('button', name='导出文章', exact=True)).to_be_enabled()
                expect(export).to_contain_text('选择保存位置')
                export.get_by_label('导出文件格式', exact=True).select_option('txt')
                expect(export.get_by_label('导出文件格式', exact=True)).to_have_value('txt')
                page.screenshot(path=str(evidence / f'export-{width}.png'))
                page.get_by_role('button', name='关闭稿件面板', exact=True).click()
                page.get_by_role('button', name='运行记录', exact=False).click()
                details = page.locator('details').filter(has_text='执行详情').filter(has_text='读取参考材料').first
                details.locator('summary').click()
                expect(details).to_contain_text('读取参考材料')
                page.screenshot(path=str(evidence / f'records-{width}.png'))
                page.get_by_role('button', name='对话', exact=True).click()
                report['checks'].append(dict(width=width, reader=True, exportInWorkbench=True, diagnosticsInRecords=True))
            after = rpc('getSnapshot')
            assert after['revisionWorkspace']['bodyVersionId'] == prepared['before']['latest_body_version_id']
            report.update(status='PASS', bodyUnchanged=True, gateStatus=after['deliveryWorkspace']['gateStatus'])
            browser.close()
    finally:
        process.terminate(); process.wait(timeout=15)
        (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
