import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../../../storage/src/index.js";
import { contentHash } from "../../../writing-core/src/index.js";
import type { JsonValue, ModelRequest } from "../../llm/src/index.js";
import { SessionStoreError } from "../src/index.js";

const runtimeActor = { kind: "runtime", id: "runtime-test" } as const;

function createProject(workspacePath: string) {
  const storage = openWorkspaceStorage({ workspacePath });
  const created = storage.createProject({
    operationId: "create-project",
    projectId: "project-1",
    name: "请求快照测试",
    mode: "deep",
    actor: runtimeActor,
  });
  assert.equal(created.ok, true);
  return storage;
}

const request: ModelRequest = {
  requestId: "request-2",
  model: "mock-writing-model",
  messages: [
    { role: "system", content: "只根据已授权材料写作。" },
    { role: "user", content: "整理成一段正文。" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-material-1",
          name: "read_material",
          arguments: { materialId: "material-1" },
          rawArguments: '{"materialId":"material-1"}',
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-material-1",
      name: "read_material",
      content: '{"content":"材料原文","contentVersionId":"material-v1"}',
    },
  ],
  tools: [
    {
      name: "read_material",
      description: "读取已授权材料",
      inputSchema: {
        type: "object",
        properties: { materialId: { type: "string" } },
        required: ["materialId"],
        additionalProperties: false,
      },
    },
  ],
  parameters: { temperature: 0, toolChoice: "auto" },
};

describe("runtime session store", () => {
  it('refreshes only an explicitly resumed loop allowance, preserves lifetime usage and still bounds the next segment', () => {
    const path = mkdtempSync(join(tmpdir(), 'loop-budget-'));
    let storage = createProject(path);
    const base = { projectId: 'project-1', runId: 'loop' };
    const call = (operationId: string) => {
      storage.prepareRuntimeOperation({ ...base, operationId, kind: 'model_request', effect: 'external_side_effect', input: {} });
      const result = storage.dispatchRuntimeOperation({ ...base, operationId, eventType: 'request.dispatch_attempted', eventPayload: {}, budgetUse: { modelRequests: 1 } });
      if (result.dispatched) storage.settleRuntimeOperation({ ...base, operationId, state: 'completed', eventType: 'request.completed', eventPayload: {}, result: {} });
      return result;
    };
    try {
      storage.createSession({ projectId: base.projectId, sessionId: 's', purpose: 'draft' });
      storage.startRun({ ...base, sessionId: 's', planVersion: 'test', budget: { maxModelRequests: 1, maxToolCalls: 2, maxRetriesPerRequest: 1, maxMajorRevisions: 1 } });
      assert.equal(call('one').dispatched, true);
      storage.pauseRun({ ...base, operationId: 'pause', reason: 'CO_CREATION_CHECKPOINT', payload: {} });
      storage.resumeRun({ ...base, operationId: 'resume', decision: 'resume', refreshLoopAllowance: true });
      storage.close(); storage = openWorkspaceStorage({ workspacePath: path });
      assert.equal(call('two').dispatched, true, 'previous user turns must not consume this turn');
      assert.equal(storage.getRun('loop')!.usage.modelRequests, 2, 'accounting must never be reset');
      assert.equal(call('over').dispatched, false, 'automatic loop still has a hard bound');
      assert.throws(() => storage.resumeRun({ ...base, operationId: 'implicit', decision: 'resume' }), /resumable/);
      storage.resumeRun({ ...base, operationId: 'explicit', decision: 'resume', refreshLoopAllowance: true });
      assert.equal(call('three').dispatched, true);
      assert.equal(storage.getRun('loop')!.usage.modelRequests, 3);
    } finally { storage.close(); rmSync(path, { recursive: true, force: true }); }
  });
  it("persists an intentional user checkpoint separately from unknown external outcomes", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-checkpoint-"));
    const storage = createProject(workspacePath);
    try {
      storage.createSession({
        sessionId: "session-checkpoint",
        projectId: "project-1",
        purpose: "draft",
      });
      storage.startRun({
        runId: "run-checkpoint",
        sessionId: "session-checkpoint",
        projectId: "project-1",
        planVersion: "test-plan-v1",
      });
      const waiting = storage.pauseRun({
        projectId: "project-1",
        runId: "run-checkpoint",
        operationId: "pause-after-outline",
        reason: "CO_CREATION_CHECKPOINT",
        payload: { stage: "outline", nextStage: "draft" },
      });
      assert.equal(waiting.status, "waiting_user");
      assert.equal(waiting.stopReason, "CO_CREATION_CHECKPOINT");
      assert.equal(storage.listRunEvents("run-checkpoint").at(-1)?.type, "run.waiting_user");

      const resumed = storage.resumeRun({
        projectId: "project-1",
        runId: "run-checkpoint",
        operationId: "resume-after-outline",
        decision: "resume",
      });
      assert.equal(resumed.status, "running");
      assert.equal(resumed.stopReason, null);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("persists immutable final request input and rebuilds it after restart without a provider", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-session-"));
    const storage = createProject(workspacePath);

    try {
      storage.createSession({
        sessionId: "session-1",
        projectId: "project-1",
        purpose: "draft",
      });
      storage.startRun({
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        planVersion: "test-plan-v1",
      });
      const saved = storage.saveRequestSnapshot({
        snapshotId: "snapshot-2",
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
        request,
        provider: {
          id: "mock-provider",
          adapterVersion: "1.2.3",
          serializationVersion: "mock-wire-v1",
          normalizedPayload: JSON.parse(
            JSON.stringify({
              model: request.model,
              messages: request.messages,
              tools: request.tools ?? [],
              parameters: request.parameters,
            }),
          ) as JsonValue,
          redactions: [],
          unreconstructableFields: [],
        },
        toolSchemas: [
          {
            ...request.tools![0]!,
            version: "1.0.0",
            schemaHash: "schema-hash-read-material",
          },
        ],
        assemblyVersion: "agent-request-v1",
        contentReferences: [
          {
            kind: "tool_result",
            id: "call-material-1",
            messageIndex: 3,
            contentHash: contentHash(
              '{"content":"材料原文","contentVersionId":"material-v1"}',
            ),
          },
        ],
      });

      assert.equal(saved.snapshotId, "snapshot-2");
      assert.equal(saved.payloadHash.length, 64);
      assert.equal(saved.requestHash.length, 64);
      assert.equal(saved.schemaHash.length, 64);
      assert.throws(
        () =>
          storage.saveRequestSnapshot({
            snapshotId: "snapshot-2",
            projectId: "project-1",
            sessionId: "session-1",
            runId: "run-1",
            request: { ...request, requestId: "different-request" },
            provider: {
              id: "mock-provider",
              adapterVersion: "1.2.3",
              serializationVersion: "mock-wire-v1",
              normalizedPayload: { changed: true },
              redactions: [],
              unreconstructableFields: [],
            },
            toolSchemas: [],
            assemblyVersion: "agent-request-v1",
            contentReferences: [],
          }),
        (error) =>
          error instanceof SessionStoreError &&
          error.code === "REQUEST_SNAPSHOT_ALREADY_EXISTS",
      );
    } finally {
      storage.close();
    }

    const reopened = openWorkspaceStorage({ workspacePath, readOnly: true });
    try {
      const snapshot = reopened.getRequestSnapshot("snapshot-2");
      assert.equal(snapshot?.provider, "mock-provider");
      assert.equal(snapshot?.adapterVersion, "1.2.3");
      assert.deepEqual(snapshot?.request.parameters, {
        temperature: 0,
        toolChoice: "auto",
      });
      assert.equal(snapshot?.toolSchemas[0]?.version, "1.0.0");
      assert.equal(
        snapshot?.toolSchemas[0]?.schemaHash,
        "schema-hash-read-material",
      );
      assert.deepEqual(snapshot?.normalizedPayload, {
        messages: request.messages,
        model: "mock-writing-model",
        parameters: request.parameters,
        tools: request.tools,
      });
      assert.deepEqual(snapshot?.contentReferences, [
        {
          kind: "tool_result",
          id: "call-material-1",
          messageIndex: 3,
          contentHash: contentHash(
            '{"content":"材料原文","contentVersionId":"material-v1"}',
          ),
        },
      ]);
      assert.deepEqual(reopened.rebuildModelRequest("snapshot-2"), request);
      assert.deepEqual(
        reopened.listRunEvents("run-1").map((event) => event.type),
        ["run.started", "request.prepared"],
      );
      const projectEvents = reopened.listEvents("project-1");
      assert.deepEqual(
        projectEvents.map((event) => event.projectSeq),
        projectEvents.map((_, index) => index + 1),
      );
    } finally {
      reopened.close();
    }

    const direct = new DatabaseSync(
      join(workspacePath, ".writing-agent", "workspace.sqlite3"),
    );
    direct
      .prepare(
        "UPDATE request_snapshots SET normalized_payload_json = ? WHERE id = ?",
      )
      .run('{"tampered":true}', "snapshot-2");
    direct.close();

    const tampered = openWorkspaceStorage({ workspacePath, readOnly: true });
    try {
      assert.throws(
        () => tampered.rebuildModelRequest("snapshot-2"),
        (error) =>
          error instanceof SessionStoreError &&
          error.code === "REQUEST_SNAPSHOT_INTEGRITY_FAILED",
      );
    } finally {
      tampered.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
