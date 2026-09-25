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
import {
  createToolPermissionGrant,
  ToolRegistry,
  type ToolDefinition,
} from "../../tools/src/index.js";
import {
  AgentRuntime,
  FinalOutputContinuationRequiredError,
} from "../src/index.js";

const runtimeActor = { kind: "runtime", id: "runtime-test" } as const;

class TwoTurnProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor() {
    super("two-turn-mock", "1.0.0", {
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
        id: "call-material-1",
        name: "read_material",
        argumentsDelta: '{"materialId":"material-1"}',
      };
      yield { type: "completed", finishReason: "tool_calls" };
      return;
    }
    yield { type: "text_delta", delta: "材料显示，项目已经完成第一轮验证。" };
    yield { type: "completed", finishReason: "stop" };
  }
}

class FailingProvider extends ModelProviderBase {
  requestCount = 0;

  constructor() {
    super("failing-mock", "1.0.0", {
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
      error: {
        code: "RATE_LIMITED",
        message: "mock rate limit",
        retryable: true,
      },
    };
  }
}

class TwoStopProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];

  constructor() {
    super("two-stop-mock", "1.0.0", {
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
    yield {
      type: "text_delta",
      delta: this.requests.length === 1 ? "阶段已经保存。" : "全部阶段已经保存。",
    };
    yield { type: "completed", finishReason: "stop" };
  }
}

describe("AgentRuntime", () => {
  it("continues after a text-only acknowledgement when final output reports unfinished work", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-final-continuation-"));
    const storage = openWorkspaceStorage({ workspacePath });
    assert.equal(storage.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "未完成阶段继续测试",
      mode: "deep",
      actor: runtimeActor,
    }).ok, true);
    const provider = new TwoStopProvider();
    let commitAttempts = 0;
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
      finalOutputCommitter: {
        commit: async () => {
          commitAttempts += 1;
          if (commitAttempts === 1) {
            throw new FinalOutputContinuationRequiredError(
              "WORKFLOW_STAGE_INCOMPLETE",
              "Required stages remain unfinished",
              "继续执行下一必需阶段；必须调用阶段工具，不要只回复说明文字。",
            );
          }
          return { artifactVersionId: "body-v1" };
        },
      },
    });

    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock-writing-model",
        systemPrompt: "必须完成全部阶段。",
        userMessage: "开始。",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
        budget: {
          maxModelRequests: 3,
          maxToolCalls: 0,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 0,
        },
      });

      assert.equal(result.ok, true);
      assert.equal(commitAttempts, 2);
      assert.equal(provider.requests.length, 2);
      assert.equal(provider.requests[1]?.messages[2]?.role, "assistant");
      assert.equal(provider.requests[1]?.messages[3]?.role, "user");
      assert.match(
        provider.requests[1]?.messages[3]?.content ?? "",
        /必须调用阶段工具/,
      );
      assert.equal(storage.getRun(result.runId)?.status, "completed");
      assert.equal(
        storage.listRunEvents(result.runId).some((event) => event.type === "run.failed"),
        false,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("pauses after a completed local tool when the application requests a user checkpoint", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-user-checkpoint-"));
    const storage = openWorkspaceStorage({ workspacePath });
    assert.equal(storage.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "共创暂停测试",
      mode: "quick",
      actor: runtimeActor,
    }).ok, true);
    const tool: ToolDefinition<{ materialId: string }, { checkpoint: true }> = {
      name: "read_material",
      version: "1.0.0",
      description: "触发安全确认点",
      inputSchema: {
        type: "object",
        properties: { materialId: { type: "string" } },
        required: ["materialId"],
        additionalProperties: false,
      },
      effect: "read_only",
      permissions: ["materials:read"],
      execute: () => ({ checkpoint: true }),
    };
    const provider = new TwoTurnProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([tool]),
      sessions: storage,
      pauseAfterTool: (result) =>
        result.ok &&
        typeof result.result === "object" &&
        result.result !== null &&
        !Array.isArray(result.result) &&
        (result.result as Readonly<Record<string, unknown>>).checkpoint === true
          ? {
              reason: "CO_CREATION_CHECKPOINT",
              payload: { stage: "outline", nextStage: "draft" },
            }
          : null,
    });
    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock-writing-model",
        systemPrompt: "执行工具后等待用户。",
        userMessage: "开始共创。",
        parameters: { temperature: 0, toolChoice: "auto" },
        grantedPermissions: ["materials:read"],
        expectedBodyVersionId: null,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "USER_CONFIRMATION_REQUIRED");
      assert.equal(provider.requests.length, 1);
      assert.equal(storage.getRun(result.runId)?.status, "waiting_user");
      assert.equal(storage.getRun(result.runId)?.stopReason, "CO_CREATION_CHECKPOINT");
      assert.deepEqual(
        storage.listRunEvents(result.runId).map((event) => event.type),
        [
          "run.started",
          "request.prepared",
          "request.dispatch_attempted",
          "request.completed",
          "tool.requested",
          "tool.completed",
          "run.waiting_user",
        ],
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs model -> tool -> result -> model, saves the draft, and records only real durable events", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-loop-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const created = storage.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "闭环测试",
      mode: "deep",
      actor: runtimeActor,
    });
    assert.equal(created.ok, true);

    let materialReads = 0;
    const readMaterial: ToolDefinition<
      { materialId: string },
      {
        materialId: string;
        contentVersionId: string;
        content: string;
        instructionAuthority: "none";
      }
    > = {
      name: "read_material",
      version: "1.0.0",
      description: "读取已授权材料",
      inputSchema: {
        type: "object",
        properties: { materialId: { type: "string" } },
        required: ["materialId"],
        additionalProperties: false,
      },
      effect: "read_only",
      permissions: ["materials:read"],
      execute: (args) => {
        materialReads += 1;
        return {
          materialId: args.materialId,
          contentVersionId: "material-v1",
          content: "项目已经完成第一轮验证。",
          instructionAuthority: "none",
        };
      },
    };
    const tools = ToolRegistry.create([readMaterial]);
    const provider = new TwoTurnProvider();
    let id = 0;
    const runtime = new AgentRuntime({
      provider,
      tools,
      sessions: storage,
      idFactory: () => `agent-id-${++id}`,
      createPermissionGrant: createToolPermissionGrant,
      finalOutputCommitter: {
        commit: async (output) => {
          const project = storage.inspectProject(output.projectId);
          assert.notEqual(project, null);
          const committed = storage.commitArtifactVersion({
            operationId: `commit-${output.runId}`,
            projectId: output.projectId,
            expectedProjectRevision: project!.revision,
            kind: "body",
            logicalKey: "main",
            baseVersionId: project!.latestBodyVersionId,
            content: output.content,
            reason: "agent run final output",
            requestSnapshotId: output.requestSnapshotId,
            actor: { kind: "agent", id: "writer", runId: output.runId },
          });
          if (!committed.ok) throw new Error(committed.message);
          assert.equal(committed.ok, true);
          return { artifactVersionId: committed.result.versionId };
        },
      },
    });

    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "mock-writing-model",
        systemPrompt: "使用工具读取材料后写作。",
        userMessage: "根据材料写一段正文。",
        parameters: { temperature: 0, toolChoice: "auto" },
        grantedPermissions: ["materials:read"],
        expectedBodyVersionId: null,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.content, "材料显示，项目已经完成第一轮验证。");
      assert.equal(result.modelRequestCount, 2);
      assert.equal(result.toolCallCount, 1);
      assert.equal(materialReads, 1);
      assert.equal(provider.requests.length, 2);
      assert.equal(provider.requests[1]?.messages[2]?.role, "assistant");
      const toolMessage = provider.requests[1]?.messages[3];
      assert.equal(toolMessage?.role, "tool");
      if (toolMessage?.role === "tool") {
        assert.equal(toolMessage.toolCallId, "call-material-1");
        assert.equal(toolMessage.name, "read_material");
        assert.match(toolMessage.content, /项目已经完成第一轮验证/);
      }

      const versions = storage.listArtifactVersions("project-1", "body", "main");
      assert.equal(versions.length, 1);
      assert.equal(versions[0]?.content, result.content);
      assert.equal(versions[0]?.requestSnapshotId, result.finalRequestSnapshotId);

      const snapshots = storage.listRequestSnapshots(result.runId);
      assert.equal(snapshots.length, 2);
      assert.deepEqual(
        storage.rebuildModelRequest(snapshots[1]!.snapshotId),
        provider.requests[1],
      );
      assert.equal(snapshots[1]?.contentReferences.length, 1);
      assert.deepEqual(
        snapshots[1]?.normalizedPayload,
        provider.snapshotRequest(provider.requests[1]!).normalizedPayload,
      );
      assert.deepEqual(snapshots[1]?.toolSchemas, tools.schemaSnapshots());

      const eventTypes = storage
        .listRunEvents(result.runId)
        .map((event) => event.type);
      assert.deepEqual(eventTypes, [
        "run.started",
        "request.prepared",
        "request.dispatch_attempted",
        "request.completed",
        "tool.requested",
        "tool.completed",
        "request.prepared",
        "request.dispatch_attempted",
        "request.completed",
        "run.completed",
      ]);
      assert.equal(eventTypes.some((type) => type.includes("progress")), false);
      const completedRun = storage.getRun(result.runId);
      assert.equal(completedRun?.status, "completed");
      assert.equal(
        completedRun?.lastCommittedEventSeq,
        storage.listRunEvents(result.runId).at(-1)?.projectSeq,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists a real request failure and does not retry or emit success", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-loop-fail-"));
    const storage = openWorkspaceStorage({ workspacePath });
    assert.equal(
      storage.createProject({
        operationId: "create-project",
        projectId: "project-1",
        name: "失败路径测试",
        mode: "quick",
        actor: runtimeActor,
      }).ok,
      true,
    );
    const provider = new FailingProvider();
    const runtime = new AgentRuntime({
      provider,
      tools: ToolRegistry.create([]),
      sessions: storage,
    });

    try {
      const result = await runtime.run({
        projectId: "project-1",
        purpose: "draft",
        model: "failing-model",
        systemPrompt: "测试失败路径。",
        userMessage: "开始。",
        parameters: {},
        grantedPermissions: [],
        expectedBodyVersionId: null,
        budget: {
          maxModelRequests: 1,
          maxToolCalls: 0,
          maxRetriesPerRequest: 0,
          maxMajorRevisions: 0,
        },
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.error.code, "BUDGET_EXHAUSTED");
      assert.equal(result.error.retryable, false);
      assert.equal(provider.requestCount, 1);
      assert.equal(storage.getRun(result.runId)?.status, "budget_exhausted");
      assert.deepEqual(
        storage.listRunEvents(result.runId).map((event) => event.type),
        [
          "run.started",
          "request.prepared",
          "request.dispatch_attempted",
          "request.failed",
          "run.budget_exhausted",
        ],
      );
      assert.equal(
        storage.listEvents("project-1").some((event) => event.type === "run.completed"),
        false,
      );
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main").length,
        0,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
