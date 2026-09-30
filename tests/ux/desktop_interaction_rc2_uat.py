from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, TimeoutError as PlaywrightTimeoutError, sync_playwright


PROJECT_NAME = "深度共创验收-20260918"
INSTRUCTION = (
    "请在当前已经保存的稿件基础上继续修改，不要另起炉灶。将全文压缩到 650 字以内，"
    "保留材料中的六项远程办公动作；开头用一句话直接说明用途，结尾只做动作回顾。"
    "不得新增材料外的原因、数据、案例、趋势判断或效果承诺。"
)
CHECKPOINT_FEEDBACK = (
    "保留六项动作，提纲按‘先说明用途—六项动作—简短回顾’组织，不新增趋势判断或案例。",
    "把全文压缩到 650 字以内，开头直接说明用途；保留六项动作，不新增材料外原因、数据或场景。",
    "优先处理事实边界和冗余表达，保留命令式、克制语气；结尾只做动作回顾。",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the rc.2 real-provider conversational co-creation UAT"
    )
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
        "feedback": CHECKPOINT_FEEDBACK,
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

        body_text = page.locator("body").inner_text()
        if PROJECT_NAME not in body_text:
            raise RuntimeError("INTERACTION_UAT_PROJECT_NOT_FOUND")

        close_settings = page.get_by_role("button", name="关闭设置", exact=True)
        if close_settings.count() > 0:
            close_settings.click()
        close_panel = page.get_by_role("button", name="关闭稿件面板", exact=True)
        if close_panel.count() > 0:
            close_panel.click()

        editor = page.get_by_role("textbox", name="写作指令", exact=True)
        editor.fill(INSTRUCTION)
        editor.press("Enter")
        wait_for_status(page, {"running", "waiting_user"}, 20)
        page.screenshot(path=str(args.output_dir / "revision-started.png"), full_page=True)
        emit("revision_started", status=run_status(page))

        checkpoint_details: list[dict[str, object]] = []
        for index, feedback in enumerate(CHECKPOINT_FEEDBACK, start=1):
            card = page.locator('section[aria-label="共创决策"]')
            card.wait_for(state="visible", timeout=180_000)
            status = wait_for_status(page, {"waiting_user"}, 10)
            title = card.get_by_role("heading", level=2).inner_text()
            card_text = card.inner_text()
            preview = card.locator("details")
            if preview.count() > 0:
                preview.locator("summary").click()
            card.get_by_role("textbox", name="给下一阶段的修改意见", exact=True).fill(feedback)
            screenshot = args.output_dir / f"checkpoint-{index}.png"
            page.screenshot(path=str(screenshot), full_page=True)
            checkpoint_details.append({
                "index": index,
                "status": status,
                "title": title,
                "cardText": card_text,
                "feedback": feedback,
                "screenshot": str(screenshot.resolve()),
            })
            card.get_by_role("button", name="带着意见继续", exact=True).click()
            try:
                card.wait_for(state="detached", timeout=15_000)
            except PlaywrightTimeoutError as error:
                raise RuntimeError(f"CHECKPOINT_{index}_DID_NOT_RESUME") from error
            emit("checkpoint_resumed", index=index, title=title)

        terminal = wait_for_status(
            page,
            {"completed", "failed", "budget_exhausted", "cancelled", "interrupted"},
            240,
        )
        page.wait_for_timeout(750)
        conversation = page.locator("section[aria-label='写作会话']").inner_text()
        report["checkpoints"] = checkpoint_details
        report["terminalStatus"] = terminal
        report["conversationText"] = conversation
        report["readCurrentDraftVisible"] = "读取现有稿件" in conversation
        report["scrollBottomDistance"] = scroll_bottom_distance(page)
        page.screenshot(path=str(args.output_dir / "revision-terminal.png"), full_page=True)
        emit(
            "revision_terminal",
            status=terminal,
            readCurrentDraftVisible=report["readCurrentDraftVisible"],
            bottomDistance=report["scrollBottomDistance"],
        )

        page.get_by_role("button", name="运行记录", exact=False).click()
        records = page.locator("article")
        report["latestRunRecord"] = records.first.inner_text() if records.count() > 0 else ""
        page.screenshot(path=str(args.output_dir / "run-record.png"), full_page=True)

        page.get_by_role("button", name="对话", exact=True).click()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        panel = page.locator('aside[aria-label="稿件与版本"]')
        panel.wait_for(state="visible")
        page.get_by_role("tab", name="核查与来源", exact=True).click()
        fact_summary = panel.locator("[data-fact-status]").first
        fact_status = fact_summary.get_attribute("data-fact-status")
        report["factStatus"] = fact_status
        report["factPanel"] = panel.inner_text()
        page.screenshot(path=str(args.output_dir / "facts.png"), full_page=True)

        page.get_by_role("tab", name="备份与交付", exact=True).click()
        editorial = panel.get_by_role("radio", name="杂志长文", exact=False)
        editorial.click()
        txt_button = panel.get_by_role("button", name="导出正式 TXT", exact=True)
        html_button = panel.get_by_role("button", name="导出杂志 HTML", exact=True)
        formal_enabled = not txt_button.is_disabled() and not html_button.is_disabled()
        report["formalExportEnabled"] = formal_enabled
        report["selectedLayout"] = "editorial"
        if terminal == "completed" and fact_status == "passed" and formal_enabled:
            txt_button.click()
            page.wait_for_timeout(500)
            html_button.click()
            page.wait_for_timeout(750)
            report["deliveryPanel"] = panel.inner_text()
            emit("formal_exports_completed", layout="editorial")
        page.screenshot(path=str(args.output_dir / "delivery-editorial.png"), full_page=True)

    report_path = args.output_dir / "interaction-rc2-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("report_written", path=str(report_path.resolve()))
    passed = (
        report.get("terminalStatus") == "completed"
        and report.get("readCurrentDraftVisible") is True
        and report.get("scrollBottomDistance") == 0
        and report.get("factStatus") == "passed"
        and report.get("formalExportEnabled") is True
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
