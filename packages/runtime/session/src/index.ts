import type {
  JsonValue,
  ModelRequest,
  ProviderRequestSnapshot,
  TokenUsage,
} from "../../llm/src/index.js";
import type {
  ToolEffect,
  ToolSchemaSnapshot,
} from "../../tools/src/index.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted"
  | "interrupted";

export type TerminalRunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "budget_exhausted";

export interface SessionRecord {
  readonly id: string;
  readonly projectId: string;
  readonly purpose: string;
  readonly createdAt: string;
}

export interface RunRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly status: RunStatus;
  readonly planVersion: string;
  readonly budget: RunBudget;
  readonly usage: RunUsage;
  readonly lastCommittedEventSeq: number;
  readonly stopReason: string | null;
  readonly createdAt: string;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface RunBudget {
  readonly maxModelRequests: number;
  readonly maxToolCalls: number;
  readonly maxRetriesPerRequest: number;
  readonly maxMajorRevisions: number;
}

export interface RunUsage {
  readonly modelRequests: number;
  readonly toolCalls: number;
  readonly retries: number;
  readonly majorRevisions: number;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cost: TokenUsage["cost"];
  readonly costKnown: boolean;
  readonly usageReports: number;
  readonly missingUsageReports: number;
}

export const DEFAULT_RUN_BUDGET: RunBudget = Object.freeze({
  maxModelRequests: 24,
  maxToolCalls: 32,
  maxRetriesPerRequest: 2,
  maxMajorRevisions: 2,
});

export const EMPTY_RUN_USAGE: RunUsage = Object.freeze({
  modelRequests: 0,
  toolCalls: 0,
  retries: 0,
  majorRevisions: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  cost: null,
  costKnown: true,
  usageReports: 0,
  missingUsageReports: 0,
});

export interface RequestContentReference {
  readonly kind: "tool_result" | "material" | "artifact";
  readonly id: string;
  readonly messageIndex: number;
  readonly contentHash: string;
}

export interface RequestSnapshotRecord {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly provider: string;
  readonly model: string;
  readonly adapterVersion: string;
  readonly serializationVersion: string;
  readonly assemblyVersion: string;
  readonly request: ModelRequest;
  readonly normalizedPayload: JsonValue;
  readonly toolSchemas: readonly ToolSchemaSnapshot[];
  readonly contentReferences: readonly RequestContentReference[];
  readonly payloadHash: string;
  readonly requestHash: string;
  readonly schemaHash: string;
  readonly redactions: readonly string[];
  readonly unreconstructableFields: readonly string[];
  readonly createdAt: string;
}

export interface RuntimeEvent {
  readonly id: string;
  readonly projectId: string;
  readonly projectSeq: number;
  readonly runId: string;
  readonly type: string;
  readonly operationId: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

export interface CreateSessionInput {
  readonly sessionId: string;
  readonly projectId: string;
  readonly purpose: string;
}

export interface StartRunInput {
  readonly purpose?: string;
  readonly expectedBodyVersionId?: string | null;
  readonly runId: string;
  readonly sessionId: string;
  readonly projectId: string;
  readonly planVersion: string;
  readonly budget?: RunBudget;
  readonly usage?: RunUsage;
  readonly displayInstruction?: string;
  readonly requiredArtifactVersionIds?: readonly string[];
  readonly operationId?: string;
}

export interface SaveRequestSnapshotInput {
  readonly snapshotId: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly request: ModelRequest;
  readonly provider: {
    readonly id: string;
    readonly adapterVersion: string;
  } & ProviderRequestSnapshot;
  readonly toolSchemas: readonly ToolSchemaSnapshot[];
  readonly assemblyVersion: string;
  readonly contentReferences: readonly RequestContentReference[];
}

export type RuntimeEventType =
  | "search.attempt_started"
  | "search.progress"
  | "request.dispatch_attempted"
  | "request.completed"
  | "request.failed"
  | "request.outcome_unknown"
  | "tool.requested"
  | "tool.completed"
  | "tool.failed"
  | "tool.outcome_unknown";

export interface RecordRunEventInput {
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly type: RuntimeEventType;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface FinishRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly status: TerminalRunStatus;
  readonly stopReason: string | null;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export interface PauseRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly reason: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type RuntimeOperationKind =
  | "model_request"
  | "tool_call"
  | "major_revision";

export type RuntimeOperationState =
  | "prepared"
  | "dispatched"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled"
  | "abandoned"
  | "unknown_outcome";

export interface RuntimeOperationRecord {
  readonly operationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: RuntimeOperationKind;
  readonly effect: ToolEffect;
  readonly inputHash: string;
  readonly state: RuntimeOperationState;
  readonly result: JsonValue | null;
  readonly error: JsonValue | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
}

export interface PrepareRuntimeOperationInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly kind: RuntimeOperationKind;
  readonly effect: ToolEffect;
  readonly input: JsonValue;
}

export interface RunBudgetUse {
  readonly modelRequests?: number;
  readonly toolCalls?: number;
  readonly retries?: number;
  readonly majorRevisions?: number;
}

export interface DispatchRuntimeOperationInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly eventType: "request.dispatch_attempted" | "tool.requested";
  readonly eventPayload: Readonly<Record<string, unknown>>;
  readonly budgetUse: RunBudgetUse;
  readonly retryAttempt?: number;
}

export type DispatchRuntimeOperationResult =
  | {
      readonly dispatched: true;
      readonly operation: RuntimeOperationRecord;
      readonly run: RunRecord;
    }
  | {
      readonly dispatched: false;
      readonly reason: "BUDGET_EXHAUSTED";
      readonly operation: RuntimeOperationRecord;
      readonly run: RunRecord;
    };

export interface SettleRuntimeOperationInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly state: "completed" | "failed" | "unknown_outcome";
  readonly eventType:
    | "request.completed"
    | "request.failed"
    | "request.outcome_unknown"
    | "tool.completed"
    | "tool.failed"
    | "tool.outcome_unknown";
  readonly eventPayload: Readonly<Record<string, unknown>>;
  readonly result?: JsonValue;
  readonly error?: JsonValue;
  readonly tokenUsage?: TokenUsage | null;
}

export interface RecoveredRun {
  readonly runId: string;
  readonly status: "interrupted" | "waiting_user";
  readonly unknownOperationIds: readonly string[];
}

export interface ResumeRunInput {
  /** Application-validated search decision, committed atomically with run.resumed. */
  readonly factSearchDecision?: { readonly requestId: string; readonly action: 'retry' | 'extend' | 'continue' };
  readonly checkpointDecision?: { readonly markerId: string; readonly intent: string; readonly receiptId: string };
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly decision: "resume" | "retry_unknown";
  readonly displayInstruction?: string;
  /** Application-owned loop protection, refreshed only after an explicit user continuation. */
  readonly refreshLoopAllowance?: boolean;
  readonly preservePendingAssignment?: boolean;
}

export function loopBudgetUsage(run: RunRecord, events: readonly Pick<RuntimeEvent, 'type' | 'payload'>[]): RunUsage {
  const baseline = events.findLast(event => event.type === 'run.resumed')?.payload.loopAllowanceBaseline as Record<string, unknown> | undefined;
  const used = { ...run.usage };
  for (const key of ['modelRequests', 'toolCalls', 'majorRevisions'] as const) {
    const value = baseline?.[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= used[key]) used[key] -= value;
  }
  return used;
}

export interface CancelRunInput {
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly reason: string;
}

export interface ReserveMajorRevisionInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly reason: string;
}

export type ReserveMajorRevisionResult =
  | {
      readonly reserved: true;
      readonly operationId: string;
      readonly majorRevisions: number;
    }
  | {
      readonly reserved: false;
      readonly operationId: string;
      readonly reason: "BUDGET_EXHAUSTED";
      readonly majorRevisions: number;
    };

export interface SessionStore {
  createSession(input: CreateSessionInput): SessionRecord;
  getSession(sessionId: string): SessionRecord | null;
  startRun(input: StartRunInput): RunRecord;
  getRun(runId: string): RunRecord | null;
  listRuns(projectId: string, sessionId?: string): RunRecord[];
  saveRequestSnapshot(input: SaveRequestSnapshotInput): RequestSnapshotRecord;
  getRequestSnapshot(snapshotId: string): RequestSnapshotRecord | null;
  listRequestSnapshots(runId: string): RequestSnapshotRecord[];
  rebuildModelRequest(snapshotId: string): ModelRequest;
  recordRunEvent(input: RecordRunEventInput): RuntimeEvent;
  prepareRuntimeOperation(
    input: PrepareRuntimeOperationInput,
  ): RuntimeOperationRecord;
  dispatchRuntimeOperation(
    input: DispatchRuntimeOperationInput,
  ): DispatchRuntimeOperationResult;
  settleRuntimeOperation(
    input: SettleRuntimeOperationInput,
  ): RuntimeOperationRecord;
  listRuntimeOperations(runId: string): RuntimeOperationRecord[];
  recoverProjectRuns(projectId: string): RecoveredRun[];
  pauseRun(input: PauseRunInput): RunRecord;
  resumeRun(input: ResumeRunInput): RunRecord;
  cancelRun(input: CancelRunInput): RunRecord;
  reserveMajorRevision(
    input: ReserveMajorRevisionInput,
  ): ReserveMajorRevisionResult;
  finishRun(input: FinishRunInput): RunRecord;
  listRunEvents(runId: string): RuntimeEvent[];
}

export class SessionStoreError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionStoreError";
  }
}
