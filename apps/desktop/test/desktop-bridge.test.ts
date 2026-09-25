import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DESKTOP_RPC_METHODS,
  DesktopClientBridge,
  type DesktopRendererApi,
  type DesktopRpcRequest,
  type DesktopRpcResponse,
} from "../../../packages/client-bridge/src/desktop-bridge.js";
import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeSnapshot,
  type ClientBridge,
} from "../../../packages/client-bridge/src/protocol.js";

function snapshot(revision = 1, generation = 1): BridgeSnapshot {
  return {
    revision,
    generation,
    workspaceId: "desktop-workspace",
    mode: "application",
    connection: "ready",
    selectedProjectId: "",
    selectedSessionId: "",
    projects: [],
    sessions: [],
    timelineBySession: {},
    runRecords: [],
    materialProcessWorkspace: { materials: [], evidence: null, outline: null, reviews: [], notice: "" },
    previewDocument: { id: null, title: "", version: 0, status: "empty", body: "" },
    revisionWorkspace: { bodyVersionId: null, projectRevision: 0, blocks: [], versions: [], proposals: [] },
    factCheckWorkspace: { status: "not_checked", snapshot: null, assessment: null, invalidations: [], provenance: [], notice: "" },
    deliveryWorkspace: { bodyVersionId: null, projectRevision: 0, gateStatus: "not_checked", formalExportEnabled: false, exports: [], notice: "" },
    settings: { theme: "system", language: "zh-CN", contentFontSize: 14, providerLabel: "未配置模型", credentialReference: null },
    activeRunId: null,
    brief: null,
    recoverableRuns: [],
    lastError: null,
    environmentNotice: "桌面本地运行时",
    composerHint: "请先新建项目",
  };
}

class FakeDesktopApi implements DesktopRendererApi {
  readonly requests: DesktopRpcRequest[] = [];
  #listener: ((value: BridgeSnapshot) => void) | null = null;

  async invoke(request: DesktopRpcRequest): Promise<DesktopRpcResponse> {
    this.requests.push(request);
    if (request.method === "handshake") {
      return {
        ok: true,
        result: {
          protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
          clientBuild: "desktop-test",
          runtimeBuild: "runtime-test",
          capabilities: ["desktop.ipc.allowlist"],
          mock: false,
          persistsUserProjects: true,
          workspaceId: "desktop-workspace",
        },
        snapshot: snapshot(),
      };
    }
    return {
      ok: true,
      result: ["sendMessage", "startConversation", "confirmConversation"].includes(request.method) ? { runId: "run-1" } : null,
      snapshot: snapshot(this.requests.length),
    };
  }

  subscribe(listener: (value: BridgeSnapshot) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = null;
    };
  }

  emit(value: BridgeSnapshot): void {
    this.#listener?.(value);
  }
}

describe("Desktop renderer bridge", () => {
  for (const feedback of ['这不是标题，请重新拟三个，正文不要改', '提纲第二部分换个角度', '补充事实：授权材料中只有两项结论']) {
    it(`preserves checkpoint feedback through the desktop transport: ${feedback}`, async () => {
      const api = new FakeDesktopApi();
      const bridge: ClientBridge = new DesktopClientBridge(api, () => 'checkpoint-operation');
      await bridge.handshake();
      await bridge.resumeRun('waiting-run', 'resume', { feedback });
      assert.deepEqual(api.requests.at(-1)?.args, ['waiting-run', 'resume', { operationId: 'checkpoint-operation', feedback }]);
      bridge.dispose();
    });
  }
  it("allows every user-facing writing command through the Electron ingress", () => {
    for (const method of [
      "selectProject",
      "updateBrief",
      "confirmBrief",
      "startConversation",
      "confirmConversation",
      "runFactCheck",
      "previewDiagnostics",
      "exportDiagnostics",
      "selectLegacyMigrationSource",
      "applyLegacyMigration",
      "backupWorkspace",
      "selectWorkspaceRestoreBackup",
      "applyWorkspaceRestore",
      "deleteProject",
    ] as const) {
      assert.equal(DESKTOP_RPC_METHODS.includes(method), true, method);
    }
  });

  it("uses versioned allowlisted RPC without exposing an arbitrary channel", async () => {
    const api = new FakeDesktopApi();
    const bridge = new DesktopClientBridge(api, () => "operation-1");
    const handshake = await bridge.handshake();
    assert.equal(handshake.protocolVersion, UI_BRIDGE_PROTOCOL_VERSION);
    assert.equal(bridge.getSnapshot().workspaceId, "desktop-workspace");

    const result = await bridge.sendMessage("开始写作");
    assert.equal(result.runId, "run-1");
    assert.deepEqual(api.requests.map((request) => request.method), [
      "handshake",
      "sendMessage",
    ]);
    assert.deepEqual(api.requests[1]?.args, ["开始写作", { operationId: "operation-1" }]);
    bridge.dispose();
  });

  it("selects a project without requiring an existing session", async () => {
    const api = new FakeDesktopApi();
    const bridge = new DesktopClientBridge(api);
    await bridge.handshake();

    await bridge.selectProject("project-empty");

    assert.deepEqual(api.requests.at(-1), {
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "selectProject",
      args: ["project-empty"],
    });
    bridge.dispose();
  });

  it("preserves the selected HTML layout across the Electron ingress", async () => {
    const api = new FakeDesktopApi();
    const bridge = new DesktopClientBridge(api, () => "operation-layout");
    await bridge.handshake();

    await bridge.exportPublication("html", { layoutPreset: "editorial" });

    assert.deepEqual(api.requests.at(-1), {
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      method: "exportPublication",
      args: ["html", { operationId: "operation-layout", layoutPreset: "editorial" }],
    });
    bridge.dispose();
  });

  it("ignores stale events and rejects another workspace", async () => {
    const api = new FakeDesktopApi();
    const bridge = new DesktopClientBridge(api);
    await bridge.handshake();
    const unsubscribe = bridge.subscribe(() => undefined);
    api.emit(snapshot(4, 2));
    api.emit(snapshot(3, 2));
    assert.equal(bridge.getSnapshot().revision, 4);
    assert.throws(
      () => api.emit({ ...snapshot(5, 2), workspaceId: "other-workspace" }),
      /WORKSPACE_SCOPE_MISMATCH/u,
    );
    unsubscribe();
    bridge.dispose();
  });
});
