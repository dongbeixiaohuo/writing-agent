"""Exercise the real conversation UI with a synthetic provider; not a real-model UX verdict."""
import json
from pathlib import Path
import subprocess
from playwright.sync_api import sync_playwright, expect

root = Path(__file__).resolve().parents[2]
evidence = root / 'output' / 'cr003-browser'
evidence.mkdir(parents=True, exist_ok=True)
# The secure application host selects a random loopback port, so its readiness
# JSON, rather than a fixed-port dev-server helper, controls this fixture.
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/ux/cr003_conversation_fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
report = {'provider': 'synthetic', 'realModelCalls': 0, 'checks': []}
try:
    ready = json.loads(server.stdout.readline())
    report['workspace'] = ready['workspacePath']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(ready['origin'])
        # Long polling is part of this application; DOM readiness is the stable boundary.
        box = page.get_by_role('textbox', name='写作指令')
        expect(box).to_be_editable()
        report['initialButtons'] = page.get_by_role('button').all_text_contents()
        expect(page.get_by_role('dialog')).to_have_count(0)
        page.screenshot(path=str(evidence / '01-entry.png'))
        box.fill('我想写夜跑，但是没想好怎么写')
        box.press('Enter')
        expect(page.get_by_text('我们可以先聊聊夜跑给你的感受。', exact=False)).to_be_visible(timeout=15000)
        expect(box).to_be_editable(timeout=15000)
        expect(page.get_by_text('当前项目', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='按这个方向继续')).to_have_count(0)
        report['checks'].append('one-idea-entry-and-adaptive-reply')
        page.screenshot(path=str(evidence / '02-reply.png'))
        page.reload()
        expect(box).to_be_editable()
        expect(page.get_by_text('我们可以先聊聊夜跑给你的感受。', exact=False)).to_be_visible()
        box.fill('我更想写个人观察，你建议一下读者和篇幅')
        box.press('Enter')
        confirm = page.get_by_role('button', name='按这个方向继续')
        expect(confirm).to_be_enabled(timeout=15000)
        page.screenshot(path=str(evidence / '03-proposal.png'))
        report['checks'].append('reload-and-proposal-without-form')
        box.fill('先别写，我要换个方向')
        box.press('Enter')
        expect(page.get_by_text('可以换方向，旧方案先不执行。', exact=False)).to_be_visible(timeout=15000)
        expect(confirm).to_have_count(0)
        page.reload()
        expect(confirm).to_have_count(0)
        expect(box).to_be_editable()
        report['checks'].append('change-direction-invalidates-old-confirmation-after-reload')
        box.fill('还是写夜跑观察，按共创方式给我一个建议方案')
        box.press('Enter')
        expect(confirm).to_be_enabled(timeout=15000)
        confirm.click()
        expect(page.get_by_role('heading', name='提纲已经形成，方向对吗？')).to_be_visible(timeout=20000)
        page.screenshot(path=str(evidence / '04-writing-checkpoint.png'))
        report['checks'].append('inline-confirmation-hands-off-and-pauses-for-user')
        assert not errors, errors
        report['pageErrors'] = errors
        report['status'] = 'PASS'
        browser.close()
finally:
    if server.poll() is None:
        server.communicate(input='stop\n', timeout=15)
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
