from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Reproduce silent desktop submit failures without an external model call")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            return str(json.load(response)["webSocketDebuggerUrl"])
    return endpoint


def create_synthetic_project(page: Page) -> None:
    page.get_by_role("button", name="新建写作项目", exact=True).last.click()
    dialog = page.get_by_role("dialog")
    dialog.wait_for()
    page.get_by_label("写作主题", exact=True).fill("验证提交失败时的用户反馈")
    page.get_by_label("项目名称（可选）", exact=True).fill("提交失败回归")
    page.get_by_role("button", name="继续", exact=True).click()
    page.get_by_label("目标读者", exact=True).fill("测试人员")
    page.get_by_label("目标字符数", exact=True).fill("600")
    page.get_by_role("button", name="继续", exact=True).click()
    page.get_by_role("button", name="继续", exact=True).click()
    page.get_by_label("材料名称", exact=True).fill("合成材料")
    page.get_by_label("材料正文", exact=True).fill("这是本地隔离回归材料，不包含真实客户数据。")
    page.get_by_role("button", name="建立简报并复核", exact=True).click()
    dialog.wait_for(state="detached")


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
        page.wait_for_timeout(250)

        status = page.evaluate("window.writingAgentDesktop.providerStatus()")
        report["providerStatus"] = {
            "configured": status["configured"],
            "kind": status["kind"],
            "baseURL": status["baseURL"],
            "model": status["model"],
            "credentialPersistence": status["credentialPersistence"],
        }
        if status["configured"] or status["baseURL"] != "https://127.0.0.1:1":
            raise RuntimeError("REPRO_REQUIRES_MISSING_CREDENTIAL_AND_LOOPBACK_PROVIDER")

        if "提交失败回归" not in page.locator("body").inner_text():
            create_synthetic_project(page)

        editor = page.get_by_role("textbox", name="写作指令")
        editor.fill("请开始写作")
        send = page.get_by_role("button", name="发送", exact=True)
        report["sendEnabledBefore"] = send.is_enabled()
        if not send.is_enabled():
            raise AssertionError("SEND_BUTTON_NOT_ENABLED")
        body_before = page.locator("body").inner_text()
        report["bodyBefore"] = body_before

        editor.press("Enter")
        page.wait_for_timeout(750)
        report["afterEnter"] = {
            "body": page.locator("body").inner_text(),
            "alerts": page.get_by_role("alert").all_inner_texts(),
            "sendEnabled": send.is_enabled() if send.count() > 0 else False,
            "editorText": editor.inner_text(),
        }
        page.screenshot(path=str(args.output_dir / "after-enter.png"), full_page=True)

        # The Enter submission clears the composer. Wait for the isolated loopback
        # provider failure to settle, then exercise the button as a separate action.
        send = page.get_by_role("button", name="发送", exact=True)
        send.wait_for(timeout=10_000)
        editor.fill("请通过按钮开始写作")
        report["sendEnabledBeforeClick"] = send.is_enabled()
        if not send.is_enabled():
            raise AssertionError("SEND_BUTTON_NOT_ENABLED_AFTER_ENTER")
        body_before_click = page.locator("body").inner_text()
        send.click()
        page.wait_for_timeout(750)
        report["afterClick"] = {
            "body": page.locator("body").inner_text(),
            "alerts": page.get_by_role("alert").all_inner_texts(),
            "sendEnabled": send.is_enabled() if send.count() > 0 else False,
            "editorText": editor.inner_text(),
        }
        page.screenshot(path=str(args.output_dir / "after-click.png"), full_page=True)

    report_path = args.output_dir / "submit-repro.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))

    enter_feedback = report["afterEnter"]["alerts"] or report["afterEnter"]["body"] != report["bodyBefore"]
    click_feedback = report["afterClick"]["alerts"] or report["afterClick"]["body"] != body_before_click
    if not enter_feedback or not click_feedback:
        raise AssertionError("SUBMIT_FAILURE_HAS_NO_VISIBLE_FEEDBACK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
