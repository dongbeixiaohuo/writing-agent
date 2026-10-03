import { randomUUID } from "node:crypto";
import { loopBudgetUsage } from '../../session/src/index.js';

import { canonicalJson, contentHash } from "../../../writing-core/src/index.js";
import type {
  CompletedToolCall,
  JsonValue,
  ModelError,
  ModelEvent,
  ModelMessage,
  ModelParameters,
  ModelProvider,
  ModelRequest,
  TokenUsage,
} from "../../llm/src/index.js";
import type {
  RequestContentReference,
  RunBudget,
  RunRecord,
  SessionStore,
} from "../../session/src/index.js";
import {
  createToolPermissionGrant,
  type CreateToolPermissionGrantInput,
} from "../../tools/src/permission-grant.js";
import type {
  ToolEffect,
  ToolExecutionResult,
  ToolRegistry,
} from "../../tools/src/index.js";

export type { RunBudget, RunUsage } from "../../session/src/index.js";

const REQUEST_ASSEMBLY_VERSION = "agent-request-v1";
const RUN_PLAN_VERSION = "bounded-writing-loop-v2";

export interface FinalOutputCommitInput {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly requestSnapshotId: string;
  readonly content: string;
}

export interface FinalOutputCommitter {
  commit(
    input: FinalOutputCommitInput,
  ): Promise<{ readonly artifactVersionId: string }>;
}

export class FinalOutputContinuationRequiredError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly instruction: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FinalOutputContinuationRequiredError";
  }
}

export interface StageOutputPreview {
  readonly id: string;
  readonly stage: import('../../../writing-core/src/public-stage-output.js').PublicStageOutput;
}

export interface AgentRuntimeOptions {
  readonly onModelStream?: (input: { projectId: string; sessionId: string; runId: string; requestId: string; actor?: string; lifecycle?: 'started' | 'finished'; textAudience?: 'conversation'; outputPreview?: StageOutputPreview; event: ModelEvent | null }) => void;
  readonly provider: ModelProvider;
  readonly tools: ToolRegistry;
  readonly sessions: SessionStore;
  readonly requestPolicy?: (runId: string) => AgentRequestPolicy;
  readonly idFactory?: () => string;
  readonly createPermissionGrant?: (
    input: CreateToolPermissionGrantInput,
  ) => ReturnType<typeof createToolPermissionGrant>;
  readonly finalOutputCommitter?: FinalOutputCommitter;
  // Only application-owned policy may declare a durably committed tool result terminal.
  readonly completeAfterTool?: (
    result: ToolExecutionResult,
  ) => { readonly content: string; readonly artifactVersionId: string } | null;
  readonly pauseAfterTool?: (
    result: ToolExecutionResult,
  ) => {
    readonly reason: string;
    readonly payload?: Readonly<Record<string, JsonValue>>;
  } | null;
  readonly pauseBeforeRequest?: (runId: string) => { readonly reason: string; readonly payload?: Readonly<Record<string, JsonValue>> } | null;
  readonly waitBeforeRetry?: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface AgentRequestPolicy {
  /** Runtime-owned diagnostic identity; never taken from tool arguments. */
  readonly actor?: string;
  readonly textAudience?: 'conversation';
  /** Application-authorized public deliverable, not model reasoning or tool authority. */
  readonly outputPreview?: StageOutputPreview;
  /** Application-owned binding: save a complete text response through the normal
   * tool pipeline, without asking the model to reproduce it as JSON. */
  readonly textOutputTool?: { readonly name: string; readonly arguments: Readonly<Record<string, JsonValue>>; readonly contentArgument: string };
  readonly expectedBodyVersionId?: string | null;
  readonly scopeId: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly allowedTools: readonly string[];
  /** Tools offered to the model may be narrower than local harness save authority. */
  readonly modelTools?: readonly string[];
  readonly toolChoice?: ModelParameters['toolChoice'];
  readonly authorizeTool?: (call: CompletedToolCall) => boolean;
}

export interface AgentRunInput {
  readonly projectId: string;
  readonly sessionId?: string;
  readonly purpose: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly parameters: ModelParameters;
  readonly grantedPermissions: readonly string[];
  readonly expectedBodyVersionId: string | null;
  readonly budget?: RunBudget;
  readonly signal?: AbortSignal;
  readonly displayInstruction?: string;
  readonly requiredArtifactVersionIds?: readonly string[];
  readonly operationId?: string;
}

interface AgentRunFacts {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly modelRequestCount: number;
  readonly toolCallCount: number;
}

interface AgentRunError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export type AgentRunResult =
  | (AgentRunFacts & {
      readonly ok: true;
      readonly content: string;
      readonly finalRequestSnapshotId: string;
      readonly artifactVersionId: string | null;
    })
  | (AgentRunFacts & {
      readonly ok: false;
      readonly error: AgentRunError;
    });

export interface AgentRunHandle {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly result: Promise<AgentRunResult>;
  cancel(reason?: string, operationId?: string): RunRecord;
}

interface ActiveRun {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly controller: AbortController;
}

interface CollectedModelAttempt {
  readonly stream: {
    headersMs: number | null;
    firstReasoningMs: number | null;
    lastReasoningMs: number | null;
    reasoningEvents: number;
    firstContentMs: number | null;
    lastContentMs: number | null;
    contentEvents: number;
  };
  readonly text: string;
  readonly completedToolCalls: readonly CompletedToolCall[];
  readonly finishReason:
    | "stop"
    | "tool_calls"
    | "max_tokens"
    | "content_filter"
    | null;
  readonly usage: TokenUsage | null;
  readonly error: ModelError | null;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${field} must not be empty`);
  return normalized;
}

function modelTools(tools: ToolRegistry): NonNullable<ModelRequest["tools"]> {
  return tools.schemaSnapshots().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

function contentReferences(
  messages: readonly ModelMessage[],
): RequestContentReference[] {
  const references: RequestContentReference[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "tool") return;
    references.push({
      kind: "tool_result",
      id: message.toolCallId,
      messageIndex,
      contentHash: contentHash(message.content),
    });
  });
  return references;
}

function usagePayload(usage: TokenUsage | null): Record<string, unknown> {
  return usage === null ? {} : { usage };
}

function failureFromModel(error: ModelError): AgentRunError {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function isUnknownExternalModelOutcome(error: ModelError): boolean {
  return (
    error.code === "NETWORK_ERROR" ||
    error.code === "TIMEOUT" ||
    error.code === "UNKNOWN_PROVIDER_ERROR"
  );
}

function isSafeModelRetry(error: ModelError): boolean {
  return (
    error.retryable &&
    (error.code === "RATE_LIMITED" || error.code === "PROVIDER_UNAVAILABLE")
  );
}

function isUnknownExternalToolOutcome(
  effect: ToolEffect,
  result: ToolExecutionResult,
): boolean {
  if (effect !== "external_side_effect" || result.ok) return false;
  return ![
    "ABORTED",
    "TOOL_INPUT_INVALID",
    "TOOL_NOT_FOUND",
    "TOOL_PERMISSION_DENIED",
    "TOOL_TARGET_INVALID",
  ].includes(result.error.code);
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

async function waitBeforeRetry(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      clearTimeout(timeout);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export class AgentRuntime {
  readonly #provider: ModelProvider;
  readonly #tools: ToolRegistry;
  readonly #sessions: SessionStore;
  readonly #requestPolicy: AgentRuntimeOptions["requestPolicy"];
  readonly #idFactory: () => string;
  readonly #createPermissionGrant: NonNullable<
    AgentRuntimeOptions["createPermissionGrant"]
  >;
  readonly #finalOutputCommitter: FinalOutputCommitter | undefined;
  readonly #completeAfterTool: NonNullable<AgentRuntimeOptions["completeAfterTool"]>;
  readonly #onModelStream: AgentRuntimeOptions['onModelStream'];
  readonly #pauseAfterTool: NonNullable<AgentRuntimeOptions["pauseAfterTool"]>;
  readonly #pauseBeforeRequest: NonNullable<AgentRuntimeOptions["pauseBeforeRequest"]>;
  readonly #waitBeforeRetry: NonNullable<
    AgentRuntimeOptions["waitBeforeRetry"]
  >;

  constructor(options: AgentRuntimeOptions) {
    this.#onModelStream = options.onModelStream;
    this.#provider = options.provider;
    this.#tools = options.tools;
    this.#sessions = options.sessions;
    this.#requestPolicy = options.requestPolicy;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#createPermissionGrant =
      options.createPermissionGrant ?? createToolPermissionGrant;
    this.#finalOutputCommitter = options.finalOutputCommitter;
    this.#completeAfterTool = options.completeAfterTool ?? (() => null);
    this.#pauseAfterTool = options.pauseAfterTool ?? (() => null);
    this.#pauseBeforeRequest = options.pauseBeforeRequest ?? (() => null);
    this.#waitBeforeRetry = options.waitBeforeRetry ?? waitBeforeRetry;
  }

  start(input: AgentRunInput): AgentRunHandle {
    const projectId = requireText(input.projectId, "projectId");
    const purpose = requireText(input.purpose, "purpose");
    requireText(input.model, "model");
    requireText(input.systemPrompt, "systemPrompt");
    requireText(input.userMessage, "userMessage");

    let sessionId: string;
    if (input.sessionId === undefined) {
      sessionId = this.#idFactory();
      this.#sessions.createSession({ sessionId, projectId, purpose });
    } else {
      sessionId = requireText(input.sessionId, "sessionId");
      const existing = this.#sessions.getSession(sessionId);
      if (existing === null) {
        this.#sessions.createSession({ sessionId, projectId, purpose });
      } else if (existing.projectId !== projectId) {
        throw new TypeError("sessionId belongs to another project");
      }
    }

    const runId = this.#idFactory();
    this.#sessions.startRun({
      expectedBodyVersionId: input.expectedBodyVersionId,
      runId,
      sessionId,
      projectId,
      planVersion: RUN_PLAN_VERSION,
      purpose: input.purpose,
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      ...(input.displayInstruction === undefined
        ? {}
        : { displayInstruction: input.displayInstruction }),
      ...(input.requiredArtifactVersionIds === undefined
        ? {}
        : { requiredArtifactVersionIds: input.requiredArtifactVersionIds }),
      ...(input.operationId === undefined
        ? {}
        : { operationId: input.operationId }),
    });
    return this.#launch(input, {
      projectId,
      sessionId,
      runId,
      controller: new AbortController(),
    });
  }

  resume(input: AgentRunInput, runIdInput: string): AgentRunHandle {
    const projectId = requireText(input.projectId, "projectId");
    const runId = requireText(runIdInput, "runId");
    const run = this.#sessions.getRun(runId);
    if (run === null || run.projectId !== projectId || run.status !== "running") {
      throw new TypeError("runId is not ready for runtime resume");
    }
    if (input.sessionId !== undefined && input.sessionId !== run.sessionId) {
      throw new TypeError("sessionId does not match the recovered run");
    }
    requireText(input.purpose, "purpose");
    requireText(input.model, "model");
    requireText(input.systemPrompt, "systemPrompt");
    requireText(input.userMessage, "userMessage");
    return this.#launch(
      { ...input, sessionId: run.sessionId },
      {
        projectId,
        sessionId: run.sessionId,
        runId,
        controller: new AbortController(),
      },
    );
  }

  #launch(input: AgentRunInput, active: ActiveRun): AgentRunHandle {
    const { projectId, sessionId, runId } = active;
    const cancel = (reason = "user_stop", operationId = this.#idFactory()): RunRecord => {
      const cancelled = this.#sessions.cancelRun({
        projectId,
        runId,
        operationId,
        reason,
      });
      active.controller.abort(reason);
      return cancelled;
    };

    if (input.signal?.aborted) {
      cancel("external_abort");
      return {
        projectId,
        sessionId,
        runId,
        result: Promise.resolve(this.#cancelledResult(active)),
        cancel,
      };
    }
    input.signal?.addEventListener(
      "abort",
      () => {
        const current = this.#sessions.getRun(runId);
        if (
          current !== null &&
          !["completed", "failed", "cancelled", "budget_exhausted"].includes(
            current.status,
          )
        ) {
          cancel("external_abort");
        }
      },
      { once: true },
    );

    const result = this.#execute(input, active).finally(() => {
      try { this.#onModelStream?.({ projectId, sessionId, runId, requestId: '', event: null }); } catch { /* optional observer */ }
    });
    return { projectId, sessionId, runId, result, cancel };
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    return this.start(input).result;
  }

  #facts(active: ActiveRun): AgentRunFacts {
    const run = this.#sessions.getRun(active.runId);
    return {
      projectId: active.projectId,
      sessionId: active.sessionId,
      runId: active.runId,
      modelRequestCount: run?.usage.modelRequests ?? 0,
      toolCallCount: run?.usage.toolCalls ?? 0,
    };
  }

  #cancelledResult(active: ActiveRun): AgentRunResult {
    return {
      ok: false,
      ...this.#facts(active),
      error: {
        code: "CANCELLED",
        message: "Run was cancelled",
        retryable: false,
      },
    };
  }

  #completeRun(active: ActiveRun, snapshotId: string, content: string, artifactVersionId: string | null): AgentRunResult {
    if (this.#sessions.getRun(active.runId)?.status === "cancelled") return this.#cancelledResult(active);
    this.#sessions.finishRun({
      projectId: active.projectId,
      runId: active.runId,
      operationId: this.#idFactory(),
      status: "completed",
      stopReason: null,
      payload: { finalRequestSnapshotId: snapshotId, artifactVersionId, outputHash: contentHash(content) },
    });
    return { ok: true, ...this.#facts(active), content, finalRequestSnapshotId: snapshotId, artifactVersionId };
  }

  #budgetResult(active: ActiveRun): AgentRunResult {
    return {
      ok: false,
      ...this.#facts(active),
      error: {
        code: "BUDGET_EXHAUSTED",
        message: "Run budget was exhausted before the next operation",
        retryable: false,
      },
    };
  }

  #unknownOutcomeResult(active: ActiveRun): AgentRunResult {
    return {
      ok: false,
      ...this.#facts(active),
      error: {
        code: "UNKNOWN_EXTERNAL_OUTCOME",
        message: "External operation outcome is unknown and requires reconciliation",
        retryable: false,
      },
    };
  }

  #waitingUserResult(active: ActiveRun): AgentRunResult {
    return {
      ok: false,
      ...this.#facts(active),
      error: {
        code: "USER_CONFIRMATION_REQUIRED",
        message: "The run reached a user confirmation checkpoint",
        retryable: false,
      },
    };
  }

  #failRun(
    active: ActiveRun,
    code: string,
    message: string,
    retryable: boolean,
  ): AgentRunResult {
    const current = this.#sessions.getRun(active.runId);
    if (current?.status === "cancelled") return this.#cancelledResult(active);
    if (current?.status === "budget_exhausted") return this.#budgetResult(active);
    if (current?.status === "waiting_user") {
      return this.#unknownOutcomeResult(active);
    }
    this.#sessions.finishRun({
      projectId: active.projectId,
      runId: active.runId,
      operationId: this.#idFactory(),
      status: "failed",
      stopReason: code,
      payload: { code },
    });
    return {
      ok: false,
      ...this.#facts(active),
      error: { code, message, retryable },
    };
  }

  async #collectModelAttempt(
    request: ModelRequest,
    active: ActiveRun,
    textAudience?: 'conversation',
    actor?: string,
    outputPreview?: StageOutputPreview,
  ): Promise<CollectedModelAttempt> {
    let text = "";
    const completedToolCalls: CompletedToolCall[] = [];
    let finishReason: CollectedModelAttempt["finishReason"] = null;
    let usage: TokenUsage | null = null;
    let error: ModelError | null = null;
    const began = performance.now();
    const stream: CollectedModelAttempt['stream'] = {
      headersMs: null,
      firstReasoningMs: null,
      lastReasoningMs: null,
      reasoningEvents: 0,
      firstContentMs: null,
      lastContentMs: null,
      contentEvents: 0,
    };
    const preview = (event: ModelEvent | null, lifecycle?: 'started' | 'finished'): void => {
      // Presentation must not affect model execution, persistence or cancellation.
      try { this.#onModelStream?.({ projectId: active.projectId, sessionId: active.sessionId, runId: active.runId, requestId: request.requestId, ...(actor ? { actor } : {}), ...(!request.signal?.aborted && lifecycle ? { lifecycle } : {}), ...(textAudience ? { textAudience } : {}), ...(outputPreview ? { outputPreview } : {}), event: request.signal?.aborted ? null : event }); } catch { /* optional observer */ }
    };
    preview(null, 'started');
    try {
      for await (const event of this.#provider.stream(request)) {
        const elapsed = Math.round(performance.now() - began);
        if (event.type === 'response_activity' && event.phase === 'headers') stream.headersMs ??= elapsed;
        if (event.type === 'response_activity' && event.phase === 'reasoning') {
          stream.firstReasoningMs ??= elapsed; stream.lastReasoningMs = elapsed; stream.reasoningEvents++;
        }
        if ((event.type === 'response_activity' && event.phase === 'content') || (event.type === 'text_delta' && event.delta.length > 0)
          || (event.type === 'tool_call_delta' && event.argumentsDelta.length > 0)) {
          stream.firstContentMs ??= elapsed; stream.lastContentMs = elapsed; stream.contentEvents++;
        }
        preview(event);
        switch (event.type) {
          case "text_delta":
            text += event.delta;
            break;
          case "tool_call_complete":
            completedToolCalls.push(event.call);
            break;
          case "usage":
            usage = event.usage;
            break;
          case "completed":
            finishReason = event.finishReason;
            break;
          case "error":
            error = event.error;
            break;
          case "tool_call_delta":
            break;
        }
      }
    } catch {
      error = {
        code: "UNKNOWN_PROVIDER_ERROR",
        message: "Model provider failed after dispatch",
        retryable: false,
      };
    }
    finally { preview(null, !error && finishReason !== null ? 'finished' : undefined); }
    return { text, completedToolCalls, finishReason, usage, error, stream };
  }

  async #execute(
    input: AgentRunInput,
    active: ActiveRun,
  ): Promise<AgentRunResult> {
    const { projectId, sessionId, runId } = active;
    const permissionGrant = this.#createPermissionGrant({
      projectId,
      runId,
      permissions: input.grantedPermissions,
    });
    let messages: ModelMessage[] = [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userMessage },
    ];
    let scopeId: string | undefined;
    let outputRecoveryCount = 0;
    let schemaCorrectionCount = 0;
    let requireToolOnContinuation = false;
    let pendingOutputRecoveryAttempt = 0;
    let pendingOutputTokenLimit: number | null = null;
    let textSaveFailures = 0;
    const rejectedTextHashes = new Set<string>();
    const toolFailureCounts = new Map<string, number>();

    executionLoop: for (;;) {
      if (this.#sessions.getRun(runId)?.status === "cancelled") {
        return this.#cancelledResult(active);
      }
      const pendingPause = this.#pauseBeforeRequest(runId);
      if (pendingPause) {
        this.#sessions.pauseRun({ projectId, runId, operationId: this.#idFactory(), ...pendingPause });
        return this.#waitingUserResult(active);
      }
      const requestId = this.#idFactory();
      const policy = this.#requestPolicy?.(runId);
      if (policy !== undefined && policy.scopeId !== scopeId) {
        scopeId = policy.scopeId;
        outputRecoveryCount = 0;
        schemaCorrectionCount = 0;
        requireToolOnContinuation = false;
        pendingOutputRecoveryAttempt = 0;
        pendingOutputTokenLimit = null;
        textSaveFailures = 0;
        rejectedTextHashes.clear();
        toolFailureCounts.clear();
        messages = [{ role: "system", content: policy.systemPrompt }, { role: "user", content: policy.userMessage }];
      } else if (policy !== undefined) {
        // Refresh authoritative state after each tool without sharing another
        // actor's history or discarding this actor's own tool feedback.
        messages[0] = { role: "system", content: policy.systemPrompt };
        messages[1] = { role: "user", content: policy.userMessage };
      }
      const offeredTools = policy?.modelTools ?? policy?.allowedTools;
      const toolSchemas = this.#tools.schemaSnapshots().filter((tool) => offeredTools === undefined || offeredTools.includes(tool.name));
      const tools = modelTools(this.#tools).filter((tool) => offeredTools === undefined || offeredTools.includes(tool.name));
      // A truncation recovery escalates the output cap once (x2, capped);
      // retrying with the same exhausted budget can only truncate again.
      const escalatedOutputTokens = pendingOutputTokenLimit;
      pendingOutputTokenLimit = null;
      const request: ModelRequest = {
        requestId,
        model: input.model,
        messages: structuredClone(messages),
        ...(tools.length === 0 ? {} : { tools }),
        parameters: { ...structuredClone(input.parameters),
          ...(escalatedOutputTokens === null ? {} : { maxOutputTokens: escalatedOutputTokens }),
          ...(policy?.toolChoice === undefined ? {} : { toolChoice: policy.toolChoice }),
          ...(requireToolOnContinuation && tools.length > 0 ? { toolChoice: 'required' as const } : {}),
        },
      };
      Object.defineProperty(request, "signal", {
        value: active.controller.signal,
        enumerable: false,
      });
      let providerSnapshot;
      try {
        providerSnapshot = this.#provider.snapshotRequest(request);
      } catch (error) {
        return this.#failRun(
          active,
          "REQUEST_ASSEMBLY_FAILED",
          error instanceof Error
            ? error.message
            : "Model request could not be assembled",
          false,
        );
      }
      const snapshotId = this.#idFactory();
      try {
        this.#sessions.saveRequestSnapshot({
          snapshotId,
          projectId,
          sessionId,
          runId,
          request,
          provider: {
            id: this.#provider.id,
            adapterVersion: this.#provider.adapterVersion,
            ...providerSnapshot,
          },
          toolSchemas,
          assemblyVersion: REQUEST_ASSEMBLY_VERSION,
          contentReferences: contentReferences(messages),
        });
      } catch (error) {
        if (this.#sessions.getRun(runId)?.status === "cancelled") {
          return this.#cancelledResult(active);
        }
        throw error;
      }

      const outputRecoveryAttempt = pendingOutputRecoveryAttempt;
      pendingOutputRecoveryAttempt = 0;
      let attemptIndex = 0;
      let attempt: CollectedModelAttempt | null = null;
      for (;;) {
        if (this.#sessions.getRun(runId)?.status === "cancelled") {
          return this.#cancelledResult(active);
        }
        const operationId = this.#idFactory();
        this.#sessions.prepareRuntimeOperation({
          operationId,
          projectId,
          runId,
          kind: "model_request",
          effect: "external_side_effect",
          input: { requestId, snapshotId, attemptIndex },
        });
        const dispatched = this.#sessions.dispatchRuntimeOperation({
          operationId,
          projectId,
          runId,
          eventType: "request.dispatch_attempted",
          eventPayload: { ...(policy?.actor ? { actor: policy.actor } : {}), requestId, snapshotId, attemptIndex, outputRecoveryAttempt },
          budgetUse: {
            modelRequests: 1,
            ...(attemptIndex + outputRecoveryAttempt === 0 ? {} : { retries: 1 }),
          },
          retryAttempt: attemptIndex + outputRecoveryAttempt,
        });
        if (!dispatched.dispatched) return this.#budgetResult(active);

        attempt = await this.#collectModelAttempt(request, active, policy?.textAudience, policy?.actor, policy?.outputPreview);
        if (this.#sessions.getRun(runId)?.status === "cancelled") {
          return this.#cancelledResult(active);
        }
        if (attempt.error !== null) {
          const run = this.#sessions.getRun(runId)!;
          // A complete new response is safe to request: this batch has not
          // executed any tool. Never concatenate partial JSON or raise an
          // explicit token ceiling, and never exceed the existing run budget.
          const recoverOutput = attempt.error.code === "MODEL_OUTPUT_TRUNCATED"
            && outputRecoveryCount < 1 && loopBudgetUsage(run, this.#sessions.listRunEvents(runId)).modelRequests < run.budget.maxModelRequests
            && attemptIndex + outputRecoveryAttempt < run.budget.maxRetriesPerRequest;
          const eventPayload = {
            requestId,
            snapshotId,
            attemptIndex,
            error: failureFromModel(attempt.error),
            stream: attempt.stream,
            ...(attempt.error.transport === undefined ? {} : { transport: attempt.error.transport }),
            ...(attempt.error.status === undefined ? {} : { providerHttpStatus: attempt.error.status }),
            ...(attempt.error.providerDetail === undefined ? {} : { providerDetail: attempt.error.providerDetail }),
            ...(providerSnapshot.outputTokenLimit === undefined ? {} : { outputTokenLimit: providerSnapshot.outputTokenLimit }),
            ...(attempt.error.providerRequestId === undefined ? {} : { providerRequestId: attempt.error.providerRequestId }),
            ...(attempt.error.code === "MODEL_OUTPUT_TRUNCATED" ? {
              partialTextLength: attempt.text.length, partialTextHash: contentHash(attempt.text),
            } : {}),
            ...(recoverOutput ? { recovery: { kind: "output_truncation", attempt: outputRecoveryCount + 1,
              nextOutputTokenLimit: (() => { const current = providerSnapshot.outputTokenLimit?.value ?? input.parameters.maxOutputTokens ?? null; return current === null ? null : Math.min(current * 2, 65536); })() } } : {}),
            ...(attempt.error.toolSchemaFeedback === undefined ? {} : { toolSchemaFeedback: attempt.error.toolSchemaFeedback }),
            ...usagePayload(attempt.usage),
          };
          if (isUnknownExternalModelOutcome(attempt.error)) {
            this.#sessions.settleRuntimeOperation({
              operationId,
              projectId,
              runId,
              state: "unknown_outcome",
              eventType: "request.outcome_unknown",
              eventPayload,
              error: jsonValue(failureFromModel(attempt.error)),
              tokenUsage: attempt.usage,
            });
            return this.#unknownOutcomeResult(active);
          }
          this.#sessions.settleRuntimeOperation({
            operationId,
            projectId,
            runId,
            state: "failed",
            eventType: "request.failed",
            eventPayload,
            error: jsonValue(failureFromModel(attempt.error)),
            tokenUsage: attempt.usage,
          });
          if (recoverOutput) {
            outputRecoveryCount += 1;
            pendingOutputRecoveryAttempt = attemptIndex + outputRecoveryAttempt + 1;
            const currentOutputLimit = providerSnapshot.outputTokenLimit?.value ?? input.parameters.maxOutputTokens ?? null;
            pendingOutputTokenLimit = currentOutputLimit === null ? null : Math.min(currentOutputLimit * 2, 65536);
            messages.push({ role: "user", content: "上次回复达到单次输出长度上限而被截断，本批工具全部未执行，残缺文本没有保存。请重新完整提交当前任务结果，不续接残缺JSON，不重复已完成的阶段。保持要求的正文、研究和事实完整；工具内容直接放入参数，不先在聊天中重复全文，省略重复过程说明。不要为了精简删掉必要事实或伪称任务完成；真实业务缺口仍按原规则提问。" });
            continue executionLoop;
          }
          if (attempt.error.code === "MODEL_RESPONSE_INVALID" && attempt.error.toolSchemaFeedback !== undefined) {
            schemaCorrectionCount += 1;
            if (schemaCorrectionCount <= 2) {
              const toolUnavailable = attempt.error.toolSchemaFeedback.issues.some(issue => issue.rule === 'allowed_tools');
              // Correct within this actor's existing scope/budget. Do not ask
              // for another prose answer before the corrected tool submission.
              requireToolOnContinuation = true;
              const invalidJson = attempt.error.toolSchemaFeedback.issues.some(issue => issue.rule === 'json_syntax');
              messages.push({ role: "user", content: toolUnavailable
                ? `本批工具全部未执行。请求了当前任务未开放的工具，请按当前状态先完成必要读取和信息检查，仅使用 allowedTools 中的工具，不得跳过前提或越权。校验反馈：${canonicalJson(attempt.error.toolSchemaFeedback)}`
                : invalidJson
                ? `本批工具全部未执行。工具参数不是合法 JSON；请直接重新调用同一工具，提交完整参数（不是差异补丁）。字符串内的双引号、反斜杠和换行必须正确转义，不加 Markdown 代码围栏、注释或尾逗号。不要在聊天中重写或重复全文，不拼接上次残缺参数，不新增用户确认或授权。校验反馈：${canonicalJson(attempt.error.toolSchemaFeedback)}`
                : `本次响应的工具参数未通过schema校验，整批工具均未执行。请修正后重新提交完整工具参数（不是差异补丁），保留全部内容及每项所有 required 字段，只更正错误，不删除主张或改用其他工具绕过。校验反馈：${canonicalJson(attempt.error.toolSchemaFeedback)}` });
              continue executionLoop;
            }
          }
          if (isSafeModelRetry(attempt.error)) {
            await this.#waitBeforeRetry(
              attempt.error.retryAfterMs ?? 0,
              active.controller.signal,
            );
            if (this.#sessions.getRun(runId)?.status === "cancelled") {
              return this.#cancelledResult(active);
            }
            attemptIndex += 1;
            continue;
          }
          return this.#failRun(
            active,
            attempt.error.code,
            attempt.error.message,
            attempt.error.retryable,
          );
        }
        if (attempt.finishReason === null) {
          this.#sessions.settleRuntimeOperation({
            operationId,
            projectId,
            runId,
            state: "failed",
            eventType: "request.failed",
            eventPayload: {
              requestId,
              snapshotId,
              attemptIndex,
              code: "MODEL_TERMINAL_MISSING",
            },
            error: { code: "MODEL_TERMINAL_MISSING" },
            tokenUsage: attempt.usage,
          });
          return this.#failRun(
            active,
            "MODEL_TERMINAL_MISSING",
            "Model stream ended without a terminal event",
            false,
          );
        }
        this.#sessions.settleRuntimeOperation({
          operationId,
          projectId,
          runId,
          state: "completed",
          eventType: "request.completed",
          eventPayload: {
            requestId,
            snapshotId,
            attemptIndex,
            finishReason: attempt.finishReason,
            stream: attempt.stream,
            responseText: attempt.text,
            responseTextHash: contentHash(attempt.text),
            toolCallIds: attempt.completedToolCalls.map((call) => call.id),
            ...usagePayload(attempt.usage),
          },
          result: {
            finishReason: attempt.finishReason,
            responseTextHash: contentHash(attempt.text),
          },
          tokenUsage: attempt.usage,
        });
        break;
      }

      if (attempt && attempt.completedToolCalls.length === 0 && !policy?.textOutputTool &&
          (requireToolOnContinuation || policy?.toolChoice === 'required')) {
        schemaCorrectionCount += 1;
        if (schemaCorrectionCount > 2) return this.#failRun(active, 'MODEL_REQUIRED_TOOL_MISSING',
          'Model did not submit the required operation; no result was saved', true);
        requireToolOnContinuation = true;
        messages.push({ role: 'user', content: `尚未执行所需操作，不能以道歉、承诺或完成说明结束。请调用当前可用工具（${tools.map(tool => tool.name).join('、')}）中符合本轮任务的工具，提交完整合法参数；不要调用未提供的工具，不要重新生成已保存的阶段。` });
        continue executionLoop;
      }
      if (attempt && attempt.completedToolCalls.length > 0) requireToolOnContinuation = false;

      if (attempt === null) {
        return this.#failRun(
          active,
          "MODEL_TERMINAL_MISSING",
          "Model attempt was not collected",
          false,
        );
      }
      const textOutputTool = policy?.textOutputTool;
      const harnessTextOutput = attempt.finishReason === 'stop' && textOutputTool !== undefined;
      const calls: readonly CompletedToolCall[] = harnessTextOutput
        ? [{ id: `text-output:${requestId}`, name: textOutputTool.name,
            rawArguments: canonicalJson({ ...textOutputTool.arguments, [textOutputTool.contentArgument]: attempt.text }),
            arguments: { ...textOutputTool.arguments, [textOutputTool.contentArgument]: attempt.text } }]
        : attempt.completedToolCalls;
      if (attempt.finishReason === "tool_calls" || harnessTextOutput) {
        messages.push({
          role: "assistant",
          content: attempt.text,
          ...(harnessTextOutput ? {} : { toolCalls: calls }),
        });
        for (const call of calls) {
          if (this.#sessions.getRun(runId)?.status === "cancelled") {
            return this.#cancelledResult(active);
          }
          const operationId = this.#idFactory();
          const effect = this.#tools.effectFor(call.name) ?? "external_side_effect";
          this.#sessions.prepareRuntimeOperation({
            operationId,
            projectId,
            runId,
            kind: "tool_call",
            effect,
            input: {
              requestId,
              callId: call.id,
              toolName: call.name,
              arguments: call.arguments,
              ...(harnessTextOutput ? { origin: 'harness_text_output' } : {}),
            },
          });
          const dispatched = this.#sessions.dispatchRuntimeOperation({
            operationId,
            projectId,
            runId,
            eventType: "tool.requested",
            eventPayload: {
              ...(policy?.actor ? { actor: policy.actor } : {}),
              ...(policy?.outputPreview ? { previewId: policy.outputPreview.id } : {}),
              requestId,
              callId: call.id,
              toolName: call.name,
              arguments: call.arguments,
              ...(harnessTextOutput ? { origin: 'harness_text_output' } : {}),
            },
            budgetUse: { toolCalls: 1 },
          });
          if (!dispatched.dispatched) return this.#budgetResult(active);
          const currentPolicy = this.#requestPolicy?.(runId);
          const allowed = policy === undefined || (
            policy.scopeId === currentPolicy?.scopeId && policy.allowedTools.includes(call.name) &&
            (policy.authorizeTool?.(call) ?? true)
          );
          const result: ToolExecutionResult = allowed ? await this.#tools.execute(call, {
            projectId,
            runId,
            operationId,
            abortSignal: active.controller.signal,
            expectedBodyVersionId: policy?.expectedBodyVersionId === undefined ? input.expectedBodyVersionId : policy.expectedBodyVersionId,
            permissionGrant,
          }) : { ok: false, operationId, runId, toolName: call.name, callId: call.id, error: { code: "TOOL_PERMISSION_DENIED", message: "Tool or target is outside this actor's assigned scope", retryable: false, details: {} } };
          if (this.#sessions.getRun(runId)?.status === "budget_exhausted") {
            return this.#budgetResult(active);
          }
          if (this.#sessions.getRun(runId)?.status === "cancelled") {
            return this.#cancelledResult(active);
          }
          if (isUnknownExternalToolOutcome(effect, result)) {
            this.#sessions.settleRuntimeOperation({
              operationId,
              projectId,
              runId,
              state: "unknown_outcome",
              eventType: "tool.outcome_unknown",
              eventPayload: { requestId, callId: call.id, result },
              error: jsonValue(result),
            });
            return this.#unknownOutcomeResult(active);
          }
          this.#sessions.settleRuntimeOperation({
            operationId,
            projectId,
            runId,
            state: result.ok ? "completed" : "failed",
            eventType: result.ok ? "tool.completed" : "tool.failed",
            eventPayload: { requestId, callId: call.id, result },
            ...(result.ok
              ? { result: jsonValue(result) }
              : { error: jsonValue(result) }),
          });
          if (harnessTextOutput && !result.ok) {
            textSaveFailures++;
            const failureKey = `${result.error.code}:${contentHash(attempt.text.trim())}`;
            const repeated = rejectedTextHashes.has(failureKey);
            rejectedTextHashes.add(failureKey);
            // Local validation feedback is not a provider retry. Bound it per
            // expert assignment, independently of the much larger run budget.
            if (repeated || textSaveFailures >= 3) {
              this.#sessions.pauseRun({ projectId, runId, operationId: this.#idFactory(), reason: 'STAGE_OUTPUT_NOT_SAVED',
                payload: { actor: policy?.actor, validationCode: result.error.code, rejectedAttempts: textSaveFailures } });
              return { ok: false, ...this.#facts(active), error: { code: 'STAGE_OUTPUT_NOT_SAVED',
                message: 'Automatic regeneration stopped after repeated local save rejection; the saved manuscript is unchanged', retryable: true } };
            }
          }
          if (!harnessTextOutput && !result.ok) {
            const failureKey = `${call.name}:${result.error.code}`;
            const failures = (toolFailureCounts.get(failureKey) ?? 0) + 1;
            toolFailureCounts.set(failureKey, failures);
            // A gate rejection that keeps repeating cannot be fixed by another
            // blind resubmit; pause instead of burning more model round-trips.
            if (failures >= 3) {
              this.#sessions.pauseRun({ projectId, runId, operationId: this.#idFactory(), reason: 'TOOL_FAILURE_LOOP',
                payload: { actor: policy?.actor, tool: call.name, validationCode: result.error.code, attempts: failures } });
              return { ok: false, ...this.#facts(active), error: { code: 'TOOL_FAILURE_LOOP',
                message: `${call.name} failed ${failures} times with ${result.error.code}; automatic retry stopped`, retryable: true } };
            }
          }
          const pause = result.ok ? this.#pauseAfterTool(result) : null;
          if (pause !== null) {
            this.#sessions.pauseRun({
              projectId,
              runId,
              operationId: this.#idFactory(),
              reason: pause.reason,
              ...(pause.payload === undefined ? {} : { payload: pause.payload }),
            });
            return this.#waitingUserResult(active);
          }
          const completion = result.ok ? this.#completeAfterTool(result) : null;
          if (completion !== null) {
            return this.#completeRun(active, snapshotId, completion.content, completion.artifactVersionId);
          }
          // Do not invent a model tool call in the conversation. A failed local
          // save is feedback to this same expert; successful stages change scope.
          if (harnessTextOutput) messages.push({ role: 'user', content: `程序保存结果（不是作者确认）：${canonicalJson(result)}。失败时根据校验反馈重新完整输出本阶段文本，不输出工具参数。` });
          else messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content: canonicalJson(result),
          });
        }
        continue;
      }

      if (attempt.finishReason !== "stop") {
        return this.#failRun(
          active,
          `MODEL_${attempt.finishReason?.toUpperCase() ?? "UNKNOWN"}`,
          `Model stopped with ${String(attempt.finishReason)}`,
          false,
        );
      }
      if (this.#sessions.getRun(runId)?.status === "cancelled") {
        return this.#cancelledResult(active);
      }

      let artifactVersionId: string | null = null;
      if (this.#finalOutputCommitter !== undefined) {
        try {
          const committed = await this.#finalOutputCommitter.commit({
            projectId,
            sessionId,
            runId,
            requestSnapshotId: snapshotId,
            content: attempt.text,
          });
          artifactVersionId = committed.artifactVersionId;
        } catch (error) {
          if (error instanceof FinalOutputContinuationRequiredError) {
            requireToolOnContinuation = policy?.outputPreview !== undefined;
            messages.push({ role: "assistant", content: attempt.text });
            messages.push({ role: "user", content: error.instruction });
            continue;
          }
          return this.#failRun(
            active,
            "FINAL_OUTPUT_COMMIT_FAILED",
            "Final model output could not be committed",
            true,
          );
        }
      }
      return this.#completeRun(active, snapshotId, attempt.text, artifactVersionId);
    }
  }
}
