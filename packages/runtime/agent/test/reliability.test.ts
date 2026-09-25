import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../../../storage/src/index.js";
import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../llm/src/index.js";
import { ToolRegistry, type ToolDefinition } from "../../tools/src/index.js";
import { AgentRuntime, type RunBudget } from "../src/index.js";

const actor = { kind: "runtime", id: "reliability-test" } as const;

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createWorkspace(prefix: string) {
  const workspacePath = mkdtempSync(join(tmpdir(), prefix));
  const storage = openWorkspaceStorage({ workspacePath });
  assert.equal(
    storage.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "WA-009 reliability",
      mode: "deep",
      actor,
    }).ok,
    true,
  );
  return { workspacePath, storage };
}

const tightBudget: RunBudget = {
  maxModelRequests: 1,
  maxToolCalls: 2,
  maxRetriesPerRequest: 0,
  maxMajorRevisions: 0,
};

class ToolThenDraftProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor() {
    super("budget-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request));
    if (this.requests.length === 1) {
      yield {
        type: "tool_call_delta",
        index: 0,
        id: "call-1",
        name: "read_material",
        argumentsDelta: "{}",
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "must not be called" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class LateProvider extends ModelProviderBase {
  readonly started = deferred();
  readonly release = deferred();
  observedStatusAtAbort: string | null = null;

  constructor(private readonly readStatus: () => string | null) {
    super("late-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    request.signal?.addEventListener(
      "abort",
      () => {
        this.observedStatusAtAbort = this.readStatus();
      },
      { once: true },
    );
    this.started.resolve();
    await this.release.promise;
    yield { type: "text_delta", delta: "late output" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class RetryOnceProvider extends ModelProviderBase {
  requestCount = 0;

  constructor() {
    super("retry-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    this.requestCount += 1;
    if (this.requestCount === 1) {
      yield {
        type: "error",
        error: {
          code: "RATE_LIMITED",
          message: "retry safely",
          retryable: true,
          retryAfterMs: 250,
        },
      };
      return;
    }
    yield {
      type: "usage",
      usage: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        cacheReadTokens: null,
        reasoningTokens: null,
      },
    };
    yield { type: "text_delta", delta: "done" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class TwoToolsProvider extends ModelProviderBase {
  requestCount = 0;

  constructor() {
    super("two-tools-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    this.requestCount += 1;
    yield {
      type: "tool_call_delta",
      index: 0,
      id: "call-1",
      name: "read_material",
      argumentsDelta: "{}",
    };
    yield {
      type: "tool_call_delta",
      index: 1,
      id: "call-2",
      name: "read_material",
      argumentsDelta: "{}",
    };
    yield { type: "completed", finishReason: "tool_calls" };
  }
}

class AlwaysRateLimitedProvider extends ModelProviderBase {
  requestCount = 0;

  constructor() {
    super("rate-limit-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    this.requestCount += 1;
    yield {
      type: "error",
      error: { code: "RATE_LIMITED", message: "still limited", retryable: true },
    };
  }
}

class UnknownOutcomeProvider extends ModelProviderBase {
  requestCount = 0;

  constructor() {
    super("network-reset-mock", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    this.requestCount += 1;
    yield {
      type: "error",
      error: { code: "NETWORK_ERROR", message: "socket reset", retryable: true },
    };
  }
}

describe("AgentRuntime reliability", () => {
  it('persists stream timing and timeout phase without persisting private partial output', async () => {
    const { workspacePath, storage } = createWorkspace('writing-activity-');
    const transport = { phase: 'stream_idle' as const, timeoutMs: 90, elapsedMs: 120, firstResponseMs: 10, lastActivityMs: 30 };
    class TimedProvider extends ModelProviderBase {
      constructor() { super('timed', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }) }
      protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
        yield { type: 'response_activity', phase: 'headers' };
        yield { type: 'text_delta', delta: 'PRIVATE_PARTIAL' };
        yield { type: 'error', error: { code: 'TIMEOUT', message: 'local timeout', retryable: true, transport } };
      }
    }
    const seen: any[] = [];
    const runtime = new AgentRuntime({ provider: new TimedProvider(), tools: ToolRegistry.create([]), sessions: storage, onModelStream: input => seen.push(input) });
    try {
      const result = await runtime.run({ projectId: 'project-1', purpose: 'draft', model: 'mock', systemPrompt: 'test', userMessage: 'go', parameters: {}, grantedPermissions: [], expectedBodyVersionId: null, budget: tightBudget });
      assert.equal(result.ok, false);
      const event = storage.listRunEvents(result.runId).find(e => e.type === 'request.outcome_unknown')!;
      assert.deepEqual(event.payload.transport, transport);
      assert.equal((event.payload.stream as any)?.contentEvents, 1);
      assert.equal(typeof (event.payload.stream as any)?.headersMs, 'number');
      assert.equal(typeof (event.payload.stream as any)?.firstContentMs, 'number');
      assert.doesNotMatch(JSON.stringify(event.payload), /PRIVATE_PARTIAL/);
      assert.equal(seen[0].lifecycle, 'started');
      assert.equal(seen.at(-1).event, null);
    } finally { storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
  });
  it("stops before an over-budget model call and preserves existing artifacts", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-budget-");
    const project = storage.inspectProject("project-1")!;
    const existing = storage.commitArtifactVersion({
      operationId: "existing-body",
      projectId: "project-1",
      expectedProjectRevision: project.revision,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: "already committed",
      reason: "fixture",
      actor,
    });
    assert.equal(existing.ok, true);

    let toolCalls = 0;
    const readMaterial: ToolDefinition<Record<string, never>, string> = {
      name: "read_material",
      version: "1.0.0",
      description: "read",
      inputSchema: { type: "object", additionalProperties: false },
      effect: "read_only",
      permissions: ["materials:read"],
      execute: () => {
        toolCalls += 1;
        return "material";
      },
    };
    const provider = new ToolThenDraftProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([readMaterial]),
      sessions: storage,
    });

    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "read then write",
        userMessage: "go",
        parameters: {},
        grantedPermissions: ["materials:read"],
        expectedBodyVersionId: existing.ok ? existing.result.versionId : null,
        budget: tightBudget,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "BUDGET_EXHAUSTED");
      assert.equal(provider.requests.length, 1);
      assert.equal(toolCalls, 1);
      assert.equal(storage.getRun(result.runId)?.status, "budget_exhausted");
      assert.deepEqual(storage.getRun(result.runId)?.usage, {
        modelRequests: 1,
        toolCalls: 1,
        retries: 0,
        majorRevisions: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        reasoningTokens: null,
        cost: null,
        costKnown: false,
        usageReports: 0,
        missingUsageReports: 1,
      });
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").at(-1)?.content,
        "already committed",
      );
      assert.equal(
        storage
          .listRunEvents(result.runId)
          .some((event) => event.type === "run.budget_exhausted"),
        true,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists cancellation before abort and discards late output", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-cancel-");
    let runId = "";
    let commits = 0;
    const provider = new LateProvider(() => storage.getRun(runId)?.status ?? null);
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
      finalOutputCommitter: {
        commit: async () => {
          commits += 1;
          return { artifactVersionId: "must-not-exist" };
        },
      },
    });

    try {
      const handle = runtime.start({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "wait",
        userMessage: "go",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
      });
      runId = handle.runId;
      await provider.started.promise;
      const cancelled = handle.cancel("user_stop");
      assert.equal(cancelled.status, "cancelled");
      assert.equal(storage.getRun(runId)?.status, "cancelled");
      assert.equal(provider.observedStatusAtAbort, "cancelled");
      provider.release.resolve();

      const result = await handle.result;
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "CANCELLED");
      assert.equal(commits, 0);
      assert.equal(storage.listArtifactVersions("project-1", "body", "main").length, 0);
      assert.equal(
        storage
          .listRunEvents(runId)
          .some((event) => event.type === "request.completed"),
        false,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("counts a safe retry in the same run budget and aggregates known usage honestly", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-retry-");
    const provider = new RetryOnceProvider();
    const waited: number[] = [];
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
      waitBeforeRetry: async (milliseconds) => {
        waited.push(milliseconds);
      },
    });

    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "retry",
        userMessage: "go",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
        budget: {
          maxModelRequests: 3,
          maxToolCalls: 0,
          maxRetriesPerRequest: 1,
          maxMajorRevisions: 0,
        },
      });
      assert.equal(result.ok, true);
      assert.equal(provider.requestCount, 2);
      assert.deepEqual(waited, [250]);
      assert.deepEqual(storage.getRun(result.runId)?.usage, {
        modelRequests: 2,
        toolCalls: 0,
        retries: 1,
        majorRevisions: 0,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        cacheReadTokens: null,
        reasoningTokens: null,
        cost: null,
        costKnown: false,
        usageReports: 1,
        missingUsageReports: 1,
      });
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("stops before the second tool when the shared tool budget is exhausted", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-tool-budget-");
    let executions = 0;
    const tool: ToolDefinition<Record<string, never>, string> = {
      name: "read_material",
      version: "1.0.0",
      description: "read",
      inputSchema: { type: "object", additionalProperties: false },
      effect: "read_only",
      permissions: ["materials:read"],
      execute: () => {
        executions += 1;
        return "ok";
      },
    };
    const provider = new TwoToolsProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([tool]),
      sessions: storage,
    });
    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "tools",
        userMessage: "go",
        parameters: {},
        grantedPermissions: ["materials:read"],
        expectedBodyVersionId: null,
        budget: {
          maxModelRequests: 2,
          maxToolCalls: 1,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 0,
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "BUDGET_EXHAUSTED");
      assert.equal(provider.requestCount, 1);
      assert.equal(executions, 1);
      assert.equal(storage.getRun(result.runId)?.usage.toolCalls, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("does not let safe retries exceed their own run budget", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-retry-budget-");
    const provider = new AlwaysRateLimitedProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
    });
    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "retry",
        userMessage: "go",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
        budget: {
          maxModelRequests: 10,
          maxToolCalls: 0,
          maxRetriesPerRequest: 1,
          maxMajorRevisions: 0,
        },
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "BUDGET_EXHAUSTED");
      assert.equal(provider.requestCount, 2);
      assert.equal(storage.getRun(result.runId)?.usage.modelRequests, 2);
      assert.equal(storage.getRun(result.runId)?.usage.retries, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("marks an ambiguous network failure unknown and never automatically retries it", async () => {
    const { workspacePath, storage } = createWorkspace("writing-agent-network-unknown-");
    const provider = new UnknownOutcomeProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
    });
    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock",
        systemPrompt: "network",
        userMessage: "go",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, "UNKNOWN_EXTERNAL_OUTCOME");
      assert.equal(provider.requestCount, 1);
      assert.equal(storage.getRun(result.runId)?.status, "waiting_user");
      assert.equal(
        storage.listRuntimeOperations(result.runId)[0]?.state,
        "unknown_outcome",
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
