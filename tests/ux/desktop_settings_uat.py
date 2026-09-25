from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from urllib.request import urlopen

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify the saved provider connection and recovery entry in the desktop UI"
    )
    parser.add_argument("--cdp-endpoint", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def websocket_endpoint(endpoint: str) -> str:
    with urlopen(f"{endpoint.rstrip('/')}/json/version", timeout=5) as response:
        return str(json.load(response)["webSocketDebuggerUrl"])


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

        close_workbench = page.get_by_role("button", name="关闭稿件面板", exact=True)
        if close_workbench.count() > 0:
            close_workbench.click()

        dialog = page.get_by_role("dialog", name="设置", exact=True)
        if dialog.count() == 0:
            page.get_by_role("button", name="设置", exact=True).click()
        dialog.wait_for(state="visible")
        dialog.get_by_role("button", name="模型", exact=True).click()

        verify = dialog.get_by_role("button", name="验证已保存配置", exact=True)
        verify.wait_for(state="visible")
        result = dialog.get_by_text(
            "连接验证通过：鉴权、模型、流式响应和工具调用均可用。",
            exact=True,
        )
        started = time.monotonic()
        verify.click()
        result.wait_for(state="visible", timeout=60_000)
        elapsed_ms = round((time.monotonic() - started) * 1000)
        connection_copy = result.inner_text()
        page.screenshot(path=str(args.output_dir / "provider-connection-passed.png"), full_page=True)

        dialog.get_by_role("button", name="数据与诊断", exact=True).click()
        restore_heading = dialog.get_by_text("从整库备份恢复", exact=True)
        restore_heading.wait_for(state="visible")
        restore_heading.scroll_into_view_if_needed()
        page.screenshot(path=str(args.output_dir / "workspace-restore-entry.png"), full_page=True)

        report = {
            "providerConnection": "passed",
            "providerConnectionElapsedMs": elapsed_ms,
            "connectionCopy": connection_copy,
            "restoreEntryVisible": restore_heading.is_visible(),
            "restoreActionVisible": dialog.get_by_role(
                "button", name="选择备份并检查", exact=True
            ).is_visible(),
            "restoreSafetyCopyVisible": dialog.get_by_text(
                "先只读检查你选定的备份。确认后会自动保存当前工作区的安全副本，再替换工作区并重启；Windows 凭据管理器中的模型 Key 不受影响。",
                exact=True,
            ).count()
            > 0,
        }
        (args.output_dir / "settings-uat-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False), flush=True)

        dialog.get_by_role("button", name="关闭设置", exact=True).click()
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
