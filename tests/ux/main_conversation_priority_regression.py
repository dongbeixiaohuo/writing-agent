from __future__ import annotations

import argparse
import contextlib
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any

from playwright.sync_api import Page, sync_playwright


ROOT = Path(__file__).resolve().parents[2]


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


@contextlib.contextmanager
def serve(root: Path):
    handler = partial(QuietStaticHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def visible_center_text(page: Page) -> str:
    center = page.locator("main")
    return center.inner_text() if center.count() else page.locator("body").inner_text()


def run(page: Page, outline_screenshot: Path, blocking_screenshot: Path) -> dict[str, Any]:
    failures: list[str] = []

    project_button = page.get_by_role("button", name="新品发布项目", exact=False)
    project_is_selectable = project_button.count() == 1
    if not project_is_selectable:
        failures.append("既有项目名称不是可选择入口")
        page.get_by_role("button", name="共创写作", exact=False).click()
    else:
        project_button.click()

    active_session = page.get_by_role("button", name="共创写作", exact=False)
    selected_semantics = (
        active_session.get_attribute("aria-current") in {"page", "true"}
        or active_session.get_attribute("aria-selected") == "true"
        or active_session.get_attribute("aria-pressed") == "true"
    )
    if not selected_semantics:
        failures.append("当前会话没有可感知的选中语义")

    sidebar = page.locator("aside").first
    sidebar_text = sidebar.inner_text() if sidebar.count() else page.locator("body").inner_text()
    active_project_is_explicit = "当前项目" in sidebar_text
    if not active_project_is_explicit:
        failures.append("左侧没有明确标出当前项目")

    conversation = page.locator('[data-conversation-feed="true"]')
    if conversation.count() == 0:
        conversation = page.locator("main")
    rendered_outline = (
        conversation.locator("h1, h2, h3").count() > 0
        and conversation.locator("ol, ul").count() > 0
        and conversation.get_by_text("业务问题", exact=True).count() > 0
    )
    if not rendered_outline:
        failures.append("提纲成果没有在主对话中自动展开为结构化内容")
    raw_markdown_visible = conversation.get_by_text("# ", exact=False).count() > 0
    if raw_markdown_visible:
        failures.append("主对话仍显示原始 Markdown 符号")
    outline_screenshot.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(outline_screenshot), full_page=True)

    page.get_by_role("button", name="公众号初稿", exact=False).click()
    main_text = visible_center_text(page)
    blocking_notice_visible = (
        "阻断" in main_text
        and ("处理" in main_text or "核查" in main_text)
        and page.get_by_role("button", name="查看并处理", exact=False).count() > 0
    )
    if not blocking_notice_visible:
        failures.append("主对话没有展示稿件阻断原因和处理入口")
    blocking_screenshot.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(blocking_screenshot), full_page=True)

    blocking_action_opens_facts = False
    if blocking_notice_visible:
        page.get_by_role("button", name="查看并处理", exact=False).click()
        facts_tab = page.get_by_role("tab", name="核查与来源", exact=True)
        facts_tab.wait_for(state="visible")
        blocking_action_opens_facts = facts_tab.get_attribute("aria-selected") == "true"
        page.get_by_role("button", name="关闭稿件面板", exact=True).click()
    if not blocking_action_opens_facts:
        failures.append("主对话的阻断操作没有直达核查详情")

    other_project = page.get_by_role("button", name="客户案例专题", exact=False)
    other_project.click()
    other_session = page.get_by_role("button", name="访谈材料整理", exact=False)
    project_switch_works = (
        other_project.get_attribute("aria-current") == "true"
        and other_session.get_attribute("aria-current") == "page"
    )
    if not project_switch_works:
        failures.append("点击既有项目后没有恢复该项目的会话")
    page.get_by_role("button", name="新品发布项目", exact=False).click()

    return {
        "projectSelectable": project_is_selectable,
        "projectSwitchWorks": project_switch_works,
        "selectedSessionSemantics": selected_semantics,
        "activeProjectExplicit": active_project_is_explicit,
        "outlineRenderedInline": rendered_outline,
        "rawMarkdownVisible": raw_markdown_visible,
        "blockingNoticeVisible": blocking_notice_visible,
        "blockingActionOpensFacts": blocking_action_opens_facts,
        "failures": failures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--dist",
        type=Path,
        default=ROOT / "apps" / "web" / "dist" / "mock",
    )
    parser.add_argument(
        "--evidence",
        type=Path,
        default=ROOT / "output" / "main-conversation-priority-regression.json",
    )
    parser.add_argument(
        "--screenshot",
        type=Path,
        default=ROOT / "output" / "playwright" / "main-conversation-priority.png",
    )
    parser.add_argument(
        "--outline-screenshot",
        type=Path,
        default=ROOT / "output" / "playwright" / "main-conversation-outline.png",
    )
    args = parser.parse_args()
    assert (args.dist / "index.html").is_file(), f"mock build not found: {args.dist}"

    with serve(args.dist) as origin, sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(
            viewport={"width": 1440, "height": 900},
            color_scheme="light",
            reduced_motion="reduce",
        )
        page.goto(origin, wait_until="networkidle")
        result = run(page, args.outline_screenshot, args.screenshot)
        browser.close()

    result["status"] = "PASS" if not result["failures"] else "FAIL"
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
