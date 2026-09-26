from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

from playwright.sync_api import sync_playwright


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify composer focus/draft continuity and per-project navigation in the isolated mock UI"
    )
    parser.add_argument("--url", default="http://127.0.0.1:4174")
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.on("console", lambda message: print(f"browser:{message.type}:{message.text}", flush=True))
        page.on("pageerror", lambda error: print(f"browser:error:{error}", flush=True))
        page.goto(args.url)
        page.wait_for_load_state("networkidle")

        # Replace the regular mock mount with the real shell plus a configured,
        # deterministic bridge. No desktop runtime or external model is used.
        page.evaluate(
            """async () => {
              const React = await import('/@id/react');
              const ReactDom = await import('/@id/react-dom/client');
              const workspace = '/@fs/D:/OneDrive%20-%20%E4%B8%8A%E6%B5%B7%E8%93%9D%E7%9B%9F%E7%BD%91%E7%BB%9C%E6%8A%80%E6%9C%AF%E6%9C%89%E9%99%90%E5%85%AC%E5%8F%B8/projects/%E6%96%87%E7%AB%A0agent';
              const { WritingAgentShell } = await import(`${workspace}/packages/ui/src/shell/WritingAgentShell.tsx`);
              const { createDeterministicMockBridge } = await import(`${workspace}/packages/client-bridge/src/mock-bridge.ts`);
              const { createDefaultWritingUiRegistry } = await import(`${workspace}/packages/writing-ui/src/index.ts`);
              // Explicit completion barriers: a fast 450ms timer made this test
              // accidentally submit the next draft on slower Windows hosts.
              const realTimeout = window.setTimeout.bind(window);
              const completions = [];
              window.setTimeout = (callback, delay, ...args) => {
                if (delay !== 424242) return realTimeout(callback, delay, ...args);
                const id = realTimeout(callback, delay, ...args);
                completions.push(() => { clearTimeout(id); callback(...args); });
                return id;
              };
              window.__finishWriting = () => completions.splice(0).forEach(f => f());
              const mock = createDeterministicMockBridge({ latencyMs: 424242 });
              window.__mock = mock;
              let sourceSnapshot;
              let configuredSnapshot;
              const bridge = {
                ...mock,
                getSnapshot: () => {
                  const snapshot = mock.getSnapshot();
                  if (snapshot !== sourceSnapshot) {
                    sourceSnapshot = snapshot;
                    configuredSnapshot = { ...snapshot, settings: { ...snapshot.settings, credentialReference: 'TEST_ONLY', providerLabel: 'Isolated mock' } };
                  }
                  return configuredSnapshot;
                },
                startConversation: async (text) => {
                  const result = await mock.sendMessage(text);
                  await new Promise(resolve => { window.__releaseHandoff = resolve; });
                  return result;
                },
              };
              document.body.innerHTML = '<div id="rc20-root" style="width:100vw;height:100vh"></div>';
              const mount = document.getElementById('rc20-root');
              const createRoot = ReactDom.createRoot ?? ReactDom.default.createRoot;
              const createElement = React.createElement ?? React.default.createElement;
              createRoot(mount).render(createElement(WritingAgentShell, {
                bridge,
                extensions: createDefaultWritingUiRegistry(),
                hostConfiguration: {},
              }));
            }"""
        )
        page.get_by_role("textbox", name="写作指令").wait_for()

        new_project = page.get_by_role("button", name="新建项目", exact=True)
        if new_project.count() != 1:
            raise AssertionError("PRIMARY_NEW_PROJECT_ACTION_MISSING")

        for project_name in ("新品发布项目", "客户案例专题"):
            row = page.locator('[data-project-row]').filter(has_text=project_name)
            if row.count() != 1:
                raise AssertionError(f"PROJECT_ROW_MISSING:{project_name}")
            if row.get_by_role("button", name=f'在项目“{project_name}”中新建对话', exact=True).count() != 1:
                raise AssertionError(f"PROJECT_NEW_CONVERSATION_MISSING:{project_name}")
            controls = row.locator("button").all()
            if controls[-1].get_attribute("aria-label") != f'在项目“{project_name}”中新建对话':
                raise AssertionError(f"PROJECT_NEW_CONVERSATION_NOT_RIGHTMOST:{project_name}")

        # Starting from the hero replaces that Composer with the conversation
        # Composer. Focus must cross the remount without a mouse click.
        new_project.click()
        hero_editor = page.get_by_role("textbox", name="写作指令")
        hero_editor.fill("从首页开始的输入")
        hero_editor.dispatch_event('keydown', {'key':'Enter', 'code':'Enter', 'isComposing':True})
        if page.get_by_role('button',name='停止生成',exact=True).count():
            raise AssertionError('IME_ENTER_SUBMITTED_DRAFT')
        hero_editor.press("Enter")
        hero_editor.fill("首页提交等待期预写")
        page.evaluate('window.__releaseHandoff()')
        conversation_editor = page.get_by_role("textbox", name="写作指令")
        page.wait_for_function("document.activeElement?.getAttribute('aria-label') === '写作指令'")
        page.wait_for_timeout(50)
        if conversation_editor.inner_text() != "首页提交等待期预写":
            raise AssertionError("HERO_HANDOFF_DRAFT_WAS_CLEARED")

        # The running state accepts a new draft but Enter cannot submit it or
        # clear it. Completion must leave both focus and text intact.
        conversation_editor.fill("生成中预写的下一条")
        conversation_editor.press("Enter")
        page.evaluate('window.__finishWriting()')
        page.get_by_role('button', name='发送', exact=True).wait_for()
        if conversation_editor.inner_text() != "生成中预写的下一条":
            raise AssertionError("PREFILLED_DRAFT_WAS_CLEARED")
        if conversation_editor.get_attribute("contenteditable") != "true":
            raise AssertionError("COMPOSER_NOT_WRITABLE_WHILE_RUNNING")
        if page.evaluate("document.activeElement?.getAttribute('aria-label')") != "写作指令":
            raise AssertionError("COMPOSER_FOCUS_LOST_AFTER_COMPLETION")

        # A later completion must not steal focus after the user deliberately
        # chooses another control.
        conversation_editor.press("Enter")
        page.get_by_role("button", name="停止生成", exact=True).wait_for()
        runs_tab = page.get_by_role("button", name=re.compile(r"^运行记录"))
        runs_tab.click()
        page.evaluate('window.__finishWriting()')
        page.wait_for_function('window.__mock.getSnapshot().activeRunId === null')
        if page.evaluate("document.activeElement?.textContent?.trim().startsWith('运行记录')") is not True:
            raise AssertionError("RUN_COMPLETION_STOLE_USER_FOCUS")

        page.screenshot(path=str(args.output_dir / "rc20-composer-navigation.png"), full_page=True)
        report = {
            "status": "PASS",
            "primaryAction": "新建项目",
            "projectRows": 2,
            "heroRemountFocus": True,
            "prefillPreserved": True,
            "completionFocusPolicy": True,
            "imeEnterDoesNotSubmit": True,
        }
        (args.output_dir / "rc20-composer-navigation.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(json.dumps(report, ensure_ascii=False), flush=True)
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
