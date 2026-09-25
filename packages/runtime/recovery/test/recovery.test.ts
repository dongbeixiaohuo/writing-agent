import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  openWorkspaceStorage,
  type CommitFaultPoint,
} from "../../../storage/src/index.js";
import { SessionStoreError } from "../../session/src/index.js";
import { RuntimeRecovery } from "../src/index.js";

const actor = { kind: "runtime", id: "recovery-test" } as const;

function setup(workspacePath: string, runId = "run-1") {
  const storage = openWorkspaceStorage({ workspacePath });
  assert.equal(
    storage.createProject({
      operationId: "create-project",
      projectId: "project-1",
      name: "recovery",
      mode: "deep",
      actor,
    }).ok,
    true,
  );
  storage.createSession({
    sessionId: "session-1",
    projectId: "project-1",
    purpose: "draft",
  });
  storage.startRun({
    runId,
    sessionId: "session-1",
    projectId: "project-1",
    planVersion: "recovery-test-v1",
  });
  return storage;
}

describe("RuntimeRecovery", () => {
  it("marks an interrupted dispatched external request unknown and never invokes an external boundary", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-unknown-"));
    const initial = setup(workspacePath);
    initial.prepareRuntimeOperation({
      operationId: "request-op-1",
      projectId: "project-1",
      runId: "run-1",
      kind: "model_request",
      effect: "external_side_effect",
      input: { requestId: "request-1", snapshotId: "snapshot-1" },
    });
    const dispatched = initial.dispatchRuntimeOperation({
      operationId: "request-op-1",
      projectId: "project-1",
      runId: "run-1",
      eventType: "request.dispatch_attempted",
      eventPayload: { requestId: "request-1", snapshotId: "snapshot-1" },
      budgetUse: { modelRequests: 1 },
    });
    assert.equal(dispatched.dispatched, true);
    initial.close();

    const reopened = openWorkspaceStorage({ workspacePath });
    try {
      const recovery = new RuntimeRecovery(reopened);
      const recovered = recovery.recoverProject("project-1");
      assert.deepEqual(recovered, [
        {
          runId: "run-1",
          status: "waiting_user",
          unknownOperationIds: ["request-op-1"],
        },
      ]);
      assert.equal(reopened.getRun("run-1")?.status, "waiting_user");
      assert.equal(
        reopened.listRuntimeOperations("run-1")[0]?.state,
        "unknown_outcome",
      );
      assert.deepEqual(
        reopened.listRunEvents("run-1").slice(-2).map((event) => event.type),
        ["run.interrupted", "request.outcome_unknown"],
      );
      const eventCount = reopened.listRunEvents("run-1").length;
      assert.deepEqual(recovery.recoverProject("project-1"), []);
      assert.equal(reopened.listRunEvents("run-1").length, eventCount);

      const replay = recovery.replayRun("run-1");
      assert.equal(replay.run.status, "waiting_user");
      assert.equal(replay.operations[0]?.state, "unknown_outcome");
      assert.equal(reopened.listRunEvents("run-1").length, eventCount);

      const blocked = recovery.resumeRun("run-1", { action: "resume" });
      assert.deepEqual(blocked, {
        resumed: false,
        runId: "run-1",
        status: "waiting_user",
        reason: "UNKNOWN_EXTERNAL_OUTCOME",
      });
      const authorized = recovery.resumeRun("run-1", {
        action: "retry_unknown",
      });
      assert.equal(authorized.resumed, true);
      assert.equal(reopened.getRun("run-1")?.status, "running");
      assert.equal(
        reopened.listRuntimeOperations("run-1")[0]?.state,
        "abandoned",
      );
    } finally {
      reopened.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("keeps operation preparation idempotent and rolls back a faulted dispatch transaction", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-op-fault-"));
    let failAt: CommitFaultPoint | null = null;
    const storage = openWorkspaceStorage({
      workspacePath,
      faultInjector: (point) => {
        if (point === failAt) throw new Error("injected dispatch crash");
      },
    });
    assert.equal(
      storage.createProject({
        operationId: "create-project",
        projectId: "project-1",
        name: "fault",
        mode: "quick",
        actor,
      }).ok,
      true,
    );
    storage.createSession({
      sessionId: "session-1",
      projectId: "project-1",
      purpose: "draft",
    });
    storage.startRun({
      runId: "run-1",
      sessionId: "session-1",
      projectId: "project-1",
      planVersion: "fault-v1",
    });
    const input = {
      operationId: "tool-op-1",
      projectId: "project-1",
      runId: "run-1",
      kind: "tool_call" as const,
      effect: "read_only" as const,
      input: { callId: "call-1" },
    };

    try {
      assert.deepEqual(
        storage.prepareRuntimeOperation(input),
        storage.prepareRuntimeOperation(input),
      );
      assert.throws(
        () =>
          storage.prepareRuntimeOperation({
            ...input,
            input: { callId: "different" },
          }),
        (error) =>
          error instanceof SessionStoreError &&
          error.code === "IDEMPOTENCY_KEY_REUSED",
      );

      failAt = "after_runtime_operation_dispatch";
      assert.throws(() =>
        storage.dispatchRuntimeOperation({
          operationId: "tool-op-1",
          projectId: "project-1",
          runId: "run-1",
          eventType: "tool.requested",
          eventPayload: { callId: "call-1", toolName: "read_material" },
          budgetUse: { toolCalls: 1 },
        }),
      );
      assert.equal(storage.listRuntimeOperations("run-1")[0]?.state, "prepared");
      assert.equal(
        storage
          .listRunEvents("run-1")
          .some((event) => event.type === "tool.requested"),
        false,
      );
      assert.equal(
        (storage.getRun("run-1")?.usage as { toolCalls: number }).toolCalls,
        0,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("marks a safe unfinished run interrupted and can explicitly resume it", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-resume-"));
    setup(workspacePath).close();
    const storage = openWorkspaceStorage({ workspacePath });
    try {
      const recovery = new RuntimeRecovery(storage);
      assert.deepEqual(recovery.recoverProject("project-1"), [
        { runId: "run-1", status: "interrupted", unknownOperationIds: [] },
      ]);
      assert.equal(storage.getRun("run-1")?.status, "interrupted");
      const resumed = recovery.resumeRun("run-1", { action: "resume" });
      assert.equal(resumed.resumed, true);
      assert.equal(storage.getRun("run-1")?.status, "running");
      assert.equal(storage.listRunEvents("run-1").at(-1)?.type, "run.resumed");
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reuses a safe interrupted operation ID after recovery and counts the retry", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-safe-retry-"));
    const initial = setup(workspacePath);
    const operationInput = {
      operationId: "read-op-1",
      projectId: "project-1",
      runId: "run-1",
      kind: "tool_call" as const,
      effect: "read_only" as const,
      input: { callId: "call-1", toolName: "read_material" },
    };
    initial.prepareRuntimeOperation(operationInput);
    initial.dispatchRuntimeOperation({
      operationId: "read-op-1",
      projectId: "project-1",
      runId: "run-1",
      eventType: "tool.requested",
      eventPayload: { callId: "call-1", toolName: "read_material" },
      budgetUse: { toolCalls: 1 },
    });
    initial.close();

    const storage = openWorkspaceStorage({ workspacePath });
    try {
      const recovery = new RuntimeRecovery(storage);
      assert.equal(recovery.recoverProject("project-1")[0]?.status, "interrupted");
      assert.equal(storage.listRuntimeOperations("run-1")[0]?.state, "interrupted");
      assert.deepEqual(
        storage.prepareRuntimeOperation(operationInput),
        storage.listRuntimeOperations("run-1")[0],
      );
      assert.equal(
        recovery.resumeRun("run-1", { action: "resume" }).resumed,
        true,
      );
      assert.equal(
        storage.dispatchRuntimeOperation({
          operationId: "read-op-1",
          projectId: "project-1",
          runId: "run-1",
          eventType: "tool.requested",
          eventPayload: { callId: "call-1", toolName: "read_material" },
          budgetUse: { toolCalls: 1, retries: 1 },
          retryAttempt: 1,
        }).dispatched,
        true,
      );
      storage.settleRuntimeOperation({
        operationId: "read-op-1",
        projectId: "project-1",
        runId: "run-1",
        state: "completed",
        eventType: "tool.completed",
        eventPayload: { callId: "call-1" },
        result: { content: "saved" },
      });
      assert.equal(storage.getRun("run-1")?.usage.toolCalls, 2);
      assert.equal(storage.getRun("run-1")?.usage.retries, 1);
      assert.equal(storage.listRuntimeOperations("run-1")[0]?.state, "completed");
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("reserves a major-revision budget idempotently and stops before an excess revision", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-revision-budget-"));
    const storage = openWorkspaceStorage({ workspacePath });
    assert.equal(
      storage.createProject({
        operationId: "create-project",
        projectId: "project-1",
        name: "revision budget",
        mode: "deep",
        actor,
      }).ok,
      true,
    );
    storage.createSession({
      sessionId: "session-1",
      projectId: "project-1",
      purpose: "revision",
    });
    storage.startRun({
      runId: "run-1",
      sessionId: "session-1",
      projectId: "project-1",
      planVersion: "revision-budget-v1",
      budget: {
        maxModelRequests: 0,
        maxToolCalls: 0,
        maxRetriesPerRequest: 0,
        maxMajorRevisions: 1,
      },
    });
    try {
      const first = storage.reserveMajorRevision({
        operationId: "revision-1",
        projectId: "project-1",
        runId: "run-1",
        reason: "user requested rewrite",
      });
      assert.equal(first.reserved, true);
      assert.deepEqual(
        storage.reserveMajorRevision({
          operationId: "revision-1",
          projectId: "project-1",
          runId: "run-1",
          reason: "user requested rewrite",
        }),
        first,
      );
      const second = storage.reserveMajorRevision({
        operationId: "revision-2",
        projectId: "project-1",
        runId: "run-1",
        reason: "another rewrite",
      });
      assert.equal(second.reserved, false);
      assert.equal(storage.getRun("run-1")?.status, "budget_exhausted");
      assert.equal(storage.getRun("run-1")?.usage.majorRevisions, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("recovers a committed draft and marks the unfinished run interrupted after an actual process exit", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-process-crash-"));
    const fixture = fileURLToPath(
      new URL("./fixtures/crash-after-commit.ts", import.meta.url),
    );
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", fixture, workspacePath],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 91, child.stderr);

    const storage = openWorkspaceStorage({ workspacePath });
    try {
      assert.equal(
        storage.listArtifactVersions("project-1", "body", "main")[0]?.content,
        "committed before crash",
      );
      const recovered = new RuntimeRecovery(storage).recoverProject("project-1");
      assert.deepEqual(recovered, [
        { runId: "run-1", status: "interrupted", unknownOperationIds: [] },
      ]);
      assert.equal(storage.getRun("run-1")?.status, "interrupted");
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
