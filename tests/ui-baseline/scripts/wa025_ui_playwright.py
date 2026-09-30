from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import platform
import subprocess
import tempfile
import time
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from typing import Any
from urllib.parse import urlparse

from PIL import Image, ImageChops, ImageEnhance
from playwright.sync_api import Browser, Error as PlaywrightError, Page, sync_playwright


ROOT = Path(__file__).resolve().parents[3]
FIXTURE_PATH = ROOT / "tests" / "ui-baseline" / "fixtures" / "wa025-content.json"
HOST_SCRIPT = ROOT / "tests" / "ui-baseline" / "fixtures" / "wa025-local-host.ts"
OUTPUT = ROOT / "output" / "playwright" / "wa025"
WA023_BASELINE = ROOT / "output" / "playwright" / "wa023"
PIXEL_CHANNEL_THRESHOLD = 16
MAX_CHANGED_PIXEL_RATIO = 0.02
MAX_MEAN_CHANNEL_DELTA = 2.0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run WA-025 UI consistency acceptance")
    parser.add_argument(
        "--upstream-url",
        default="http://127.0.0.1:4173/preview.html?preview-fixture=vfs-example",
    )
    parser.add_argument("--derived-url", default="http://127.0.0.1:4174/")
    parser.add_argument(
        "--serve-static",
        action="store_true",
        help="serve the built upstream and derived assets on random loopback ports",
    )
    parser.add_argument("--upstream-dist")
    parser.add_argument(
        "--derived-dist",
        default=str(ROOT / "apps" / "web" / "dist" / "mock"),
    )
    return parser.parse_args()


class QuietStaticHandler(SimpleHTTPRequestHandler):
    def log_message(self, _format: str, *_args: object) -> None:
        return


def start_static_server(root: Path) -> str:
    assert root.is_dir(), f"static root does not exist: {root}"
    handler = partial(QuietStaticHandler, directory=str(root))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def cleanup() -> None:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    atexit.register(cleanup)
    return f"http://127.0.0.1:{server.server_port}"


def tracker(page: Page) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {
        "consoleErrors": [],
        "pageErrors": [],
        "requests": [],
        "httpFailures": [],
    }
    page.on(
        "console",
        lambda message: result["consoleErrors"].append(message.text)
        if message.type == "error"
        else None,
    )
    page.on("pageerror", lambda error: result["pageErrors"].append(str(error)))
    page.on("request", lambda request: result["requests"].append(request.url))
    page.on(
        "response",
        lambda response: result["httpFailures"].append(
            f"{response.status} {response.url}"
        )
        if response.status >= 400
        else None,
    )
    return result


def capture(page: Page, name: str, paths: list[Path]) -> Path:
    target = OUTPUT / name
    page.screenshot(path=str(target), full_page=True)
    paths.append(target)
    return target


def goto_local(page: Page, url: str) -> None:
    """Tolerate only the local static server's first-connection race."""
    last_error: PlaywrightError | None = None
    for _ in range(3):
        try:
            page.goto(url, wait_until="domcontentloaded")
            return
        except PlaywrightError as error:
            last_error = error
            page.wait_for_timeout(250)
    assert last_error is not None
    raise last_error


def wait_for_theme(page: Page, dark: bool) -> None:
    page.wait_for_function(
        "expected => document.body.hasAttribute('data-ds-dark-theme') === expected",
        arg=dark,
    )


def open_settings(page: Page) -> None:
    buttons = page.get_by_role("button", name="设置", exact=True)
    assert buttons.count() >= 1, "settings button is missing"
    buttons.last.click()
    page.get_by_role("dialog").wait_for()


def select_theme(page: Page, label: str, dark: bool) -> None:
    page.get_by_role("button", name=label, exact=True).click()
    wait_for_theme(page, dark)


def close_settings_with_escape(page: Page) -> None:
    page.keyboard.press("Escape")
    page.get_by_role("dialog").wait_for(state="detached")


def layout_metrics(page: Page) -> dict[str, Any]:
    return page.evaluate(
        """
        () => {
          const rect = (element) => {
            if (!(element instanceof Element)) return null
            const value = element.getBoundingClientRect()
            return {
              x: Math.round(value.x * 100) / 100,
              y: Math.round(value.y * 100) / 100,
              width: Math.round(value.width * 100) / 100,
              height: Math.round(value.height * 100) / 100,
            }
          }
          const candidates = [...document.querySelectorAll('body *')]
            .filter((element) => {
              const box = element.getBoundingClientRect()
              const style = getComputedStyle(element)
              return style.display === 'grid' &&
                box.width >= window.innerWidth - 2 &&
                box.height >= window.innerHeight - 2 &&
                style.gridTemplateColumns.split(' ').length >= 2
            })
            .sort((left, right) => {
              const a = left.getBoundingClientRect()
              const b = right.getBoundingClientRect()
              return (b.width * b.height) - (a.width * a.height)
            })
          const frame = candidates[0] ?? null
          const children = frame === null
            ? []
            : [...frame.children].filter((element) => element.getBoundingClientRect().height > 0)
          const editor = document.querySelector('[contenteditable="true"][role="textbox"]')
          let composer = editor
          while (composer?.parentElement) {
            const box = composer.getBoundingClientRect()
            const parent = composer.parentElement
            const parentBox = parent.getBoundingClientRect()
            if (parentBox.width > box.width + 20 && parentBox.width <= 900) {
              composer = parent
              break
            }
            composer = parent
          }
          const bodyStyle = getComputedStyle(document.body)
          return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            deviceScaleFactor: window.devicePixelRatio,
            frame: rect(frame),
            gridTemplateColumns: frame === null ? null : getComputedStyle(frame).gridTemplateColumns,
            sidebar: rect(children[0] ?? null),
            center: rect(children[1] ?? null),
            editor: rect(editor),
            composer: rect(composer),
            backgroundColor: bodyStyle.backgroundColor,
            textColor: bodyStyle.color,
            businessColor: bodyStyle.getPropertyValue('--dsw-alias-state-business-primary').trim(),
            horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          }
        }
        """
    )


def dialog_metrics(page: Page) -> dict[str, Any]:
    return page.get_by_role("dialog").evaluate(
        """
        (dialog) => {
          const box = dialog.getBoundingClientRect()
          const nav = dialog.querySelector('nav')
          const navBox = nav?.getBoundingClientRect()
          return {
            width: Math.round(box.width * 100) / 100,
            height: Math.round(box.height * 100) / 100,
            navWidth: navBox === undefined ? null : Math.round(navBox.width * 100) / 100,
            ariaModal: dialog.getAttribute('aria-modal'),
          }
        }
        """
    )


def boot_upstream(page: Page, url: str) -> None:
    goto_local(page, url)
    ready = page.get_by_text("WebWorker Preview Showcase", exact=False).first
    start = page.get_by_role("button", name="Start Preview")
    started = False
    # The upstream project's own preview-boot acceptance allows four minutes
    # for the WebWorker image to become interactive on a cold Windows start.
    expires_at = time.monotonic() + 240
    while time.monotonic() < expires_at:
        if ready.count() > 0 and ready.is_visible():
            break
        if not started and start.count() > 0 and start.is_visible():
            start.click(no_wait_after=True)
            started = True
        page.wait_for_timeout(1_000)
    else:
        state = page.locator("body").inner_text()[:2_000]
        raise AssertionError(f"upstream preview did not become ready: {state}")
    dismiss_upstream_startup_dialogs(page)


def dismiss_upstream_startup_dialogs(page: Page) -> None:
    """Finish deterministic first-run dialogs before baseline capture."""
    presentations = page.locator('[role="presentation"]')
    button_names = ("稍后配置", "继续", "Continue")
    quiet_since: float | None = None
    expires_at = time.monotonic() + 20
    last_visible: list[str] = []
    while time.monotonic() < expires_at:
        handled = False
        for name in button_names:
            candidates = (
                page.get_by_role("button", name=name, exact=True),
                page.get_by_text(name, exact=True),
            )
            for button in candidates:
                if button.count() == 0 or not button.last.is_visible():
                    continue
                overlay = presentations.filter(has=button.last)
                button.last.click()
                if overlay.count() > 0:
                    overlay.last.wait_for(state="detached")
                handled = True
                quiet_since = None
                break
            if handled:
                break
        if handled:
            continue

        visible = [
            presentations.nth(index).inner_text()
            for index in range(presentations.count())
            if presentations.nth(index).is_visible()
        ]
        if visible:
            last_visible = visible
            quiet_since = None
            page.wait_for_timeout(100)
            continue
        quiet_since = quiet_since or time.monotonic()
        if time.monotonic() - quiet_since >= 2:
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"upstream startup dialogs did not settle: {last_visible}")


def assert_local_network(records: dict[str, list[str]], label: str) -> None:
    external = []
    for value in records["requests"]:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https", "ws", "wss"} and parsed.hostname != "127.0.0.1":
            external.append(value)
    assert external == [], f"{label} made external requests: {external}"


def compare_pixels(current: Path, baseline: Path) -> dict[str, Any]:
    with Image.open(current).convert("RGB") as current_image, Image.open(baseline).convert(
        "RGB"
    ) as baseline_image:
        assert current_image.size == baseline_image.size, (
            current.name,
            current_image.size,
            baseline_image.size,
        )
        difference = ImageChops.difference(current_image, baseline_image)
        pixels = list(difference.getdata())
        changed = sum(1 for pixel in pixels if max(pixel) > PIXEL_CHANNEL_THRESHOLD)
        total = current_image.width * current_image.height
        histogram = difference.histogram()
        channel_total = sum(
            value * count
            for channel in range(3)
            for value, count in enumerate(histogram[channel * 256 : (channel + 1) * 256])
        )
        mean_delta = channel_total / (total * 3)
        diff_path = OUTPUT / f"diff-{current.stem}-vs-wa023.png"
        ImageEnhance.Brightness(difference).enhance(4).save(diff_path)
        return {
            "current": current.relative_to(ROOT).as_posix(),
            "baseline": baseline.relative_to(ROOT).as_posix(),
            "diff": diff_path.relative_to(ROOT).as_posix(),
            "changedPixelRatio": changed / total,
            "meanChannelDelta": mean_delta,
            "channelThreshold": PIXEL_CHANNEL_THRESHOLD,
            "maxChangedPixelRatio": MAX_CHANGED_PIXEL_RATIO,
            "maxMeanChannelDelta": MAX_MEAN_CHANNEL_DELTA,
        }


def assert_structural_parity(upstream: dict[str, Any], derived: dict[str, Any]) -> dict[str, float]:
    assert upstream["sidebar"] is not None and derived["sidebar"] is not None
    assert upstream["center"] is not None and derived["center"] is not None
    assert upstream["editor"] is not None and derived["editor"] is not None
    deltas = {
        "sidebarWidth": abs(upstream["sidebar"]["width"] - derived["sidebar"]["width"]),
        "centerLeft": abs(upstream["center"]["x"] - derived["center"]["x"]),
        "editorWidth": abs(upstream["editor"]["width"] - derived["editor"]["width"]),
    }
    assert deltas["sidebarWidth"] <= 1, deltas
    assert deltas["centerLeft"] <= 1, deltas
    assert deltas["editorWidth"] <= 40, deltas
    assert upstream["backgroundColor"] == derived["backgroundColor"], (upstream, derived)
    assert upstream["textColor"] == derived["textColor"], (upstream, derived)
    assert derived["horizontalOverflow"] <= 0, derived
    return deltas


def start_application_host(workspace: Path) -> tuple[subprocess.Popen[str], str]:
    creation_flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    process = subprocess.Popen(
        [
            "node",
            "--import",
            "tsx",
            str(HOST_SCRIPT),
            "--workspace",
            str(workspace),
            "--fixture",
            str(FIXTURE_PATH),
        ],
        cwd=ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=creation_flags,
    )
    assert process.stdout is not None
    line = process.stdout.readline().strip()
    if not line:
        stderr = process.stderr.read() if process.stderr is not None else ""
        raise AssertionError(f"WA-025 fixture host did not start: {stderr}")
    payload = json.loads(line)
    assert payload["status"] == "ready", payload
    return process, str(payload["origin"])


def stop_application_host(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def run_upstream(browser: Browser, url: str, screenshots: list[Path]) -> dict[str, Any]:
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        color_scheme="light",
        reduced_motion="reduce",
    )
    page = context.new_page()
    records = tracker(page)
    try:
        boot_upstream(page, url)
        open_settings(page)
        select_theme(page, "浅色", False)
        light_dialog = dialog_metrics(page)
        capture(page, "upstream-settings-light-1440x900.png", screenshots)
        close_settings_with_escape(page)
        light_layout = layout_metrics(page)
        capture(page, "upstream-chat-light-1440x900.png", screenshots)

        open_settings(page)
        select_theme(page, "深色", True)
        dark_dialog = dialog_metrics(page)
        capture(page, "upstream-settings-dark-1440x900.png", screenshots)
        close_settings_with_escape(page)
        dark_layout = layout_metrics(page)
        capture(page, "upstream-chat-dark-1440x900.png", screenshots)
        page.set_viewport_size({"width": 1280, "height": 800})
        capture(page, "upstream-chat-dark-1280x800.png", screenshots)

        assert records["pageErrors"] == [], records
        known_404s = {
            "/open-in-app/apps",
            "/plugins/events",
        }
        unexpected_http = [
            failure
            for failure in records["httpFailures"]
            if urlparse(failure.split(" ", 1)[1]).path not in known_404s
        ]
        assert unexpected_http == [], unexpected_http
        assert len(records["consoleErrors"]) <= len(known_404s), records["consoleErrors"]
        assert_local_network(records, "upstream reference")
        return {
            "lightLayout": light_layout,
            "darkLayout": dark_layout,
            "lightDialog": light_dialog,
            "darkDialog": dark_dialog,
            "knownHttpFailures": records["httpFailures"],
            "consoleErrorCount": len(records["consoleErrors"]),
        }
    finally:
        context.close()


def run_derived(browser: Browser, url: str, screenshots: list[Path]) -> dict[str, Any]:
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        color_scheme="light",
        reduced_motion="reduce",
    )
    page = context.new_page()
    records = tracker(page)
    try:
        goto_local(page, url)
        page.wait_for_load_state("networkidle")
        page.get_by_text("界面移植预览，未接入真实写作", exact=False).wait_for()
        assert "DeepSeek" not in page.locator("body").inner_text()
        assert page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
        page.get_by_role("button", name="公众号初稿", exact=False).click()

        open_settings(page)
        select_theme(page, "浅色", False)
        light_dialog = dialog_metrics(page)
        assert light_dialog["ariaModal"] == "true"
        capture(page, "derived-settings-light-1440x900.png", screenshots)
        close_settings_with_escape(page)
        light_layout = layout_metrics(page)
        capture(page, "derived-chat-light-1440x900.png", screenshots)

        page.get_by_role("textbox", name="写作指令", exact=True).fill(
            "请把标题改得更简洁"
        )
        page.get_by_role("button", name="发送", exact=True).click()
        page.get_by_text(
            "这是界面移植阶段的确定性响应。真实材料读取、模型调用和稿件保存尚未接入。",
            exact=True,
        ).wait_for()

        open_settings(page)
        select_theme(page, "深色", True)
        dark_dialog = dialog_metrics(page)
        capture(page, "derived-settings-dark-1440x900.png", screenshots)
        close_settings_with_escape(page)
        dark_layout = layout_metrics(page)
        capture(page, "derived-chat-dark-1440x900.png", screenshots)
        page.set_viewport_size({"width": 1280, "height": 800})
        capture(page, "derived-chat-dark-1280x800.png", screenshots)

        page.set_viewport_size({"width": 1440, "height": 900})
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        page.get_by_text("演示只读", exact=True).wait_for()
        locked_block = page.locator("[data-block-id='mock-block-1']")
        assert locked_block.get_by_role("button", name="显式解锁").is_disabled()
        assert locked_block.get_by_role("button", name="局部修改").is_disabled()
        page.get_by_role("tab", name="核查与来源", exact=True).click()
        page.get_by_text("存在阻断", exact=True).first.wait_for()
        capture(page, "derived-workbench-dark-1440x900.png", screenshots)
        page.get_by_role("button", name="访谈材料整理", exact=False).click()
        assert page.get_by_role("tab", name="稿件与差异", exact=True).get_attribute(
            "aria-selected"
        ) == "true"
        page.get_by_text("尚无已保存正文", exact=False).wait_for()
        assert "第二段允许" not in page.locator("body").inner_text()

        open_settings(page)
        select_theme(page, "跟随系统", False)
        page.emulate_media(color_scheme="dark", reduced_motion="reduce")
        wait_for_theme(page, True)
        page.emulate_media(color_scheme="light", reduced_motion="reduce")
        wait_for_theme(page, False)
        close_settings_with_escape(page)

        assert records["consoleErrors"] == [], records
        assert records["pageErrors"] == [], records
        assert records["httpFailures"] == [], records
        assert_local_network(records, "derived mock")
        return {
            "lightLayout": light_layout,
            "darkLayout": dark_layout,
            "lightDialog": light_dialog,
            "darkDialog": dark_dialog,
            "consoleErrorCount": 0,
            "pageErrorCount": 0,
        }
    finally:
        context.close()


def run_application(
    browser: Browser,
    workspace: Path,
    screenshots: list[Path],
) -> dict[str, Any]:
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    primary = fixture["primaryProject"]
    secondary = fixture["secondaryProject"]
    process, origin = start_application_host(workspace)
    context = browser.new_context(
        viewport={"width": 1440, "height": 900},
        color_scheme="light",
        reduced_motion="reduce",
    )
    page = context.new_page()
    records = tracker(page)
    try:
        goto_local(page, origin)
        page.get_by_text(
            "已连接自有 Application Service；界面只显示持久提交状态",
            exact=False,
        ).wait_for(timeout=15_000)
        page.get_by_role("button", name=primary["sessionTitle"], exact=False).click()
        page.get_by_role("button", name="稿件与版本", exact=True).click()
        page.get_by_text("版本保护编辑", exact=True).wait_for()

        page.get_by_role("tab", name="核查与来源", exact=True).click()
        page.get_by_text("快照已通过", exact=True).first.wait_for()
        capture(page, "application-facts-passed-light-1440x900.png", screenshots)

        page.get_by_role("tab", name="稿件与差异", exact=True).click()
        preserved = page.locator("[data-block-id]").filter(has_text="第一段需要保持原样。")
        preserved.get_by_role("button", name="锁定", exact=True).click()
        preserved.get_by_role("button", name="显式解锁", exact=True).wait_for()
        assert preserved.get_by_role("button", name="局部修改", exact=True).is_disabled()

        editable = page.locator("[data-block-id]").filter(
            has_text="第二段允许通过受保护 Bridge 修改。"
        )
        editable_block_id = editable.get_attribute("data-block-id")
        assert editable_block_id is not None
        editable = page.locator(f"[data-block-id='{editable_block_id}']")
        editable.get_by_role("button", name="局部修改", exact=True).click()
        editor = editable.get_by_role("textbox", name="编辑块 3", exact=True)
        editor.fill(primary["replacement"])
        editable.get_by_role("textbox", name="修改说明", exact=True).fill(
            "WA-025 浏览器差异验收"
        )
        editable.get_by_role("button", name="生成差异预览", exact=True).click()
        page.get_by_text("差异预览", exact=True).wait_for()
        page.get_by_text(primary["replacement"], exact=True).wait_for()
        page.get_by_role("button", name="接受并创建新版本", exact=True).click()
        page.locator("[data-block-id]").filter(has_text=primary["replacement"]).wait_for()

        page.get_by_role("tab", name="核查与来源", exact=True).click()
        page.get_by_text("结果已失效", exact=True).first.wait_for()
        capture(page, "application-revision-stale-light-1440x900.png", screenshots)

        page.get_by_role("button", name=secondary["sessionTitle"], exact=False).click()
        page.get_by_text("尚无已保存正文", exact=False).wait_for()
        assert page.get_by_role("tab", name="稿件与差异", exact=True).get_attribute(
            "aria-selected"
        ) == "true"
        assert primary["replacement"] not in page.locator("body").inner_text()
        capture(page, "application-project-isolation-light-1440x900.png", screenshots)

        page.get_by_role("button", name=primary["sessionTitle"], exact=False).click()
        page.locator("[data-block-id]").filter(has_text=primary["replacement"]).wait_for()
        open_settings(page)
        select_theme(page, "深色", True)
        page.get_by_role("combobox", name="正文字号", exact=True).select_option("16")
        page.wait_for_function(
            "() => getComputedStyle(document.querySelector('main')).getPropertyValue('--dsh-content-font-size').trim() === '16px'"
        )
        close_settings_with_escape(page)
        page.reload()
        page.get_by_text(
            "已连接自有 Application Service；界面只显示持久提交状态",
            exact=False,
        ).wait_for(timeout=15_000)
        wait_for_theme(page, True)
        open_settings(page)
        assert page.get_by_role("combobox", name="正文字号", exact=True).input_value() == "16"
        close_settings_with_escape(page)
        capture(page, "application-persisted-dark-1440x900.png", screenshots)

        stale_poll_failures = [
            failure
            for failure in records["httpFailures"]
            if failure.startswith("409 ")
            and urlparse(failure.split(" ", 1)[1]).path == "/api/v6/events/poll"
        ]
        unexpected_http = [
            failure
            for failure in records["httpFailures"]
            if failure not in stale_poll_failures
        ]
        assert unexpected_http == [], records
        assert len(records["consoleErrors"]) == len(stale_poll_failures), records
        assert all("409 (Conflict)" in error for error in records["consoleErrors"]), records
        assert records["pageErrors"] == [], records
        assert_local_network(records, "application Web host")
        return {
            "originHost": urlparse(origin).hostname,
            "providerCalls": 0,
            "factGateBeforeEdit": "passed",
            "factGateAfterEdit": "stale",
            "projectIsolation": "passed",
            "settingsPersistence": "passed",
            "expectedStalePollConflictCount": len(stale_poll_failures),
            "unexpectedConsoleErrorCount": 0,
            "pageErrorCount": 0,
        }
    finally:
        context.close()
        stop_application_host(process)


def write_hashes(paths: list[Path]) -> list[dict[str, str]]:
    entries = []
    for path in sorted(set(paths)):
        entries.append(
            {
                "path": path.relative_to(ROOT).as_posix(),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            }
        )
    (OUTPUT / "SHA256SUMS.txt").write_text(
        "".join(f"{entry['sha256']}  {Path(entry['path']).name}\n" for entry in entries),
        encoding="utf-8",
    )
    return entries


def main() -> None:
    args = parse_args()
    upstream_url = args.upstream_url
    derived_url = args.derived_url
    if args.serve_static:
        assert args.upstream_dist is not None, "--upstream-dist is required with --serve-static"
        upstream_origin = start_static_server(Path(args.upstream_dist).resolve())
        derived_origin = start_static_server(Path(args.derived_dist).resolve())
        upstream_url = f"{upstream_origin}/preview.html?preview-fixture=vfs-example"
        derived_url = f"{derived_origin}/"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    assert (ROOT / "apps" / "web" / "dist" / "production" / "index.html").is_file(), (
        "run npm run ui:build before WA-025 browser acceptance"
    )
    screenshots: list[Path] = []
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            upstream = run_upstream(browser, upstream_url, screenshots)
            derived = run_derived(browser, derived_url, screenshots)
            with tempfile.TemporaryDirectory(prefix="wa025-ui-") as temp:
                application = run_application(browser, Path(temp), screenshots)

            structural = {
                "light": assert_structural_parity(
                    upstream["lightLayout"], derived["lightLayout"]
                ),
                "dark": assert_structural_parity(
                    upstream["darkLayout"], derived["darkLayout"]
                ),
                "dialogWidthDeltaLight": abs(
                    upstream["lightDialog"]["width"]
                    - derived["lightDialog"]["width"]
                ),
                "dialogWidthDeltaDark": abs(
                    upstream["darkDialog"]["width"]
                    - derived["darkDialog"]["width"]
                ),
            }
            assert structural["dialogWidthDeltaLight"] <= 2, structural
            assert structural["dialogWidthDeltaDark"] <= 2, structural

            comparisons = []
            for name in (
                "derived-chat-light-1440x900.png",
                "derived-chat-dark-1440x900.png",
                "derived-chat-dark-1280x800.png",
                "derived-settings-light-1440x900.png",
                "derived-settings-dark-1440x900.png",
            ):
                comparisons.append(compare_pixels(OUTPUT / name, WA023_BASELINE / name))
            visual_failures = [
                item
                for item in comparisons
                if item["changedPixelRatio"] > MAX_CHANGED_PIXEL_RATIO
                or item["meanChannelDelta"] > MAX_MEAN_CHANNEL_DELTA
            ]
            hashes = write_hashes(screenshots)
            report = {
                "schemaVersion": 1,
                "task": "WA-025",
                "generatedAt": datetime.now().astimezone().isoformat(),
                "environment": {
                    "os": platform.platform(),
                    "browser": f"Chromium {browser.version}",
                    "deviceScaleFactor": 1,
                    "viewports": ["1440x900", "1280x800"],
                    "themes": ["light", "dark", "system"],
                    "reducedMotion": "reduce",
                    "staticFixtureServers": (
                        "managed-random-loopback" if args.serve_static else "external"
                    ),
                },
                "upstream": upstream,
                "derived": derived,
                "application": application,
                "structuralParity": structural,
                "pixelRegressionAgainstWa023": comparisons,
                "screenshots": hashes,
                "visualFailures": visual_failures,
            }
            (OUTPUT / "WA025_REPORT.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            assert visual_failures == [], visual_failures
        finally:
            browser.close()

    print(
        f"WA025 UI/bridge consistency: PASS ({len(screenshots)} screenshots, "
        f"report={OUTPUT / 'WA025_REPORT.json'})"
    )


if __name__ == "__main__":
    main()
