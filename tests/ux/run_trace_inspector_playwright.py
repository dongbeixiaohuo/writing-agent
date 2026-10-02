"""Actual React inspector, synthetic history; API/SQLite coverage lives in run-trace-detail.test.ts."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4195/run-trace-inspector.html")
    page.wait_for_load_state("networkidle")
    print("Mounted options:", page.get_by_role("option").count())
    expect(page.get_by_role("option")).to_have_count(60)
    expect(page.get_by_label("详情读取次数")).to_have_text("0")
    inspector = page.locator(".run-trace-inspector")
    ledger = page.locator(".run-trace-ledger")
    assert ledger.evaluate("e => e.scrollHeight - e.scrollTop - e.clientHeight < 4"), "initial history should show current work"

    def select(index):
        page.locator(f'[data-step-id="step-{index}"] .run-trace-select').click()

    # Slow selection must not overwrite a newer fast selection.
    select(70)
    select(71)
    page.get_by_role("tab", name="输出", exact=True).click()
    expect(inspector).to_contain_text("找到 2 条来源")
    page.wait_for_timeout(1350)
    expect(inspector).to_contain_text("找到 2 条来源")
    expect(inspector).not_to_contain_text("步骤 70 的实际模型回复")
    page.get_by_role("tab", name="输入", exact=True).click()
    expect(inspector).to_contain_text('"query": "2026 假期安排"')
    page.get_by_role("tab", name="Schema", exact=True).click()
    expect(inspector).to_contain_text('"name":"search_fact_sources"')
    page.get_by_role("tab", name="时序", exact=True).click()
    expect(inspector).to_contain_text("首个有效内容")
    expect(inspector).to_contain_text("900 毫秒")

    # Search summaries, load older rows without eager details, failure/retry and old missing history.
    search = page.get_by_role("searchbox", name="搜索运行轨迹")
    search.fill("搜索回执")
    expect(page.get_by_role("option")).to_have_count(1)
    search.fill("")
    page.get_by_role("button", name="加载更早 20 条").click()
    expect(page.get_by_role("option")).to_have_count(80)
    expect(page.get_by_label("详情读取次数")).to_have_text("2")
    select(72)
    expect(inspector.get_by_role("alert")).to_contain_text("读取失败")
    inspector.get_by_role("button", name="重试", exact=True).click()
    page.get_by_role("tab", name="输出", exact=True).click()
    expect(inspector).to_contain_text("步骤 72 的实际模型回复")
    select(73)
    expect(inspector).to_contain_text("没有可用的原始历史")

    # Pending selection refreshes once on completion, not once each clock tick.
    select(79)
    page.get_by_role("tab", name="输出", exact=True).click()
    expect(inspector).to_contain_text("当前请求还没有完成结果")
    loads = int(page.get_by_label("详情读取次数").inner_text())
    page.get_by_role("button", name="完成当前请求", exact=True).click()
    expect(inspector).to_contain_text("当前请求已保存完整回复")
    expect(page.get_by_label("详情读取次数")).to_have_text(str(loads + 1))
    page.get_by_label("主对话输入测试").fill("正在查看运行记录，也能正常输入确认意见。" * 30)
    expect(page.get_by_label("详情读取次数")).to_have_text(str(loads + 1))
    ledger.evaluate("e => { e.scrollTop = 250; e.dispatchEvent(new Event('scroll')); }")
    page.get_by_role("button", name="新增执行步骤", exact=True).click()
    expect(page.get_by_role("button", name="回到最新步骤", exact=True)).to_be_visible()
    assert ledger.evaluate("e => e.scrollTop") < 1000, "reading history should not jump to latest"
    page.get_by_role("button", name="回到最新步骤", exact=True).click()
    page.wait_for_function("() => {const e=document.querySelector('.run-trace-ledger'); return e.scrollHeight - e.scrollTop - e.clientHeight < 4;}")
    page.get_by_role("button", name="新增执行步骤", exact=True).click()
    page.wait_for_function("() => {const e=document.querySelector('.run-trace-ledger'); return e.scrollHeight - e.scrollTop - e.clientHeight < 4;}")
    expect(page.get_by_label("详情读取次数")).to_have_text(str(loads + 1))
    select(71)
    page.get_by_role("tab", name="输出", exact=True).click()
    expect(inspector).to_contain_text("找到 2 条来源")
    for width in [1440, 640]:
        page.set_viewport_size({"width": width, "height": 1000})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "horizontal overflow"
        screenshot = Path(f"output/desktop/run-trace-inspector-{width}.png")
        screenshot.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(screenshot), full_page=True)
    assert errors == [], errors
    browser.close()
    print("PASS: lazy detail, stale selection, input/output/schema/timing, search/history, retry/missing, settled refresh, composer and responsive widths")
