from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


PROJECT_NAME = "交互基准引导验收-20260919"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify the production guided brief flow")
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

        if PROJECT_NAME in page.locator("body").inner_text():
            raise RuntimeError("GUIDED_UAT_PROJECT_ALREADY_EXISTS")
        existing_dialog = page.get_by_role("dialog", name="一起建立写作简报", exact=True)
        if existing_dialog.count() > 0:
            existing_dialog.get_by_role("button", name="关闭新建项目", exact=True).click()
        add_project = page.get_by_role("button", name="添加项目", exact=True)
        if add_project.count() > 0:
            add_project.click()
        else:
            page.get_by_role("button", name="新建写作项目", exact=True).last.click()
        dialog = page.get_by_role("dialog", name="一起建立写作简报", exact=True)
        dialog.wait_for(state="visible")

        progress = dialog.get_by_role("list", name="简报创建进度", exact=True)
        roles = progress.locator("strong").all_inner_texts()
        page.get_by_label("写作主题", exact=True).fill("把远程办公安全动作写成普通员工能直接照做的短指南")
        page.get_by_label("项目名称（可选）", exact=True).fill(PROJECT_NAME)
        page.screenshot(path=str(args.output_dir / "guided-step-1.png"), full_page=True)
        dialog.get_by_role("button", name="继续", exact=True).click()

        page.get_by_label("目标读者", exact=True).fill("没有专职安全背景的小型企业员工")
        page.get_by_label("目标字符数", exact=True).fill("650")
        page.get_by_label("发布平台（可选）", exact=True).fill("企业知识库")
        page.screenshot(path=str(args.output_dir / "guided-step-2.png"), full_page=True)
        dialog.get_by_role("button", name="继续", exact=True).click()

        deep_selected = dialog.get_by_role("button", name="深度写作", exact=False).get_attribute("aria-pressed")
        co_creation_selected = dialog.get_by_role("button", name="逐步共创（推荐）", exact=False).get_attribute("aria-pressed")
        page.get_by_label("作者声音（可选）", exact=True).fill("直接、克制、像同事提醒")
        page.screenshot(path=str(args.output_dir / "guided-step-3.png"), full_page=True)
        dialog.get_by_role("button", name="继续", exact=True).click()

        page.get_by_text("添加材料", exact=True).click()
        names = dialog.locator('input[data-error-code="PROJECT_MATERIAL_NAME_REQUIRED"]')
        contents = dialog.locator('textarea[data-error-code="PROJECT_MATERIAL_REQUIRED"]')
        names.nth(0).fill("安全动作清单")
        contents.nth(0).fill("只使用公司批准的设备和账户；离开座位时锁屏；不共享密码或一次性验证码。")
        names.nth(1).fill("资料处理清单")
        contents.nth(1).fill("客户资料只放在公司批准的位置；可疑信息先核实；设备丢失、可疑登录或误发资料时立即联系 IT 服务台。")
        dialog.locator("textarea").first.fill("不得添加材料外事实\n不得虚构案例或数据")
        page.screenshot(path=str(args.output_dir / "guided-step-4.png"), full_page=True)
        dialog.get_by_role("button", name="建立简报并复核", exact=True).click()
        dialog.wait_for(state="detached")

        confirm = page.get_by_role("button", name="确认简报并开始", exact=True)
        confirm.wait_for(state="visible")
        review_text = page.locator("body").inner_text()
        page.screenshot(path=str(args.output_dir / "guided-brief-review.png"), full_page=True)
        confirm.click()
        confirm.wait_for(state="detached")
        page.wait_for_timeout(500)

        composer = page.get_by_role("textbox", name="写作指令", exact=True)
        report = {
            "project": PROJECT_NAME,
            "roles": roles,
            "deepSelected": deep_selected == "true",
            "coCreationSelected": co_creation_selected == "true",
            "twoMaterialsVisibleInReview": "2 份材料" in review_text,
            "briefConfirmed": composer.get_attribute("contenteditable") == "true",
            "modelCallStarted": page.locator('[data-run-status="running"]').count() > 0,
        }
        page.screenshot(path=str(args.output_dir / "guided-project-ready.png"), full_page=True)
        report_path = args.output_dir / "guided-project-report.json"
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(report, ensure_ascii=False), flush=True)

    passed = (
        report["roles"] == ["选题策划", "读者研究", "创作导演", "资料研究"]
        and report["deepSelected"]
        and report["coCreationSelected"]
        and report["twoMaterialsVisibleInReview"]
        and report["briefConfirmed"]
        and not report["modelCallStarted"]
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
