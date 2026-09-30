from __future__ import annotations

from pathlib import Path

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parents[1]
SCREENSHOT = ROOT / "output" / "wa024-ui-extension-demo.png"


def main() -> None:
    console_errors: list[str] = []
    page_errors: list[str] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.goto("http://127.0.0.1:4174/extension-demo.html")
        page.wait_for_load_state("networkidle")

        page.get_by_text("Editorial Desk Demo", exact=False).first.wait_for()
        page.get_by_text("界面移植预览，未接入真实写作", exact=False).wait_for()
        theme_color = page.locator("main").evaluate(
            "element => getComputedStyle(element).getPropertyValue('--dsw-alias-state-business-primary').trim()"
        )
        assert theme_color == "#8b4b32", theme_color

        demo_launcher = page.get_by_role("button", name="编辑备注演示")
        demo_launcher.click()
        demo_panel = page.locator("[data-wa-demo-panel]")
        demo_panel.wait_for()
        assert demo_panel.locator("[data-wa-demo-header]").count() == 1
        assert "project-launch" in demo_panel.inner_text()
        demo_panel.get_by_role("button", name="关闭").click()
        assert demo_panel.count() == 0

        page.get_by_role("button", name="公众号初稿", exact=False).click()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        page.get_by_role("tab", name="稿件与差异", exact=True).wait_for()
        page.get_by_role("tab", name="核查与来源", exact=True).click()
        page.get_by_text("存在阻断", exact=True).first.wait_for()

        page.get_by_role("button", name="访谈材料整理", exact=False).click()
        edit_tab = page.get_by_role("tab", name="稿件与差异", exact=True)
        assert edit_tab.get_attribute("aria-selected") == "true"
        page.get_by_text("尚无已保存正文", exact=False).wait_for()
        page.get_by_role("button", name="关闭稿件面板").click()

        demo_launcher.click()
        demo_panel.wait_for()
        assert "project-case" in demo_panel.inner_text()
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(SCREENSHOT), full_page=True)

        assert console_errors == [], console_errors
        assert page_errors == [], page_errors
        browser.close()

    print(f"WA024 browser extension isolation: PASS ({SCREENSHOT})")


if __name__ == "__main__":
    main()
