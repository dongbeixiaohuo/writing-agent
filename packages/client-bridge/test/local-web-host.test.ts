import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { WritingApplicationService } from "../../application/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import type { WritingBrief } from "../../writing-core/src/index.js";
import { createApplicationBridge } from "../src/application-bridge.js";
import { startLocalWebHost } from "../src/local-web-host.js";
import { UI_BRIDGE_PROTOCOL_VERSION } from "../src/protocol.js";
import { createWebClientBridge } from "../src/web-bridge.js";
import { ImmediateWorkflowProvider } from "./helpers/workflow-provider.js";

const actor = { kind: "user", id: "local-web-test" } as const;

function seed(service: WritingApplicationService): void {
  const brief: WritingBrief = {
    schemaVersion: 1,
    topic: "本地 Web 安全桥接",
    genre: "explanatory_analysis",
    audience: "本地用户",
    lengthTarget: { targetCharacters: 600 },
    materialIds: ["material-1"],
    constraints: [],
    interactionMode: "autonomous",
    authorAuthorization: {
      voice: null,
      styleReference: null,
      styleDecision: "unspecified",
      directionDecision: "user_confirmed",
      firsthandMaterialIds: [],
    },
    platform: null,
    publicationGoal: "not_applicable",
    confirmationStatus: "confirmed",
  };
  assert.equal(
    service.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "本地 Web 项目",
      mode: "quick",
      actor,
    }).ok,
    true,
  );
  assert.equal(
    service.importMaterial({
      operationId: "import-material",
      projectId: "project-1",
      expectedProjectRevision: 0,
      materialId: "material-1",
      displayName: "材料.md",
      sourceKind: "utf8_file",
      sourceReference: "D:\\private\\customer\\material.md",
      role: "source_verified",
      trustLabel: "user_provided_untrusted",
      permissionScope: "project_only",
      content: "PRIVATE-LOCAL-WEB-MATERIAL",
      actor,
    }).ok,
    true,
  );
  assert.equal(
    service.saveWritingBrief({
      operationId: "save-brief",
      projectId: "project-1",
      expectedProjectRevision: 1,
      baseVersionId: null,
      brief,
      actor,
    }).ok,
    true,
  );
}

function staticFixture(): { root: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), "wa-web-static-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(
    join(root, "index.html"),
    "<!doctype html><html><head><title>Writing Agent</title></head><body><script type=\"module\" src=\"/assets/app.js\"></script></body></html>",
    "utf8",
  );
  writeFileSync(join(root, "assets", "app.js"), "export const app = true\n", "utf8");
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function bootstrapFrom(html: string): string {
  const match = html.match(
    /<meta name="writing-agent-bootstrap-capability" content="([^"]+)">/u,
  );
  assert.notEqual(match, null);
  return match?.[1] ?? "";
}

async function loadBootstrap(origin: string): Promise<{
  token: string;
  response: Response;
}> {
  const response = await fetch(`${origin}/`);
  const html = await response.text();
  return { token: bootstrapFrom(html), response };
}

async function api(
  origin: string,
  route: string,
  capability: string,
  body: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return fetch(`${origin}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-writing-agent-protocol": String(UI_BRIDGE_PROTOCOL_VERSION),
      "x-writing-agent-capability": capability,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function errorCode(payload: unknown): string | undefined {
  return (payload as { error?: { code?: string } }).error?.code;
}

async function apiWithHost(
  origin: string,
  route: string,
  capability: string,
  hostHeader: string,
): Promise<{ status: number; payload: unknown }> {
  const url = new URL(route, origin);
  const body = JSON.stringify({ protocolVersion: UI_BRIDGE_PROTOCOL_VERSION });
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      url,
      {
        method: "POST",
        headers: {
          host: hostHeader,
          origin,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-writing-agent-protocol": String(UI_BRIDGE_PROTOCOL_VERSION),
          "x-writing-agent-capability": capability,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
          resolveResponse({ status: response.statusCode ?? 0, payload });
        });
      },
    );
    request.once("error", rejectResponse);
    request.end(body);
  });
}

describe("secure local Web host", () => {
  it("binds random loopback and enforces Host, Origin, protocol, one-time bootstrap, and generation", async () => {
    const fixture = staticFixture();
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-web-workspace-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({
      storage,
      provider: new ImmediateWorkflowProvider("local-web-test"),
    });
    seed(service);
    const logs: unknown[] = [];
    let timestamp = Date.now();
    const host = await startLocalWebHost({
      staticRoot: fixture.root,
      bridgeFactory: () =>
        createApplicationBridge({
          service,
          workspaceId: "workspace-secure",
          model: {
            model: "test-model",
            providerLabel: "测试 Provider",
            credentialReference: "SECRET_ENV_NAME",
            parameters: { temperature: 0 },
          },
        }),
      logger: (event) => logs.push(event),
      pollTimeoutMs: 10,
      sessionTtlMs: 100,
      now: () => timestamp,
    });
    try {
      const url = new URL(host.origin);
      assert.equal(url.hostname, "127.0.0.1");
      assert.ok(host.port > 0);
      const parallelHost = await startLocalWebHost({
        staticRoot: fixture.root,
        bridgeFactory: () => {
          throw new Error("UNUSED_PARALLEL_HOST");
        },
      });
      try {
        assert.notEqual(parallelHost.port, host.port);
      } finally {
        await parallelHost.close();
      }

      const first = await loadBootstrap(host.origin);
      assert.equal(first.response.status, 200);
      assert.match(
        first.response.headers.get("content-security-policy") ?? "",
        /connect-src 'self'/u,
      );
      assert.equal(first.response.headers.get("referrer-policy"), "no-referrer");

      const badOrigin = await api(
        host.origin,
        "/api/v6/handshake",
        first.token,
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
        { origin: "http://evil.example" },
      );
      assert.equal(badOrigin.status, 403);
      assert.equal(errorCode(await badOrigin.json()), "ORIGIN_REJECTED");

      const badHost = await apiWithHost(
        host.origin,
        "/api/v6/handshake",
        first.token,
        "127.0.0.1:1",
      );
      assert.equal(badHost.status, 403);
      assert.equal(errorCode(badHost.payload), "HOST_REJECTED");

      const badProtocol = await api(
        host.origin,
        "/api/v6/handshake",
        first.token,
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
        { "x-writing-agent-protocol": "1" },
      );
      assert.equal(badProtocol.status, 409);
      assert.equal(
        errorCode(await badProtocol.json()),
        "PROTOCOL_VERSION_MISMATCH",
      );

      const handshakeResponse = await api(
        host.origin,
        "/api/v6/handshake",
        first.token,
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
      );
      assert.equal(handshakeResponse.status, 200);
      const handshake = (await handshakeResponse.json()) as {
        capability: string;
        handshake: { mock: boolean; workspaceId: string };
      };
      assert.equal(handshake.handshake.mock, false);
      assert.equal(handshake.handshake.workspaceId, "workspace-secure");
      assert.ok(handshake.capability.length >= 32);

      const reused = await api(
        host.origin,
        "/api/v6/handshake",
        first.token,
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
      );
      assert.equal(reused.status, 401);
      assert.equal(errorCode(await reused.json()), "CAPABILITY_REJECTED");

      const snapshotResponse = await api(
        host.origin,
        "/api/v6/snapshot",
        handshake.capability,
        {},
      );
      assert.equal(snapshotResponse.status, 200);
      const snapshotPayload = (await snapshotResponse.json()) as {
        snapshot: { generation: number };
      };
      const createResponse = await api(
        host.origin,
        "/api/v6/command/create-project",
        handshake.capability,
        {
          generation: snapshotPayload.snapshot.generation,
          operationId: "create-project-via-host",
          name: "Host 新项目",
          mode: "quick",
          topic: "受控项目创建",
          genre: "explanatory_analysis",
          audience: "测试读者",
          targetCharacters: 1800,
          constraints: ["不得虚构数据"],
          interactionMode: "autonomous",
          authorVoice: null,
          styleReference: null,
          styleDecision: "unspecified",
          directionDecision: "tentative",
          platform: null,
          publicationGoal: "not_applicable",
          materials: [{
            name: "合成材料",
            content: "仅用于本地 Host 集成测试。",
            role: "illustrative",
            sourceKind: "pasted_text",
            sourceReference: null,
          }],
        },
      );
      assert.equal(createResponse.status, 200);
      const createPayload = (await createResponse.json()) as {
        result: { projectId: string };
      };
      assert.equal(
        storage.inspectProject(createPayload.result.projectId)?.name,
        "Host 新项目",
      );
      const staleStart = await api(
        host.origin,
        "/api/v6/command/start-run",
        handshake.capability,
        {
          generation: snapshotPayload.snapshot.generation - 1,
          operationId: "must-not-run",
          text: "不应执行",
        },
      );
      assert.equal(staleStart.status, 409);
      assert.equal(
        errorCode(await staleStart.json()),
        "STALE_CLIENT_GENERATION",
      );
      assert.deepEqual(storage.listRuns("project-1"), []);

      timestamp += 101;
      const expiredSession = await api(
        host.origin,
        "/api/v6/snapshot",
        handshake.capability,
        {},
      );
      assert.equal(expiredSession.status, 401);
      assert.equal(
        errorCode(await expiredSession.json()),
        "CAPABILITY_REJECTED",
      );

      const serializedLogs = JSON.stringify(logs);
      assert.equal(serializedLogs.includes(first.token), false);
      assert.equal(serializedLogs.includes(handshake.capability), false);
      assert.equal(serializedLogs.includes("SECRET_ENV_NAME"), false);
      assert.equal(serializedLogs.includes("PRIVATE-LOCAL-WEB-MATERIAL"), false);
      assert.equal(serializedLogs.includes("D:\\private"), false);
    } finally {
      await host.close();
      storage.close();
      fixture.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs the browser Remote against the real Application bridge and replays saved state", async () => {
    const fixture = staticFixture();
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-web-remote-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({
      storage,
      provider: new ImmediateWorkflowProvider("local-web-test"),
    });
    seed(service);
    const settingsState: {
      current: {
        theme: "light" | "dark" | "system";
        contentFontSize: number;
      } | null;
    } = { current: null };
    const uiSettingsPersistence = {
      load: () => settingsState.current,
      save: (value: { theme: "light" | "dark" | "system"; contentFontSize: number }) => {
        settingsState.current = { ...value };
      },
    };
    const host = await startLocalWebHost({
      staticRoot: fixture.root,
      bridgeFactory: () =>
        createApplicationBridge({
          service,
          workspaceId: "workspace-remote",
          model: {
            model: "test-model",
            providerLabel: "测试 Provider",
            credentialReference: null,
            parameters: { temperature: 0 },
          },
          pollIntervalMs: 5,
          uiSettingsPersistence,
        }),
      pollTimeoutMs: 10,
    });
    const bootstrap = await loadBootstrap(host.origin);
    const browserFetch: typeof fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set("origin", host.origin);
      return fetch(input, { ...init, headers });
    };
    const remote = createWebClientBridge({
      baseUrl: host.origin,
      bootstrapCapability: bootstrap.token,
      fetchImpl: browserFetch,
      pollDelayMs: 5,
      operationIdFactory: () => "remote-operation",
    });
    try {
      const handshake = await remote.handshake();
      assert.equal(handshake.workspaceId, "workspace-remote");
      assert.equal(remote.getSnapshot().brief?.topic, "本地 Web 安全桥接");
      await remote.updateSettings({ theme: "dark", contentFontSize: 16 });
      assert.equal(remote.getSnapshot().settings.theme, "dark");
      const { runId } = await remote.sendMessage("请开始写作", {
        operationId: "remote-start",
      });
      for (let attempts = 0; attempts < 100; attempts += 1) {
        if (storage.getRun(runId)?.status === "completed") break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(storage.getRun(runId)?.status, "completed");
      await remote.refresh();
      assert.match(remote.getSnapshot().previewDocument.body, /回归草稿/u);
      assert.equal(remote.getSnapshot().activeRunId, null);
      const workingCopy = await remote.saveWorkingCopy({
        operationId: "remote-working-copy",
      });
      assert.equal(workingCopy.mode, "working_copy");
      assert.equal(remote.getSnapshot().deliveryWorkspace.exports.length, 1);
      const revision = remote.getSnapshot().revisionWorkspace;
      const firstBlock = revision.blocks[0];
      const editableBlock = revision.blocks.at(-1);
      assert.notEqual(firstBlock, undefined);
      assert.notEqual(editableBlock, undefined);
      if (
        revision.bodyVersionId !== null &&
        firstBlock !== undefined &&
        editableBlock !== undefined
      ) {
        await remote.setBlockLock(
          revision.bodyVersionId,
          firstBlock.id,
          firstBlock.contentHash,
          "lock",
          { operationId: "remote-lock" },
        );
        assert.equal(remote.getSnapshot().revisionWorkspace.blocks[0]?.locked, true);
        const proposed = await remote.proposeRevision({
          baseBodyVersionId: revision.bodyVersionId,
          instruction: "Remote 局部修改",
          edits: [{
            type: "replace",
            targetBlockId: editableBlock.id,
            baseBlockHash: editableBlock.contentHash,
            content: "通过受保护的 Local Web Host 接受局部修改。",
          }],
        }, { operationId: "remote-propose" });
        assert.equal(
          remote.getSnapshot().revisionWorkspace.proposals.at(-1)?.id,
          proposed.proposalId,
        );
        const accepted = await remote.acceptRevision(proposed.proposalId, {
          operationId: "remote-accept",
        });
        assert.equal(accepted.status, "created");
        assert.match(
          remote.getSnapshot().previewDocument.body,
          /接受局部修改/u,
        );
      }

      remote.dispose();
      const secondBootstrap = await loadBootstrap(host.origin);
      const reconnected = createWebClientBridge({
        baseUrl: host.origin,
        bootstrapCapability: secondBootstrap.token,
        fetchImpl: browserFetch,
      });
      try {
        await reconnected.handshake();
        assert.match(
          reconnected.getSnapshot().previewDocument.body,
          /接受局部修改/u,
        );
        assert.equal(storage.listRuns("project-1").length, 1);
        assert.equal(reconnected.getSnapshot().deliveryWorkspace.exports.length, 1);
        assert.equal(reconnected.getSnapshot().settings.theme, "dark");
        assert.equal(reconnected.getSnapshot().settings.contentFontSize, 16);
        await reconnected.updateSettings({ theme: "system", contentFontSize: 14 });
        assert.equal(settingsState.current?.theme, "system");
      } finally {
        reconnected.dispose();
      }
    } finally {
      remote.dispose();
      await host.close();
      storage.close();
      fixture.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("expires capabilities without placing either token in logs", async () => {
    const fixture = staticFixture();
    let timestamp = Date.now();
    const logs: unknown[] = [];
    const host = await startLocalWebHost({
      staticRoot: fixture.root,
      bridgeFactory: () => {
        throw new Error("BRIDGE_MUST_NOT_START_FOR_EXPIRED_BOOTSTRAP");
      },
      bootstrapTtlMs: 50,
      now: () => timestamp,
      logger: (event) => logs.push(event),
    });
    try {
      const bootstrap = await loadBootstrap(host.origin);
      timestamp += 51;
      const expired = await api(
        host.origin,
        "/api/v6/handshake",
        bootstrap.token,
        { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION },
      );
      assert.equal(expired.status, 401);
      assert.equal(errorCode(await expired.json()), "CAPABILITY_REJECTED");
      assert.equal(JSON.stringify(logs).includes(bootstrap.token), false);
    } finally {
      await host.close();
      fixture.cleanup();
    }
  });
});
