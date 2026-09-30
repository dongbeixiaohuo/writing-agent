from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Capture the first-run Writing Agent desktop UX")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--about-only", action="store_true")
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            return str(json.load(response)["webSocketDebuggerUrl"])
    return endpoint


def visible_controls(page: Page) -> dict[str, object]:
    return {
        "bodyText": page.locator("body").inner_text(),
        "buttons": page.locator("button:visible").evaluate_all(
            "elements => elements.map(element => ({text: element.innerText, ariaLabel: element.getAttribute('aria-label'), disabled: element.disabled}))"
        ),
        "fields": page.locator("input:visible, select:visible, [role='textbox']:visible").evaluate_all(
            "elements => elements.map(element => ({tag: element.tagName, ariaLabel: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'), value: element.value ?? element.innerText, disabled: element.disabled}))"
        ),
    }


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
        page.get_by_role("button", name="设置", exact=True).click()
        page.get_by_role("dialog").wait_for()
        page.screenshot(path=str(args.output_dir / "desktop-settings-general.png"), full_page=True)
        report["settingsGeneral"] = visible_controls(page)

        page.get_by_role("button", name="模型", exact=True).click()
        page.screenshot(path=str(args.output_dir / "desktop-settings-model.png"), full_page=True)
        report["settingsModel"] = visible_controls(page)

        page.get_by_role("button", name="关于", exact=True).click()
        page.screenshot(path=str(args.output_dir / "desktop-settings-about.png"), full_page=True)
        report["settingsAbout"] = visible_controls(page)
        page.get_by_role("button", name="关闭设置").click()

        if not args.about_only:
            page.get_by_role("button", name="新建第一个项目", exact=True).click()
            page.get_by_role("dialog").wait_for()
            page.screenshot(path=str(args.output_dir / "desktop-project-create.png"), full_page=True)
            report["projectCreate"] = visible_controls(page)
            page.get_by_role("button", name="关闭新建项目").click()

        report["url"] = page.url
        report["title"] = page.title()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
