"""Production renderer and real bridge/storage; synthetic provider, no real usage."""
import json
import subprocess
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeoutError

root = Path(__file__).resolve().parents[2]
evidence = root / 'output/rc15-title-browser'
evidence.mkdir(parents=True, exist_ok=True)
# Fixture requires a dynamically assigned port and stdin state inspection.
server = subprocess.Popen(['node', '--import', 'tsx', 'tests/ux/rc15_title_fixture.ts'], cwd=root,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
report = {'realModelCalls': 0, 'checks': []}

def rpc(method):
    server.stdin.write(json.dumps({'method': method}) + '\n')
    server.stdin.flush()
    return json.loads(server.stdout.readline())

try:
    ready_line = server.stdout.readline()
    if not ready_line:
        raise RuntimeError(server.stderr.read())
    ready = json.loads(ready_line)
    report['workspace'] = ready['root']
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={'width': 1440, 'height': 1000})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(ready['origin'], wait_until='domcontentloaded')
        try:
            page.wait_for_load_state('networkidle', timeout=3000)
        except PlaywrightTimeoutError:
            # The local Web bridge holds a long poll; rendered app readiness is
            # asserted below instead of waiting for a permanently idle network.
            pass
        report['controls'] = page.get_by_role('button').all_text_contents()
        card = page.get_by_role('region', name='补充写作信息', exact=True)
        expect(card.get_by_role('heading')).to_contain_text('标题')
        expect(card).not_to_contain_text('当前工作标题是「键盘')
        expect(card).not_to_contain_text('信息补齐')
        card.get_by_role('textbox').fill('这根本不是标题，请重新拟三个，只讨论标题，不要改正文。')
        card.get_by_role('button', name='发送意见', exact=True).click()
        expect(card.get_by_role('list', name='标题候选')).to_contain_text('功劳不是通行证', timeout=10000)
        expect(card.get_by_role('list', name='标题候选').get_by_role('listitem')).to_have_count(3)
        expect(card.get_by_role('textbox')).to_have_value('')
        report['checks'].append('legacy-bad-title-hidden-and-checkpoint-natural-feedback-saves-three-candidates')
        page.screenshot(path=str(evidence / '01-title-options.png'))
        # The shared main composer is contenteditable, unlike the card textarea.
        report['textboxes'] = page.get_by_role('textbox').evaluate_all('(nodes)=>nodes.map(n=>({label:n.getAttribute("aria-label"),editable:n.getAttribute("contenteditable")}))')
        composer = page.locator('[contenteditable="true"][role="textbox"]')
        composer.fill('不行，换一批')
        composer.press('Enter')
        expect(card.get_by_role('list', name='标题候选')).to_contain_text('忙，也要守住标准', timeout=10000)
        expect(card.get_by_role('list', name='标题候选')).not_to_contain_text('功劳不是通行证')
        page.reload(wait_until='domcontentloaded')
        expect(card.get_by_role('list', name='标题候选')).to_contain_text('忙，也要守住标准')
        report['checks'].append('main-composer-rephrasing-refreshes-same-card-and-survives-reload')
        page.set_viewport_size({'width': 960, 'height': 640})
        card.get_by_role('textbox').fill('这些标题再克制一点')
        card.get_by_role('button', name='发送意见', exact=True).scroll_into_view_if_needed()
        expect(card.get_by_role('button', name='发送意见', exact=True)).to_be_in_viewport()
        report['smallWindowButtonUnobstructed'] = card.get_by_role('button', name='发送意见', exact=True).evaluate('''button => {
            const rect = button.getBoundingClientRect();
            const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return top !== null && button.contains(top);
        }''')
        assert report['smallWindowButtonUnobstructed'], 'main composer must not cover the checkpoint action'
        card.get_by_role('button', name='发送意见', exact=True).click(trial=True)
        page.screenshot(path=str(evidence / '02-title-small-window.png'))
        state = rpc('state')
        assert state['bodyUnchanged'] and state['selectedTitle'] is None and state['waiting'] == 'waiting_user', state
        assert not errors, errors
        report.update(status='PASS', state=state, pageErrors=errors)
        browser.close()
finally:
    if server.poll() is None:
        server.communicate(input=json.dumps({'method': 'stop'}) + '\n', timeout=15)
    (evidence / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False))
