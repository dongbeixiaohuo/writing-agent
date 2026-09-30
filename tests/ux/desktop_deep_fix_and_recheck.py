from __future__ import annotations

import argparse
import json
import re
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, sync_playwright


REPLACEMENTS = {
    2: "远程办公时，请按公司要求完成以下基础动作。",
    4: "远程办公时，只使用公司批准的设备和账户。",
    6: "离开座位时，请先锁屏。",
    8: "不要与他人共享公司密码或一次性验证码。",
    10: "处理客户资料时，应使用公司批准的存储位置，不得转存到个人网盘。",
    12: "公共 Wi-Fi 的身份无法确认，建议优先使用可信网络；必须使用公共网络时，应先连接公司提供的安全访问方式。",
    14: "视频会议结束后，退出会议并关闭不再使用的共享。",
    16: "收到要求立即提供密码、验证码或打开陌生附件的信息时，不要照做；通过已知联系方式向发件人或 IT 服务台核实。",
    18: "发现设备丢失、可疑登录或误发资料后，立即联系 IT 服务台。",
    19: "## 关键动作回顾",
    20: "只使用公司批准的设备和账户；离开座位时锁屏；不共享密码或验证码；客户资料只放在公司批准的存储位置。",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fix a blocked deep draft through visible revision controls")
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


def wait_for_fact_status(page: Page, allowed: set[str], timeout_seconds: int) -> str:
    deadline = time.monotonic() + timeout_seconds
    last: str | None = None
    while time.monotonic() < deadline:
        summary = page.locator("[data-fact-status]").first
        last = summary.get_attribute("data-fact-status") if summary.count() > 0 else None
        if last in allowed:
            return str(last)
        page.wait_for_timeout(500)
    raise RuntimeError(f"FACT_STATUS_TIMEOUT last={last!r}")


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {"replacements": REPLACEMENTS}

    with sync_playwright() as playwright:
        browser = playwright.chromium.connect_over_cdp(websocket_endpoint(args.cdp_endpoint))
        pages = [page for context in browser.contexts for page in context.pages]
        page = next((candidate for candidate in pages if candidate.url.startswith("writing-agent://")), None)
        if page is None:
            raise RuntimeError("WRITING_AGENT_PAGE_NOT_FOUND")
        page.wait_for_load_state("domcontentloaded")
        page.wait_for_timeout(500)

        if page.get_by_role("button", name="稿件与版本", exact=True).count() == 0:
            page.get_by_role("button", name=re.compile(r"^写作草稿")).first.click()
            page.get_by_role("button", name="稿件与版本", exact=True).wait_for(state="visible")
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        panel = page.locator('aside[aria-label="稿件与版本"]')
        panel.wait_for(state="visible")
        page.get_by_role("tab", name="稿件与差异", exact=True).click()
        cards = panel.locator("section[data-block-id]")
        if cards.count() != 20:
            raise RuntimeError(f"UNEXPECTED_BLOCK_COUNT {cards.count()}")

        for block_number, replacement in REPLACEMENTS.items():
            card = panel.locator("section[data-block-id]").nth(block_number - 1)
            card.get_by_role("button", name="局部修改", exact=True).click()
            page.get_by_role("textbox", name=f"编辑块 {block_number}", exact=True).fill(replacement)
            page.get_by_role("textbox", name="修改说明", exact=True).fill("删除材料外推断，仅保留授权材料明确支持的表述")
            card.get_by_role("button", name="生成差异预览", exact=True).click()
            accept = panel.get_by_role("button", name="接受并创建新版本", exact=True).last
            accept.wait_for(state="visible", timeout=10_000)
            accept.click()
            accept.wait_for(state="hidden", timeout=10_000)
            emit("revision_accepted", block=block_number)

        page.screenshot(path=str(args.output_dir / "draft-after-revisions.png"), full_page=True)
        report["draftAfterRevisions"] = panel.inner_text()

        page.get_by_role("tab", name="核查与来源", exact=True).click()
        stale = wait_for_fact_status(page, {"stale"}, 10)
        report["statusBeforeRecheck"] = stale
        page.screenshot(path=str(args.output_dir / "facts-stale.png"), full_page=True)
        panel.get_by_role("button", name="重新核查当前稿件", exact=True).click()
        emit("fact_recheck_started")
        terminal = wait_for_fact_status(page, {"passed", "blocked", "error"}, 120)
        report["statusAfterRecheck"] = terminal
        report["factPanel"] = panel.inner_text()
        report["claimLabels"] = panel.locator("article strong").all_inner_texts()
        page.screenshot(path=str(args.output_dir / "facts-terminal.png"), full_page=True)
        emit("fact_recheck_terminal", status=terminal)

        page.get_by_role("tab", name="备份与交付", exact=True).click()
        txt_button = panel.get_by_role("button", name="导出正式 TXT", exact=True)
        html_button = panel.get_by_role("button", name="导出正式 HTML", exact=True)
        report["formalExportEnabled"] = not txt_button.is_disabled() and not html_button.is_disabled()
        if report["formalExportEnabled"]:
            txt_button.click()
            page.wait_for_timeout(300)
            html_button.click()
            page.wait_for_timeout(500)
            emit("formal_exports_completed")
        report["deliveryPanel"] = panel.inner_text()
        page.screenshot(path=str(args.output_dir / "delivery.png"), full_page=True)

    report_path = args.output_dir / "deep-fix-report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    emit("report_written", path=str(report_path.resolve()))
    return 0 if report.get("statusAfterRecheck") == "passed" else 2


if __name__ == "__main__":
    raise SystemExit(main())
