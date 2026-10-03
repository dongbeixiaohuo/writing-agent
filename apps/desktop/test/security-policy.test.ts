import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  DESKTOP_APP_ORIGIN,
  DESKTOP_BRIDGE_CHANNEL,
  createSecureWebPreferences,
  isAllowedNavigation,
  isTrustedIpcSender,
  resolveRendererAsset,
} from "../src/security-policy.js";

describe("Electron desktop security policy", () => {
  it("keeps the renderer sandboxed behind one fixed preload channel", () => {
    const preload = resolve("apps/desktop/dist/preload.cjs");
    assert.deepEqual(createSecureWebPreferences(preload), {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
    });
    assert.equal(DESKTOP_BRIDGE_CHANNEL, "writing-agent:bridge:v7");
  });

  it("accepts only the packaged application origin for IPC and navigation", () => {
    assert.equal(DESKTOP_APP_ORIGIN, "writing-agent://app");
    assert.equal(isTrustedIpcSender("writing-agent://app/index.html"), true);
    assert.equal(isAllowedNavigation("writing-agent://app/index.html"), true);
    for (const url of [
      "https://example.com/",
      "file:///C:/private.txt",
      "writing-agent://evil/index.html",
      "data:text/html,<script>alert(1)</script>",
    ]) {
      assert.equal(isTrustedIpcSender(url), false, url);
      assert.equal(isAllowedNavigation(url), false, url);
    }
  });

  it("resolves packaged assets without allowing traversal or arbitrary schemes", () => {
    const root = resolve("apps/desktop/dist/renderer");
    assert.equal(
      resolveRendererAsset(root, "writing-agent://app/assets/index.js"),
      join(root, "assets", "index.js"),
    );
    assert.equal(
      resolveRendererAsset(root, "writing-agent://app/"),
      join(root, "index.html"),
    );
    for (const url of [
      "writing-agent://app/../secret.txt",
      "writing-agent://app/%2e%2e/secret.txt",
      "writing-agent://other/index.html",
      "file:///C:/secret.txt",
    ]) {
      assert.throws(() => resolveRendererAsset(root, url), /DESKTOP_ASSET_/u, url);
    }
  });
});
