from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


PROJECT_NAME = "深度共创验收-20260918"
INSTRUCTION = (
    "请基于两份已确认材料，重新完成一轮深度共创写作。"
    "严格只写材料明确包含的动作，不新增自动锁屏时长、私人电脑或家人共用、"
    "公司云盘、U盘、聊天记录、攻击者或骗子动机、保护现场、效果判断等材料外事实；"
    "不要把审稿结论、修改说明或‘正文如下’写入文章。"
    "面向没有专职安全背景的小型企业员工，约900字。"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the real-provider deep co-creation desktop UAT")
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    if endpoint.startswith(("http://", "https://")):
        with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
            return str(json.load(response)["webSocketDebuggerUrl"])
    return endpoint


def emit(event: str, **details: object) -> None:
    print(json.dumps({"event": event, **details}, ensure_ascii=False), flush=True)


def run_status(page: Page) -> str | None:
    status = page.locator('[aria-label="写作工作流进度"] [data-run-status]').first
    if status.count() == 0:
        return None
    return status.get_attribute("data-run-status")


def wait_for_status(page: Page, allowed: set[str], timeout_seconds: int) -> str:
    deadline = time.monotonic() + timeout_seconds
    last: str | None = None
    while time.monotonic() < deadline:
        last = run_status(page)
        if last in allowed:
            return str(last)
        page.wait_for_timeout(500)
    raise RuntimeError(f"RUN_STATUS_TIMEOUT last={last!r} allowed={sorted(allowed)!r}")


def inspect_process_panel(page: Page) -> dict[str, object]:
    launcher = page.get_by_role("button", name="稿件与版本", exact=True)
    launcher.click()
    panel = page.locator('aside[aria-label="稿件与版本"]')
    panel.wait_for(state="visible")
    page.get_by_role("tab", name="材料与过程", exact=True).click()
    panel_text = panel.inner_text()
    result = {
        "text": panel_text,
        "rawJsonVisible": '{"claims"' in panel_text or '"evidence_id"' in panel_text,
        "editorReviewCount": panel.get_by_text("编辑审校", exact=True).count(),
        "publishReviewCount": panel.get_by_text("发布审校", exact=True).count(),
        "readerReviewCount": panel.get_by_text("读者审校", exact=True).count(),
    }
    return result


def close_panel(page: Page) -> None:
    close = page.get_by_role("button", name="关闭稿件面板", exact=True)
    if close.count() > 0:
        close.click()


def scroll_bottom_distance(page: Page) -> float | None:
    return page.evaluate(
        """() => {
          const section = document.querySelector('section[aria-label="写作会话"]');
          if (!section) return null;
          const candidates = [...section.querySelectorAll('*')].filter((element) => {
            const style = getComputedStyle(element);
            return element.scrollHeight > element.clientHeight + 1 &&
              ['auto', 'scroll'].includes(style.overflowY);
          });
          if (candidates.length === 0) return null;
          const element = candidates.sort((left, right) => right.scrollHeight - left.scrollHeight)[0];
          return Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop);
        }"""
    )


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "project": PROJECT_NAME,
        "instruction": INSTRUCTION,
        "checkpoints": [],
    }

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(websocket_endpoint(args.cdp_endpoint))
        pages = [page for context in browser.contexts for page in context.pages]
        page = next((candidate for candidate in pages if candidate.url.startswith("writing-agent://")), None)
        if page is None:
            raise RuntimeError("WRITING_AGENT_PAGE_NOT_FOUND")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        if PROJECT_NAME not in page.locator("body").inner_text():
            raise RuntimeError("DEEP_UAT_PROJECT_NOT_FOUND")

        editor = page.get_by_role("textbox", name="写作指令", exact=True)
        editor.fill(INSTRUCTION)
        editor.press("Enter")
        wait_for_status(page, {"running", "waiting_user"}, 20)
        page.screenshot(path=str(args.output_dir / "run-started.png"), full_page=True)
        emit("run_started", status=run_status(page))

        continuation = page.get_by_role("button", name="确认当前阶段并继续", exact=True)
        checkpoint_details: list[dict[str, object]] = []
        for checkpoint in range(1, 4):
            continuation.wait_for(state="visible", timeout=120_000)
            status = wait_for_status(page, {"waiting_user"}, 10)
            screenshot = args.output_dir / f"checkpoint-{checkpoint}.png"
            page.screenshot(path=str(screenshot), full_page=True)
            detail: dict[str, object] = {
                "index": checkpoint,
                "status": status,
                "screenshot": str(screenshot.resolve()),
            }
            if checkpoint in {1, 3}:
                detail["process"] = inspect_process_panel(page)
                page.screenshot(
                    path=str(args.output_dir / f"checkpoint-{checkpoint}-process.png"),
                    full_page=True,
                )
                close_panel(page)
            checkpoint_details.append(detail)
            emit("checkpoint", index=checkpoint, status=status)
            continuation.click()
            try:
                continuation.wait_for(state="hidden", timeout=10_000)
            except PlaywrightTimeoutError as error:
                raise RuntimeError(f"CHECKPOINT_{checkpoint}_DID_NOT_RESUME") from error

        terminal = wait_for_status(
            page,
            {"completed", "failed", "budget_exhausted", "cancelled", "interrupted"},
            180,
        )
        page.wait_for_timeout(500)
        terminal_screenshot = args.output_dir / "run-terminal.png"
        page.screenshot(path=str(terminal_screenshot), full_page=True)
        report["checkpoints"] = checkpoint_details
        report["terminalStatus"] = terminal
        report["terminalScreenshot"] = str(terminal_screenshot.resolve())
        report["scrollBottomDistance"] = scroll_bottom_distance(page)
        report["conversationText"] = page.locator("section[aria-label='写作会话']").inner_text()
        emit("run_terminal", status=terminal, bottomDistance=report["scrollBottomDistance"])

        page.get_by_role("button", name="运行记录", exact=False).click()
        cards = page.locator("article")
        report["latestRunRecord"] = cards.first.inner_text() if cards.count() > 0 else ""
        page.screenshot(path=str(args.output_dir / "run-record.png"), full_page=True)

        page.get_by_role("button", name="对话", exact=True).click()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        panel = page.locator('aside[aria-label="稿件与版本"]')
        panel.wait_for(state="visible")
        report["draftPanel"] = panel.inner_text()
        page.screenshot(path=str(args.output_dir / "draft.png"), full_page=True)

        page.get_by_role("tab", name="材料与过程", exact=True).click()
        report["finalProcess"] = {
            "text": panel.inner_text(),
            "rawJsonVisible": '{"claims"' in panel.inner_text() or '"evidence_id"' in panel.inner_text(),
            "editorReviewCount": panel.get_by_text("编辑审校", exact=True).count(),
            "publishReviewCount": panel.get_by_text("发布审校", exact=True).count(),
            "readerReviewCount": panel.get_by_text("读者审校", exact=True).count(),
        }
        page.screenshot(path=str(args.output_dir / "process.png"), full_page=True)

        page.get_by_role("tab", name="核查与来源", exact=True).click()
        report["factPanel"] = panel.inner_text()
        page.screenshot(path=str(args.output_dir / "facts.png"), full_page=True)

        page.get_by_role("tab", name="备份与交付", exact=True).click()
        report["deliveryBefore"] = panel.inner_text()
        txt_button = panel.get_by_role("button", name="导出正式 TXT", exact=True)
        html_button = panel.get_by_role("button", name="导出正式 HTML", exact=True)
        report["formalExportEnabled"] = not txt_button.is_disabled() and not html_button.is_disabled()
        if terminal == "completed" and bool(report["formalExportEnabled"]):
            txt_button.click()
            page.wait_for_timeout(300)
            html_button.click()
            page.wait_for_timeout(500)
            report["deliveryAfter"] = panel.inner_text()
            emit("formal_exports_completed")
        page.screenshot(path=str(args.output_dir / "delivery.png"), full_page=True)

    report_path = args.output_dir / "deep-uat-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("report_written", path=str(report_path.resolve()))
    return 0 if report.get("terminalStatus") == "completed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
