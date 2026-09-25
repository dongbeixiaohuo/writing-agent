from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect a running Writing Agent desktop UX environment")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    endpoint = args.cdp_endpoint
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            endpoint = json.load(response)["webSocketDebuggerUrl"]
    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(endpoint)
        pages = [page for context in browser.contexts for page in context.pages]
        page = next((candidate for candidate in pages if candidate.url.startswith("writing-agent://")), None)
        if page is None:
            raise RuntimeError("WRITING_AGENT_PAGE_NOT_FOUND")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(750)
        screenshot = args.output_dir / "desktop-initial.png"
        page.screenshot(path=str(screenshot), full_page=True)
        result = {
            "title": page.title(),
            "url": page.url,
            "viewport": page.viewport_size,
            "bodyText": page.locator("body").inner_text(),
            "visibleButtons": page.locator("button:visible").evaluate_all(
                "elements => elements.map(element => ({text: element.innerText, ariaLabel: element.getAttribute('aria-label'), disabled: element.disabled}))"
            ),
            "visibleInputs": page.locator("input:visible, select:visible, [role='textbox']:visible").evaluate_all(
                "elements => elements.map(element => ({tag: element.tagName, ariaLabel: element.getAttribute('aria-label'), placeholder: element.getAttribute('placeholder'), disabled: element.disabled}))"
            ),
            "dialogs": page.locator("[role='dialog']:visible").count(),
            "screenshot": str(screenshot.resolve()),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
