from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


PROJECT_NAME = "深度共创验收-20260918"
INSTRUCTION_PREFIX = "请在当前已经保存的稿件基础上继续修改"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify persisted rc.2 UAT state after restart")
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
        if PROJECT_NAME not in page.locator("body").inner_text():
            raise RuntimeError("INTERACTION_UAT_PROJECT_NOT_FOUND_AFTER_RESTART")

        close_panel = page.get_by_role("button", name="关闭稿件面板", exact=True)
        if close_panel.count() > 0:
            close_panel.click()

        draft_session = page.locator("button").filter(has_text="写作草稿").first
        if draft_session.count() > 0:
            draft_session.click()
            page.wait_for_timeout(500)

        conversation = page.locator("section[aria-label='写作会话']").inner_text()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        panel = page.locator('aside[aria-label="稿件与版本"]')
        panel.wait_for(state="visible")
        panel_text = panel.inner_text()
        draft_heading = panel_text.splitlines()[0] if panel_text else ""

        page.get_by_role("tab", name="核查与来源", exact=True).click()
        fact_status = panel.locator("[data-fact-status]").first.get_attribute("data-fact-status")

        page.get_by_role("tab", name="备份与交付", exact=True).click()
        delivery_text = panel.inner_text()
        html_exports = panel.get_by_text("正式交付 · HTML", exact=True).count()
        txt_exports = panel.get_by_text("正式交付 · TXT", exact=True).count()
        latest_html = panel.get_by_text("正式交付 · HTML", exact=True).first
        latest_html_row = latest_html.locator("..").inner_text() if html_exports > 0 else ""
        page.screenshot(path=str(args.output_dir / "restart-readback.png"), full_page=True)

        report = {
            "project": PROJECT_NAME,
            "instructionRestored": INSTRUCTION_PREFIX in conversation,
            "draftHeading": draft_heading,
            "factStatus": fact_status,
            "htmlExportCount": html_exports,
            "txtExportCount": txt_exports,
            "latestHtmlRow": latest_html_row,
            "publicationHistoryVisible": "导出记录" in delivery_text,
        }
        report_path = args.output_dir / "restart-readback-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)

    passed = (
        report["instructionRestored"]
        and report["factStatus"] == "passed"
        and report["htmlExportCount"] >= 1
        and report["txtExportCount"] >= 1
        and ".html" in report["latestHtmlRow"]
        and report["publicationHistoryVisible"]
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
