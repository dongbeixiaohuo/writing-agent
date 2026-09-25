import { randomUUID } from "node:crypto";

import {
  SessionStoreError,
  type RequestSnapshotRecord,
  type RunRecord,
  type RuntimeEvent,
  type RuntimeOperationRecord,
  type SessionStore,
} from "../../session/src/index.js";

export interface RunReplay {
  readonly run: RunRecord;
  readonly events: readonly RuntimeEvent[];
  readonly operations: readonly RuntimeOperationRecord[];
  readonly requestSnapshots: readonly RequestSnapshotRecord[];
}

export type RecoveryDecision =
  | { readonly action: "resume" }
  | { readonly action: "retry_unknown" };

export type ResumeResult =
  | {
      readonly resumed: true;
      readonly runId: string;
      readonly status: "running";
    }
  | {
      readonly resumed: false;
      readonly runId: string;
      readonly status: RunRecord["status"];
      readonly reason: string;
    };

export class RuntimeRecovery {
  constructor(
    private readonly sessions: SessionStore,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  recoverProject(projectId: string) {
    return this.sessions.recoverProjectRuns(projectId);
  }

  inspectRun(runId: string): RunReplay {
    return this.replayRun(runId);
  }

  replayRun(runId: string): RunReplay {
    const run = this.sessions.getRun(runId);
    if (run === null) {
      throw new SessionStoreError("RUN_NOT_FOUND", "Run does not exist");
    }
    return {
      run,
      events: this.sessions.listRunEvents(runId),
      operations: this.sessions.listRuntimeOperations(runId),
      requestSnapshots: this.sessions.listRequestSnapshots(runId),
    };
  }

  resumeRun(runId: string, decision: RecoveryDecision): ResumeResult {
    const run = this.sessions.getRun(runId);
    if (run === null) {
      throw new SessionStoreError("RUN_NOT_FOUND", "Run does not exist");
    }
    const hasUnknown = this.sessions
      .listRuntimeOperations(runId)
      .some((operation) => operation.state === "unknown_outcome");
    if (hasUnknown && decision.action !== "retry_unknown") {
      return {
        resumed: false,
        runId,
        status: run.status,
        reason: "UNKNOWN_EXTERNAL_OUTCOME",
      };
    }
    if (run.status !== "interrupted" && run.status !== "waiting_user") {
      return {
        resumed: false,
        runId,
        status: run.status,
        reason: "RUN_NOT_RESUMABLE",
      };
    }
    const resumed = this.sessions.resumeRun({
      projectId: run.projectId,
      runId,
      operationId: this.idFactory(),
      decision: decision.action,
    });
    return { resumed: true, runId, status: resumed.status as "running" };
  }
}
