from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Locator, Page, sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Exercise the isolated Writing Agent desktop first-run flow")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            return str(json.load(response)["webSocketDebuggerUrl"])
    return endpoint


def active_element(page: Page) -> dict[str, str | None]:
    return page.evaluate(
        """() => {
          const element = document.activeElement;
          return {
            tag: element?.tagName ?? null,
            text: element?.textContent?.trim() || null,
            ariaLabel: element?.getAttribute?.('aria-label') ?? null,
            name: element?.getAttribute?.('name') ?? null,
          };
        }"""
    )


def field(page: Page, name: str) -> Locator:
    return page.get_by_label(name, exact=True)


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {}

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(websocket_endpoint(args.cdp_endpoint))
        pages = [page for context in browser.contexts for page in context.pages]
        page = next((candidate for candidate in pages if candidate.url.startswith("writing-agent://")), None)
        if page is None:
            raise RuntimeError("WRITING_AGENT_PAGE_NOT_FOUND")
        page.wait_for_load_state("domcontentloaded")

        # Model form validation must be local: an empty form cannot reach a provider.
        page.get_by_role("button", name="设置", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.wait_for()
        report["settingsInitialFocus"] = active_element(page)
        page.keyboard.press("Shift+Tab")
        report["settingsShiftTabFocus"] = active_element(page)
        report["settingsFocusStayedInDialog"] = dialog.evaluate(
            "element => element.contains(document.activeElement)"
        )
        page.get_by_role("button", name="模型", exact=True).click()
        page.get_by_role("button", name="保存模型配置", exact=True).click()
        settings_alert = page.get_by_role("alert")
        settings_alert.wait_for()
        report["emptyProviderError"] = settings_alert.inner_text()
        report["emptyProviderFocus"] = active_element(page)
        page.screenshot(path=str(args.output_dir / "desktop-provider-validation.png"), full_page=True)
        page.keyboard.press("Escape")
        report["settingsEscapeClosed"] = dialog.count() == 0

        # Project setup should focus inside the modal, trap focus, close with Escape,
        # and translate validation failures into useful copy.
        page.get_by_role("button", name="新建写作项目", exact=True).last.click()
        project_dialog = page.get_by_role("dialog")
        project_dialog.wait_for()
        report["projectInitialFocus"] = active_element(page)
        page.keyboard.press("Shift+Tab")
        report["projectShiftTabFocus"] = active_element(page)
        report["projectFocusStayedInDialog"] = project_dialog.evaluate(
            "element => element.contains(document.activeElement)"
        )
        page.keyboard.press("Escape")
        report["projectEscapeClosed"] = project_dialog.count() == 0
        if project_dialog.count() > 0:
            page.get_by_role("button", name="关闭新建项目").click()

        page.get_by_role("button", name="新建写作项目", exact=True).last.click()
        project_dialog.wait_for()
        page.get_by_role("button", name="继续", exact=True).click()
        project_alert = page.get_by_role("alert")
        project_alert.wait_for()
        report["emptyProjectError"] = project_alert.inner_text()
        report["emptyProjectFocus"] = active_element(page)
        page.screenshot(path=str(args.output_dir / "desktop-project-validation.png"), full_page=True)

        field(page, "写作主题").fill("桌面端首次使用流程验收")
        field(page, "项目名称（可选）").fill("UX 验收项目")
        page.get_by_role("button", name="继续", exact=True).click()
        field(page, "目标读者").fill("第一次使用 Writing Agent 的内容编辑")
        field(page, "目标字符数").fill("600")
        page.get_by_role("button", name="继续", exact=True).click()
        page.get_by_role("button", name="继续", exact=True).click()
        field(page, "材料名称").fill("虚构验收材料")
        field(page, "材料正文").fill("这是专用于本地隔离 UX 验收的虚构材料，不包含客户数据。")
        page.get_by_role("button", name="建立简报并复核", exact=True).click()
        project_dialog.wait_for(state="detached")
        page.wait_for_timeout(500)
        report["projectCreatedBody"] = page.locator("body").inner_text()
        page.screenshot(path=str(args.output_dir / "desktop-project-created.png"), full_page=True)

        # A persisted project should expose its session and confirmed brief without
        # attempting a model call merely by navigating.
        report["composerEditable"] = page.get_by_role("textbox", name="写作指令").get_attribute("contenteditable")
        report["modelSetupActionCount"] = page.get_by_role("button", name="配置模型", exact=True).count()

    report_path = args.output_dir / "desktop-ux-acceptance.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
