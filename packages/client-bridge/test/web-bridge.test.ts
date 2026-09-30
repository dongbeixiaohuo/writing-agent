import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeSnapshot,
} from "../src/protocol.js";
import {
  WebBridgeError,
  createWebClientBridge,
} from "../src/web-bridge.js";

const CAPABILITY = "c".repeat(43);
const BOOTSTRAP = "b".repeat(43);

function snapshot(
  overrides: Partial<BridgeSnapshot> = {},
): BridgeSnapshot {
  return {
    revision: 1,
    generation: 1,
    workspaceId: "workspace-wa025",
    mode: "application",
    connection: "ready",
    selectedProjectId: "project-1",
    selectedSessionId: "session-1",
    projects: [
      {
        id: "project-1",
        name: "项目一",
        sessionIds: ["session-1"],
        revision: 1,
        latestProjectSeq: 1,
      },
    ],
    sessions: [
      {
        id: "session-1",
        projectId: "project-1",
        title: "会话一",
        relativeTime: "刚刚",
        status: "idle",
      },
    ],
    timelineBySession: { "session-1": [] },
    runRecords: [],
    materialProcessWorkspace: {
      materials: [],
      evidence: null,
      outline: null,
      reviews: [],
      notice: "",
    },
    previewDocument: {
      id: null,
      title: "尚未生成稿件",
      version: 0,
      status: "empty",
      body: "",
    },
    revisionWorkspace: {
      bodyVersionId: null,
      projectRevision: 1,
      blocks: [],
      versions: [],
      proposals: [],
    },
    factCheckWorkspace: {
      status: "not_checked",
      snapshot: null,
      assessment: null,
      invalidations: [],
      provenance: [],
      notice: "未知保持 unknown。",
    },
    deliveryWorkspace: {
      bodyVersionId: null,
      projectRevision: 1,
      gateStatus: "not_checked",
      formalExportEnabled: false,
      exports: [],
      notice: "工作备份不代表正式交付。",
    },
    settings: {
      theme: "light",
      language: "zh-CN",
      contentFontSize: 14,
      providerLabel: "测试 Provider",
      credentialReference: null,
    },
    activeRunId: null,
    brief: null,
    recoverableRuns: [],
    lastError: null,
    environmentNotice: "本地应用服务",
    composerHint: "输入写作指令",
    ...overrides,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function handshakeEnvelope(protocolVersion = UI_BRIDGE_PROTOCOL_VERSION) {
  return {
    handshake: {
      protocolVersion,
      clientBuild: "wa025-client",
      runtimeBuild: "wa025-runtime",
      capabilities: [],
      mock: false,
      persistsUserProjects: true,
      workspaceId: "workspace-wa025",
    },
    capability: CAPABILITY,
  };
}

async function waitUntil(
  check: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const expiresAt = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= expiresAt) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Web client bridge ordering", () => {
  it("selects a project without requiring an existing session", async () => {
    const initial = snapshot();
    const selected = snapshot({
      revision: 2,
      generation: 2,
      selectedProjectId: "project-empty",
      selectedSessionId: "",
      projects: [
        ...initial.projects,
        {
          id: "project-empty",
          name: "test",
          sessionIds: [],
          revision: 1,
          latestProjectSeq: 1,
        },
      ],
    });
    let commandBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: initial });
      if (route === "/api/v6/command/select-project") {
        commandBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ snapshot: selected });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
    });
    try {
      await bridge.handshake();
      await bridge.selectProject("project-empty");
      assert.equal(commandBody?.projectId, "project-empty");
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-empty");
      assert.equal(bridge.getSnapshot().selectedSessionId, "");
    } finally {
      bridge.dispose();
    }
  });

  it("binds the native fetch receiver to globalThis", async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = async function (
      this: unknown,
      input: string | URL | Request,
    ): Promise<Response> {
      assert.equal(this, globalThis);
      const route = new URL(String(input)).pathname;
      calls.push(route);
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: snapshot() });
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    } as typeof fetch;

    try {
      const bridge = createWebClientBridge({
        baseUrl: "http://127.0.0.1:4174",
        bootstrapCapability: BOOTSTRAP,
      });
      await bridge.handshake();
      assert.deepEqual(calls, ["/api/v6/handshake", "/api/v6/snapshot"]);
      bridge.dispose();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores a late snapshot from an older project generation", async () => {
    const initial = snapshot();
    const switched = snapshot({
      revision: 2,
      generation: 2,
      selectedProjectId: "project-2",
      selectedSessionId: "session-2",
      projects: [
        {
          id: "project-2",
          name: "项目二",
          sessionIds: ["session-2"],
          revision: 1,
          latestProjectSeq: 1,
        },
      ],
      sessions: [
        {
          id: "session-2",
          projectId: "project-2",
          title: "会话二",
          relativeTime: "刚刚",
          status: "idle",
        },
      ],
      timelineBySession: { "session-2": [] },
    });
    let snapshotRequests = 0;
    let releaseLateSnapshot: (() => void) | undefined;
    let markLateSnapshotStarted: (() => void) | undefined;
    const lateSnapshotStarted = new Promise<void>((resolve) => {
      markLateSnapshotStarted = resolve;
    });
    const lateSnapshotRelease = new Promise<void>((resolve) => {
      releaseLateSnapshot = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return json({ snapshot: initial });
        markLateSnapshotStarted?.();
        await lateSnapshotRelease;
        return json({ snapshot: initial });
      }
      if (route === "/api/v6/command/select-session") {
        return json({ snapshot: switched });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
    });
    try {
      await bridge.handshake();
      const lateRefresh = bridge.refresh();
      await lateSnapshotStarted;
      await bridge.selectSession("project-2", "session-2");
      assert.equal(bridge.getSnapshot().generation, 2);
      releaseLateSnapshot?.();
      await lateRefresh;
      assert.equal(bridge.getSnapshot().generation, 2);
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-2");
    } finally {
      bridge.dispose();
    }
  });

  it("ignores a lower revision returned after a newer command in the same generation", async () => {
    const initial = snapshot();
    const stale = snapshot({ revision: 2 });
    const newest = snapshot({
      revision: 3,
      settings: { ...initial.settings, theme: "dark" },
    });
    let snapshotRequests = 0;
    let releaseLateSnapshot: (() => void) | undefined;
    let markLateSnapshotStarted: (() => void) | undefined;
    const lateSnapshotStarted = new Promise<void>((resolve) => {
      markLateSnapshotStarted = resolve;
    });
    const lateSnapshotRelease = new Promise<void>((resolve) => {
      releaseLateSnapshot = resolve;
    });
    const fetchImpl = (async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") {
        snapshotRequests += 1;
        if (snapshotRequests === 1) return json({ snapshot: initial });
        markLateSnapshotStarted?.();
        await lateSnapshotRelease;
        return json({ snapshot: stale });
      }
      if (route === "/api/v6/command/update-settings") {
        return json({ snapshot: newest });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
    });
    try {
      await bridge.handshake();
      const lateRefresh = bridge.refresh();
      await lateSnapshotStarted;
      await bridge.updateSettings({ theme: "dark" });
      assert.equal(bridge.getSnapshot().revision, 3);
      releaseLateSnapshot?.();
      await lateRefresh;
      assert.equal(bridge.getSnapshot().revision, 3);
      assert.equal(bridge.getSnapshot().settings.theme, "dark");
    } finally {
      bridge.dispose();
    }
  });

  it("fails closed on an incompatible handshake protocol", async () => {
    const fetchImpl = (async () =>
      json(handshakeEnvelope(UI_BRIDGE_PROTOCOL_VERSION - 1))) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
    });
    try {
      await assert.rejects(
        bridge.handshake(),
        (error: unknown) =>
          error instanceof WebBridgeError &&
          error.code === "PROTOCOL_VERSION_MISMATCH",
      );
    } finally {
      bridge.dispose();
    }
  });

  it("creates a persisted project through the versioned web command", async () => {
    const initial = snapshot({
      selectedProjectId: "",
      selectedSessionId: "",
      projects: [],
      sessions: [],
      timelineBySession: {},
    });
    const created = snapshot({
      revision: 2,
      generation: 2,
      selectedProjectId: "project-new",
      selectedSessionId: "session-project-new",
    });
    let commandBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: initial });
      if (route === "/api/v6/command/create-project") {
        commandBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ result: { projectId: "project-new" }, snapshot: created });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
      operationIdFactory: () => "create-operation",
    });
    try {
      const result = await bridge.createProject({
        name: "新项目",
        mode: "quick",
        topic: "主题",
        genre: "explanatory_analysis",
        audience: "读者",
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
          name: "材料",
          content: "合成材料内容",
          role: "illustrative",
          sourceKind: "pasted_text",
          sourceReference: null,
        }],
      });
      assert.deepEqual(result, { projectId: "project-new" });
      assert.equal(commandBody?.operationId, "create-operation");
      assert.equal(commandBody?.generation, 1);
      assert.equal(bridge.getSnapshot().selectedProjectId, "project-new");
    } finally {
      bridge.dispose();
    }
  });

  it("passes the selected publication layout to the local runtime", async () => {
    let commandBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: snapshot() });
      if (route === "/api/v6/command/export-publication") {
        commandBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({
          result: {
            id: "export-1",
            operationId: "export-operation",
            mode: "publication",
            format: "html",
            state: "completed",
            gateStatus: "passed",
            relativePath: "exports/project/publication/article-editorial.html",
            manifestRelativePath: null,
            contentHash: "hash",
            createdAt: "2026-09-19T00:00:00.000Z",
            completedAt: "2026-09-19T00:00:01.000Z",
          },
          snapshot: snapshot({ revision: 2 }),
        });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
      operationIdFactory: () => "export-operation",
    });
    try {
      await bridge.handshake();
      await bridge.exportPublication("html", { layoutPreset: "editorial" });
      assert.equal(commandBody?.format, "html");
      assert.equal(commandBody?.layoutPreset, "editorial");
      assert.equal(commandBody?.operationId, "export-operation");
    } finally {
      bridge.dispose();
    }
  });

  it("passes co-creation feedback when resuming a waiting run", async () => {
    let commandBody: Record<string, unknown> | null = null;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: snapshot() });
      if (route === "/api/v6/command/resume-run") {
        commandBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ snapshot: snapshot({ revision: 2 }) });
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
      operationIdFactory: () => "resume-operation",
    });
    try {
      await bridge.handshake();
      await bridge.resumeRun("run-1", "resume", {
        feedback: "保留前两部分，把第三部分改成案例拆解。",
      });
      assert.equal(commandBody?.runId, "run-1");
      assert.equal(commandBody?.decision, "resume");
      assert.equal(commandBody?.feedback, "保留前两部分，把第三部分改成案例拆解。");
    } finally {
      bridge.dispose();
    }
  });

  it("recovers a transient poll disconnect without starting or resuming work", async () => {
    const initial = snapshot({ revision: 4 });
    const recovered = snapshot({ revision: 5, connection: "ready" });
    let pollRequests = 0;
    let startOrResumeRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const route = new URL(String(input)).pathname;
      if (route === "/api/v6/handshake") return json(handshakeEnvelope());
      if (route === "/api/v6/snapshot") return json({ snapshot: initial });
      if (route === "/api/v6/events/poll") {
        pollRequests += 1;
        if (pollRequests === 1) throw new TypeError("connection interrupted");
        return json({ changed: true, snapshot: recovered });
      }
      if (
        route === "/api/v6/command/start-run" ||
        route === "/api/v6/command/resume-run"
      ) {
        startOrResumeRequests += 1;
      }
      throw new Error(`UNEXPECTED_ROUTE:${route}`);
    }) as typeof fetch;
    const bridge = createWebClientBridge({
      baseUrl: "http://127.0.0.1:4174",
      bootstrapCapability: BOOTSTRAP,
      fetchImpl,
      pollDelayMs: 1,
    });
    let offlineRevision: number | null = null;
    try {
      await bridge.handshake();
      const unsubscribe = bridge.subscribe(() => {
        if (bridge.getSnapshot().connection === "offline") {
          offlineRevision = bridge.getSnapshot().revision;
        }
      });
      try {
        await waitUntil(() => offlineRevision !== null);
        assert.equal(offlineRevision, 4);
        await waitUntil(
          () =>
            bridge.getSnapshot().connection === "ready" &&
            bridge.getSnapshot().revision === 5,
        );
        assert.equal(startOrResumeRequests, 0);
        assert.ok(pollRequests >= 2);
      } finally {
        unsubscribe();
      }
    } finally {
      bridge.dispose();
    }
  });
});
