import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { normalizeSuggestedProjectName } from "../../application/src/conversation-intake.js";
import { WritingApplicationService } from "../../application/src/index.js";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { createApplicationBridge } from "../src/application-bridge.js";
import { DesktopClientBridge, type DesktopRpcRequest } from "../src/desktop-bridge.js";
import { startLocalWebHost } from "../src/local-web-host.js";
import { createDeterministicMockBridge } from "../src/mock-bridge.js";
import { createWebClientBridge } from "../src/web-bridge.js";
import { UI_BRIDGE_PROTOCOL_VERSION } from "../src/protocol.js";

class NamingIntakeProvider extends ModelProviderBase {
  requests = 0;
  constructor(private readonly delayMs = 0) {
    super("project-naming-intake", "1", { protocol: "mock", streaming: "supported", tools: "supported", usage: "reported" });
  }
  protected async *providerStream(_request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests += 1;
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    yield {
      type: "tool_call_delta",
      index: 0,
      id: `project-name-${this.requests}`,
      name: "respond_writing_intake",
      argumentsDelta: JSON.stringify({
        reply: "我们可以先围绕企业 AI 项目的落地经验梳理重点。",
        summary: "讨论企业 AI 项目的落地经验。",
        questions: [],
        suggestedProjectName: "企业 AI 落地经验",
      }),
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= expiresAt) throw new Error("condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("project naming bridge", () => {
  it("normalizes semantic labels without turning URLs into project names", () => {
    assert.equal(normalizeSuggestedProjectName("  《企业 AI 交付实践》  "), "企业 AI 交付实践");
    assert.equal(normalizeSuggestedProjectName("https://example.com/article"), null);
    assert.equal(normalizeSuggestedProjectName("好"), null);
    assert.equal(Array.from(normalizeSuggestedProjectName("这是一个需要被截断的非常非常非常非常长的项目语义名称") ?? "").length, 24);
  });

  it("persists a manual rename through the application bridge", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-project-rename-bridge-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({ storage });
    const bridge = createApplicationBridge({
      service,
      workspaceId: "project-rename-workspace",
      model: {
        model: "not-configured",
        providerLabel: "未配置模型",
        credentialReference: null,
        parameters: { temperature: 0, toolChoice: "auto" },
      },
      operationIdFactory: (() => {
        let id = 0;
        return () => `project-rename-${++id}`;
      })(),
    });
    try {
      const created = await bridge.createProject({
        name: "初始项目名",
        mode: "quick",
        topic: "命名验证",
        genre: "explanatory_analysis",
        audience: "测试人员",
        targetCharacters: 600,
        constraints: [],
        interactionMode: "co_creation",
        authorVoice: null,
        styleReference: null,
        styleDecision: "unspecified",
        directionDecision: "tentative",
        platform: null,
        publicationGoal: "not_applicable",
        materials: [],
      });
      await bridge.renameProject!(created.projectId, "手动命名项目");
      assert.equal(service.listProjects()[0]?.name, "手动命名项目");
      assert.equal(bridge.getSnapshot().projects[0]?.name, "手动命名项目");
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("uses the existing intake model response to name a new project without another request", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-project-auto-name-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new NamingIntakeProvider();
    const service = new WritingApplicationService({ storage, provider });
    const bridge = createApplicationBridge({
      service,
      workspaceId: "project-auto-name-workspace",
      model: { model: "naming-model", providerLabel: "命名测试模型", credentialReference: "TEST_ONLY", parameters: { temperature: 0, toolChoice: "auto" } },
    });
    try {
      await bridge.startConversation("https://example.test/report\n你好，想聊聊企业 AI 项目落地经验。", { operationId: "auto-name-start" });
      await waitUntil(() => service.listProjects()[0]?.name === "企业 AI 落地经验");
      assert.equal(provider.requests, 1);
      assert.equal(service.listProjects()[0]?.name, "企业 AI 落地经验");
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("keeps a manual rename made while intake is still generating", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-project-name-race-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const provider = new NamingIntakeProvider(40);
    const service = new WritingApplicationService({ storage, provider });
    const bridge = createApplicationBridge({
      service,
      workspaceId: "project-name-race-workspace",
      model: { model: "naming-model", providerLabel: "命名测试模型", credentialReference: "TEST_ONLY", parameters: { temperature: 0, toolChoice: "auto" } },
    });
    try {
      await bridge.startConversation("先聊聊企业 AI 项目落地经验。", { operationId: "race-name-start" });
      await bridge.renameProject!("project:race-name-start", "客户手动命名", { operationId: "race-manual-name" });
      await waitUntil(() => service.getProjectProjection("project:race-name-start").runs[0]?.status === "completed");
      assert.equal(service.listProjects()[0]?.name, "客户手动命名");
    } finally {
      bridge.dispose();
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("supports manual rename in the deterministic UI mock", async () => {
    const bridge = createDeterministicMockBridge({ latencyMs: 0 });
    await bridge.renameProject!("project-launch", "手动改名演示");
    assert.equal(bridge.getSnapshot().projects[0]?.name, "手动改名演示");
  });

  it("carries manual rename through the local Web transport", async () => {
    const root = mkdtempSync(join(tmpdir(), "wa-project-name-web-"));
    const staticRoot = join(root, "static");
    mkdirSync(staticRoot);
    writeFileSync(join(staticRoot, "index.html"), "<!doctype html><html><head></head><body>test</body></html>", "utf8");
    const storage = openWorkspaceStorage({ workspacePath: join(root, "workspace") });
    const service = new WritingApplicationService({ storage });
    service.createProject({ operationId: "web-project", projectId: "web-project", name: "Web 旧名称", mode: "quick", actor: { kind: "user", id: "test" } });
    const host = await startLocalWebHost({
      staticRoot,
      bridgeFactory: () => createApplicationBridge({
        service,
        workspaceId: "project-name-web",
        model: { model: "none", providerLabel: "未配置", credentialReference: null, parameters: {} },
      }),
      pollTimeoutMs: 5,
    });
    let web: ReturnType<typeof createWebClientBridge> | undefined;
    try {
      const html = await (await fetch(`${host.origin}/`)).text();
      const bootstrap = html.match(/<meta name="writing-agent-bootstrap-capability" content="([^"]+)">/u)?.[1];
      assert.ok(bootstrap);
      const browserFetch: typeof fetch = (input, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("origin", host.origin);
        return fetch(input, { ...init, headers });
      };
      web = createWebClientBridge({ baseUrl: host.origin, bootstrapCapability: bootstrap, fetchImpl: browserFetch, pollDelayMs: 5 });
      await web.handshake();
      await web.renameProject!("web-project", "Web 手动新名称", { operationId: "web-rename" });
      assert.equal(service.listProjects()[0]?.name, "Web 手动新名称");
    } finally {
      web?.dispose();
      await host.close();
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("carries manual rename through the desktop protocol allowlist", async () => {
    const mock = createDeterministicMockBridge({ latencyMs: 0 });
    const snapshot = mock.getSnapshot();
    mock.dispose();
    const requests: DesktopRpcRequest[] = [];
    const bridge = new DesktopClientBridge({
      async invoke(request) {
        requests.push(request);
        if (request.method === "handshake") return { ok: true, result: {
          protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
          clientBuild: "project-naming-test",
          runtimeBuild: "project-naming-test",
          capabilities: ["project.rename"],
          mock: false,
          persistsUserProjects: true,
          workspaceId: snapshot.workspaceId,
        }, snapshot };
        return { ok: true, result: null, snapshot };
      },
      subscribe: () => () => undefined,
    }, () => "desktop-rename-operation");
    await bridge.handshake();
    await bridge.renameProject("project-launch", "桌面手动新名称");
    assert.deepEqual(requests.at(-1)?.args, ["project-launch", "桌面手动新名称", { operationId: "desktop-rename-operation" }]);
    bridge.dispose();
  });
});
