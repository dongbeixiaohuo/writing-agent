import type {
  ArtifactKind,
  ArtifactVersion,
  FactClaim,
  JsonValue,
  MutationResult,
  ProjectMode,
  StoragePort,
} from "../../writing-core/src/index.js";
import type { RunRecord, RuntimeEvent, SessionStore } from "../../runtime/session/src/index.js";
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
type WorkflowStorage = StoragePort & Pick<SessionStore, 'listRunEvents'> & {
  getRun(runId: string): RunRecord | null;
  listRuns(projectId: string, sessionId?: string): RunRecord[];
};

type ContentStage = Exclude<WritingWorkflowStage, "fact_check">;
import { canonicalJson, FactClaimStatusSchema, FactClaimTypeSchema, createFactCheckInputSnapshot, evaluateFactCheck } from '../../writing-core/src/index.js';
import { defaultFactTitleContent, isPublicationSelectionCurrent } from './publication-choice.js';
import { COMPACT_RESEARCH_SCHEMA, prepareResearchEvidence } from './research-evidence.js';
import { normalizeFactVerification } from './fact-context.js';
import { factSearchLimitations } from './fact-search-recovery.js';
import { PREWRITING_JSON_SCHEMA, confirmedWritingFocus, isPracticalGuide, parsePrewriting, prewritingContent, validateReadingRoute, type PrewritingAssessment } from './prewriting.js';
import { confirmedWritingDirection } from './conversation-intake.js';
import { researchReadings } from './research-readings.js';
import { usesPublicSources, withResearchSupplement, type OutlineSupplement } from './research-supplement.js';
import { JSON_SCHEMA as REVISION_COMPARISON_SCHEMA, parseRevisionComparison } from './revision-comparison.js';
import { applyParagraphEdits, articleParagraphs, PARAGRAPH_EDITS_SCHEMA, quoteParagraphIds } from './paragraph-revision.js';
import { applyLintEdits, applyReviewEdits, bindReviewExcerpt, isArticleHeading, LINT_SUBMISSION_SCHEMA, REVIEW_EDITS_SCHEMA,
  REVIEW_EXCERPT_SCHEMA, type LintSource, type ReviewExcerptSelection } from './focused-review.js';
import { inlineMaterialContext } from './material-context.js';
import { JSON_SCHEMA as REVIEW_FINDINGS_SCHEMA, PERSUASION_FINDINGS_SCHEMA, RESOLUTIONS_JSON_SCHEMA, REVISION_AUDIT_JSON_SCHEMA,
  validateReviewFindings, validateColdReviewFindings, validatePersuasionFindings, parseReadingAssessment, parseReviewResolutions, parseRevisionAudit, READING_JSON_SCHEMA, needsArticleRedevelopment,
  type ReadingAssessment, type ReviewFinding, type BoundReviewFinding } from './review-closure.js';
type BodyStage = Extract<ContentStage, "draft" | "central_revision" | "language_review">;

interface SubmitWritingStageArgs {
  readonly stage: ContentStage;
  readonly content: string | { [key: string]: JsonValue };
  readonly comparison?: JsonValue;
  readonly findings?: JsonValue;
  readonly resolutions?: JsonValue;
  readonly audit?: JsonValue;
  readonly prewriting?: JsonValue;
  readonly reading?: JsonValue;
  readonly paragraphEdits?: JsonValue;
  readonly reviewEdits?: JsonValue;
  readonly lintEdits?: JsonValue;
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
  readonly requireEditorialPlan: boolean;
  prewritingRequired(runId: string): boolean;
  prewritingApproval(runId: string): PrewritingAssessment | null;
  pendingPrewritingReturn(runId: string): ArtifactVersion | null;
  readerValueRequired(runId: string): boolean;
  editorialRecovery(runId: string): EditorialRecovery | null;
  revisionCandidates(runId: string): { original: ArtifactVersion; revised: ArtifactVersion; allowOriginal: boolean } | null;
  pendingCheckpoint(runId: string): { stage: string; nextStage: string; markerId: string; requiredArtifactVersionIds: string[] } | null;
  recoverConfirmedBody(runId: string): string | null;
  recoverLanguageReview(runId: string, events: readonly RuntimeEvent[]): ArtifactVersion | null;
  recoverCentralRevision(runId: string, events: readonly RuntimeEvent[]): ArtifactVersion | null;
  reviewClosure(runId: string): ReviewClosure | null;
  revisionWork(runId: string, bodyVersionId: string | null): { closure: ReviewClosure; returnReportId: string | null } | null;
  reviewExcerpt(base: ArtifactVersion, findings: readonly BoundReviewFinding[]): ReturnType<typeof bindReviewExcerpt<BoundReviewFinding>> | null;
  reviewFindingsRequired(runId: string): boolean;
  lintSources(runId: string): LintSource[];
  protectedHypotheses(runId: string): string[];
  pendingRevisionReturn(runId: string): ArtifactVersion | null;
  hasRevisionReturnForAssignment(runId: string, dispatchSeq: number, bodyVersionId: string | null, events: readonly RuntimeEvent[]): boolean;
  readonly definitions: readonly ToolDefinition<never, JsonValue>[];
  isReady(runId: string): boolean;
  approveReadiness(context: ToolExecutionContext, reason: string, deliveredArtifacts?: readonly string[]): JsonValue;
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

export function stageMarker(
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
  return workflowStagesForRun(storage, projectId, runId, mode).find(
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

// A limit on an inference can itself be the article's point. The older body
// policy treated it as a work note even when no source assessment was present.
const inferenceLimit = /(?:不能|不宜|无法|难以|不足以)[^。！？\n]{0,24}(?:推断|认定|猜测|扩写|证明|当作|归因|算作|算到|算在)/u;
const editorialInferenceLimit = new RegExp('(?:现有|手头|本轮|所给)的?(?:材料|资料|证据)[^。！？\\n]{0,20}' + inferenceLimit.source, 'u');
const EDITORIAL_CAVEAT_PATTERNS = [
  /(?:细节|记载|记述|故事|传闻|传说|史料|记录|证据)[^。！？\n]{0,24}(?:未必|很难|难以|无法|不能|不可)[^。！？\n]{0,16}(?:核实|证实|确认|断定)/u,
  inferenceLimit,
  /(?:材料|证据|报道|记载|回忆|转述|史料)[^。！？；：，,\n]{0,20}(?:不能|不宜|无法|难以|不足以)[^。！？；：，,\n]{0,16}判断/u,
  /(?:不能|不宜|无法|难以|不足以)[^。！？；：\n]{0,8}(?:据此|凭[^。！？；：\n]{1,10}(?:材料|证据|报道|记载|回忆|转述|史料))[^。！？；：\n]{0,8}判断/u,
  /(?:细节|记载|记述|故事|传闻|传说|史料|记录|证据|材料|文本)[^。！？\n]{0,16}(?:不能|无法|难以)[^。！？\n]{0,12}告诉/u,
  /(?:不能|不宜|无法|难以)[^。！？\n]{0,6}据此[^。！？\n]{0,6}说/u,
  /(?:材料|记述|记载|报道|回忆|细节|史料|记录|证据|文本)[^。！？\n]{0,20}(?:没有|并未|无从|无法|难以|不能)[^。！？\n]{0,20}(?:答案|留下|给出|回答|告诉|说明)/u,
  /(?:想法|感受|内心)[^。！？\n]{0,15}(?:无从|不可知|无法|难以|没有)(?:给出|留下|知道|判断|确认|答案)?/u,
  /是否[^。！？\n]{0,16}(?:很难|难以|无法|不能)[^。！？\n]{0,20}(?:断定|确认|核实)/u,
  /(?:^|\n)这是(?:一则|一段)?[^。！？\n]{0,16}(?:野史|传闻|传说|后人记述|后人转述|笔记)/u,
  /应当当作(?:传闻|传说|野史)读/u,
];
const READER_CAVEAT_PATTERNS = EDITORIAL_CAVEAT_PATTERNS.map(pattern =>
  pattern === inferenceLimit ? editorialInferenceLimit : pattern);

export function assertCleanBodyStageContent(stage: BodyStage, content: string, boundBody?: string,
  rejectEditorialCaveats: boolean | 'reader_review' = false): void {
  const normalized = content.trim();
  if (rejectEditorialCaveats) {
    const patterns = rejectEditorialCaveats === 'reader_review' ? READER_CAVEAT_PATTERNS : EDITORIAL_CAVEAT_PATTERNS;
    const quotes = [...new Set(patterns.flatMap(pattern =>
      Array.from(normalized.matchAll(new RegExp(pattern.source, 'gu')), match => match[0])))];
    if (quotes.length > 0) {
      const repairNeighborhoods = stage === 'draft' ? articleParagraphs(normalized).flatMap((paragraph, index, paragraphs) => {
        if (isArticleHeading(paragraph, index) || !quotes.some(quote => paragraph.text.includes(quote))) return [];
        const neighborhood = [index - 1, index, index + 1].flatMap(position => {
          const item = paragraphs[position];
          return item && !isArticleHeading(item, position) ? [{ paragraphId: item.id, text: item.text.slice(0, 4000) }] : [];
        });
        return [{ flaggedParagraphId: paragraph.id, paragraphs: neighborhood }];
      }).slice(0, 4) : [];
      throw new ToolExecutionFault(
        'BODY_STAGE_CONTAINS_EDITORIAL_CAVEATS',
        'Remove editorial source assessment and inference-boundary commentary from the article',
        false,
        {
          stage,
          quote: quotes[0]!,
          quotes,
          correction: '删除来源可靠性、核实难度、材料缺口、推断边界和人物内心不可知的说明，不换同义句保留。必要限定只用事实归属、时间和行动表达，再以新的动作、回应或后果推进。' + (stage === 'draft'
            ? '先看问题段和前后正文。研究样本或自报口径放进首次介绍，后段只留新解释，别重播前段已交代的数字、设定和发现。只改问题段及需要承接的邻段，标题与其余段落按原稿输出。' : ''),
          ...(repairNeighborhoods.length ? { repairNeighborhoods } : {}),
        },
      );
    }
  }
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
    throw new ToolExecutionFault('BODY_STAGE_STRUCTURE_MISMATCH', 'Return the complete article; the response appears truncated — it dropped a heading or most of the article body', false, {
      stage, requiredHeadings: headings(baseline!),
      correction: 'Return the full article preserving every Markdown heading and section; do not abridge or truncate it. This is not a request to add length or padding — if the article genuinely needed cuts those are fine, only return the whole revised article rather than a fragment. Remove any legacy postscript change notes; those are not part of the article. Do not rewrite an unchanged response.',
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
  readonly carriedFromMarkerId?: string;
  readonly focusedReview?: boolean;
}

interface WritingReviewEnvelope {
  readonly schemaVersion: "writing-review-v1";
  readonly reviewType: Extract<ContentStage, `review_${string}`>;
  readonly runId: string;
  readonly bodyVersionId: string;
  readonly content: string;
  readonly findings?: readonly ReviewFinding[];
  readonly reading?: ReadingAssessment;
}

interface EditorialRecovery {
  route: 'research' | 'discuss' | 'outline';
  reportIds: string[];
  reason: string;
  queries: string[];
  questions: string[];
}

interface ReviewClosure {
  readonly findings: BoundReviewFinding[];
  readonly reviewVersionIds: string[];
  readonly reportVersionIds: string[];
  readonly evidenceIds: string[];
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

function stageMarkerLineage(storage: StoragePort, marker: ArtifactVersion | null): ArtifactVersion[] {
  const lineage: ArtifactVersion[] = [];
  while (marker) {
    lineage.push(marker);
    const binding = markerPayload(marker);
    if (typeof binding?.carriedFromMarkerId !== 'string') break;
    const source = storage.getArtifactVersion(binding.carriedFromMarkerId);
    const sourceBinding = markerPayload(source);
    if (!source || source.projectId !== marker.projectId || source.kind !== 'report' ||
        source.createdEventSeq >= marker.createdEventSeq || sourceBinding?.stage !== binding.stage ||
        sourceBinding.artifactVersionId !== binding.artifactVersionId ||
        source.logicalKey !== markerKey(sourceBinding.runId, sourceBinding.stage) ||
        source.actor.kind !== 'agent' || source.actor.runId !== sourceBinding.runId) break;
    marker = source;
  }
  return lineage;
}

export function isReadingFirstRun(storage: StoragePort, projectId: string, runId: string): boolean {
  return stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'outline'))
    .some(marker => JSON.parse(marker.content).readingFirst === true);
}

export function usesFocusedReview(storage: StoragePort, projectId: string, runId: string): boolean {
  return stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'outline'))
    .some(marker => markerPayload(marker)?.focusedReview === true);
}

/** One cold read owns prose revision. Extra publication/simulated reviews do
 * not become competing authors in the reading-first chain. Legacy runs keep
 * their original sequence; final publication verification remains separate. */
export function workflowStagesForRun(storage: StoragePort, projectId: string, runId: string, mode: ProjectMode) {
  return workflowStageSequence(mode).filter(stage => !isReadingFirstRun(storage, projectId, runId) ||
    !['review_publish', 'review_reader'].includes(stage));
}

/** Carry markers point at the original stage contract. A restart must not
 * silently turn a read-only audit into a second writer. */
export function isReadOnlyRevisionAudit(storage: WorkflowStorage, projectId: string, runId: string): boolean {
  const lineage = stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'central_revision'));
  return lineage.some(marker => ['redevelop', 'paragraphs'].includes(JSON.parse(marker.content).revisionMode));
}

export function stageArtifact(storage: StoragePort, projectId: string, runId: string, stage: WritingWorkflowStage): ArtifactVersion | null {
  const payload = markerPayload(stageMarker(storage, projectId, runId, stage));
  return payload ? storage.getArtifactVersion(payload.artifactVersionId) : null;
}

function continuationContextStages(
  nextStage: WritingWorkflowStage | null,
  mode: ProjectMode,
): readonly WritingWorkflowStage[] {
  if (nextStage === null || nextStage === "research") return [];
  if (nextStage === "outline") return ["research"];
  if (nextStage === "draft") return ["research", "outline"];
  if (nextStage === 'review_editor') return ['draft'];
  if (
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
  carriedRevisionRepair?: ArtifactVersion,
): readonly { readonly stage: WritingWorkflowStage; readonly artifactVersionId: string }[] {
  if (nextStage === "central_revision") {
    const rework = storage.listArtifactVersions(projectId, "report", `workflow-invalidated:${runId}`).at(-1) ?? carriedRevisionRepair;
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
  findings?: readonly ReviewFinding[],
  reading?: ReadingAssessment,
): string {
  const envelope: WritingReviewEnvelope = {
    schemaVersion: "writing-review-v1",
    reviewType: stage,
    runId: context.runId,
    bodyVersionId: draftVersionForReview(storage, context),
    content: content.trim(),
    ...(findings ? { findings } : {}),
    ...(reading ? { reading } : {}),
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
  const reviewStages = workflowStagesForRun(storage, context.projectId, context.runId, mode).filter(
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
  findings?: readonly ReviewFinding[],
  reading?: ReadingAssessment,
): ArtifactVersion {
  const project = storage.inspectProject(context.projectId);
  if (project === null) {
    throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
  }
  const kind = artifactKind(stage);
  const key = logicalKey(stage, context.runId);
  const persistedContent = stage.startsWith("review_")
      ? reviewEnvelopeContent(
          storage,
          context,
          stage as Extract<ContentStage, `review_${string}`>,
          content,
          findings,
          reading,
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
  context: Pick<ToolExecutionContext, 'projectId' | 'runId' | 'operationId'>,
  stage: WritingWorkflowStage,
  artifactVersionId: string,
  reason?: string,
  carriedDecision?: string,
  expectedBodyVersionId?: string,
  metadata?: Record<string, unknown>,
): void {
  const project = storage.inspectProject(context.projectId);
  if (project === null) {
    throw new ToolExecutionFault("PROJECT_NOT_FOUND", "Writing project is unavailable");
  }
  if (expectedBodyVersionId !== undefined && project.latestBodyVersionId !== expectedBodyVersionId) {
    throw new ToolExecutionFault('BASE_VERSION_CONFLICT', 'The body changed before the language review could be reconciled.');
  }
  const rework = storage.listArtifactVersions(context.projectId, 'report', `workflow-invalidated:${context.runId}`).at(-1);
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
      // A completed rework can legitimately keep the same artifact. Its marker
      // must not deduplicate to the earlier, invalidated completion record.
      ...(rework ? { reworkVersionId: rework.id } : {}),
      ...(carriedDecision ? { carriedDecision } : {}),
      ...metadata,
    }),
    reason: reason ?? `workflow-stage-complete:${stage}`,
    requestSnapshotId: null,
    actor: actor(stage, context.runId),
  }));
}

function revisionComparisonContent(runId: string, candidates: { original: ArtifactVersion; revised: ArtifactVersion },
  finalVersionId: string, comparison: ReturnType<typeof parseRevisionComparison>, audit?: unknown): string {
  return JSON.stringify({ schemaVersion: 'revision-comparison-v1', runId,
    originalVersionId: candidates.original.id, revisedVersionId: candidates.revised.id, finalVersionId, ...comparison,
    ...(audit ? { audit } : {}) });
}

function commitRevisionComparison(storage: StoragePort, context: Pick<ToolExecutionContext, 'projectId' | 'runId' | 'operationId'>,
  finalVersionId: string, content: string): void {
  const { projectId, runId, operationId } = context;
  const project = storage.inspectProject(projectId);
  if (project?.latestBodyVersionId !== finalVersionId) {
    throw new ToolExecutionFault('BASE_VERSION_CONFLICT', 'The body changed before its revision comparison could be saved.');
  }
  const key = `revision-comparison:${runId}`;
  value(storage.commitArtifactVersion({ operationId: `${operationId}:comparison`, projectId,
    expectedProjectRevision: project.revision, kind: 'report', logicalKey: key,
    baseVersionId: storage.listArtifactVersions(projectId, 'report', key).at(-1)?.id ?? null,
    content, actor: actor('language_review', runId), reason: 'revision-comparison', requestSnapshotId: null }));
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
  const sequence = workflowStagesForRun(storage, projectId, runId, project.mode);
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
  let sequence = workflowStagesForRun(storage, projectId, runId, mode);
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
  sequence = workflowStagesForRun(storage, projectId, source.id, mode);
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
        undefined,
        { carriedFromMarkerId: marker.id },
      );
    } catch {
      break; // a partial carry still forms a valid contiguous prefix
    }
  }
}

const WRITING_STAGE_SCHEMA = {
  type: "object",
  properties: {
    prewriting: PREWRITING_JSON_SCHEMA,
    reading: READING_JSON_SCHEMA,
    comparison: REVISION_COMPARISON_SCHEMA,
    findings: { anyOf: [REVIEW_FINDINGS_SCHEMA, PERSUASION_FINDINGS_SCHEMA] },
    resolutions: RESOLUTIONS_JSON_SCHEMA,
    audit: REVISION_AUDIT_JSON_SCHEMA,
    paragraphEdits: PARAGRAPH_EDITS_SCHEMA,
    reviewEdits: { anyOf: [REVIEW_EDITS_SCHEMA, REVIEW_EXCERPT_SCHEMA] },
    lintEdits: LINT_SUBMISSION_SCHEMA,
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
      anyOf: [{ type: 'string', minLength: 1, maxLength: 1_000_000 }, COMPACT_RESEARCH_SCHEMA, { type: 'object' }],
      description:
        "Research: submit {sources,claims,notes,editorialPlan} with optional counterclaims. Runtime expands shared sources, keeps usable evidence and counterclaim rows, and normalizes plan references. Legacy ledger strings remain supported. Other stages require a plain Markdown string; body stages contain only the complete article.",
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
            minLength: 1,
            maxLength: 80,
            description: `Display category: prefer ${FactClaimTypeSchema.options.join(', ')}. Other non-empty labels are saved as other; this never changes status, risk, evidence or verification.`,
          },
          location: { type: "string", minLength: 1 },
          status: {
            type: "string",
            enum: FactClaimStatusSchema.options,
            description: 'SUPPORTED requires complete evidence. CONTRADICTED requires direct contrary evidence. An aggregate release or notice to institutions neither establishes nor rules out public lookup: use UNSUPPORTED if access is unverified. Missing author evidence=NEEDS_USER_SOURCE. Partial belongs to supportScope. The app computes passed/blocked.',
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
          checkReason: { type: 'string', enum: ['key_fact', 'suspected_error'], description: 'Preserve the prepared selection reason; required for newly discovered facts. Do not add normal background just for citation completeness.' },
          verificationMethod: { type: 'string', enum: ['external_source', 'material_comparison', 'model_review'],
            description: 'Material agreement is NOT external verification. external_source requires successful tool call IDs and the same specific URL in sourceReference.' },
          verificationRecordIds: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', minLength: 1 },
            description: 'callId values from successful search_fact_sources/read_fact_source results in THIS run, not evidence IDs or failed calls.' },
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
  readonly requireEditorialPlan?: boolean;
  readonly interactionMode?: "autonomous" | "co_creation";
  readonly requiredMaterialIds?: readonly string[];
  readonly completedMaterialIds?: (runId: string) => readonly string[];
  readonly enforceContinuationReads?: boolean;
  readonly requiredInitialArtifactIds?: readonly string[];
  readonly completedArtifactReadIds?: (runId: string) => readonly string[];
  readonly supplementOutline?: OutlineSupplement;
  readonly reviewExcerpt?: ReviewExcerptSelection;
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
  const readyInputsByRun = new Map<string, { key: string; factArtifacts: readonly string[] }>();
  const prewritingRequired = (runId: string) => stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'research'))
    .some(marker => JSON.parse(marker.content).prewritingRequired === true);
  const readerValueRequired = (runId: string) => stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'research'))
    .some(marker => JSON.parse(marker.content).readerValueRequired === true);
  const prewritingReports = () => storage.listArtifactVersions(projectId, 'report', 'prewriting-assessment');
  const boundPrewriting = (runId: string) => {
    const research = stageArtifact(storage, projectId, runId, 'research');
    const markers = stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'research')).map(marker => marker.id);
    const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
    return prewritingReports().filter(report => { const data = JSON.parse(report.content); return data.schemaVersion === 'prewriting-v1' &&
      markers.includes(data.researchMarkerId) && data.researchVersionId === research?.id && data.briefVersionId === briefId; });
  };
  const prewritingApproval = (runId: string): PrewritingAssessment | null => {
    const outline = stageArtifact(storage, projectId, runId, 'outline');
    const report = boundPrewriting(runId).findLast(report => { const data = JSON.parse(report.content); return data.outlineVersionId === outline?.id && data.assessment.decision === 'ready'; });
    return report ? JSON.parse(report.content).assessment : null;
  };
  const pendingPrewritingReturn = (runId: string): ArtifactVersion | null => {
    if (!prewritingRequired(runId) || prewritingApproval(runId)) return null;
    const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
    if (readerValueRequired(runId) && briefId && storage.getWritingBriefVersion(briefId)?.brief.confirmationStatus === 'confirmed') return null;
    const report = boundPrewriting(runId).filter(report => JSON.parse(report.content).assessment.decision !== 'ready').at(-1);
    if (!report) return null;
    // A reply permits a new assessment, never a draft or a fabricated approval.
    if (storage.listRunEvents(runId).some(e => e.type === 'run.resumed' && e.projectSeq > report.createdEventSeq &&
      e.payload.decision !== 'retry_unknown' && e.payload.preservePendingAssignment !== true)) return null;
    return report;
  };
  const savePrewriting = (context: ToolExecutionContext, assessment: PrewritingAssessment, outlineVersionId: string | null) => {
    const project = storage.inspectProject(projectId)!;
    const key = 'prewriting-assessment';
    const prior = prewritingReports().find(report => report.operationId === `${context.operationId}:prewriting`);
    if (prior) {
      const saved = JSON.parse(prior.content);
      if (saved.outlineVersionId !== outlineVersionId || saved.briefVersionId !== project.currentBriefVersionId ||
          saved.researchMarkerId !== stageMarker(storage, projectId, context.runId, 'research')?.id ||
          saved.researchVersionId !== stageArtifact(storage, projectId, context.runId, 'research')?.id || canonicalJson(saved.assessment) !== canonicalJson(assessment)) {
        throw new ToolExecutionFault('PREWRITING_CONFLICT', 'Prewriting inputs changed; assess the current inputs again.');
      }
      return prior;
    }
    const saved = value(storage.commitArtifactVersion({ operationId: `${context.operationId}:prewriting`, projectId,
      expectedProjectRevision: project.revision, kind: 'report', logicalKey: key,
      baseVersionId: prewritingReports().at(-1)?.id ?? null,
      content: JSON.stringify({ schemaVersion: 'prewriting-v1', assessmentOperationId: context.operationId,
        researchVersionId: stageArtifact(storage, projectId, context.runId, 'research')?.id,
        researchMarkerId: stageMarker(storage, projectId, context.runId, 'research')?.id,
        briefVersionId: project.currentBriefVersionId, outlineVersionId, assessment }), reason: 'prewriting-assessment',
      requestSnapshotId: null, actor: actor('outline', context.runId) }));
    return storage.getArtifactVersion(saved.versionId)!;
  };
  const reviewFindingsRequired = (runId: string) => Boolean(options.requireEditorialPlan &&
    (prewritingRequired(runId) || JSON.parse(stageArtifact(storage, projectId, runId, 'research')?.content ?? '{}').editorialPlan));
  const lintSources = (runId: string): LintSource[] => {
    const research = stageArtifact(storage, projectId, runId, 'research');
    if (!research) return [];
    const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
    const brief = briefId ? storage.getWritingBriefVersion(briefId) : null;
    const materials = storage.listMaterials(projectId).filter(material => brief?.brief.materialIds.includes(material.id));
    const confirmedDirection = confirmedWritingDirection(storage, projectId, brief);
    const practicalGuide = Boolean(confirmedDirection) && isPracticalGuide(brief?.brief);
    const readings = withResearchSupplement(storage, runId, research, researchReadings(storage, projectId, research,
      materials, Boolean(confirmedDirection), practicalGuide), prewritingApproval(runId) ?? undefined);
    const local = inlineMaterialContext(materials.filter(material => !material.id.startsWith('intake-user-') &&
      !readings.some(reading => reading.url === material.sourceReference)));
    return [...readings.map(reading => ({ id: reading.url, text: reading.text, instructionAuthority: 'none' as const,
      ...(practicalGuide && reading.sourceType ? { sourceType: reading.sourceType, useBoundary: reading.useBoundary } : {}) })),
      ...local.flatMap(item => item && typeof item === 'object' && !Array.isArray(item) && typeof item.materialId === 'string' &&
        typeof item.content === 'string' ? [{ id: item.materialId, text: item.content, instructionAuthority: 'none' as const }] : [])];
  };
  const protectedHypotheses = (runId: string): string[] => {
    const original = stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'central_revision')).at(-1);
    return original ? JSON.parse(original.content).protectedHypotheses ?? [] : [];
  };
  const checkLintSubmission = (runId: string, base: ArtifactVersion, edits: unknown,
    options: Parameters<typeof applyLintEdits>[5] = {}, legacyInferenceVeto = false) => {
    const editorialPolicy = !isReadingFirstRun(storage, projectId, runId) ? false : legacyInferenceVeto ? true : 'reader_review';
    return applyLintEdits(base.content, base.id, edits, lintSources(runId), protectedHypotheses(runId), {
      ...options,
      trimEditorialAsides: editorialPolicy === 'reader_review',
      validateBody: (content, headingBaseline) => {
        if (content.length > 1_000_000) throw new ToolExecutionFault('FINAL_LINT_INVALID', '这条修改使稿件超出可保存长度。');
        assertCleanBodyStageContent('language_review', content, headingBaseline, editorialPolicy);
      },
    });
  };
  const lintStageData = (lint: ReturnType<typeof applyLintEdits>) => ({
    lintEdits: lint.edits, ...(lint.rejected.length ? { lintRejectedEdits: lint.rejected } : {}),
    ...(lint.editorialCuts.length ? { editorialCuts: lint.editorialCuts } : {}),
  });
  function revisionReturnOwners(runId: string): Set<string> {
    const owners = new Set([runId]);
    for (const stage of ['review_editor', 'review_publish', 'central_revision'] as const) {
      const marker = stageMarker(storage, projectId, runId, stage);
      const artifact = marker ? storage.getArtifactVersion(markerPayload(marker)?.artifactVersionId ?? '') : null;
      if (artifact?.actor.kind === 'agent') owners.add(artifact.actor.runId);
      for (const ancestor of stageMarkerLineage(storage, marker)) {
        if (ancestor.actor.kind === 'agent') owners.add(ancestor.actor.runId);
      }
    }
    return owners;
  }
  function reviewClosure(runId: string, owners?: Set<string>): ReviewClosure | null {
    const evidence = stageArtifact(storage, projectId, runId, 'research');
    const evidenceIds = evidenceIdsFromLedger(evidence?.content ?? '');
    const reviews = (['review_editor', 'review_publish'] as const).filter(stage => !isReadingFirstRun(storage, projectId, runId) || stage === 'review_editor').map(stage => stageArtifact(storage, projectId, runId, stage))
      .filter((review): review is ArtifactVersion => review !== null);
    const findings: BoundReviewFinding[] = [];
    let structured = false;
    for (const review of reviews) {
      const envelope = JSON.parse(review.content) as WritingReviewEnvelope;
      if (!Array.isArray(envelope.findings)) continue;
      structured = true;
      findings.push(...envelope.findings.map((finding, index) => ({ ...finding, id: `${review.id}:${index + 1}`,
        bodyVersionId: envelope.bodyVersionId, reviewVersionId: review.id })));
    }
    if (!structured) return null; // Historical free-text reviews are not fabricated into findings.
    const reviewVersionIds = reviews.map(review => review.id).sort();
    const reports = [...(owners ?? revisionReturnOwners(runId))].flatMap(owner => storage.listArtifactVersions(projectId, 'report', `revision-return:${owner}`))
      .filter(report => { const data = JSON.parse(report.content); return data.schemaVersion === 'revision-return-v1' &&
        JSON.stringify(data.reviewVersionIds) === JSON.stringify(reviewVersionIds); });
    for (const report of reports) {
      const data = JSON.parse(report.content);
      findings.push(...(data.audit.newFindings as ReviewFinding[]).map((finding, index) => ({ ...finding,
        id: `${report.id}:${index + 1}`, bodyVersionId: data.bodyVersionId as string, reviewVersionId: report.id })));
    }
    return { findings, reviewVersionIds, reportVersionIds: reports.map(r => r.id), evidenceIds: [...evidenceIds] };
  }
  // A writer repairs the latest audited version, not every issue ever raised.
  // Keep the full closure for independent audit and provenance. Bind this work
  // set to the assignment's input body, including interrupted-save recovery.
  function revisionWork(runId: string, bodyVersionId: string | null) {
    const closure = reviewClosure(runId);
    if (!closure) return null;
    const accepted = [...revisionReturnOwners(runId)].flatMap(owner => storage.listArtifactVersions(projectId, 'report', `revision-comparison:${owner}`))
      .filter(item => { const saved = JSON.parse(item.content); return saved.finalVersionId === bodyVersionId && saved.audit &&
        JSON.stringify(saved.audit.reviewVersionIds) === JSON.stringify(closure.reviewVersionIds); });
    const report = [...closure.reportVersionIds.map(id => storage.getArtifactVersion(id)!)
      .filter(item => JSON.parse(item.content).bodyVersionId === bodyVersionId), ...accepted]
      .sort((a, b) => b.createdEventSeq - a.createdEventSeq)[0];
    if (!report) return { closure, returnReportId: null };
    const audit = JSON.parse(report.content).audit;
    const unresolved = new Set(audit.checks.filter((check: { verdict: string }) => check.verdict === 'unresolved')
      .map((check: { findingId: string }) => check.findingId));
    const body = bodyVersionId ? storage.getArtifactVersion(bodyVersionId) : null;
    const findings = closure.findings.filter(finding => finding.reviewVersionId === report.id || unresolved.has(finding.id)).map(finding => {
      const check = audit.checks.find((item: { findingId: string }) => item.findingId === finding.id);
      return body && check?.quote && body.content.includes(check.quote) ? { ...finding, quote: check.quote,
        bodyVersionId: body.id, paragraphIds: quoteParagraphIds(body.content, check.quote) } : finding;
    });
    if (!closure.reportVersionIds.includes(report.id)) {
      findings.push(...(audit.newFindings as ReviewFinding[]).map((finding, index) => ({ ...finding,
        id: `${report.id}:${index + 1}`, bodyVersionId: bodyVersionId!, reviewVersionId: report.id })));
    }
    return { closure: { ...closure, findings, reportVersionIds: [...new Set([...closure.reportVersionIds, report.id])] }, returnReportId: report.id };
  }
  function reviewExcerpt(base: ArtifactVersion, findings: readonly BoundReviewFinding[]) {
    return options.reviewExcerpt ? bindReviewExcerpt(base, findings, options.reviewExcerpt) : null;
  }
  function paragraphSubmission(runId: string, bodyVersionId: string | null, args: Partial<SubmitWritingStageArgs>, reconcileRecorded = false) {
    if (args.paragraphEdits === undefined && args.reviewEdits === undefined) return null;
    const base = bodyVersionId ? storage.getArtifactVersion(bodyVersionId) : null;
    const work = revisionWork(runId, bodyVersionId);
    if (args.stage !== 'central_revision' || !base || base.projectId !== projectId || base.kind !== 'body' ||
        args.content !== base.content || !work || (!work.returnReportId && !isReadingFirstRun(storage, projectId, runId))) {
      throw new ToolExecutionFault('PARAGRAPH_EDITS_INVALID', 'Paragraph repair requires the bound current article and its audit.', true);
    }
    if (args.reviewEdits !== undefined) {
      if (args.paragraphEdits !== undefined || !usesFocusedReview(storage, projectId, runId)) {
        throw new ToolExecutionFault('REVIEW_EDITS_INVALID', '仅本轮论点审稿对应的修订可以提交这些局部修改。', true);
      }
      const excerpt = reviewExcerpt(base, work.closure.findings);
      if (excerpt) return excerpt.apply(args.reviewEdits);
      return applyReviewEdits(base.content, base.id, args.reviewEdits, work.closure.findings, lintSources(runId), reconcileRecorded);
    }
    return { ...applyParagraphEdits(base.content, base.id, args.paragraphEdits, work.closure.findings), protectedHypotheses: [] };
  }
  function pendingRevisionReturn(runId: string): ArtifactVersion | null {
    const owners = revisionReturnOwners(runId);
    const closure = reviewClosure(runId, owners);
    if (!closure) return null;
    const central = stageMarkerLineage(storage, stageMarker(storage, projectId, runId, 'central_revision')).at(-1);
    const bodyId = storage.inspectProject(projectId)?.latestBodyVersionId;
    const invalidations = [...owners].flatMap(owner => storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${owner}`));
    return closure.reportVersionIds.map(id => storage.getArtifactVersion(id)!).filter(report => {
      const data = JSON.parse(report.content);
      const consumed = invalidations.some(invalidation => { const saved = JSON.parse(invalidation.content); return saved.revisionReturnId === report.id &&
        saved.revisionInput?.bodyVersionId === data.bodyVersionId; });
      return !consumed && data.bodyVersionId === bodyId && (!central || report.createdEventSeq > central.createdEventSeq);
    }).sort((a, b) => b.createdEventSeq - a.createdEventSeq)[0] ?? null;
  }
  function editorialRecovery(runId: string): EditorialRecovery | null {
    const closure = reviewClosure(runId);
    if (!closure) return null;
    const pending = pendingRevisionReturn(runId);
    if (!pending && !['review_publish', 'review_reader', 'central_revision'].includes(nextStageForRun(runId) ?? '')) return null;
    const data = pending ? JSON.parse(pending.content) : null;
    const unresolved = new Set<string>(data?.audit.checks.filter((check: { verdict: string }) => check.verdict === 'unresolved').map((check: { findingId: string }) => check.findingId) ?? []);
    const relevant = closure.findings.filter(f => f.severity === 'required' && f.recovery &&
      storage.getArtifactVersion(f.reviewVersionId)?.reason !== 'workflow:review_editor' &&
      (!pending || f.reviewVersionId === pending.id || unresolved.has(f.id)));
    if (!relevant.length) return null;
    const reportIds = [...new Set(relevant.map(f => f.reviewVersionId))];
    const after = Math.max(...reportIds.map(id => storage.getArtifactVersion(id)!.createdEventSeq));
    const events = storage.listRunEvents(runId);
    const discussion = events.findLast(e => e.type === 'run.waiting_user' && e.payload.stopReason === 'WRITING_INPUT_REQUIRED' && e.projectSeq > after);
    const answered = discussion && events.some(e => e.type === 'run.resumed' && e.projectSeq > discussion.projectSeq &&
      e.payload.preservePendingAssignment !== true && e.payload.decision !== 'retry_unknown' && typeof e.payload.displayInstruction === 'string');
    return {
      route: answered ? 'outline' : relevant.some(f => f.recovery?.route === 'discuss') ? 'discuss' : 'research',
      reportIds, reason: relevant.map(f => `${f.issue}；需要达到：${f.repairTarget}`).join('\n'),
      queries: [...new Set(relevant.flatMap(f => f.recovery!.queries))].slice(0, 2),
      questions: [...new Set(relevant.flatMap(f => f.recovery!.questions))].slice(0, 2),
    };
  }
  function hasRevisionReturnForAssignment(runId: string, dispatchSeq: number, bodyVersionId: string | null, events: readonly RuntimeEvent[]): boolean {
    if (bodyVersionId === null) return false;
    const reports = storage.listArtifactVersions(projectId, 'report', `revision-return:${runId}`);
    if (reports.length === 0) return false;
    const submissions = new Map(events.filter(event => event.projectSeq > dispatchSeq && event.type === 'tool.requested' &&
      event.payload.actor === 'language_review' && event.payload.toolName === 'submit_writing_stage')
      .map(event => [`${event.operationId}:return`, event.projectSeq]));
    return reports.some(report => {
      const submissionSeq = submissions.get(report.operationId);
      if (submissionSeq === undefined || report.createdEventSeq <= submissionSeq || report.reason !== 'revision-required' ||
          report.actor.kind !== 'agent' || report.actor.runId !== runId) return false;
      const saved = JSON.parse(report.content);
      return saved.schemaVersion === 'revision-return-v1' && saved.bodyVersionId === bodyVersionId && saved.audit?.requiresRevision === true;
    });
  }
  function carriedRevisionRepair(runId: string, stage: WritingWorkflowStage | null): ArtifactVersion | undefined {
    if (stage !== 'central_revision') return undefined;
    const owners = revisionReturnOwners(runId);
    owners.delete(runId);
    if (owners.size === 0) return undefined;
    const closure = reviewClosure(runId, owners);
    const bodyVersionId = storage.inspectProject(projectId)?.latestBodyVersionId;
    const activeReportIds = new Set(closure?.reportVersionIds.filter(id => {
      const report = storage.getArtifactVersion(id);
      return report && JSON.parse(report.content).bodyVersionId === bodyVersionId;
    }));
    if (activeReportIds.size === 0) return undefined;
    return [...owners].flatMap(owner => storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${owner}`))
      .filter(invalidation => {
        const saved = JSON.parse(invalidation.content);
        return invalidation.reason === 'workflow-rework:central_revision' && activeReportIds.has(saved.revisionReturnId) &&
          saved.revisionInput?.bodyVersionId === bodyVersionId;
      }).sort((a, b) => b.createdEventSeq - a.createdEventSeq)[0];
  }
  function saveRevisionReturn(context: ToolExecutionContext, closure: ReviewClosure,
    audit: ReturnType<typeof parseRevisionAudit>): ArtifactVersion {
    const project = storage.inspectProject(projectId)!;
    if (project.latestBodyVersionId !== context.expectedBodyVersionId) throw new ToolExecutionFault('BASE_VERSION_CONFLICT', 'The reviewed article changed.');
    const key = `revision-return:${context.runId}`;
    const saved = value(storage.commitArtifactVersion({ operationId: `${context.operationId}:return`, projectId,
      expectedProjectRevision: project.revision, kind: 'report', logicalKey: key,
      baseVersionId: storage.listArtifactVersions(projectId, 'report', key).at(-1)?.id ?? null,
      content: JSON.stringify({ schemaVersion: 'revision-return-v1', bodyVersionId: project.latestBodyVersionId,
        reviewVersionIds: closure.reviewVersionIds, findingIds: closure.findings.map(f => f.id), audit }), reason: 'revision-required', requestSnapshotId: null,
      actor: actor('language_review', context.runId) }));
    return storage.getArtifactVersion(saved.versionId)!;
  }
  const revisionCandidates = (runId: string) => {
    const evidence = stageArtifact(storage, projectId, runId, 'research');
    // Existing runs remain resumable without manufacturing a plan retrospectively.
    if (!evidence || (!prewritingRequired(runId) && !JSON.parse(evidence.content).editorialPlan)) return null;
    const original = stageArtifact(storage, projectId, runId, 'draft');
    const revised = stageArtifact(storage, projectId, runId, 'central_revision');
    if (!original || !revised) return null;
    const marker = stageMarker(storage, projectId, runId, 'central_revision');
    const reworked = storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${runId}`).length > 0
      || storage.listArtifactVersions(projectId, 'report', `workflow-carried-rework:${runId}`).length > 0;
    return { original, revised, allowOriginal: interactionMode === 'autonomous' && !reworked &&
      !reviewClosure(runId)?.findings.some(finding => finding.severity === 'required') &&
      !(marker && stageDecision(storage, marker)) };
  };
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

  function recoverLanguageReview(runId: string, events: readonly RuntimeEvent[]): ArtifactVersion | null {
    if (factCheckOnly || !options.requireEditorialPlan) return null;
    const dispatch = events.findLast(event => event.type === 'tool.completed' && (event.payload.result as { toolName?: string })?.toolName === 'director_decide');
    const assignment = (dispatch?.payload.result as { result?: { collaboration?: {
      actor?: string; stage?: string; status?: string; decisionId?: string; expectedBodyVersionId?: string; inputVersionIds?: string[];
    } } } | undefined)?.result?.collaboration;
    if (!dispatch || assignment?.actor !== 'language_review' || assignment.stage !== 'language_review' ||
        assignment.status !== 'dispatched' || assignment.decisionId !== dispatch.operationId || !assignment.expectedBodyVersionId) return null;
    const isSubmission = (event: RuntimeEvent) => event.projectSeq > dispatch.projectSeq && event.type === 'tool.requested' &&
      event.projectId === projectId && event.runId === runId &&
      event.payload.actor === 'language_review' && event.payload.toolName === 'submit_writing_stage';
    const latestSubmission = events.findLast(isSubmission);
    if (!latestSubmission || events.some(event => event.operationId === latestSubmission.operationId && event.type === 'tool.completed')) return null;
    const latestBodyId = storage.inspectProject(projectId)?.latestBodyVersionId;
    const body = latestBodyId ? storage.getArtifactVersion(latestBodyId) : null;
    if (!body || body.projectId !== projectId || body.kind !== 'body' || body.logicalKey !== 'main') return null;
    const report = storage.listArtifactVersions(projectId, 'report', `revision-comparison:${runId}`).at(-1);
    const currentMarker = stageMarker(storage, projectId, runId, 'language_review');
    const focused = usesFocusedReview(storage, projectId, runId);
    const request = events.findLast(event => isSubmission(event) && (body.operationId === `${event.operationId}:artifact` ||
      (body.id === assignment.expectedBodyVersionId && (focused ? currentMarker?.operationId === `${event.operationId}:marker`
        : report?.operationId === `${event.operationId}:comparison`))));
    if (!request || events.some(event => event.operationId === request.operationId && event.type === 'tool.completed')) return null;
    const args = request.payload.arguments as Partial<SubmitWritingStageArgs> | undefined;
    if (args?.stage !== 'language_review') return null;

    const operationId = request.operationId;
    const marker = currentMarker;
    if (marker) {
      const binding = markerPayload(marker);
      if (marker.operationId !== `${operationId}:marker` || binding?.artifactVersionId !== body.id ||
          binding.runId !== runId || binding.stage !== 'language_review') return null;
    } else if (nextStageForRun(runId) !== 'language_review') return null;
    const hasReport = report?.operationId === `${operationId}:comparison`;
    if (!hasReport && report && report.createdEventSeq > request.projectSeq) return null;
    const newBody = body.operationId === `${operationId}:artifact` && body.reason === 'workflow:language_review' &&
      body.actor.kind === 'agent' && body.actor.runId === runId && body.createdEventSeq > request.projectSeq &&
      body.parentVersionIds.length === 1 && body.parentVersionIds[0] === assignment.expectedBodyVersionId;
    if (focused) {
      const base = stageArtifact(storage, projectId, runId, 'central_revision');
      if (!base || base.id !== assignment.expectedBodyVersionId || args.content !== base.content ||
          !assignment.inputVersionIds?.includes(base.id) || (!newBody && !(marker && body.id === base.id))) return null;
      try {
        const recorded = marker ? JSON.parse(marker.content) : undefined;
        const matchesSaved = (lint: ReturnType<typeof checkLintSubmission>) => lint.content === body.content &&
          (!recorded || (canonicalJson(recorded.lintEdits) === canonicalJson(lint.edits) &&
            canonicalJson(recorded.editorialCuts ?? []) === canonicalJson(lint.editorialCuts) &&
            canonicalJson(recorded.lintRejectedEdits ?? []) === canonicalJson(lint.rejected)));
        let lint = checkLintSubmission(runId, base, args.lintEdits);
        // A skipped edit can leave identical prose with a different receipt.
        for (const olderChecks of [{}, { checkLocalSampleSizes: false }, { checkLocalSampleSizes: false, checkDetachedReferences: false }]) {
          if (matchesSaved(lint)) break;
          lint = checkLintSubmission(runId, base, args.lintEdits, olderChecks, true);
        }
        if (!matchesSaved(lint)) {
          // Older receipts contain only fully accepted batches. Recover one only if it reproduces the committed body exactly.
          const legacy = applyLintEdits(base.content, base.id, args.lintEdits, lintSources(runId), protectedHypotheses(runId),
            { checkIntroducedRepeats: false, checkDetachedReferences: false, checkLocalSampleSizes: false });
          if (legacy.rejected.length || !matchesSaved(legacy)) return null;
          lint = legacy;
        }
        if (marker) return marker;
        markStage(storage, { projectId, runId, operationId }, 'language_review', body.id, undefined, undefined, body.id,
          lintStageData(lint));
        return stageMarker(storage, projectId, runId, 'language_review');
      } catch {
        return null; // The normal stage retry retains the already-saved body.
      }
    }
    if (args.content !== body.content || args.comparison === undefined) return null;
    // An unchanged submission has no new body version. Its own comparison
    // receipt is enough to prove progress when the bound body is still current.
    if (!newBody && !(hasReport && body.id === assignment.expectedBodyVersionId)) return null;
    try {
      const candidates = revisionCandidates(runId);
      if (!candidates || candidates.revised.id !== assignment.expectedBodyVersionId ||
          !assignment.inputVersionIds?.includes(candidates.original.id) || !assignment.inputVersionIds.includes(candidates.revised.id)) return null;
      const readOnlyAudit = isReadOnlyRevisionAudit(storage, projectId, runId);
      if (readOnlyAudit && body.id !== candidates.revised.id) return null;
      const comparison = parseRevisionComparison(args.comparison, readOnlyAudit ? { ...candidates, allowOriginal: false } : candidates, body.content);
      const closure = reviewClosure(runId);
      const audit = closure ? parseRevisionAudit(args.audit, closure.findings, body.content, new Set(closure.evidenceIds), undefined, readerValueRequired(runId)) : undefined;
      if (audit?.requiresRevision) return null;
      const selected = comparison.selectedVersionId === candidates.original.id ? candidates.original : candidates.revised;
      assertCleanBodyStageContent('language_review', body.content, selected.content, isReadingFirstRun(storage, projectId, runId));
      const content = revisionComparisonContent(runId, candidates, body.id, comparison,
        audit && closure ? { ...audit, reviewVersionIds: closure.reviewVersionIds } : undefined);
      if (hasReport && (report.actor.kind !== 'agent' || report.actor.runId !== runId || report.reason !== 'revision-comparison' ||
          report.createdEventSeq <= request.projectSeq || canonicalJson(JSON.parse(report.content)) !== canonicalJson(JSON.parse(content)))) return null;
      if (marker && (!hasReport || marker.createdEventSeq <= report.createdEventSeq)) return null;
      const context = { projectId, runId, operationId };
      if (!hasReport) commitRevisionComparison(storage, context, body.id, content);
      if (marker) return marker;
      markStage(storage, context, 'language_review', body.id, undefined, undefined, body.id);
      return stageMarker(storage, projectId, runId, 'language_review');
    } catch {
      return null;
    }
  }

  function recoverCentralRevision(runId: string, events: readonly RuntimeEvent[]): ArtifactVersion | null {
    const closure = reviewClosure(runId);
    if (!closure) return null;
    const dispatch = events.findLast(event => event.type === 'tool.completed' && (event.payload.result as any)?.toolName === 'director_decide');
    const assignment = (dispatch?.payload.result as any)?.result?.collaboration;
    if (!dispatch || assignment?.actor !== 'central_revision' || assignment.stage !== 'central_revision' ||
        assignment.status !== 'dispatched' || assignment.decisionId !== dispatch.operationId) return null;
    const request = events.findLast(event => event.projectSeq > dispatch.projectSeq && event.type === 'tool.requested' &&
      event.payload.actor === 'central_revision' && event.payload.toolName === 'submit_writing_stage');
    if (!request || events.some(event => event.operationId === request.operationId && event.type === 'tool.completed')) return null;
    const bodyId = storage.inspectProject(projectId)?.latestBodyVersionId;
    const body = bodyId ? storage.getArtifactVersion(bodyId) : null;
    const args = request.payload.arguments as Partial<SubmitWritingStageArgs> | undefined;
    let paragraphRepair: ReturnType<typeof paragraphSubmission> = null;
    try { paragraphRepair = args ? paragraphSubmission(runId, assignment.expectedBodyVersionId, args, true) : null; } catch { return null; }
    if (!body || args?.stage !== 'central_revision' || (paragraphRepair?.content ?? args.content) !== body.content ||
        !closure.reviewVersionIds.every(id => assignment.inputVersionIds.includes(id))) return null;
    const ownBody = body.operationId === `${request.operationId}:artifact` && body.actor.kind === 'agent' && body.actor.runId === runId &&
      body.reason === 'workflow:central_revision' && body.createdEventSeq > request.projectSeq &&
      body.parentVersionIds.length === 1 && body.parentVersionIds[0] === assignment.expectedBodyVersionId;
    const marker = stageMarker(storage, projectId, runId, 'central_revision');
    // requestPolicy also runs immediately after tool.requested, before execute.
    // A no-op body has no durable write proof: only its already-saved marker
    // can be reconciled. Before-marker failures safely retry the same stage.
    if (!ownBody && !(body.id === assignment.expectedBodyVersionId && marker?.operationId === `${request.operationId}:marker`)) return null;
    if (!marker && nextStageForRun(runId) !== 'central_revision') return null;
    try {
      const work = revisionWork(runId, assignment.expectedBodyVersionId)?.closure ?? closure;
      const resolutions = paragraphRepair || args.resolutions === undefined && needsArticleRedevelopment(work.findings)
        ? undefined : parseReviewResolutions(args.resolutions, work.findings, body.content);
      assertCleanBodyStageContent('central_revision', body.content, undefined, isReadingFirstRun(storage, projectId, runId));
      if (marker) {
        const saved = JSON.parse(marker.content);
        return marker.operationId === `${request.operationId}:marker` && saved.artifactVersionId === body.id &&
          canonicalJson(saved.resolutions ?? null) === canonicalJson(resolutions ?? null) &&
          canonicalJson(saved.reviewEdits ?? null) === canonicalJson(args.reviewEdits ?? null) &&
          canonicalJson(saved.protectedHypotheses ?? []) === canonicalJson(paragraphRepair?.protectedHypotheses ?? []) &&
          (resolutions !== undefined || saved.revisionMode === (paragraphRepair ? 'paragraphs' : 'redevelop')) &&
          canonicalJson(saved.reviewVersionIds) === canonicalJson(closure.reviewVersionIds) ? marker : null;
      }
      markStage(storage, { projectId, runId, operationId: request.operationId }, 'central_revision', body.id, undefined, undefined, body.id,
        { ...(resolutions ? { resolutions } : { revisionMode: paragraphRepair ? 'paragraphs' : 'redevelop' }),
          ...(paragraphRepair ? { baseBodyVersionId: assignment.expectedBodyVersionId,
            ...(args.reviewEdits === undefined ? { paragraphEdits: args.paragraphEdits } : { reviewEdits: args.reviewEdits,
              protectedHypotheses: paragraphRepair.protectedHypotheses }) } : {}), reviewVersionIds: closure.reviewVersionIds });
      return stageMarker(storage, projectId, runId, 'central_revision');
    } catch { return null; }
  }

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
      stages: workflowStagesForRun(storage, projectId, runId, mode).map(stage => stageMarker(storage, projectId, runId, stage)?.id ?? null),
      rework: storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${runId}`).at(-1)?.id ?? null,
    });
  };
  const isReady = (runId: string): boolean =>
    nextStageForRun(runId) === null || readyInputsByRun.get(runId)?.key === readinessKey(runId);

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
          carriedRevisionRepair(context.runId, stage),
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

  const assertReadinessPrerequisites = (context: ToolExecutionContext, deliveredArtifacts: readonly string[] = []): void => {
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
    const unreadArtifacts = requiredContextArtifacts(context, nextStageForRun(context.runId)).filter(a => unreadIds.has(a.artifactVersionId) && !deliveredArtifacts.includes(a.artifactVersionId));
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
    const delivered = stage === 'fact_check' && isReady(context.runId) ? readyInputsByRun.get(context.runId)?.factArtifacts : undefined;
    const completed = new Set([...(completedArtifactReadIds?.(context.runId) ?? []), ...(delivered ?? [])]);
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

  const approveReadiness = (context: ToolExecutionContext, reason: string, deliveredArtifacts: readonly string[] = []): JsonValue => {
    if (context.projectId !== projectId) throw new ToolExecutionFault('PROJECT_SCOPE_MISMATCH', 'Workflow belongs to another project');
    if (!reason.trim()) throw new ToolExecutionFault('WRITING_READINESS_INVALID', 'A readiness reason is required');
    const nextStage = nextStageForRun(context.runId);
    const factArtifacts = nextStage === 'fact_check' ? deliveredArtifacts : [];
    assertReadinessPrerequisites(context, factArtifacts);
    readyInputsByRun.set(context.runId, { key: readinessKey(context.runId), factArtifacts });
    return { status: 'ready', reason: reason.trim(), questions: [], nextStage };
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
        return approveReadiness(context, reason);
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
    inputSchema: options.requireEditorialPlan ? { ...WRITING_STAGE_SCHEMA, properties: { ...WRITING_STAGE_SCHEMA.properties,
      content: { ...WRITING_STAGE_SCHEMA.properties.content, anyOf: [WRITING_STAGE_SCHEMA.properties.content.anyOf[0],
        { ...COMPACT_RESEARCH_SCHEMA, required: [...COMPACT_RESEARCH_SCHEMA.required, 'editorialPlan'] },
        WRITING_STAGE_SCHEMA.properties.content.anyOf[2]] },
    } } : WRITING_STAGE_SCHEMA,
    effect: "local_idempotent",
    permissions: ["workflow:submit"],
    execute(args, context) {
      if (context.projectId !== projectId) {
        throw new ToolExecutionFault("PROJECT_SCOPE_MISMATCH", "Workflow belongs to another project");
      }
      assertWritingReady(context);
      assertExpectedStage(storage, context, mode, args.stage);
      assertContinuationContextRead(context, args.stage);
      if (args.stage !== 'research' && typeof args.content !== 'string') {
        throw new ToolExecutionFault('TOOL_INPUT_INVALID', 'Only research accepts structured content; this stage requires a complete Markdown string.');
      }
      const paragraphRepair = paragraphSubmission(context.runId, context.expectedBodyVersionId, args);
      const focused = usesFocusedReview(storage, projectId, context.runId);
      const focusedCritic = focused && args.stage === 'review_editor';
      const focusedLint = focused && args.stage === 'language_review';
      let lint: ReturnType<typeof applyLintEdits> | undefined;
      if (focusedLint) {
        const base = stageArtifact(storage, projectId, context.runId, 'central_revision');
        if (!base || base.id !== context.expectedBodyVersionId || args.content !== base.content) {
          throw new ToolExecutionFault('BASE_VERSION_CONFLICT', '终稿检查需要使用这次任务绑定的修订稿。');
        }
        if (args.audit !== undefined || args.comparison !== undefined) {
          throw new ToolExecutionFault('FINAL_LINT_INVALID', '终稿检查只提交局部修改。', true);
        }
        lint = checkLintSubmission(context.runId, base, args.lintEdits);
      } else if (args.lintEdits !== undefined) {
        throw new ToolExecutionFault('FINAL_LINT_INVALID', '只有终稿检查可以提交这组局部修改。', true);
      }
      if (focused && args.stage === 'central_revision' && args.reviewEdits === undefined) {
        throw new ToolExecutionFault('REVIEW_EDITS_INVALID', '仅提交绑定审稿原句的局部修改，没出处的反例用假设。', true);
      }
      let content = lint?.content ?? paragraphRepair?.content ?? (typeof args.content === 'string' ? args.content : JSON.stringify(args.content));
      // A locally persisted return is an idempotent handoff, not a completed
      // language stage. Reconcile it before its new findings join the next pass.
      const priorReturn = args.stage === 'language_review' ? storage.listArtifactVersions(projectId, 'report', `revision-return:${context.runId}`)
        .find(report => report.operationId === `${context.operationId}:return`) : undefined;
      if (priorReturn) {
        const saved = JSON.parse(priorReturn.content);
        const { requiresRevision: _requiresRevision, ...submittedAudit } = saved.audit;
        const currentRevision = stageArtifact(storage, projectId, context.runId, 'central_revision');
        const priorClosure = reviewClosure(context.runId)!;
        const normalized = parseRevisionAudit(args.audit, priorClosure.findings.filter(f => f.reviewVersionId !== priorReturn.id),
          content, new Set(priorClosure.evidenceIds), currentRevision?.content, readerValueRequired(context.runId));
        const { requiresRevision: _normalizedRequiresRevision, ...normalizedAudit } = normalized;
        if (storage.inspectProject(projectId)?.latestBodyVersionId !== saved.bodyVersionId || context.expectedBodyVersionId !== saved.bodyVersionId ||
            currentRevision?.id !== saved.bodyVersionId || canonicalJson(submittedAudit) !== canonicalJson(normalizedAudit)) {
          throw new ToolExecutionFault('REVISION_RETURN_CONFLICT', 'The pending return no longer matches this article and submission.');
        }
        return { handoff: { kind: 'revision_required', reportId: priorReturn.id, bodyVersionId: saved.bodyVersionId },
          message: '终审发现仍需修正的内容，已交回主笔继续修订。当前稿件已保留。' };
      }
      if (content.length > 1_000_000) throw new ToolExecutionFault('TOOL_INPUT_INVALID', 'Stage content exceeds the supported size; no content was saved or truncated.');
      if (/^(?:正在|仍在)(?:整理|生成|撰写|提交|保存)(?:文章)?(?:提纲|大纲|正文|稿件|本阶段(?:成果|内容))?[。！!…\s]*$/u.test(content.trim())) {
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
      let researchAdjustment: Omit<ReturnType<typeof prepareResearchEvidence>, 'content'> | undefined;
      if (args.stage === 'research') {
        const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
        const briefVersion = briefId ? storage.getWritingBriefVersion(briefId) : null;
        const confirmedDirection = Boolean(confirmedWritingDirection(storage, projectId, briefVersion));
        const { content: prepared, ...adjustment } = prepareResearchEvidence(content, { requirePlan: options.requireEditorialPlan === true, confirmedDirection });
        if (options.requireEditorialPlan && !confirmedDirection && adjustment.planStatus === 'skipped') {
          throw new ToolExecutionFault('EDITORIAL_PLAN_INVALID', 'There is no confirmed writing direction and no usable editorial plan.', true);
        }
        content = prepared;
        if (adjustment.omittedClaims || adjustment.omittedCounterclaims || adjustment.normalizedClaimIds || adjustment.damagedPayload || adjustment.planStatus || adjustment.discardedLegacyMetadata) {
          researchAdjustment = adjustment;
        }
      }
      if (args.prewriting !== undefined && args.stage !== 'outline') throw new ToolExecutionFault('PREWRITING_UNEXPECTED', 'Only the outline editor submits prewriting.');
      let prewriting: PrewritingAssessment | undefined;
      if (args.stage === 'outline' && prewritingRequired(context.runId)) {
        const research = stageArtifact(storage, projectId, context.runId, 'research')!;
        const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
        const briefVersion = briefId ? storage.getWritingBriefVersion(briefId) : null;
        const readingSelection = readerValueRequired(context.runId);
        const confirmedDirection = readingSelection ? confirmedWritingDirection(storage, projectId, briefVersion) : undefined;
        const materials = storage.listMaterials(projectId).filter(material => !confirmedDirection || briefVersion!.brief.materialIds.includes(material.id));
        const authorWords = materials.filter(material =>
          material.id.startsWith('intake-user-') || material.role === 'user_firsthand').map(material => material.content);
        const focus = confirmedDirection ? confirmedWritingFocus(confirmedDirection, authorWords) : undefined;
        const practicalGuide = Boolean(confirmedDirection) && isPracticalGuide(briefVersion?.brief);
        const sources = withResearchSupplement(storage, context.runId, research,
          researchReadings(storage, projectId, research, materials, Boolean(confirmedDirection), practicalGuide));
        try {
          prewriting = parsePrewriting(args.prewriting, research.content, content, readingSelection,
            confirmedDirection ? { direction: confirmedDirection, sources, authorWords, practicalGuide, ...(focus ? { focus } : {}) } : undefined);
          if (!confirmedDirection) validateReadingRoute(prewriting, sources);
        }
        catch (error) { throw new ToolExecutionFault('PREWRITING_INVALID', error instanceof Error ? error.message : 'Prewriting assessment required', true); }
        if (confirmedDirection && usesPublicSources(briefVersion?.brief)) {
          const supplement = options.supplementOutline?.(context, prewriting, sources, research, focus);
          // Re-entry skips already attempted queries.
          if (supplement) return supplement.then(result => result ?? submitWritingStage.execute(args, context));
        }
        content = prewritingContent(prewriting, content);
        if (prewriting.decision !== 'ready') {
          const report = savePrewriting(context, prewriting, null);
          readyInputsByRun.delete(context.runId);
          return { handoff: { kind: 'prewriting_required', reportId: report.id },
            message: '提纲 Agent 发现文章的关键问题还没有讲清，正在安排补查或与你确认切口。' };
        }
      }
      if (args.stage === 'draft' && prewritingRequired(context.runId) && !prewritingApproval(context.runId)) {
        throw new ToolExecutionFault('PREWRITING_REQUIRED', 'The bound research and outline must pass the prewriting assessment before drafting. Author confirmation is not evidence.');
      }
      if (args.stage === "central_revision") {
        assertReviewsBoundToDraft(storage, context, mode);
        if (editorialRecovery(context.runId)) throw new ToolExecutionFault('EDITORIAL_RECOVERY_REQUIRED', 'The core promise needs research or author discussion before rewriting; do not submit a cosmetic repair.');
      }
      const closure = args.stage === 'central_revision'
        ? revisionWork(context.runId, context.expectedBodyVersionId)?.closure ?? null : reviewClosure(context.runId);
      const reviewStage = args.stage === 'review_editor' || args.stage === 'review_publish';
      if (focusedCritic && args.reading !== undefined) {
        throw new ToolExecutionFault('REVIEW_FINDINGS_INVALID', '本轮审稿只提交最多两条论点漏洞或现实反例。', true);
      }
      if (args.reading !== undefined && args.stage !== 'review_editor') throw new ToolExecutionFault('READING_ASSESSMENT_UNEXPECTED', 'Only the cold editor submits the initial reading assessment.');
      const reading = args.stage === 'review_editor' && !focusedCritic && (readerValueRequired(context.runId) || args.reading !== undefined)
        ? parseReadingAssessment(args.reading, stageArtifact(storage, projectId, context.runId, 'draft')!.content, 'REVIEW_FINDINGS_INVALID', true) : undefined;
      const findings = focusedCritic ? validatePersuasionFindings(args.findings,
        stageArtifact(storage, projectId, context.runId, 'draft')!.content)
        : reviewStage && (reviewFindingsRequired(context.runId) || args.findings !== undefined)
        ? args.stage === 'review_editor'
          ? validateColdReviewFindings(args.findings, stageArtifact(storage, projectId, context.runId, 'draft')!.content, reading)
          : validateReviewFindings(args.findings, stageArtifact(storage, projectId, context.runId, 'draft')!.content,
            new Set(evidenceIdsFromLedger(stageArtifact(storage, projectId, context.runId, 'research')?.content ?? '')))
        : undefined;
      if (focusedCritic && findings) {
        content = findings.length ? findings.map(({ issue }, index) => `${index + 1}. ${issue}`).join('\n\n')
          : '没有发现需要处理的论点漏洞。';
      }
      if (args.findings !== undefined && !reviewStage) throw new ToolExecutionFault('REVIEW_FINDINGS_UNEXPECTED', 'Only independent reviews submit findings.');
      if (args.resolutions !== undefined && args.stage !== 'central_revision') throw new ToolExecutionFault('REVIEW_RESOLUTIONS_UNEXPECTED', 'Only central revision submits resolutions.');
      if (args.audit !== undefined && args.stage !== 'language_review') throw new ToolExecutionFault('REVISION_AUDIT_UNEXPECTED', 'Only final review submits audit.');
      const resolutions = args.stage === 'central_revision' && closure && !paragraphRepair &&
        (args.resolutions !== undefined || !needsArticleRedevelopment(closure.findings))
        ? parseReviewResolutions(args.resolutions, closure.findings, content) : undefined;
      let audit: ReturnType<typeof parseRevisionAudit> | undefined;
      const readOnlyAudit = args.stage === 'language_review' && isReadOnlyRevisionAudit(storage, projectId, context.runId);
      if (args.stage === 'language_review' && closure && !focusedLint) {
        const currentBody = stageArtifact(storage, projectId, context.runId, 'central_revision');
        if (!currentBody || currentBody.id !== context.expectedBodyVersionId) {
          throw new ToolExecutionFault('BASE_VERSION_CONFLICT', 'Final review requires the exact central revision bound to this assignment.');
        }
        if (readOnlyAudit && content !== currentBody.content) {
          throw new ToolExecutionFault('REVISION_AUDIT_READ_ONLY', 'Audit the bound revision without replacing its content. Return findings for the writer to repair.', true);
        }
        audit = parseRevisionAudit(args.audit, closure.findings, content, new Set(closure.evidenceIds), currentBody.content, readerValueRequired(context.runId));
        if (audit.requiresRevision) {
          const report = saveRevisionReturn(context, closure, audit);
          return { handoff: { kind: 'revision_required', reportId: report.id, bodyVersionId: currentBody.id },
            message: '终审发现文章还需要完善，正在安排下一步。当前稿件已保留。' };
        }
      }
      const candidates = args.stage === 'language_review' && !focusedLint ? revisionCandidates(context.runId) : null;
      const comparison = candidates ? parseRevisionComparison(args.comparison, readOnlyAudit ? { ...candidates, allowOriginal: false } : candidates, content) : null;
      if (args.comparison !== undefined && !candidates) throw new ToolExecutionFault('REVISION_COMPARISON_UNEXPECTED', 'Comparison is only accepted for the bound final review.');
      if (!lint && (
        args.stage === "draft" ||
        args.stage === "central_revision" ||
        args.stage === "language_review"
      )) {
        const languageSource = args.stage === "language_review" ? markerPayload(stageMarker(storage, context.projectId, context.runId, "central_revision")) : null;
        const selected = candidates && comparison ? (comparison.selectedVersionId === candidates.original.id ? candidates.original : candidates.revised) : null;
        const structureBaseline = selected?.content ??
          (languageSource === null ? undefined : storage.getArtifactVersion(languageSource.artifactVersionId)?.content);
        assertCleanBodyStageContent(args.stage, content, structureBaseline, isReadingFirstRun(storage, projectId, context.runId));
      }
      const artifact = commitStageArtifact(storage, context, args.stage, content, findings, reading);
      if (prewriting) savePrewriting(context, prewriting, artifact.id);
      if (comparison && candidates) {
        commitRevisionComparison(storage, context, artifact.id, revisionComparisonContent(context.runId, candidates, artifact.id, comparison,
          audit && closure ? { ...audit, reviewVersionIds: closure.reviewVersionIds } : undefined));
      }
      markStage(storage, context, args.stage, artifact.id, undefined, undefined, lint || comparison || resolutions || args.stage === 'central_revision' && closure ? artifact.id : undefined,
        { ...(prewriting?.readingRoute ? { readingFirst: true, focusedReview: true } : {}),
          ...(lint ? lintStageData(lint) : {}),
          ...(args.stage === 'central_revision' && closure ? { ...(resolutions ? { resolutions } : { revisionMode: paragraphRepair ? 'paragraphs' : 'redevelop' }),
          ...(paragraphRepair ? { baseBodyVersionId: context.expectedBodyVersionId,
            ...(args.reviewEdits === undefined ? { paragraphEdits: args.paragraphEdits } : { reviewEdits: args.reviewEdits,
              protectedHypotheses: paragraphRepair.protectedHypotheses }) } : {}), reviewVersionIds: closure.reviewVersionIds } : {}),
          ...(args.stage === 'research' && options.requireEditorialPlan ? { prewritingRequired: true, readerValueRequired: true } : {}) });
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
        ...(lint ? { lintAppliedIndexes: lint.appliedIndexes, lintRejectedEdits: lint.rejected,
          ...(lint.editorialCuts.length ? { editorialCuts: lint.editorialCuts } : {}),
          ...(lint.rejected.length ? { message: `终审已保存 ${lint.appliedIndexes.length} 条修改，跳过 ${lint.rejected.length} 条。可在本步输出里查看原因。` } : {}) } : {}),
        ...(args.stage === "research"
          ? {
              evidenceIds: [...evidenceIdsFromLedger(artifact.content)],
              ...(researchAdjustment ? { researchAdjustment } : {}),
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
      "Compare prepared important facts with available sources. Only red-risk significant errors or unresolved critical facts block delivery; medium/low risks do not. Runtime validates the report and provenance.",
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
      const runEvents = storage.listRunEvents(context.runId);
      const searchLimitations = factSearchLimitations(runEvents);
      const preparation = (runEvents.findLast(event => event.type === 'tool.completed' &&
        (event.payload.result as any)?.ok === true && (event.payload.result as any)?.toolName === 'prepare_fact_check')?.payload.result as any)?.result;
      const claims = normalizeFactVerification(runEvents, preparation?.bodyVersionId === body.id && preparation?.evidenceVersionId === evidence.id ? preparation : null,
        // Category is presentation metadata, not a factual verdict. Avoid a
        // full model rewrite just for an invented label; all gate/provenance
        // fields retain their existing strict validation. Raw args stay in trace.
        args.claims.map(claim => FactClaimTypeSchema.safeParse(claim.claimType).success ? claim : { ...claim, claimType: 'other' as const }));
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
      const selectedTitle = project.currentTitleVersionId ? storage.getArtifactVersion(project.currentTitleVersionId) : null;
      if ((interactionMode === 'co_creation' || selectedTitle?.reason === 'author-publication-selection') && !isPublicationSelectionCurrent(storage, context.projectId)) {
        throw new ToolExecutionFault('PUBLICATION_SELECTION_REQUIRED', '先在主对话确认发布标题，再核查该标题与正文，不得把生成的标题冒充用户选择。');
      }
      const titleContent = selectedTitle?.reason === 'author-publication-selection' ? selectedTitle.content
        : defaultFactTitleContent(body.content);
      // Run the SAME pure fact policy before any mutation. A rejected model
      // submission must not change the title pointer, snapshot or extraction
      // binding. Persisted evaluation below still rechecks the actual versions.
      try {
        const preview = createFactCheckInputSnapshot({ snapshotId: `${context.operationId}:preflight`,
          bodyVersionId: body.id, bodyContent: body.content, evidenceVersionId: evidence.id, evidenceContent: evidence.content,
          titleVersionId: selectedTitle?.id ?? `${context.operationId}:pending-title`, titleContent });
        evaluateFactCheck(preview, { bodyContent: body.content, evidenceContent: evidence.content, titleContent }, {
          schemaVersion: 'fact-check-v2', snapshotId: preview.snapshotId, bodyVersionId: body.id, titleVersionId: preview.titleVersionId,
          coverage: { body: true, title: true, distributionCopy: true }, claims, noFactualClaimsReason: args.noFactualClaimsReason,
        });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('FACT_')) {
          throw new ToolExecutionFault(error.message, '核查提交未通过事实门禁；未改变标题、核查快照或已抽取条目。请修正本次提交后重试，不需重新抽取全文。');
        }
        throw error;
      }
      const titleCommit = selectedTitle?.reason === 'author-publication-selection' ||
        (selectedTitle?.reason === 'workflow:fact-check-title' && selectedTitle.content === titleContent) ? null : storage.commitArtifactVersion({
        operationId: `${context.operationId}:title`,
        projectId: context.projectId,
        expectedProjectRevision: project.revision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: project.currentTitleVersionId,
        content: titleContent,
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
          claims,
          noFactualClaimsReason: args.noFactualClaimsReason,
          ...(searchLimitations.length ? { searchLimitations } : {}),
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
    const sequence = workflowStagesForRun(storage, projectId, runId, mode);
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
    requireEditorialPlan: options.requireEditorialPlan ?? false,
    prewritingRequired,
    readerValueRequired,
    editorialRecovery,
    prewritingApproval,
    pendingPrewritingReturn,
    revisionCandidates,
    reviewClosure,
    revisionWork,
    reviewExcerpt,
    reviewFindingsRequired,
    lintSources,
    protectedHypotheses,
    pendingRevisionReturn,
    hasRevisionReturnForAssignment,
    recoverCentralRevision,
    isReady,
    approveReadiness,
    recoverConfirmedBody,
    recoverLanguageReview,
    pendingCheckpoint(runId) {
      seedCarryOnce(runId);
      if (factCheckOnly) return null;
      const pending = pendingStageCheckpoint(storage, projectId, runId);
      return pending ?? (interactionMode === 'co_creation' && recoverLanguageReview(runId, storage.listRunEvents(runId))
        ? pendingStageCheckpoint(storage, projectId, runId) : null);
    },
    unreadReadinessArtifactIds,
    invalidate(context, stage) {
      const revisionReturn = stage === 'central_revision' ? pendingRevisionReturn(context.runId) : null;
      const prewritingReturn = stage === 'research' ? pendingPrewritingReturn(context.runId) : null;
      const editorial = ['research', 'outline'].includes(stage) ? editorialRecovery(context.runId) : null;
      const sequence = workflowStagesForRun(storage, projectId, context.runId, mode);
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
          ...(prewritingReturn ? { prewritingReturnId: prewritingReturn.id } : {}),
          ...(editorial ? { editorialRecovery: editorial } : {}),
          ...(revisionReturn ? { revisionReturnId: revisionReturn.id } : {}),
          ...(stage === "central_revision" && project.latestBodyVersionId !== null ? { revisionInput: { bodyVersionId: project.latestBodyVersionId, factCheck: storage.getFactCheckStatus(projectId) } } : {}) }), reason: `workflow-rework:${stage}`,
        requestSnapshotId: null, actor: { kind: "agent", id: "writing-pack/director", runId: context.runId } }));
      // Rework introduces a new bound context report. Retiring the old admission
      // exposes that report to the director before dispatch, instead of letting
      // the writer finish and then rejecting its save for an invisible reread.
      readyInputsByRun.delete(context.runId);
      return affected;
    },
    definitions: (factCheckOnly
      ? [submitFactCheck]
      : [assessWritingReadiness, submitWritingStage, submitFactCheck]) as unknown as readonly ToolDefinition<never, JsonValue>[],
    progress(runId) {
      seedCarryOnce(runId);
      const sequence = factCheckOnly
        ? (["fact_check"] as const)
        : workflowStagesForRun(storage, projectId, runId, mode);
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
          ...(nextStage === 'research' ? (() => {
            const invalidation = storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${runId}`).at(-1);
            const id = invalidation ? JSON.parse(invalidation.content).prewritingReturnId : null;
            return typeof id === 'string' ? [{ stage: 'research' as const, artifactVersionId: id }] : [];
          })() : []),
          ...(['research', 'outline'].includes(nextStage ?? '') ? (() => {
            const invalidation = storage.listArtifactVersions(projectId, 'report', `workflow-invalidated:${runId}`).at(-1);
            const ids = invalidation ? JSON.parse(invalidation.content).editorialRecovery?.reportIds ?? [] : [];
            return ids.map((artifactVersionId: string) => ({ stage: nextStage!, artifactVersionId }));
          })() : []),
          ...continuationContextArtifacts(storage, projectId, runId, mode, nextStage, carriedRevisionRepair(runId, nextStage)),
          ...(['central_revision', 'language_review'].includes(nextStage ?? '') ? (() => {
            const closure = reviewClosure(runId);
            return closure ? [...closure.reviewVersionIds, ...closure.reportVersionIds].map(artifactVersionId => ({
              stage: 'central_revision' as const, artifactVersionId })) : [];
          })() : []),
          ...(nextStage === 'language_review' && revisionCandidates(runId) ? [{ stage: 'draft' as const,
            artifactVersionId: revisionCandidates(runId)!.original.id }] : []),
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
