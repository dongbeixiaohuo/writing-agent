"""Real browser component regression; all page data are synthetic, no model/API calls."""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 1000}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto("http://127.0.0.1:4194/process-preview.html")
    page.wait_for_load_state("networkidle")
    # Inspect mounted DOM before actions. Selectors are the rendered accessible labels.
    print(page.locator("button").all_text_contents())
    expect(page.get_by_label("已提供素材预览")).to_contain_text("窗边的光线")
    expect(page.get_by_label("已提供素材预览")).to_contain_text("保持叙事顺序", timeout=9000)
    page.get_by_role("button", name="过程开始", exact=True).click()
    expect(page.get_by_label("临时素材预览")).to_contain_text("核对文中的假期")
    page.get_by_role("button", name="过程追加", exact=True).click()
    expect(page.get_by_label("临时素材预览")).to_contain_text("日期，正文保持不变")
    page.get_by_role("button", name="生成最终答复", exact=True).click()
    expect(page.locator("[data-material-preview]")).to_have_count(0)
    expect(page.locator("[data-work-preview]")).to_have_count(0)
    expect(page.locator("[data-final-preview]")).to_contain_text("这一刻有什么用", timeout=8000)
    page.get_by_role("button", name="保存完成", exact=True).click()
    expect(page.locator("[data-final-preview]")).to_have_count(0)
    expect(page.locator("[data-saved-body] h1")).to_have_text("安静的片刻")
    expect(page.locator("[data-saved-body]")).to_contain_text("润色后的这一版你认可吗")
    page.get_by_role("button", name="搜索进行中", exact=True).click()
    expect(page.get_by_role("status", name="正在处理你的消息")).to_have_text("正在搜索事实来源")
    trace = page.get_by_label("运行轨迹", exact=True)
    expect(trace).to_contain_text("搜索事实来源")
    trace.locator('[data-step-id="q1"] .run-trace-select').click()
    trace.get_by_role("tab", name="时序", exact=True).click()
    expect(trace.locator('.run-trace-inspector')).to_contain_text("首个有效内容")
    for width in [1440, 640]:
        page.set_viewport_size({"width": width, "height": 1000})
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
        path = Path(f"output/desktop/process-preview-{width}.png")
        path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path), full_page=True)
    assert errors == [], errors
    browser.close()
    print("PASS: material progression, process deltas, final handoff, persisted Markdown, trace timings, responsive layout; no page errors")
