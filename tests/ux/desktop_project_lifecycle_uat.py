from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import Page, sync_playwright


EMPTY_PROJECT = "test"
OTHER_PROJECT = "保留项目"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify empty-project conversation entry and visible project deletion"
    )
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
        return str(json.load(response)["webSocketDebuggerUrl"])


def create_confirmed_project(page: Page, name: str) -> None:
    page.get_by_role("button", name="添加项目", exact=True).click()
    dialog = page.get_by_role("dialog", name="一起建立写作简报", exact=True)
    dialog.wait_for(state="visible")

    page.get_by_label("写作主题", exact=True).fill(f"{name} 的验收主题")
    page.get_by_label("项目名称（可选）", exact=True).fill(name)
    dialog.get_by_role("button", name="继续", exact=True).click()

    page.get_by_label("目标读者", exact=True).fill("最终用户")
    page.get_by_label("目标字符数", exact=True).fill("600")
    dialog.get_by_role("button", name="继续", exact=True).click()
    dialog.get_by_role("button", name="继续", exact=True).click()

    dialog.locator('input[data-error-code="PROJECT_MATERIAL_NAME_REQUIRED"]').first.fill("验收材料")
    dialog.locator('textarea[data-error-code="PROJECT_MATERIAL_REQUIRED"]').first.fill(
        "这是隔离测试材料，只用于验证老项目选择、新对话入口和删除确认。"
    )
    dialog.get_by_role("button", name="建立简报并复核", exact=True).click()
    dialog.wait_for(state="detached")

    confirm = page.get_by_role("button", name="确认简报并开始", exact=True)
    confirm.wait_for(state="visible")
    confirm.click()
    confirm.wait_for(state="detached")


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

        create_confirmed_project(page, EMPTY_PROJECT)
        create_confirmed_project(page, OTHER_PROJECT)

        empty_project = page.get_by_role("button", name=EMPTY_PROJECT, exact=True)
        empty_project.click()
        heading = page.get_by_role(
            "heading", name=f"在“{EMPTY_PROJECT}”中开始新对话", exact=True
        )
        heading.wait_for(state="visible")
        selected_project = page.locator('button[aria-current="true"]').filter(has_text=EMPTY_PROJECT)
        selected_without_session = selected_project.count() == 1
        new_conversation_visible = page.get_by_role(
            "button", name="新建对话", exact=True
        ).is_visible()
        composer_visible = page.get_by_role(
            "textbox", name="写作指令", exact=True
        ).is_visible()
        page.screenshot(
            path=str(args.output_dir / "empty-project-new-conversation.png"),
            full_page=True,
        )

        delete_entry = page.get_by_role(
            "button", name=f"删除项目“{EMPTY_PROJECT}”", exact=True
        )
        delete_entry_visible = delete_entry.is_visible()
        delete_entry.click()
        delete_dialog = page.get_by_role(
            "dialog", name=f"删除项目“{EMPTY_PROJECT}”？", exact=True
        )
        delete_dialog.wait_for(state="visible")
        delete_action = delete_dialog.get_by_role(
            "button", name="永久删除项目", exact=True
        )
        guarded_before_confirmation = delete_action.is_disabled()
        confirmation = delete_dialog.get_by_label("输入项目名称确认删除", exact=True)
        confirmation.fill("错误名称")
        guarded_after_wrong_name = delete_action.is_disabled()
        confirmation.fill(EMPTY_PROJECT)
        enabled_after_exact_name = delete_action.is_enabled()
        page.screenshot(
            path=str(args.output_dir / "project-delete-confirmation.png"),
            full_page=True,
        )
        delete_action.click()
        delete_dialog.wait_for(state="detached")
        page.get_by_text(f"已删除项目“{EMPTY_PROJECT}”。", exact=True).wait_for(state="visible")

        project_removed = page.get_by_role(
            "button", name=EMPTY_PROJECT, exact=True
        ).count() == 0
        other_project_kept = page.locator('button[aria-current="true"]').filter(
            has_text=OTHER_PROJECT
        ).count() == 1
        page.screenshot(
            path=str(args.output_dir / "project-deleted.png"),
            full_page=True,
        )

        report = {
            "emptyProject": EMPTY_PROJECT,
            "selectedWithoutSession": selected_without_session,
            "newConversationVisible": new_conversation_visible,
            "composerVisible": composer_visible,
            "deleteEntryVisible": delete_entry_visible,
            "guardedBeforeConfirmation": guarded_before_confirmation,
            "guardedAfterWrongName": guarded_after_wrong_name,
            "enabledAfterExactName": enabled_after_exact_name,
            "projectRemoved": project_removed,
            "otherProjectKept": other_project_kept,
        }
        report["status"] = "PASS" if all(
            value for key, value in report.items() if key not in {"emptyProject", "status"}
        ) else "FAIL"
        (args.output_dir / "project-lifecycle-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False), flush=True)
        browser.close()

    return 0 if report["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
