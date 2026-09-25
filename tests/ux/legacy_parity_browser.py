"""Real production-renderer clicks over Local Web Host with synthetic data/provider."""
import json
from pathlib import Path
import subprocess
import time
import traceback

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import expect, sync_playwright


root = Path(__file__).resolve().parents[2]
evidence = root / "output" / "legacy-parity-browser"
evidence.mkdir(parents=True, exist_ok=True)
server = subprocess.Popen(
    ["node", "--import", "tsx", "tests/ux/legacy_parity_fixture.ts"],
    cwd=root,
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    encoding="utf-8",
)
report = {
    "renderer": "apps/web/dist/production",
    "provider": "synthetic deterministic",
    "realModelCalls": 0,
    "versionSidebarClicks": 0,
    "checks": [],
    "screenshots": [],
}


def fixture_rpc(method):
    server.stdin.write(json.dumps({"method": method}, ensure_ascii=False) + "\n")
    server.stdin.flush()
    response = json.loads(server.stdout.readline())
    assert response["ok"], response
    return response["state"]


ready = None
browser = None
try:
    ready = json.loads(server.stdout.readline())
    report["fixtureRoot"] = ready["fixtureRoot"]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        page_errors = []
        console_errors = []
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on(
            "console",
            lambda message: console_errors.append(message.text)
            if message.type == "error"
            else None,
        )
        try:
            page.goto(ready["origin"], wait_until="networkidle", timeout=8000)
            report["networkIdleReached"] = True
        except PlaywrightTimeoutError:
            # The application keeps a protected long-poll subscription open.
            page.wait_for_load_state("domcontentloaded")
            report["networkIdleReached"] = False
            report["networkIdleNote"] = "protected snapshot polling remains active; DOM readiness used"
        page.locator("body").wait_for(state="visible", timeout=15000)

        # Reconnaissance precedes action locators and is preserved as evidence.
        observed = {
            "buttons": page.get_by_role("button").all_text_contents(),
            "headings": page.get_by_role("heading").all_text_contents(),
            "regions": page.get_by_role("region").evaluate_all(
                "els => els.map(e => ({label:e.getAttribute('aria-label'), text:e.innerText.slice(0,500)}))"
            ),
        }
        report["observedDom"] = observed
        observed_path = evidence / "00-observed-dom.png"
        page.screenshot(path=str(observed_path), full_page=True)
        report["screenshots"].append(str(observed_path.relative_to(root)))
        assert any(region["label"] == "稿件修改建议" for region in observed["regions"])
        assert any(region["label"] == "文章导出" for region in observed["regions"])

        revision = page.get_by_role("region", name="稿件修改建议")
        expect(revision).to_be_visible()
        expect(revision.get_by_text("修改前", exact=True)).to_be_visible()
        expect(revision.get_by_text("第二段原来有点拖沓，需要压缩。", exact=True)).to_be_visible()
        expect(revision.get_by_text("修改后", exact=True)).to_be_visible()
        expect(revision.get_by_text("第二段已经压缩。", exact=True)).to_be_visible()
        version_sidebar = page.get_by_role("button", name="稿件与版本", exact=True)
        expect(version_sidebar).to_be_visible()
        proposal_path = evidence / "01-main-conversation-proposal.png"
        page.screenshot(path=str(proposal_path), full_page=True)
        report["screenshots"].append(str(proposal_path.relative_to(root)))
        report["checks"].append("main-conversation-shows-before-and-after-without-version-sidebar")

        accept = revision.get_by_role("button", name="接受这次修改", exact=True)
        expect(accept).to_be_enabled()
        accept.click()
        expect(page.get_by_role("status").get_by_text(
            "修改已保存为新版本，其他段落保持不变；正式导出前需要重新核查。",
            exact=True,
        )).to_be_visible(timeout=15000)
        expect(revision).to_have_count(0)
        after_accept = fixture_rpc("state")
        assert "第一段必须保留。" in after_accept["body"]
        assert "第二段已经压缩。" in after_accept["body"]
        assert "第二段原来有点拖沓，需要压缩。" not in after_accept["body"]
        assert "第三段也必须保留。" in after_accept["body"]
        assert after_accept["factGateStatus"] == "stale"
        assert after_accept["pendingProposals"] == 0
        report["afterAccept"] = after_accept
        report["checks"].append("accept-changes-only-target-block-and-makes-fact-gate-stale")

        export_card = page.get_by_role("region", name="文章导出")
        expect(export_card.get_by_text(
            "稿件已修改，需要重新核查当前版本后再导出。", exact=True
        )).to_be_visible(timeout=15000)
        backup = export_card.get_by_role("button", name="保存工作备份", exact=True)
        recheck = export_card.get_by_role("button", name="重新核查", exact=True)
        expect(backup).to_be_enabled()
        expect(recheck).to_be_enabled()
        stale_path = evidence / "02-stale-actions-visible.png"
        page.screenshot(path=str(stale_path), full_page=True)
        report["screenshots"].append(str(stale_path.relative_to(root)))
        report["checks"].append("stale-main-conversation-shows-backup-and-recheck-actions")

        backup.click()
        expect(export_card.get_by_text("工作备份已保存：", exact=False)).to_be_visible(timeout=15000)
        after_backup = fixture_rpc("state")
        working_copies = [item for item in after_backup["exports"] if item["mode"] == "working_copy"]
        assert len(working_copies) == 1, after_backup
        workspace = Path(ready["workspacePath"]).resolve()
        backup_path = (workspace / working_copies[0]["relativePath"]).resolve()
        assert backup_path.is_relative_to(workspace), backup_path
        assert backup_path.is_file(), backup_path
        backup_content = backup_path.read_text(encoding="utf-8")
        assert "第二段已经压缩。" in backup_content
        assert "第三段也必须保留。" in backup_content
        report["workingCopy"] = {
            "relativePath": working_copies[0]["relativePath"],
            "existsDuringTest": True,
            "containsAcceptedBody": True,
        }
        backup_screen = evidence / "03-working-copy-saved.png"
        page.screenshot(path=str(backup_screen), full_page=True)
        report["screenshots"].append(str(backup_screen.relative_to(root)))
        report["checks"].append("working-copy-button-persists-current-stale-body")

        expect(recheck).to_be_enabled()
        recheck.click()
        # The deterministic provider may finish before the transient "正在核查"
        # notice paints. Poll the persisted gate first, then require the renderer
        # to expose that durable result.
        after_recheck = None
        for _ in range(60):
            candidate = fixture_rpc("state")
            if candidate["factGateStatus"] == "passed":
                after_recheck = candidate
                break
            time.sleep(0.5)
        assert after_recheck is not None, candidate
        expect(export_card.get_by_role("heading", name="当前版本可以正式导出")).to_be_visible(
            timeout=15000
        )
        assert after_recheck["factGateStatus"] == "passed", after_recheck
        assert after_recheck["body"] == after_accept["body"]
        assert after_recheck["providerCalls"] > 0
        report["afterRecheck"] = after_recheck
        report["checks"].append("deterministic-recheck-passes-without-rewriting-body")
        final_path = evidence / "04-recheck-passed.png"
        page.screenshot(path=str(final_path), full_page=True)
        report["screenshots"].append(str(final_path.relative_to(root)))

        # No click targeted the version/sidebar entry throughout this browser run.
        expect(version_sidebar).to_be_visible()
        assert report["versionSidebarClicks"] == 0
        assert not page_errors, page_errors
        assert not console_errors, console_errors
        report["pageErrors"] = page_errors
        report["consoleErrors"] = console_errors
        report["status"] = "PASS"
        browser.close()
        browser = None
except Exception as error:
    report["status"] = "FAIL"
    report["error"] = f"{type(error).__name__}: {error}"
    report["traceback"] = traceback.format_exc()
    raise
finally:
    if browser is not None:
        try:
            browser.close()
        except Exception:
            # sync_playwright has already stopped its event loop on test failure.
            pass
    stderr = ""
    if server.poll() is None:
        _, stderr = server.communicate(input=json.dumps({"method": "stop"}) + "\n", timeout=20)
    elif server.stderr is not None:
        stderr = server.stderr.read()
    report["fixtureStderr"] = stderr
    if ready is not None:
        report["temporaryFixtureRemoved"] = not Path(ready["fixtureRoot"]).exists()
    (evidence / "result.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False))
