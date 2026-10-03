import type {
  ArtifactKind,
  ArtifactVersion,
  FactClaim,
  JsonValue,
  MutationResult,
  ProjectMode,
  StoragePort,
} from "../../writing-core/src/index.js";
import type { RunRecord } from "../../runtime/session/src/index.js";
import {
  workflowStageSequence,
  type WritingWorkflowStage,
} from "../../writing-pack/src/index.js";
import {
  ToolExecutionFault,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../../runtime/tools/src/index.js";

// The workflow layer needs run history for cross-run stage carry-over; the
// concrete workspace storage implements both ports.
type WorkflowStorage = StoragePort & {
  getRun(runId: string): RunRecord | null;
  listRuns(projectId: string, sessionId?: string): RunRecord[];
};

type ContentStage = Exclude<WritingWorkflowStage, "fact_check">;
import { FactClaimStatusSchema, FactClaimTypeSchema, parseEvidenceLedger } from '../../writing-core/src/index.js';
import { isPublicationSelectionCurrent } from './publication-choice.js';
type BodyStage = Extract<ContentStage, "draft" | "central_revision" | "language_review">;

interface SubmitWritingStageArgs {
  readonly stage: ContentStage;
  readonly content: string;
}

interface SubmitFactCheckArgs {
  readonly claims: readonly FactClaim[];
  readonly noFactualClaimsReason: string;
}

interface AssessWritingReadinessArgs {
  readonly status: "ready" | "needs_input";
  readonly reason: string;
  readonly questions: readonly string[];
}

export function assertBusinessInputQuestions(reason: string, questions: readonly string[]): void {
  if (/(?:COLLABORATION_STATE|inputVersionIds|contentVersionId|artifactVersionId|UUID)/iu.test([reason, ...questions].join("\n"))) {
    throw new ToolExecutionFault("INTERNAL_METADATA_NOT_USER_GAP",
      "Internal runtime IDs are not missing writing material. The runtime binds input versions automatically; an empty research artifact list is valid. Ask users only about actual writing scope or evidence, never tool metadata.");
  }
}

export interface WritingWorkflowCompletion {
  readonly complete: boolean;
  readonly bodyVersionId: string | null;
  readonly publicationReady: boolean;
}

export interface WritingWorkflowTools {
  pendingCheckpoint(runId: string): { stage: string; nextStage: string; markerId: string; requiredArtifactVersionIds: string[] } | null;
  recoverConfirmedBody(runId: string): string | null;
  readonly definitions: readonly ToolDefinition<never, JsonValue>[];
  isReady(runId: string): boolean;
  unreadReadinessArtifactIds(runId: string): readonly string[];
  invalidate(context: ToolExecutionContext, stage: WritingWorkflowStage): readonly WritingWorkflowStage[];
  progress(runId: string): {
    readonly completedStages: readonly WritingWorkflowStage[];
    readonly nextStage: WritingWorkflowStage | null;
  };
  continuationContext(runId: string): {
    readonly nextStage: WritingWorkflowStage | null;
    readonly artifacts: readonly {
      readonly stage: WritingWorkflowStage | "current_body";
      readonly artifactVersionId: string;
    }[];
  };
  completion(runId: string): WritingWorkflowCompletion;
}

const CO_CREATION_CHECKPOINT_STAGES = new Set<ContentStage>([
  "outline",
  "draft",
  "review_editor",
  "review_publish",
  "review_reader",
  "central_revision",
  "language_review",
]);

function value<T>(result: MutationResult<T>): T {
  if (result.ok) return result.result;
  throw new ToolExecutionFault(result.code, result.message, result.retryable, {
    operationId: result.operationId,
  });
}

function markerKey(runId: string, stage: WritingWorkflowStage): string {
  return `workflow:${runId}:${stage}`;
}

function stageMarker(
  storage: StoragePort,
  projectId: string,
  runId: string,
  stage: WritingWorkflowStage,
): ArtifactVersion | null {
  const invalidated = new Set(storage.listArtifactVersions(projectId, "report", `workflow-invalidated:${runId}`)
    .flatMap((version) => { try { return JSON.parse(version.content).markerIds as string[]; } catch { return []; } }));
  return storage
    .listArtifactVersions(projectId, "report", markerKey(runId, stage))
    .filter((version) => !invalidated.has(version.id)).reverse().find(
      (version) =>
        version.actor.kind === "agent" && version.actor.runId === runId,
    ) ?? null;
}

function expectedStage(
  storage: StoragePort,
  projectId: string,
  runId: string,
  mode: ProjectMode,
): WritingWorkflowStage | null {
  return workflowStageSequence(mode).find(
    (stage) => stageMarker(storage, projectId, runId, stage) === null || (stage === "fact_check" && storage.getFactCheckStatus(projectId).status !== "passed"),
  ) ?? null;
}

function assertExpectedStage(
  storage: StoragePort,
  context: ToolExecutionContext,
  mode: ProjectMode,
  received: WritingWorkflowStage,
): void {
  const expected = expectedStage(
    storage,
    context.projectId,
    context.runId,
    mode,
  );
  if (expected === null) {
    throw new ToolExecutionFault(
      "WORKFLOW_ALREADY_COMPLETE",
      "All writing workflow stages have already been submitted",
    );
  }
  if (received !== expected) {
    throw new ToolExecutionFault(
      "WORKFLOW_STAGE_OUT_OF_ORDER",
      `Expected ${expected} before ${received}`,
      false,
      { expected, received },
    );
  }
}

function actor(stage: WritingWorkflowStage, runId: string) {
  const id = stage.startsWith("review_")
    ? `writing-pack/${stage}`
    : stage === "research" || stage === "fact_check"
      ? "writing-pack/researcher"
      : "writing-pack/writer";
  return { kind: "agent" as const, id, runId };
}

function logicalKey(stage: ContentStage, runId: string): string {
  if (stage.startsWith("review_")) return `${stage}:${runId}`;
  return "main";
}

function artifactKind(stage: ContentStage): ArtifactKind {
  if (stage === "research") return "evidence";
  if (stage === "outline") return "outline";
  if (stage.startsWith("review_")) return "review";
  return "body";
}

/** Legacy body versions can contain an explicit postscript. Use only the article
 * for shape comparison; never rewrite the stored version or drop prose silently. */
export function bodyArticleBaseline(content: string): string {
  const marker = /\n\s*\n(?:#{1,6}\s+|\*\*)(?:改动说明|修改说明|修订说明|润色说明|审校结论)(?:[（(:：\s]|\*\*|$)/u.exec(content);
  return (marker ? content.slice(0, marker.index).replace(/\n\s*(?:---|\*\*\*)\s*$/u, '') : content).trim();
}

export function assertCleanBodyStageContent(stage: BodyStage, content: string, boundBody?: string): void {
  const normalized = content.trim();
  const baseline = boundBody === undefined ? undefined : bodyArticleBaseline(boundBody);
  const containsProcessPostscript = bodyArticleBaseline(normalized) !== normalized;
  if (stage === "language_review" && baseline === normalized && !containsProcessPostscript) return;
  const firstLine = normalized.split(/\r?\n/u, 1)[0] ?? "";
  const startsWithProcessHeading = /^#{1,6}\s*(?:语言终审|语言审校|最终审校|集中修订说明|修订说明|编辑说明|初稿说明)(?:\s|$)/u.test(firstLine);
  const includesWrappedArticleMarker = /(?:终稿|正文)(?:与[^\n]{0,40})?(?:如下|如下所示)|以下(?:是|为)(?:最终)?(?:正文|终稿)/u.test(
    normalized.slice(0, 1_000),
  );
  const startsWithReviewAssessment = /^(?:#{1,6}\s*)?(?:本稿|该稿|此稿|当前稿件|原稿)(?:的)?(?:语言|结构|表达|节奏|文字|整体|底子)/u.test(firstLine);
  const startsWithReviewStatus = /^(?:审校|润色|修订)(?:已)?完成[。！!\s]*$/u.test(firstLine);
  const containsReviewRecommendations = /建议优先处理|整体可保留|审校意见|修改建议|建议保留[：:]/u.test(normalized.slice(0, 1_000));
  const standaloneReviewConclusion = !normalized.includes("\n") && /^(?:无需(?:修改|调整)|整体表达|未发现明显问题|没有需要(?:修改|调整))/u.test(normalized);
  const headings = (text: string) => text.split(/\r?\n/u).filter((line) => /^#{1,6}\s/u.test(line)).map((line) => line.trim());
  const changedArticleShape = stage === "language_review" && baseline !== undefined && (
    normalized.length < baseline.length * 0.65 ||
    JSON.stringify(headings(normalized)) !== JSON.stringify(headings(baseline))
  );
  if (!startsWithProcessHeading && !startsWithReviewStatus && !includesWrappedArticleMarker && !(startsWithReviewAssessment && containsReviewRecommendations) && !standaloneReviewConclusion && !containsProcessPostscript) {
    if (!changedArticleShape) return;
    throw new ToolExecutionFault('BODY_STAGE_STRUCTURE_MISMATCH', 'Return the complete article with its existing headings; the response removed a heading or too much article text', false, {
      stage, requiredHeadings: headings(baseline!), minimumCharacters: Math.ceil(baseline!.length * 0.65),
      correction: 'Preserve these exact Markdown headings and return the complete article, not just paragraphs. Remove any legacy postscript change notes; those notes are not part of article length. Do not rewrite an unchanged response.',
    });
  }
  throw new ToolExecutionFault(
    "BODY_STAGE_CONTAINS_PROCESS_NOTES",
    "Body stages must contain the complete article only, without review conclusions or process notes",
    false,
    {
      stage,
      correction:
        "Resubmit only the complete Markdown article. Start with the real article title; omit conclusions, rationale, change lists, and phrases such as 'final article below'.",
    },
  );
}

function evidenceLedgerContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { claims?: unknown }).claims)
    ) {
      // Persist only what the fact-check gate can later accept; rejecting here
      // lets the research expert fix the ledger while it still owns it.
      parseEvidenceLedger(JSON.stringify(parsed));
      return JSON.stringify(parsed);
    }
    return JSON.stringify({ claims: [], notes: content.trim() });
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Free-form research notes remain useful, but they do not become evidence
      // claims implicitly. The fact gate will therefore reject any unsupported
      // factual claims instead of treating prose notes as verified evidence.
      return JSON.stringify({ claims: [], notes: content.trim() });
    }
    throw new ToolExecutionFault(
      "EVIDENCE_LEDGER_INVALID",
      "The evidence ledger does not satisfy the persisted contract",
      true,
      {
        correction:
          "Every claim needs all required fields as non-empty strings: evidence_id (unique E001/E002...), claim_type, claim_text, source_title, source_publisher, source_quote, accessed_at, reliability (high/medium/low), use_boundary, verification_status. Only entries marked verification_status='illustrative' may leave source_quote as an empty string. source_url, when present, must be an http(s) URL. Resubmit the complete corrected ledger JSON.",
      },
    );
  }
}

export function evidenceIdsFromLedger(content: string): readonly string[] {
  try {
    const parsed = JSON.parse(content) as { readonly claims?: readonly unknown[] };
    if (!Array.isArray(parsed.claims)) return [];
    return parsed.claims.flatMap((claim) => {
      if (claim === null || typeof claim !== "object" || Array.isArray(claim)) return [];
      const evidenceId = (claim as { readonly evidence_id?: unknown }).evidence_id;
      return typeof evidenceId === "string" && /^E\d{3,}$/u.test(evidenceId)
        ? [evidenceId]
        : [];
    });
  } catch {
    return [];
  }
}

interface WorkflowStageMarkerPayload {
  readonly schemaVersion: "writing-workflow-stage-v1";
  readonly runId: string;
  readonly stage: WritingWorkflowStage;
  readonly artifactVersionId: string;
}

interface WritingReviewEnvelope {
  readonly schemaVersion: "writing-review-v1";
  readonly reviewType: Extract<ContentStage, `review_${string}`>;
  readonly runId: string;
  readonly bodyVersionId: string;
  readonly content: string;
}

function markerPayload(marker: ArtifactVersion | null): WorkflowStageMarkerPayload | null {
  if (marker === null) return null;
  try {
    const payload = JSON.parse(marker.content) as Partial<WorkflowStageMarkerPayload>;
    if (
      payload.schemaVersion !== "writing-workflow-stage-v1" ||
      typeof payload.runId !== "string" ||
      typeof payload.stage !== "string" ||
      typeof payload.artifactVersionId !== "string"
    ) {
      return null;
    }
    return payload as WorkflowStageMarkerPayload;
  } catch {
    return null;
  }
}

function continuationContextStages(
  nextStage: WritingWorkflowStage | null,
  mode: ProjectMode,
): readonly WritingWorkflowStage[] {
  if (nextStage === null || nextStage === "research") return [];
  if (nextStage === "outline") return ["research"];
  if (nextStage === "draft") return ["research", "outline"];
  if (
    nextStage === "review_editor" ||
    nextStage === "review_publish" ||
    nextStage === "review_reader"
  ) {
    return ["research", "draft"];
  }
  if (nextStage === "central_revision") {
    return [
      "research",
      "draft",
      ...workflowStageSequence(mode).filter((stage) => stage.startsWith("review_")),
    ];
  }
  if (nextStage === "language_review") return ["research", "central_revision"];
  return ["research", "language_review"];
}

function continuationContextArtifacts(
  storage: StoragePort,
  projectId: string,
  runId: string,
  mode: ProjectMode,
  nextStage: WritingWorkflowStage | null,
): readonly { readonly stage: WritingWorkflowStage; readonly artifactVersionId: string }[] {
  if (nextStage === "central_revision") {
    const rework = storage.listArtifactVersions(projectId, "report", `workflow-invalidated:${runId}`).at(-1);
    const binding = rework === undefined ? null : JSON.parse(rework.content).revisionInput;
    if (binding?.bodyVersionId) {
      const research = markerPayload(stageMarker(storage, projectId, runId, "research"));
      return [
        ...(research === null ? [] : [{ stage: "research" as const, artifactVersionId: research.artifactVersionId }]),
        { stage: "language_review", artifactVersionId: binding.bodyVersionId },
        { stage: "fact_check", artifactVersionId: rework!.id },
      ];
    }
  }
  if (nextStage === "fact_check") {
    const project = storage.inspectProject(projectId);
    return [
      ...(project?.currentEvidenceVersionId ? [{ stage: "research" as const, artifactVersionId: project.currentEvidenceVersionId }] : []),
      ...(project?.latestBodyVersionId ? [{ stage: "language_review" as const, artifactVersionId: project.latestBodyVersionId }] : []),
    ];
  }
  const artifacts: Array<{ stage: WritingWorkflowStage; artifactVersionId: string }> = [];
  const seen = new Set<string>();
  for (const stage of continuationContextStages(nextStage, mode)) {
    const marker = markerPayload(stageMarker(storage, projectId, runId, stage));
    if (marker === null || seen.has(marker.artifactVersionId)) continue;
    seen.add(marker.artifactVersionId);
    artifacts.push({ stage, artifactVersionId: marker.artifactVersionId });
  }
  return artifacts;
}

function draftVersionForReview(
  storage: StoragePort,
  context: ToolExecutionContext,
  requireCurrentDraft = true,
): string {
  const draftMarker = markerPayload(
    stageMarker(storage, context.projectId, context.runId, "draft"),
  );
  if (draftMarker === null) {
    throw new ToolExecutionFault(
      "REVIEW_DRAFT_MISSING",
      "A persisted draft is required before independent review",
    );
  }
  const draft = storage.getArtifactVersion(draftMarker.artifactVersionId);
  if (draft === null || draft.kind !== "body") {
    throw new ToolExecutionFault(
      "REVIEW_DRAFT_MISSING",
      "The draft bound to this workflow could not be read",
    );
  }
  const project = storage.inspectProject(context.projectId);
  if (requireCurrentDraft && project?.latestBodyVersionId !== draft.id) {
    throw new ToolExecutionFault(
      "REVIEW_DRAFT_CHANGED",
      "The body changed after the workflow draft was saved; start a new run before reviewing",
    );
  }
  return draft.id;
}

function reviewEnvelopeContent(
  storage: StoragePort,
  context: ToolExecutionContext,
  stage: Extract<ContentStage, `review_${string}`>,
  content: string,
): string {
  const envelope: WritingReviewEnvelope = {
    schemaVersion: "writing-review-v1",
    reviewType: stage,
    runId: context.runId,
    bodyVersionId: draftVersionForReview(storage, context),
    content: content.trim(),
  };
  return JSON.stringify(envelope);
}

function assertReviewsBoundToDraft(
  storage: StoragePort,
  context: ToolExecutionContext,
  mode: ProjectMode,
): void {
  // Review reports remain bound to their original draft. A later authorized
  // central rework reads the current body; its write is guarded by assignment CAS.
  const draftVersionId = draftVersionForReview(storage, context, false);
  const reviewStages = workflowStageSequence(mode).filter(
    (stage): stage is Extract<ContentStage, `review_${string}`> =>
      stage.startsWith("review_"),
  );
  for (const stage of reviewStages) {
    const marker = markerPayload(
      stageMarker(storage, context.projectId, context.runId, stage),
    );
    const review = marker === null
      ? null
      : storage.getArtifactVersion(marker.artifactVersionId);
    if (review === null || review.kind !== "review") {
      throw new ToolExecutionFault(
        "REVIEW_BINDING_MISSING",
        `${stage} must be persisted before central revision`,
      );
    }
    try {
      const envelope = JSON.parse(review.content) as Partial<WritingReviewEnvelope>;
      if (
        envelope.schemaVersion !== "writing-review-v1" ||
        envelope.reviewType !== stage ||
        typeof envelope.runId !== "string" ||
        review.actor.kind !== "agent" ||
        review.actor.runId !== envelope.runId ||
        review.logicalKey !== `${stage}:${envelope.runId}` ||
        envelope.bodyVersionId !== draftVersionId ||
        typeof envelope.content !== "string" ||
        envelope.content.trim().length === 0
      ) {
        throw new Error("invalid review binding");
      }
    } catch {
      throw new ToolExecutionFault(
        "REVIEW_BINDING_INVALID",
        `${stage} is not bound to the workflow draft`,
      );
    }
  }
}

function commitStageArtifact(
  storage: StoragePort,
  context: ToolExecutionContext,
  stage: ContentStage,
  content: string,
): ArtifactVersion {
  const project = storage.inspectProject(context.projectId);
  if (project === null) {
    throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
  }
  const kind = artifactKind(stage);
  const key = logicalKey(stage, context.runId);
  const persistedContent = stage === "research"
    ? evidenceLedgerContent(content)
    : stage.startsWith("review_")
      ? reviewEnvelopeContent(
          storage,
          context,
          stage as Extract<ContentStage, `review_${string}`>,
          content,
        )
      : content;
  const baseVersionId = kind === "body"
    ? context.expectedBodyVersionId
    : kind === "evidence"
      ? project.currentEvidenceVersionId
      : storage.listArtifactVersions(context.projectId, kind, key).at(-1)?.id ?? null;
  const prior = storage.listArtifactVersions(context.projectId, kind, key).find((version) => version.operationId === `${context.operationId}:artifact`);
  if (prior !== undefined) {
    if (prior.content !== persistedContent) throw new ToolExecutionFault("IDEMPOTENCY_CONFLICT", "The submitted artifact differs from this operation's committed result");
    return prior;
  }
  const committed = storage.commitArtifactVersion({
    operationId: `${context.operationId}:artifact`,
    projectId: context.projectId,
    expectedProjectRevision: project.revision,
    kind,
    logicalKey: key,
    baseVersionId,
    content: persistedContent,
    reason: `workflow:${stage}`,
    requestSnapshotId: null,
    actor: actor(stage, context.runId),
  });
  const committedValue = value(committed);
  const version = storage.getArtifactVersion(committedValue.versionId);
  if (version === null) {
    throw new ToolExecutionFault(
      "WORKFLOW_ARTIFACT_MISSING",
      "Submitted workflow artifact could not be read back",
    );
  }
  return version;
}

function markStage(
  storage: StoragePort,
  context: ToolExecutionContext,
  stage: WritingWorkflowStage,
  artifactVersionId: string,
  reason?: string,
  carriedDecision?: string,
): void {
  const project = storage.inspectProject(context.projectId);
  if (project === null) {
    throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
  }
  value(storage.commitArtifactVersion({
    operationId: `${context.operationId}:marker`,
    projectId: context.projectId,
    expectedProjectRevision: project.revision,
    kind: "report",
    logicalKey: markerKey(context.runId, stage),
    baseVersionId: storage.listArtifactVersions(context.projectId, "report", markerKey(context.runId, stage)).at(-1)?.id ?? null,
    content: JSON.stringify({
      schemaVersion: "writing-workflow-stage-v1",
      runId: context.runId,
      stage,
      artifactVersionId,
      ...(carriedDecision ? { carriedDecision } : {}),
    }),
    reason: reason ?? `workflow-stage-complete:${stage}`,
    requestSnapshotId: null,
    actor: actor(stage, context.runId),
  }));
}

// A run that died mid-pipeline keeps its stage markers. A brand-new run in
// the same session carries the dead run's contiguous completed prefix (with
// the same stage output versions) so the director continues at nextStage
// instead of restarting research→outline→draft on an already-written body.
// Carried markers are this run's own artifacts: rework/invalidation and all
// downstream CAS checks apply to them exactly like freshly earned markers.
const CARRY_SOURCE_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled", "interrupted"]);

interface ConfirmedCheckpointDecision {
  readonly intent: "approve_checkpoint" | "revise_checkpoint";
  readonly bodyVersionId: string | null;
  readonly receiptId: string;
  readonly resumeEventId: string;
  readonly instruction: string;
}

function confirmedCheckpointDecision(
  storage: WorkflowStorage,
  marker: ArtifactVersion,
): ConfirmedCheckpointDecision | null {
  let markerData: any;
  try { markerData = JSON.parse(marker.content); } catch { return null; }
  const run = storage.getRun(markerData.runId);
  if (!run || run.projectId !== marker.projectId) return null;
  const events = storage.listEvents(marker.projectId).filter(event => event.runId === run.id);
  const resumes = events.filter(event => event.type === "run.resumed" && event.payload.decision === "resume" &&
    event.projectSeq > marker.createdEventSeq).reverse();
  for (const resumed of resumes) {
    const explicit = resumed.payload.checkpointDecision as { markerId?: unknown; intent?: unknown; receiptId?: unknown } | undefined;
    if (explicit?.markerId !== undefined && explicit.markerId !== marker.id) continue;
    const wait = events.findLast(event => event.type === "run.waiting_user" &&
      event.projectSeq > marker.createdEventSeq && event.projectSeq < resumed.projectSeq &&
      event.payload.stage === markerData.stage && event.payload.stopReason === "CO_CREATION_CHECKPOINT");
    if (!wait) continue;
    const receiptCandidates = typeof explicit?.receiptId === "string"
      ? [storage.getArtifactVersion(explicit.receiptId)]
      : storage.listRuns(marker.projectId, run.sessionId).flatMap(candidate =>
          storage.listArtifactVersions(marker.projectId, "report", `author-intent:${candidate.id}`));
    for (const receipt of receiptCandidates) {
      if (!receipt || receipt.reason !== "contextual-author-intent" || receipt.createdEventSeq >= resumed.projectSeq) continue;
      try {
        const data = JSON.parse(receipt.content);
        const intent = data.intent as unknown;
        const sourceRun = storage.getRun(data.sourceRunId);
        if ((intent !== "approve_checkpoint" && intent !== "revise_checkpoint") ||
          (explicit?.intent !== undefined && explicit.intent !== intent) ||
          data.checkpoint?.runId !== run.id || data.checkpoint?.eventSeq !== wait.projectSeq ||
          data.sessionId !== run.sessionId || data.userMessage !== resumed.payload.displayInstruction ||
          (data.bodyVersionId !== null && typeof data.bodyVersionId !== "string") || sourceRun?.projectId !== marker.projectId ||
          sourceRun.sessionId !== run.sessionId || sourceRun.status !== "completed") continue;
        return { intent, bodyVersionId: data.bodyVersionId, receiptId: receipt.id, resumeEventId: resumed.id,
          instruction: data.userMessage };
      } catch { /* Ignore malformed legacy receipts. */ }
    }
  }
  return null;
}

function stageDecision(storage: WorkflowStorage, marker: ArtifactVersion): string | null {
  const data = JSON.parse(marker.content);
  return confirmedCheckpointDecision(storage, marker)?.intent ?? data.carriedDecision ?? null;
}

interface CarriedReworkPayload {
  readonly schemaVersion: "writing-carried-rework-v1";
  readonly stage: WritingWorkflowStage;
  readonly instruction: string;
  readonly receiptId: string;
  readonly sourceMarkerId: string;
  readonly sourceRunId: string;
}

function carriedRework(
  storage: StoragePort,
  projectId: string,
  runId: string,
): { artifact: ArtifactVersion; payload: CarriedReworkPayload } | null {
  const artifact = storage.listArtifactVersions(projectId, "report", `workflow-carried-rework:${runId}`).at(-1);
  if (!artifact) return null;
  try {
    const payload = JSON.parse(artifact.content) as Partial<CarriedReworkPayload>;
    if (payload.schemaVersion !== "writing-carried-rework-v1" || typeof payload.stage !== "string" ||
      typeof payload.instruction !== "string" || !payload.instruction.trim() || typeof payload.receiptId !== "string" ||
      typeof payload.sourceMarkerId !== "string" || typeof payload.sourceRunId !== "string") return null;
    return { artifact, payload: payload as CarriedReworkPayload };
  } catch { return null; }
}

/** Saved work is not permission to advance. Reconstruct every checkpoint, including a crash before pauseRun. */
export function pendingStageCheckpoint(storage: WorkflowStorage, projectId: string, runId: string) {
  const project = storage.inspectProject(projectId)!;
  const brief = project.currentBriefVersionId && storage.getWritingBriefVersion(project.currentBriefVersionId)?.brief;
  if (!brief || brief.interactionMode !== 'co_creation') return null;
  const sequence = workflowStageSequence(project.mode);
  for (const [index, stage] of sequence.entries()) {
    const marker = stageMarker(storage, projectId, runId, stage);
    if (!marker) break;
    if (!CO_CREATION_CHECKPOINT_STAGES.has(stage as ContentStage) || !sequence[index + 1]) continue;
    if (stageDecision(storage, marker)) continue;
    return { stage, nextStage: sequence[index + 1]!, markerId: marker.id, requiredArtifactVersionIds: [] as string[] };
  }
  return null;
}

function seedCarriedStageMarkers(
  storage: WorkflowStorage,
  projectId: string,
  runId: string,
  mode: ProjectMode,
): void {
  const run = storage.getRun(runId);
  if (run === null) return;
  const sequence = workflowStageSequence(mode);
  // Own progress (or an earlier seeding) already exists: nothing to carry.
  if (sequence.some((stage) => stageMarker(storage, projectId, runId, stage) !== null)) return;
  const source = storage
    .listRuns(projectId, run.sessionId)
    .filter((candidate) =>
      candidate.id !== runId &&
      candidate.createdAt < run.createdAt &&
      CARRY_SOURCE_STATUSES.has(candidate.status))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .find((candidate) =>
      sequence.some((stage) => stageMarker(storage, projectId, candidate.id, stage) !== null));
  if (source === undefined) return;
  const inheritedRework = carriedRework(storage, projectId, source.id)?.payload ?? null;
  let explicitRework: CarriedReworkPayload | null = null;
  for (const stage of sequence) {
    const marker = stageMarker(storage, projectId, source.id, stage);
    if (!marker) break;
    const decision = confirmedCheckpointDecision(storage, marker);
    if (decision?.intent === "revise_checkpoint") {
      explicitRework = { schemaVersion: "writing-carried-rework-v1", stage, instruction: decision.instruction,
        receiptId: decision.receiptId, sourceMarkerId: marker.id, sourceRunId: source.id };
      break;
    }
  }
  const rework = explicitRework ?? inheritedRework;
  const rebuiltMarker = rework ? stageMarker(storage, projectId, source.id, rework.stage) : null;
  // A new explicit revise invalidates the marker it answered. An inherited
  // instruction is still pending only while no replacement marker exists.
  const reworkPendingExecution = rework !== null && (explicitRework !== null || rebuiltMarker === null);
  const rebuiltDecision = rebuiltMarker ? stageDecision(storage, rebuiltMarker) : null;
  const preserveRework = rework !== null && (reworkPendingExecution || rebuiltDecision !== "approve_checkpoint");
  if (preserveRework) {
    const project = storage.inspectProject(projectId)!;
    const saved = storage.commitArtifactVersion({ operationId: `carry:${runId}:rework`, projectId,
      expectedProjectRevision: project.revision, kind: "report", logicalKey: `workflow-carried-rework:${runId}`,
      baseVersionId: null, content: JSON.stringify(rework), reason: "workflow-carried-rework",
      requestSnapshotId: null, actor: { kind: "agent", id: "writing-pack/director", runId } });
    if (!saved.ok) return; // Never carry past a revision request that was not durably preserved.
  }
  for (const stage of sequence) {
    // fact_check completion stays with the project-level gate; never carried.
    if (stage === "fact_check") continue;
    const marker = stageMarker(storage, projectId, source.id, stage);
    if (marker === null) break; // contiguous prefix only
    if (reworkPendingExecution && rework?.stage === stage) break;
    let artifactVersionId: unknown;
    try {
      artifactVersionId = (JSON.parse(marker.content) as { artifactVersionId?: unknown }).artifactVersionId;
    } catch {
      break;
    }
    if (typeof artifactVersionId !== "string" || artifactVersionId.length === 0) break;
    try {
      markStage(
        storage,
        { operationId: `carry:${runId}:${stage}`, projectId, runId } as ToolExecutionContext,
        stage,
        artifactVersionId,
        `workflow-stage-carried:${stage}`,
        stageDecision(storage, marker) === "approve_checkpoint" ? "approve_checkpoint" : undefined,
      );
    } catch {
      break; // a partial carry still forms a valid contiguous prefix
    }
  }
}

function titleFromBody(content: string): string {
  const heading = content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/u.test(line));
  if (heading !== undefined) return heading.replace(/^#{1,6}\s+/u, "").trim();
  const firstLine = content.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
  return firstLine?.slice(0, 80) ?? "未命名稿件";
}

const WRITING_STAGE_SCHEMA = {
  type: "object",
  properties: {
    stage: {
      type: "string",
      enum: [
        "research",
        "outline",
        "draft",
        "review_editor",
        "review_publish",
        "review_reader",
        "central_revision",
        "language_review",
      ],
    },
    content: {
      type: "string",
      minLength: 1,
      maxLength: 1_000_000,
      description:
        "Stage output. For research this must be a JSON evidence ledger, never Markdown: claims[].evidence_id uses E001/E002 and each claim includes claim_type, claim_text, source_title, source_publisher, source_quote, accessed_at, reliability, use_boundary, verification_status. Use claims:[] plus non-empty notes when no evidence claim exists. For draft, central_revision, and language_review, submit only the complete Markdown article with its real title; never wrap it in review conclusions, rationale, change lists, or 'final article below' notes.",
    },
  },
  required: ["stage", "content"],
  additionalProperties: false,
} as const;

const WRITING_READINESS_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "needs_input"] },
    reason: { type: "string", minLength: 1, maxLength: 20_000 },
    questions: {
      type: "array",
      maxItems: 2,
      items: { type: "string", minLength: 1, maxLength: 2_000 },
    },
  },
  required: ["status", "reason", "questions"],
  additionalProperties: false,
} as const;

const NULLABLE_STRING_SCHEMA = {
  anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
} as const;

const FACT_CHECK_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      maxItems: 1_000,
      items: {
        type: "object",
        properties: {
          claimId: { type: "string", pattern: "^C[0-9]{3,}$" },
          claimText: { type: "string", minLength: 1 },
          claimType: {
            type: "string",
            enum: FactClaimTypeSchema.options,
          },
          location: { type: "string", minLength: 1 },
          status: {
            type: "string",
            enum: FactClaimStatusSchema.options,
            description: 'Exact uppercase enum. Unverifiable=UNSUPPORTED; missing author evidence=NEEDS_USER_SOURCE. Partial belongs to supportScope, never status. SUPPORTED requires complete evidence. Final passed/blocked is computed by the application.',
          },
          risk: { type: "string", enum: ["red", "yellow", "green"] },
          supportScope: { type: "string", enum: ["full", "partial", "none"] },
          matchedEvidenceId: {
            ...NULLABLE_STRING_SCHEMA,
            description:
              "Exact E### evidence_id from the persisted research ledger. Never use a material ID, version ID, claim ID, or invented ID. Use JSON null if no exact ledger ID exists.",
          },
          sourceReference: {
            ...NULLABLE_STRING_SCHEMA,
            description:
              "Authorized material ID or independently verifiable source locator. Required for SUPPORTED when matchedEvidenceId is null.",
          },
          evidenceSummary: { type: "string", minLength: 1 },
          recommendedAction: { type: "string", minLength: 1 },
        },
        required: [
          "claimId",
          "claimText",
          "claimType",
          "location",
          "status",
          "risk",
          "supportScope",
          "matchedEvidenceId",
          "sourceReference",
          "evidenceSummary",
          "recommendedAction",
        ],
        additionalProperties: false,
      },
    },
    noFactualClaimsReason: { type: "string", maxLength: 20_000 },
  },
  required: ["claims", "noFactualClaimsReason"],
  additionalProperties: false,
} as const;

export function createWritingWorkflowTools(options: {
  readonly storage: WorkflowStorage;
  readonly projectId: string;
  readonly mode: ProjectMode;
  readonly factCheckOnly?: boolean;
  readonly interactionMode?: "autonomous" | "co_creation";
  readonly requiredMaterialIds?: readonly string[];
  readonly completedMaterialIds?: (runId: string) => readonly string[];
  readonly enforceContinuationReads?: boolean;
  readonly requiredInitialArtifactIds?: readonly string[];
  readonly completedArtifactReadIds?: (runId: string) => readonly string[];
}): WritingWorkflowTools {
  const {
    storage,
    projectId,
    mode,
    factCheckOnly = false,
    interactionMode = "autonomous",
    requiredMaterialIds = [],
    completedMaterialIds,
    enforceContinuationReads = false,
    requiredInitialArtifactIds = [],
    completedArtifactReadIds,
  } = options;
  const continuationEntryStageByRun = new Map<string, WritingWorkflowStage | null>();
  const readyInputsByRun = new Map<string, string>();
  const carryCheckedRuns = new Set<string>();
  const seedCarryOnce = (runId: string): void => {
    if (factCheckOnly || carryCheckedRuns.has(runId)) return;
    carryCheckedRuns.add(runId);
    seedCarriedStageMarkers(storage, projectId, runId, mode);
  };
  const initialContextIds = (runId: string): readonly string[] =>
    storage.listArtifactVersions(projectId, "report", markerKey(runId, "draft")).length > 0 ? [] : requiredInitialArtifactIds;
  const carriedReworkInput = (runId: string, stage: WritingWorkflowStage | null) => {
    const rework = carriedRework(storage, projectId, runId);
    return rework && rework.payload.stage === stage ? rework.artifact : null;
  };

  const nextStageForRun = (runId: string): WritingWorkflowStage | null =>
    factCheckOnly
      ? (stageMarker(storage, projectId, runId, "fact_check") === null
          ? "fact_check"
          : null)
      : expectedStage(storage, projectId, runId, mode);

  // Admission belongs to one stage and its exact inputs, not to the whole run.
  // Include markers so rework of the same stage cannot reuse an older approval.
  const readinessKey = (runId: string): string => {
    const project = storage.inspectProject(projectId)!;
    return JSON.stringify({
      nextStage: nextStageForRun(runId),
      brief: project.currentBriefVersionId,
      body: project.latestBodyVersionId,
      title: project.currentTitleVersionId,
      evidence: project.currentEvidenceVersionId,
      materials: storage.listMaterials(projectId).filter(m => requiredMaterialIds.includes(m.id)).map(m => [m.id, m.contentVersionId]),
      stages: workflowStageSequence(mode).map(stage => stageMarker(storage, projectId, runId, stage)?.id ?? null),
      rework: storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${runId}`).at(-1)?.id ?? null,
    });
  };
  const isReady = (runId: string): boolean =>
    nextStageForRun(runId) === null || readyInputsByRun.get(runId) === readinessKey(runId);

  const requiredContextArtifacts = (
    context: Pick<ToolExecutionContext, 'projectId' | 'runId'>,
    stage: WritingWorkflowStage | null,
  ): readonly { readonly artifactVersionId: string; readonly source: string }[] => [
    ...(enforceContinuationReads
      ? continuationContextArtifacts(
          storage,
          context.projectId,
          context.runId,
          mode,
          stage,
        ).map((artifact) => ({
          artifactVersionId: artifact.artifactVersionId,
          source: artifact.stage,
        }))
      : []),
    ...initialContextIds(context.runId).map((artifactVersionId) => ({
      artifactVersionId,
      source: "current_body",
    })),
    ...(carriedReworkInput(context.runId, stage) ? [{
      artifactVersionId: carriedReworkInput(context.runId, stage)!.id,
      source: "author_rework",
    }] : []),
  ].filter((artifact, index, artifacts) =>
    artifacts.findIndex((candidate) =>
      candidate.artifactVersionId === artifact.artifactVersionId,
    ) === index,
  );

  const unreadReadinessArtifactIds = (runId: string): readonly string[] => {
    // Later stages receive their exact bound artifacts in their independent
    // request context. Explicit rereads are required only on entry/recovery.
    if (readyInputsByRun.has(runId)) return [];
    const read = new Set(completedArtifactReadIds?.(runId) ?? []);
    return requiredContextArtifacts({ projectId, runId }, nextStageForRun(runId))
      .map(a => a.artifactVersionId).filter(id => !read.has(id));
  };

  const assertReadinessPrerequisites = (context: ToolExecutionContext): void => {
    const completedMaterials = new Set(completedMaterialIds?.(context.runId) ?? []);
    const unreadMaterialIds = requiredMaterialIds.filter(
      (materialId) => !completedMaterials.has(materialId),
    );
    if (unreadMaterialIds.length > 0) {
      throw new ToolExecutionFault(
        "READINESS_MATERIAL_READ_REQUIRED",
        "Read every material authorized by the brief before declaring writing readiness",
        false,
        { unreadMaterialIds: [...unreadMaterialIds] },
      );
    }
    const unreadIds = new Set(unreadReadinessArtifactIds(context.runId));
    const unreadArtifacts = requiredContextArtifacts(context, nextStageForRun(context.runId)).filter(a => unreadIds.has(a.artifactVersionId));
    if (unreadArtifacts.length > 0) {
      throw new ToolExecutionFault(
        "READINESS_CONTEXT_READ_REQUIRED",
        "Read every required persisted context artifact before declaring writing readiness",
        false,
        { unreadArtifacts },
      );
    }
  };

  const assertWritingReady = (context: ToolExecutionContext): void => {
    if (isReady(context.runId)) return;
    throw new ToolExecutionFault(
      "WRITING_READINESS_REQUIRED",
      "Assess writing readiness for the current stage and current input versions before submitting it",
      false,
      {
        correction:
          "After reading all required inputs, call assess_writing_readiness with ready or needs_input before any stage submission.",
      },
    );
  };

  const assertContinuationContextRead = (
    context: ToolExecutionContext,
    stage: WritingWorkflowStage,
  ): void => {
    if (!enforceContinuationReads && requiredInitialArtifactIds.length === 0) return;
    if (!continuationEntryStageByRun.has(context.runId)) {
      continuationEntryStageByRun.set(
        context.runId,
        factCheckOnly
          ? "fact_check"
          : expectedStage(storage, context.projectId, context.runId, mode),
      );
    }
    if (continuationEntryStageByRun.get(context.runId) !== stage) return;
    const requiredArtifacts = requiredContextArtifacts(context, stage);
    const completed = new Set(completedArtifactReadIds?.(context.runId) ?? []);
    const unreadArtifacts = requiredArtifacts.filter(
      (artifact) => !completed.has(artifact.artifactVersionId),
    );
    if (unreadArtifacts.length === 0) return;
    throw new ToolExecutionFault(
      "CONTINUATION_CONTEXT_READ_REQUIRED",
      "Read every required persisted context artifact before continuing the workflow",
      false,
      {
        nextStage: stage,
        unreadArtifacts,
        correction:
          "Call read_artifact_version once for every unread artifactVersionId, then resubmit the same stage using that persisted context as the editing baseline.",
      },
    );
  };

  const assessWritingReadiness: ToolDefinition<AssessWritingReadinessArgs, JsonValue> = {
    name: "assess_writing_readiness",
    version: "1.0.0",
    description:
      "Assess the NEXT stage using its current inputs and the previous expert result, before dispatch or submission. This approval expires after a stage is saved, reworked, or its inputs change. Ask at most two focused questions only for actual missing author information; agent-created defects belong to internal rework.",
    inputSchema: WRITING_READINESS_SCHEMA,
    effect: "local_idempotent",
    permissions: ["workflow:submit"],
    execute(args, context) {
      if (context.projectId !== projectId) {
        throw new ToolExecutionFault("PROJECT_SCOPE_MISMATCH", "Workflow belongs to another project");
      }
      const reason = args.reason.trim();
      const questions = args.questions.map((question) => question.trim());
      if (reason.length === 0 || questions.some((question) => question.length === 0)) {
        throw new ToolExecutionFault(
          "WRITING_READINESS_INVALID",
          "Readiness reason and every question must be non-empty",
        );
      }
      if (args.status === "ready") {
        if (questions.length > 0) {
          throw new ToolExecutionFault(
            "WRITING_READINESS_INVALID",
            "A ready assessment must not include unresolved questions",
          );
        }
        assertReadinessPrerequisites(context);
        readyInputsByRun.set(context.runId, readinessKey(context.runId));
        return {
          status: "ready",
          reason,
          questions: [],
          nextStage: nextStageForRun(context.runId),
        };
      }
      if (questions.length === 0) {
        throw new ToolExecutionFault(
          "WRITING_READINESS_INVALID",
          "A needs_input assessment must include at least one focused question",
        );
      }
      assertBusinessInputQuestions(reason, questions);
      readyInputsByRun.delete(context.runId);
      const nextStage = nextStageForRun(context.runId);
      const requiredArtifactVersionIds =
        nextStage === "research" || nextStage === "outline" || nextStage === "draft"
          ? [...initialContextIds(context.runId)]
          : [];
      return {
        status: "needs_input",
        reason,
        questions,
        nextStage,
        awaitingUserInput: {
          reason,
          questions,
          nextStage,
          requiredArtifactVersionIds,
        },
      };
    },
  };

  const submitWritingStage: ToolDefinition<SubmitWritingStageArgs, JsonValue> = {
    name: "submit_writing_stage",
    version: "1.0.0",
    description:
      "Persist the next required writing workflow stage. Stages are ordered and review stages cannot modify the body.",
    inputSchema: WRITING_STAGE_SCHEMA,
    effect: "local_idempotent",
    permissions: ["workflow:submit"],
    execute(args, context) {
      if (context.projectId !== projectId) {
        throw new ToolExecutionFault("PROJECT_SCOPE_MISMATCH", "Workflow belongs to another project");
      }
      assertWritingReady(context);
      assertExpectedStage(storage, context, mode, args.stage);
      assertContinuationContextRead(context, args.stage);
      if (/^(?:正在|仍在)(?:整理|生成|撰写|提交|保存)(?:文章)?(?:提纲|大纲|正文|稿件|本阶段(?:成果|内容))?[。！!…\s]*$/u.test(args.content.trim())) {
        throw new ToolExecutionFault('STAGE_OUTPUT_IS_STATUS_ONLY', 'Return the complete stage deliverable, not an acknowledgement or promise to generate it.');
      }
      if (args.stage === "research" && requiredMaterialIds.length > 0) {
        const completed = new Set(completedMaterialIds?.(context.runId) ?? []);
        const unreadMaterialIds = requiredMaterialIds.filter(
          (materialId) => !completed.has(materialId),
        );
        if (unreadMaterialIds.length > 0) {
          throw new ToolExecutionFault(
            "MATERIAL_READ_REQUIRED",
            "Read every material authorized by the brief before submitting research",
            false,
            { unreadMaterialIds: [...unreadMaterialIds] },
          );
        }
      }
      if (args.stage === "central_revision") {
        assertReviewsBoundToDraft(storage, context, mode);
      }
      if (
        args.stage === "draft" ||
        args.stage === "central_revision" ||
        args.stage === "language_review"
      ) {
        const languageSource = args.stage === "language_review" ? markerPayload(stageMarker(storage, context.projectId, context.runId, "central_revision")) : null;
        assertCleanBodyStageContent(args.stage, args.content, languageSource === null ? undefined : storage.getArtifactVersion(languageSource.artifactVersionId)?.content);
      }
      const artifact = commitStageArtifact(storage, context, args.stage, args.content);
      markStage(storage, context, args.stage, artifact.id);
      const nextStage = expectedStage(storage, context.projectId, context.runId, mode);
      const awaitingUserConfirmation =
        interactionMode === "co_creation" &&
        CO_CREATION_CHECKPOINT_STAGES.has(args.stage) &&
        nextStage !== null
          ? {
              stage: args.stage,
              nextStage,
              requiredArtifactVersionIds:
                nextStage === "draft" ? [...initialContextIds(context.runId)] : [],
            }
          : null;
      return {
        stage: args.stage,
        artifactVersionId: artifact.id,
        bodyVersionId: storage.inspectProject(context.projectId)?.latestBodyVersionId ?? null,
        nextStage,
        ...(args.stage === "research"
          ? {
              evidenceIds: [...evidenceIdsFromLedger(artifact.content)],
              factCheckReferenceRule:
                "matchedEvidenceId must be one of evidenceIds; otherwise use null and provide sourceReference",
            }
          : {}),
        ...(awaitingUserConfirmation === null
          ? {}
          : { awaitingUserConfirmation }),
      };
    },
  };

  const submitFactCheck: ToolDefinition<SubmitFactCheckArgs, JsonValue> = {
    name: "submit_fact_check",
    version: "1.0.0",
    description:
      "Evaluate the final body against the saved evidence ledger. Unsupported claims remain blockers; the model cannot self-approve the gate.",
    inputSchema: FACT_CHECK_SCHEMA,
    effect: "local_idempotent",
    permissions: ["workflow:submit", "fact:submit"],
    execute(args, context) {
      if (context.projectId !== projectId) {
        throw new ToolExecutionFault("PROJECT_SCOPE_MISMATCH", "Workflow belongs to another project");
      }
      if (!factCheckOnly) assertWritingReady(context);
      if (!factCheckOnly) assertExpectedStage(storage, context, mode, "fact_check");
      if (!factCheckOnly) assertContinuationContextRead(context, "fact_check");
      let project = storage.inspectProject(context.projectId);
      if (
        project === null ||
        project.latestBodyVersionId === null ||
        project.currentEvidenceVersionId === null
      ) {
        throw new ToolExecutionFault(
          "FACT_INPUTS_INCOMPLETE",
          "Final body and evidence must exist before fact checking",
        );
      }
      const body = storage.getArtifactVersion(project.latestBodyVersionId);
      if (project.latestBodyVersionId !== context.expectedBodyVersionId) throw new ToolExecutionFault("BASE_VERSION_CONFLICT", "The body changed after this fact-check assignment; request a fresh assignment before evaluating it");
      if (body === null) {
        throw new ToolExecutionFault("FACT_INPUTS_INCOMPLETE", "Final body could not be read");
      }
      const evidence = storage.getArtifactVersion(project.currentEvidenceVersionId);
      if (evidence === null || evidence.kind !== "evidence") {
        throw new ToolExecutionFault("FACT_INPUTS_INCOMPLETE", "Evidence ledger could not be read");
      }
      const validEvidenceIds = evidenceIdsFromLedger(evidence.content);
      const validEvidenceIdSet = new Set(validEvidenceIds);
      const invalidEvidenceIds = [...new Set(args.claims
        .map((claim) => claim.matchedEvidenceId)
        .filter((evidenceId): evidenceId is string =>
          evidenceId !== null && !validEvidenceIdSet.has(evidenceId),
        ))];
      if (invalidEvidenceIds.length > 0) {
        throw new ToolExecutionFault(
          "FACT_CHECK_EVIDENCE_REFERENCE_INVALID",
          "matchedEvidenceId must exactly match the saved evidence ledger or be null",
          false,
          {
            invalidEvidenceIds,
            validEvidenceIds,
            correction:
              "Use an exact E### ID from validEvidenceIds. If the list is empty or no item matches, set matchedEvidenceId to null and provide sourceReference.",
          },
        );
      }
      const title = titleFromBody(body.content);
      const selectedTitle = project.currentTitleVersionId ? storage.getArtifactVersion(project.currentTitleVersionId) : null;
      if ((interactionMode === 'co_creation' || selectedTitle?.reason === 'author-publication-selection') && !isPublicationSelectionCurrent(storage, context.projectId)) {
        throw new ToolExecutionFault('PUBLICATION_SELECTION_REQUIRED', '先在主对话确认发布标题，再核查该标题与正文，不得把生成的标题冒充用户选择。');
      }
      const titleCommit = selectedTitle?.reason === 'author-publication-selection' ? null : storage.commitArtifactVersion({
        operationId: `${context.operationId}:title`,
        projectId: context.projectId,
        expectedProjectRevision: project.revision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: project.currentTitleVersionId,
        content: `- 选择状态：已锁定\n- 最终标题：「${title}」\n- 选择来源：按自主推进模式代选当前稿件标题\n- 分发文案范围：本次不包含分发文案，核查覆盖其缺省状态\n`,
        reason: "workflow:fact-check-title",
        requestSnapshotId: null,
        actor: actor("fact_check", context.runId),
      });
      const titleValue = titleCommit === null ? { versionId: selectedTitle!.id } : value(titleCommit);
      project = storage.inspectProject(context.projectId);
      if (project === null) {
        throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
      }
      const frozen = storage.createFactCheckSnapshot({
        operationId: `${context.operationId}:snapshot`,
        projectId: context.projectId,
        expectedProjectRevision: project.revision,
        bodyVersionId: body.id,
        titleVersionId: titleValue.versionId,
        evidenceVersionId: evidence.id,
        actor: actor("fact_check", context.runId),
      });
      const frozenValue = value(frozen);
      project = storage.inspectProject(context.projectId);
      if (project === null) {
        throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
      }
      const evaluated = storage.evaluateFactCheckSnapshot({
        operationId: `${context.operationId}:evaluation`,
        projectId: context.projectId,
        expectedProjectRevision: project.revision,
        snapshotId: frozenValue.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozenValue.snapshotId,
          bodyVersionId: body.id,
          titleVersionId: titleValue.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [...args.claims],
          noFactualClaimsReason: args.noFactualClaimsReason,
        },
        actor: actor("fact_check", context.runId),
      });
      const evaluation = value(evaluated);
      markStage(storage, context, "fact_check", evaluation.assessmentId);
      return {
        stage: "fact_check",
        snapshotId: evaluation.snapshotId,
        assessmentId: evaluation.assessmentId,
        status: evaluation.status,
        blockers: [...evaluation.blockers],
        unresolvedClaims: args.claims.filter((claim) => evaluation.blockers.includes(claim.claimId)).map((claim) => ({ claimText: claim.claimText, recommendedAction: claim.recommendedAction })),
        bodyVersionId: body.id,
        nextStage: null,
      };
    },
  };

  const recoveryKey = (runId: string): string => `workflow-body-rebound:${runId}`;
  const recoveredBodyVersionId = (runId: string): string | null => {
    const report = storage.listArtifactVersions(projectId, "report", recoveryKey(runId)).at(-1);
    if (!report) return null;
    try {
      const data = JSON.parse(report.content);
      return data.schemaVersion === "writing-checkpoint-body-rebind-v1" && typeof data.bodyVersionId === "string"
        ? data.bodyVersionId
        : null;
    } catch { return null; }
  };
  const recoverConfirmedBody = (runId: string): string | null => {
    seedCarryOnce(runId);
    if (factCheckOnly) return null;
    const existing = recoveredBodyVersionId(runId);
    const sequence = workflowStageSequence(mode);
    const candidates = sequence.flatMap(stage => {
      const marker = stageMarker(storage, projectId, runId, stage);
      if (!marker) return [];
      const decision = confirmedCheckpointDecision(storage, marker);
      if (decision?.intent !== "approve_checkpoint") return [];
      const resume = storage.listEvents(projectId).find(event => event.runId === runId && event.id === decision.resumeEventId);
      return resume ? [{ stage, marker, decision, projectSeq: resume.projectSeq }] : [];
    }).sort((left, right) => right.projectSeq - left.projectSeq);
    const candidate = candidates[0];
    if (!candidate || candidate.decision.bodyVersionId === null) return existing;
    const alreadyRecovered = storage.listArtifactVersions(projectId, "report", recoveryKey(runId)).some(report => {
      try {
        const data = JSON.parse(report.content);
        return data.sourceMarkerId === candidate.marker.id && data.receiptId === candidate.decision.receiptId;
      } catch { return false; }
    });
    if (alreadyRecovered) return recoveredBodyVersionId(runId);
    const project = storage.inspectProject(projectId);
    const body = storage.getArtifactVersion(candidate.decision.bodyVersionId);
    // The author authorized exactly the version captured by the receipt. A
    // later edit is a new boundary and must never be silently adopted.
    if (!project || project.latestBodyVersionId !== candidate.decision.bodyVersionId || body?.kind !== "body") return existing;

    const boundBodyMarker = candidate.stage.startsWith("review_")
      ? markerPayload(stageMarker(storage, projectId, runId, "draft"))
      : candidate.stage === "draft" || candidate.stage === "central_revision" || candidate.stage === "language_review"
        ? markerPayload(candidate.marker)
        : null;
    // A normal checkpoint already points at the confirmed body. Recovery is
    // only for an author save made between stage completion and confirmation.
    if (boundBodyMarker?.artifactVersionId === body.id) return existing;

    const operationBase = `checkpoint-body-rebind:${runId}:${candidate.decision.resumeEventId}`;
    const bodyStages = new Set<WritingWorkflowStage>(["draft", "central_revision", "language_review"]);
    if (bodyStages.has(candidate.stage)) {
      markStage(storage, { projectId, runId, operationId: `${operationBase}:stage` } as ToolExecutionContext,
        candidate.stage, body.id, "workflow-stage-rebound-to-confirmed-body", "approve_checkpoint");
    } else if (candidate.stage.startsWith("review_")) {
      markStage(storage, { projectId, runId, operationId: `${operationBase}:draft` } as ToolExecutionContext,
        "draft", body.id, "workflow-draft-rebound-to-confirmed-body", "approve_checkpoint");
    }

    const affectedStart = candidate.stage === "draft" || candidate.stage.startsWith("review_")
      ? sequence.indexOf("review_editor")
      : candidate.stage === "central_revision"
        ? sequence.indexOf("language_review")
        : candidate.stage === "language_review"
          ? sequence.indexOf("fact_check")
          : -1;
    const affected = affectedStart < 0 ? [] : sequence.slice(affectedStart);
    const markerIds = affected.flatMap(stage => {
      const marker = stageMarker(storage, projectId, runId, stage);
      return marker ? [marker.id] : [];
    });
    if (markerIds.length > 0) {
      const invalidationKey = `workflow-invalidated:${runId}`;
      const current = storage.inspectProject(projectId)!;
      value(storage.commitArtifactVersion({
        operationId: `${operationBase}:invalidate`, projectId, expectedProjectRevision: current.revision,
        kind: "report", logicalKey: invalidationKey,
        baseVersionId: storage.listArtifactVersions(projectId, "report", invalidationKey).at(-1)?.id ?? null,
        content: JSON.stringify({ markerIds, invalidatedStages: affected, checkpointBodyRebind: true }),
        reason: "workflow-checkpoint-body-rebind", requestSnapshotId: null,
        actor: { kind: "agent", id: "writing-pack/director", runId },
      }));
    }
    const current = storage.inspectProject(projectId)!;
    value(storage.commitArtifactVersion({
      operationId: `${operationBase}:report`, projectId, expectedProjectRevision: current.revision,
      kind: "report", logicalKey: recoveryKey(runId),
      baseVersionId: storage.listArtifactVersions(projectId, "report", recoveryKey(runId)).at(-1)?.id ?? null,
      content: JSON.stringify({ schemaVersion: "writing-checkpoint-body-rebind-v1", sourceMarkerId: candidate.marker.id,
        stage: candidate.stage, bodyVersionId: body.id, receiptId: candidate.decision.receiptId, invalidatedStages: affected }),
      reason: "workflow-checkpoint-body-rebind", requestSnapshotId: null,
      actor: { kind: "agent", id: "writing-pack/director", runId },
    }));
    readyInputsByRun.delete(runId);
    return body.id;
  };

  return {
    isReady,
    recoverConfirmedBody,
    pendingCheckpoint(runId) {
      seedCarryOnce(runId);
      return factCheckOnly ? null : pendingStageCheckpoint(storage, projectId, runId);
    },
    unreadReadinessArtifactIds,
    invalidate(context, stage) {
      const sequence = workflowStageSequence(mode);
      const affected = sequence.slice(sequence.indexOf(stage));
      const markerIds = affected.flatMap((item) => {
        const marker = stageMarker(storage, projectId, context.runId, item);
        return marker === null ? [] : [marker.id];
      });
      const key = `workflow-invalidated:${context.runId}`;
      const project = storage.inspectProject(projectId)!;
      value(storage.commitArtifactVersion({ operationId: `${context.operationId}:invalidate`, projectId,
        expectedProjectRevision: project.revision, kind: "report", logicalKey: key,
        baseVersionId: storage.listArtifactVersions(projectId, "report", key).at(-1)?.id ?? null,
        content: JSON.stringify({ markerIds, invalidatedStages: affected,
          ...(stage === "central_revision" && project.latestBodyVersionId !== null ? { revisionInput: { bodyVersionId: project.latestBodyVersionId, factCheck: storage.getFactCheckStatus(projectId) } } : {}) }), reason: `workflow-rework:${stage}`,
        requestSnapshotId: null, actor: { kind: "agent", id: "writing-pack/director", runId: context.runId } }));
      return affected;
    },
    definitions: (factCheckOnly
      ? [submitFactCheck]
      : [assessWritingReadiness, submitWritingStage, submitFactCheck]) as unknown as readonly ToolDefinition<never, JsonValue>[],
    progress(runId) {
      seedCarryOnce(runId);
      const sequence = factCheckOnly
        ? (["fact_check"] as const)
        : workflowStageSequence(mode);
      const completedStages = sequence.filter(
        (stage) => stageMarker(storage, projectId, runId, stage) !== null && (factCheckOnly || stage !== "fact_check" || storage.getFactCheckStatus(projectId).status === "passed"),
      );
      return {
        completedStages,
        nextStage: sequence.find(
          (stage) => !completedStages.includes(stage),
        ) ?? null,
      };
    },
    continuationContext(runId) {
      const nextStage = factCheckOnly
        ? (stageMarker(storage, projectId, runId, "fact_check") === null ? "fact_check" : null)
        : expectedStage(storage, projectId, runId, mode);
      return {
        nextStage,
        artifacts: [
          ...continuationContextArtifacts(storage, projectId, runId, mode, nextStage),
          ...initialContextIds(runId).map((artifactVersionId) => ({
            stage: "current_body" as const,
            artifactVersionId,
          })),
          ...(carriedReworkInput(runId, nextStage) ? [{
            stage: nextStage!,
            artifactVersionId: carriedReworkInput(runId, nextStage)!.id,
          }] : []),
        ].filter((artifact, index, artifacts) =>
          artifacts.findIndex((candidate) =>
            candidate.artifactVersionId === artifact.artifactVersionId,
          ) === index,
        ),
      };
    },
    completion(runId) {
      const complete = factCheckOnly
        ? stageMarker(storage, projectId, runId, "fact_check") !== null
        : expectedStage(storage, projectId, runId, mode) === null;
      const project = storage.inspectProject(projectId);
      return {
        complete,
        bodyVersionId: project?.latestBodyVersionId ?? null,
        publicationReady:
          complete && storage.getFactCheckStatus(projectId).status === "passed",
      };
    },
  };
}

export function createFactCheckOnlyTools(options: {
  readonly storage: WorkflowStorage;
  readonly projectId: string;
}): WritingWorkflowTools {
  return createWritingWorkflowTools({
    ...options,
    mode: "quick",
    factCheckOnly: true,
  });
}
