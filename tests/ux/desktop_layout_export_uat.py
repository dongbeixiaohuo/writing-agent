from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify desktop HTML layout selection reaches the exported file")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            return str(json.load(response)["webSocketDebuggerUrl"])
    return endpoint


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(websocket_endpoint(args.cdp_endpoint))
        pages = [page for context in browser.contexts for page in context.pages]
        page = next((candidate for candidate in pages if candidate.url.startswith("writing-agent://")), None)
        if page is None:
            raise RuntimeError("WRITING_AGENT_PAGE_NOT_FOUND")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        draft_session = page.locator("button").filter(has_text="写作草稿").first
        if draft_session.count() > 0:
            draft_session.click()
            page.wait_for_timeout(300)
        close_panel = page.get_by_role("button", name="关闭稿件面板", exact=True)
        if close_panel.count() > 0:
            close_panel.click()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        panel = page.locator('aside[aria-label="稿件与版本"]')
        panel.wait_for(state="visible")
        page.get_by_role("tab", name="备份与交付", exact=True).click()

        html_rows = panel.get_by_text("正式交付 · HTML", exact=True)
        before_count = html_rows.count()
        before_latest = html_rows.first.locator("..").inner_text() if before_count > 0 else ""
        editorial = panel.get_by_role("radio", name="杂志长文", exact=False)
        editorial.click()
        html_button = panel.get_by_role("button", name="导出杂志 HTML", exact=True)
        if html_button.is_disabled():
            raise RuntimeError("FORMAL_HTML_EXPORT_DISABLED")
        html_button.click()
        page.wait_for_function(
            """([prior]) => [...document.querySelectorAll('aside[aria-label="稿件与版本"] *')]
              .filter((element) => element.textContent?.trim() === '正式交付 · HTML').length > prior""",
            arg=[before_count],
            timeout=15_000,
        )
        page.wait_for_timeout(300)

        html_rows = panel.get_by_text("正式交付 · HTML", exact=True)
        latest = html_rows.first.locator("..").inner_text()
        page.screenshot(path=str(args.output_dir / "desktop-editorial-export.png"), full_page=True)
        report = {
            "layout": "editorial",
            "beforeCount": before_count,
            "afterCount": html_rows.count(),
            "beforeLatest": before_latest,
            "latestHtmlRow": latest,
            "buttonLabel": html_button.inner_text(),
        }
        report_path = args.output_dir / "desktop-layout-export-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)

    return 0 if report["afterCount"] == report["beforeCount"] + 1 else 2


if __name__ == "__main__":
    raise SystemExit(main())
