import type { AgentRequestPolicy } from "../../runtime/agent/src/index.js";
import { createReaderTextTasks } from './reader-simulation.js';
import { projectStyleSelection } from './style-selection.js';
import { STYLE_APPLICATION_POLICY, styleContext } from '../../writing-core/src/style-package.js';
import { isPublicStageOutput } from '../../writing-core/src/public-stage-output.js';
import type { SessionStore } from "../../runtime/session/src/index.js";
import { ToolExecutionFault, type ToolDefinition } from "../../runtime/tools/src/index.js";
import type { JsonValue, StoragePort } from "../../writing-core/src/index.js";
import { FactClaimStatusSchema, FactClaimTypeSchema } from "../../writing-core/src/index.js";
import { workflowStageSequence, type WritingWorkflowStage } from "../../writing-pack/src/index.js";
import { buildExpertInstructions, LANGUAGE_REVIEW_SEMANTIC_CONTRACT } from '../../writing-pack/src/expert-instructions.js';
import { assertBusinessInputQuestions, bodyArticleBaseline, evidenceIdsFromLedger, stageArtifact, type WritingWorkflowTools } from "./workflow-tools.js";
import { EDITORIAL_PLAN_INSTRUCTIONS } from './editorial-plan.js';
import { REVISION_COMPARISON_INSTRUCTIONS } from './revision-comparison.js';
import { PUBLICATION_REVIEW_INSTRUCTIONS, publicationReviewEvidence, publicationReviewSourceSlices } from './publication-review-context.js';
import { FINDINGS_SUBMISSION, RESOLUTION_SUBMISSION, FINAL_REVISION_AUDIT } from './review-closure-prompts.js';
import { JSON_SCHEMA as REVIEW_FINDINGS_SCHEMA } from './review-closure.js';
import { getPublicationCandidates, savePublicationCandidates, isPublicationSelectionCurrent, isUsablePublicationTitle,
  PUBLICATION_SELECTION_WAIT_REASON, selectedPublicationContext, type PublicationCandidate } from './publication-choice.js';
import { createFactSourceTool, factToolFailureLoopKey } from './fact-web.js';
import { createFactSearchTools, type FactSearchConfiguration } from './fact-search.js';
import { checkpointIntentReceipt } from './conversation-intent.js';
import { inlineMaterialContext } from './material-context.js';
import { deduplicateReviewDiscussion, factStatusContext, projectInlineRead, stageArtifactContext } from './agent-context.js';
import { factMaterialContext, factReviewPrompt, factReviewTools, projectFactHistory, projectFactToolResult, createFactContextTools, factPreparation, factExtractionArtifacts, factVerificationArtifacts, factSubmissionError, factRecordCatalog, type FactBinding } from './fact-context.js';

type Decision = { action: "dispatch" | "ask" | "rework" | "finish"; stage: WritingWorkflowStage | null; reason: string; questions: string[]; inputVersionIds?: string[]; readinessReason?: string };

type CollaborationStage = WritingWorkflowStage | "title";
type ArtifactExpectation = { kind: "evidence" | "outline" | "body" | "review" | "fact_assessment" | "publication_candidates"; mayCommitBody: boolean };
type Assignment = { actor: string; stage: CollaborationStage | null; decisionId: string; inputVersionIds: string[]; reason: string; status: string; invalidatedStages: readonly string[]; expectedArtifact: ArtifactExpectation | null; expectedBodyVersionId?: string | null };

const reviewOutputSchema = { type: 'object', properties: { content: { type: 'string' }, findings: REVIEW_FINDINGS_SCHEMA },
  required: ['content', 'findings'], additionalProperties: false };

function expectedArtifact(stage: CollaborationStage): ArtifactExpectation {
  if (stage === 'title') return { kind: 'publication_candidates', mayCommitBody: false };
  if (stage === "research") return { kind: "evidence", mayCommitBody: false };
  if (stage === "outline") return { kind: "outline", mayCommitBody: false };
  if (stage.startsWith("review_")) return { kind: "review", mayCommitBody: false };
  if (stage === "fact_check") return { kind: "fact_assessment", mayCommitBody: false };
  return { kind: "body", mayCommitBody: true };
}

function stageInstruction(stage: WritingWorkflowStage, basePrompt: string, researchSearchEnabled = false, editorialPlanRequired = false): string {
  if (stage === 'review_reader') return '三个隔离模拟读者只给口语感受，不是编辑审校，不给修改建议；程序合并为一个成果和一次作者确认。';
  if (stage === "research") return (researchSearchEnabled
    ? '已配置可选前置搜索search_research_sources：先整理授权材料，只有关键公开事实缺口影响文章前提时才搜索，最多2条简短查询（不占末尾事实核查额度），不要每篇强行搜索或发整篇材料。优先搜索摘录，保留实际URL与引句，不把摘录写成读过原文。失败/额度用尽后不自动重试，说明限制；必要信息仍缺再向作者问。'
    : '当前为材料整理模式，没有外部搜索工具：从本次授权材料提取正文所需证据；多来源矛盾只对照实际提供的内容，不臆造检索或核验结果。')
    + '只提交研究账本，content直接用对象' + (editorialPlanRequired ? '{sources,claims,notes,editorialPlan}' : '{sources,claims,notes}') + '，不要转成带转义的JSON字符串。sources按来源列一次source_id、source_title、source_publisher、accessed_at及可选source_url；每条claim用source_id引用，填写claim_type、claim_text、source_quote、reliability、use_boundary、verification_status。evidence_id可省略，由程序编号；确需保留旧编号时明确填写。仅illustrative允许空引句，其余必须引用连续原文；用户材料不能自动标为已外部核实。无事实时sources和claims用空数组，notes说明原因。关键前提存在必要证据缺口时暂停提问，不用猜测补足；成稿后仍须独立事实核查。不要设计开头、结尾、标题或提纲；明确排除的材料只在notes简记理由和必要风险，不另造完整证据条目。';
  if (stage === "outline") return "只提交可供确认的文体化提纲，体现用户要求和材料边界，不要提前写正文。提纲是写给作者看的确认稿：禁止出现 E001/E002 这类证据编号和 use_boundary、illustrative 等内部字段名；证据与观点的对应关系由研究账本承担，不在提纲里标注；需要说明来源性质时用自然语言（如「这是作者的亲历观察」「这一点按既有事实写」）。";
  if (stage.startsWith("review_")) return "你是只读独立评审。只审阅绑定的同一初稿，不得读取其他初审意见，不得提交正文或重写文章。面向普通作者交流，不交一份冗长内部报告：先用1—2句给结论，再按‘优先讨论的问题’‘可选优化’‘建议保留’分段；优先列最多3个最重要的讨论点，每点用短句说明位置、影响和建议。确有更多重要风险不能省略，但不要为凑条目逐段复述全文、重复夸赞或展开后台检查清单。不得显示正文UUID、review_publish等内部字段。不要声称已交接下一位；共创模式会由程序在你保存后等待作者讨论和确认。";
  if (stage === "language_review") return "你是主笔的最终语言润色环节，不是撰写评审报告的审稿人。只对绑定的集中修订稿作有收益的最小语言润色，不做第二次结构重写，不增删事实或改变文意。submit_writing_stage.content必须是可直接交付的完整文章正文；无修改也须逐字提交原文。禁止交付‘本稿语言良好、修改建议、建议优先处理、整体可保留’等评审意见或过程说明。保留真实标题（Markdown或纯文本均可）及全部正文。";
  if (stage === "fact_check") return [
    ...basePrompt.split("\n").filter((line) => line.startsWith("事实核查：")),
    `claimType 只能使用 ${FactClaimTypeSchema.options.join(' / ')}。引语、解读、场景等不属于前九类时使用 other，不新增 quote/interpretation 等分类。每次提交完整 claims 数组和每条所有必填字段，不提交差异补丁。validEvidenceIds 是程序按实际保存账本提取的唯一可引用 ID 清单；notes 文字中出现的 E### 不代表已登记证据。列表为空或找不到匹配时 matchedEvidenceId 必须是 JSON null，sourceReference 可填写真正可复核的来源定位；缺少支持仍标 UNSUPPORTED 或 NEEDS_USER_SOURCE，不能猜测为支持。`,
    `提交契约优先于任务描述里的报告措辞。submit_fact_check.claims[].status 只能逐字使用 ${FactClaimStatusSchema.options.join(' / ')}。无法验证或证据不足使用 UNSUPPORTED；需要作者补充来源使用 NEEDS_USER_SOURCE；有证据相反使用 CONTRADICTED；链接失效使用 BROKEN_LINK。不得填写 unverifiable、partial、passed 或 passed_with_minor_notes 等非枚举值。partial 是 supportScope，不是 status，部分支持须使用 UNSUPPORTED + supportScope=partial。只有证据完整支持才能使用 SUPPORTED。最终 passed/blocked 由程序根据逐条结论计算，不自行添加总评字段，不用调整状态绕过阻断。格式、字数、排版不是事实主张。核验绑定的当前正文及用户已选择的发布标题和配文，不核查旧标题或未选候选；不得修改正文。给作者的收尾说明必须以明确的下一步结束：全部通过就写「下一步：可以导出发布」；有阻断项就写「下一步：需要你处理以上第几项后让我重新核查」，不得以含糊总结收尾。`,
  ].join('\n');
  return stage === "central_revision" ? "你是主笔。按taskInstruction综合各独立评审的分歧与必要修改，完成一次集中修订；保留原稿工作标题或用户指定标题，提交完整文章正文，不要提交修改说明。未获材料支持的内容不得保留或补写。" : "你是主笔。依据绑定研究和已确认提纲写出完整文章正文。保留用户已指定标题；未指定时只用已确认主题作工作标题，不拟发布标题或候选，也不要求作者提前选标题。不得编造材料外事实或经历。content只含文章，不附过程说明。";
}

/** The runtime, not a nested provider, owns every request, tool, budget and cancellation. */
export function createWritingCollaboration(options: {
  factSearchConfiguration?: () => FactSearchConfiguration;
  storage: StoragePort & SessionStore;
  projectId: string;
  workflow: WritingWorkflowTools;
  systemPrompt: string;
  directorMessage: string;
  expertMessage: string;
  factInstruction?: string;
  materialIds: readonly string[];
  authorReviewDiscussion?: JsonValue;
  recoverPendingAssignment?: boolean;
}) {
  const { storage, projectId, workflow } = options;
  const factSearch = createFactSearchTools({ storage, configuration: options.factSearchConfiguration ?? (() => ({ parallelEnabled: false, tavilyEnabled: false })) });
  const researchSearch = createFactSearchTools({ storage, purpose: 'research', configuration: options.factSearchConfiguration ?? (() => ({ parallelEnabled: false, tavilyEnabled: false })) });
  const state = (runId: string) => {
    const confirmedBodyVersionId = workflow.recoverConfirmedBody(runId);
    const events = storage.listRunEvents(runId);
    const recoveredRevisionMarker = workflow.recoverCentralRevision(runId, events);
    const recoveredLanguageMarker = workflow.recoverLanguageReview(runId, events);
    const nextStage = workflow.progress(runId).nextStage;
    const revisionReturn = workflow.pendingRevisionReturn(runId);
    const resume = events.findLastIndex((event) => event.type === "run.resumed");
    const segment = events.slice(Math.max(0, resume));
    // A transport-only retry does not revoke an already issued task. A real
    // author reply still returns control to the director for a new decision.
    const assignmentBoundary = options.recoverPendingAssignment
      ? events.findLastIndex(event => event.type === 'run.resumed' && event.payload.decision !== 'retry_unknown' && event.payload.preservePendingAssignment !== true)
      : resume;
    const decisions = events.slice(Math.max(0, assignmentBoundary)).filter((event) => event.type === "tool.completed" &&
      (event.payload.result as any)?.toolName === "director_decide");
    const latest = decisions.at(-1);
    const assignment = (latest?.payload.result as any)?.result?.collaboration as Assignment | undefined;
    const completedAfter = latest !== undefined && ((assignment?.stage === 'central_revision' &&
      recoveredRevisionMarker !== null && recoveredRevisionMarker.createdEventSeq > latest.projectSeq) ||
      (assignment?.stage === 'language_review' && workflow.hasRevisionReturnForAssignment(runId, latest.projectSeq, assignment.expectedBodyVersionId ?? null, events)) ||
      (assignment?.stage === 'language_review' &&
      recoveredLanguageMarker !== null && recoveredLanguageMarker.createdEventSeq > latest.projectSeq) ||
      events.some((event) => event.projectSeq > latest.projectSeq && event.type === "tool.completed" &&
      ["submit_writing_stage", "submit_fact_check", "submit_publication_candidates"].includes((event.payload.result as any)?.toolName) &&
      (event.payload.result as any)?.result?.stage === assignment?.stage));
    const current = assignment !== undefined && assignment.status === "dispatched" && !completedAfter ? assignment : null;
    const inputs = workflow.continuationContext(runId).artifacts.map((item) => item.artifactVersionId);
    const ready = workflow.isReady(runId);
    const finished = assignment?.status === "finished" && workflow.completion(runId).publicationReady;
    const started = events.find((event) => event.type === "run.started");
    const legacyBaseline = ((started?.payload.requiredArtifactVersionIds ?? []) as string[]).find((id) => storage.getArtifactVersion(id)?.kind === "body") ??
      storage.listArtifactVersions(projectId, "body", "main").filter((version) => started !== undefined && version.createdEventSeq < started.projectSeq).at(-1)?.id ?? null;
    const initialBody = started?.payload.expectedBodyVersionId === undefined ? legacyBaseline : started.payload.expectedBodyVersionId as string | null;
    // Write CAS follows this run's own last committed body, never a concurrently
    // edited project pointer. Rework may read an earlier body while replacing
    // the run's previous output; those are intentionally distinct bindings.
    const expectedBodyVersionId = storage.listArtifactVersions(projectId, "body", "main")
      .filter((version) => (version.actor.kind === "agent" && version.actor.runId === runId) || version.id === confirmedBodyVersionId)
      .sort((left, right) => left.createdEventSeq - right.createdEventSeq).at(-1)?.id ?? initialBody;
    return { events, segment, resume, latest, current, nextStage, inputs, ready, finished, expectedBodyVersionId, revisionReturn };
  };
  const factBinding = (runId: string): FactBinding | null => {
    const assignment = state(runId).current;
    if (assignment?.stage !== 'fact_check') return null;
    const versions = assignment.inputVersionIds.map(id => storage.getArtifactVersion(id));
    const body = versions.find(v => v?.kind === 'body'), evidence = versions.find(v => v?.kind === 'evidence');
    const project = storage.inspectProject(projectId);
    if (!body || !evidence || body.id !== project?.latestBodyVersionId || evidence.id !== project.currentEvidenceVersionId) return null;
    const publication = selectedPublicationContext(storage, projectId);
    const title = project.currentTitleVersionId ? storage.getArtifactVersion(project.currentTitleVersionId) : null;
    return { body, evidence, titleVersionId: project.currentTitleVersionId, finalTitle: publication?.finalTitle,
      distributionCopy: publication?.distributionCopy ?? undefined,
      generatedTitleContent: title?.reason === 'workflow:fact-check-title' ? title.content : undefined };
  };
  const definition: ToolDefinition<Decision, JsonValue> = {
    name: "director_decide", version: "1.0.0", effect: "local_idempotent", permissions: ["workflow:submit"],
    description: "Director only: dispatch one expert, ask business questions, rework a stage and its descendants, or finish after the fact gate passes. Never write the article here. The runtime automatically binds input artifact versions; omit inputVersionIds. Research normally has zero input artifacts; this is valid and does not indicate missing material.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["dispatch", "ask", "rework", "finish"] },
      stage: { anyOf: [{ type: "string", enum: ["research", "outline", "draft", "review_editor", "review_publish", "review_reader", "central_revision", "language_review", "fact_check"] }, { type: "null" }] },
      reason: { type: "string", minLength: 1, maxLength: 2000, description: "Concise delegated task: what this expert must solve, the task scope based on current bound inputs, and the expected result. Put questions for the expert here, not in questions. This is its task instruction, not private chain of thought. It is also shown to the user: write in plain Chinese with role names like 集中修订/语言终审/事实核查, never internal stage ids such as central_revision/language_review/fact_check." }, questions: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 2, description: 'Only action=ask may ask the USER a real unresolved question. For dispatch/rework/finish use questions=[] (zero items). Never use placeholders such as （无） or （暂留）. Questions for an expert belong in reason.' },
      inputVersionIds: { type: "array", items: { type: "string" }, description: "Optional explicit binding for callers that need validation. Prefer omitting: runtime binds exact inputs automatically. Empty arrays are valid for research." },
      readinessReason: { type: 'string', minLength: 1, maxLength: 1000, description: 'For dispatch when ready=false: briefly assess why the supplied inputs suffice for this next stage. This combines readiness and dispatch in one call; all required reads, current-version and author-confirmation checks still apply. Missing author information requires ask instead.' },
    }, required: ["action", "stage", "reason", "questions"], additionalProperties: false },
    execute(args, context) {
      const current = state(context.runId);
      if (current.current !== null) throw new ToolExecutionFault("DIRECTOR_NOT_ACTIVE", "The assigned expert must return before the director can decide");
      if (current.revisionReturn && !(args.action === 'rework' && args.stage === 'central_revision')) {
        throw new ToolExecutionFault('REVISION_REPAIR_REQUIRED', 'Final review found unresolved issues. Use the existing rework central_revision path; do not repeat final review, proceed to facts, finish, or ask the author to repair agent errors.');
      }
      if (args.reason.trim().length === 0) throw new ToolExecutionFault("DIRECTOR_REASON_REQUIRED", "A concise decision summary is required");
      if (args.inputVersionIds !== undefined && JSON.stringify([...args.inputVersionIds].sort()) !== JSON.stringify([...current.inputs].sort())) throw new ToolExecutionFault("DIRECTOR_INPUT_VERSION_MISMATCH", "Omit inputVersionIds: runtime will bind current artifact inputs automatically. Material IDs are not artifact IDs; an empty research list is valid.");
      let invalidatedStages: readonly string[] = [];
      if (args.action === "ask") {
        if (args.questions.length === 0) throw new ToolExecutionFault("DIRECTOR_QUESTION_REQUIRED", "Ask one or two focused questions");
        assertBusinessInputQuestions(args.reason, args.questions);
      } else {
        if (args.questions.length > 0) throw new ToolExecutionFault("DIRECTOR_UNRESOLVED_QUESTIONS", "For dispatch/rework/finish use questions=[] (zero items, no placeholders). Put expert review questions in reason. If a real USER answer is needed, use action=ask instead; do not discard that question to force dispatch.");
      }
      if (args.action === "rework") {
        const sequence = workflowStageSequence(storage.inspectProject(projectId)!.mode);
        const completed = workflow.progress(context.runId).completedStages;
        const stageIndex = args.stage === null ? -1 : sequence.indexOf(args.stage);
        if (stageIndex < 0 || args.stage === null || !completed.includes(args.stage) || sequence.slice(0, stageIndex).some((stage) => !completed.includes(stage))) {
          throw new ToolExecutionFault("DIRECTOR_REWORK_NOT_AVAILABLE", `nextStage=${current.nextStage ?? "finished"}. Rework requires this run's completed target stage and completed prerequisites. A new run editing an existing project body must start with research and follow the normal workflow; the project body or an older run's fact gate does not authorize central_revision rework. Dispatch the current nextStage after readiness; no revision budget was charged.`);
        }
      }
      if (args.action !== "ask") {
        if ((args.action === "rework" || (args.action === "dispatch" && args.stage !== null && (expectedArtifact(args.stage).mayCommitBody || args.stage === "fact_check"))) && storage.inspectProject(projectId)?.latestBodyVersionId !== current.expectedBodyVersionId) {
          const reason = "正文已在本次运行之外更新，无法确认旧任务对新正文的修改或核查授权，已保留当前稿件。";
          return { collaboration: { actor: "director", stage: args.stage, decisionId: context.operationId, inputVersionIds: current.inputs, reason, status: "waiting_user", invalidatedStages: [], expectedArtifact: null, expectedBodyVersionId: current.expectedBodyVersionId }, awaitingUserInput: { reason, questions: ["是否要基于当前保存的稿件重新开始写作？请结束旧任务后，从当前稿件发起新任务。"], nextStage: args.stage, requiredArtifactVersionIds: current.inputs } };
        }
        if (!current.ready && !current.revisionReturn && !(args.action === 'dispatch' && args.readinessReason?.trim())) throw new ToolExecutionFault("WRITING_READINESS_REQUIRED", "Read authorized inputs, then assess readiness or supply readinessReason with dispatch for the current next stage");
      }
      if (args.action === "dispatch") {
        if (args.stage === null || args.stage !== current.nextStage) throw new ToolExecutionFault("DIRECTOR_STAGE_INVALID", `dispatch only accepts nextStage=${current.nextStage ?? "finished"}. Only if central_revision is already completed in THIS run, change that article with director_decide action=rework stage=central_revision, then dispatch central_revision, language_review, fact_check. Otherwise continue nextStage: a new run editing a pre-existing project body starts from research, not rework. Do not replace authorized editing with rechecking the unchanged body. language_review is only minimal polishing, not content deletion or restructuring.`);
        if (!current.ready) workflow.approveReadiness(context, args.readinessReason!);
        // Older clients saved these stages without a confirmation boundary.
        // On recovery show the latest saved result for approval, not a replay
        // of finished experts and not an implicit approval from a retry click.
        const previousStage = args.stage === 'language_review' ? 'central_revision'
          : args.stage === 'fact_check' ? 'language_review' : null;
        const projectForCheckpoint = storage.inspectProject(projectId)!;
        const briefForCheckpoint = projectForCheckpoint.currentBriefVersionId
          ? storage.getWritingBriefVersion(projectForCheckpoint.currentBriefVersionId)?.brief : null;
        if (previousStage && briefForCheckpoint?.interactionMode === 'co_creation' && workflow.progress(context.runId).completedStages.includes(previousStage)) {
          const marker = storage.listArtifactVersions(projectId, 'report', `workflow:${context.runId}:${previousStage}`).at(-1);
          const hasCheckpoint = marker && current.events.some(event => event.type === 'run.waiting_user' &&
            event.payload.stopReason === 'CO_CREATION_CHECKPOINT' && event.payload.stage === previousStage && event.projectSeq > marker.createdEventSeq);
          if (marker && !hasCheckpoint) return { awaitingUserConfirmation: { stage: previousStage, nextStage: args.stage, requiredArtifactVersionIds: [] } };
        }
        if (args.stage === 'fact_check') {
          const project = storage.inspectProject(projectId)!;
          const brief = project.currentBriefVersionId ? storage.getWritingBriefVersion(project.currentBriefVersionId)?.brief : null;
          const selected = project.currentTitleVersionId ? storage.getArtifactVersion(project.currentTitleVersionId) : null;
          if ((brief?.interactionMode === 'co_creation' || selected?.reason === 'author-publication-selection') && !isPublicationSelectionCurrent(storage, projectId)) {
            const body = storage.getArtifactVersion(project.latestBodyVersionId!)!;
            const candidates = getPublicationCandidates(storage, projectId);
            const usable = candidates?.bodyVersionId === body.id && candidates.candidates.length > 0 &&
              candidates.candidates.every(candidate => isUsablePublicationTitle(candidate.title, body.content));
            if (usable) {
              return { awaitingUserInput: { kind: 'publication_selection', reason: PUBLICATION_SELECTION_WAIT_REASON,
                questions: ['请选择一个标题候选；也可以直接说明希望怎样调整，正文不会因此改动。'], nextStage: 'fact_check', requiredArtifactVersionIds: [] } };
            }
            const collaboration: Assignment = { actor: 'title', stage: 'title', decisionId: context.operationId,
              inputVersionIds: [body.id], reason: '根据当前最终正文生成少量真实、不同且不越过正文承诺的标题候选，供用户选择。',
              status: 'dispatched', invalidatedStages: [], expectedArtifact: { kind: 'publication_candidates', mayCommitBody: false }, expectedBodyVersionId: body.id };
            return { collaboration: collaboration as unknown as JsonValue };
          }
        }
        const wait = current.events.filter((event) => event.type === "run.waiting_user").at(-1);
        const reply = current.events.filter((event) => event.type === "run.resumed").at(-1);
        if (wait && reply && wait.payload.stage !== 'outline' && reply.projectSeq > wait.projectSeq && args.stage === wait.payload.nextStage &&
          checkpointIntentReceipt(storage, projectId, context.runId, String(reply.payload.displayInstruction ?? ''))?.intent === 'revise_checkpoint') {
          throw new ToolExecutionFault('CHECKPOINT_REWORK_REQUIRED', 'The author requested changes to the current stage. Rework that stage and obtain a new confirmation before advancing.');
        }
        if (args.stage === "draft" && wait?.payload.stage === "outline" && reply !== undefined &&
          checkpointIntentReceipt(storage, projectId, context.runId, String(reply.payload.displayInstruction ?? ''))?.intent !== 'approve_checkpoint') {
          throw new ToolExecutionFault("OUTLINE_REWORK_REQUIRED", "The user requested an outline change: rework outline and obtain confirmation before drafting");
        }
      }
      if (args.action === "rework") {
        const project = storage.inspectProject(projectId)!;
        if (args.stage === null || !workflowStageSequence(project.mode).includes(args.stage)) throw new ToolExecutionFault("DIRECTOR_STAGE_INVALID", "Choose a valid stage for rework");
        const operationId = `${context.operationId}:major-revision`;
        storage.prepareRuntimeOperation({ operationId, projectId, runId: context.runId, kind: "major_revision", effect: "local_idempotent", input: { stage: args.stage } });
        const charged = storage.dispatchRuntimeOperation({ operationId, projectId, runId: context.runId, eventType: "tool.requested", eventPayload: { toolName: "director_rework", stage: args.stage }, budgetUse: { majorRevisions: 1 } });
        if (!charged.dispatched) throw new ToolExecutionFault("BUDGET_EXHAUSTED", "The revision budget is exhausted");
        invalidatedStages = workflow.invalidate(context, args.stage);
        storage.settleRuntimeOperation({ operationId, projectId, runId: context.runId, state: "completed", eventType: "tool.completed", eventPayload: { invalidatedStages }, result: { invalidatedStages: [...invalidatedStages] } });
      }
      if (args.action === "finish" && (current.nextStage !== null || !workflow.completion(context.runId).publicationReady)) throw new ToolExecutionFault("DIRECTOR_FINISH_BLOCKED", "All stages and the current fact gate must pass before finish");
      const collaboration: Assignment = { actor: args.action === "dispatch" ? args.stage! : "director", stage: args.stage, decisionId: context.operationId,
        inputVersionIds: current.inputs, reason: args.action === 'dispatch' && args.stage === 'central_revision' && !args.reason.includes('导演解读（非读者原话）')
          ? `导演解读（非读者原话）：\n${args.reason.trim()}` : args.reason.trim(), status: args.action === "dispatch" ? "dispatched" : args.action === "finish" ? "finished" : args.action === "rework" ? "rework" : "waiting_user", invalidatedStages,
        expectedArtifact: args.action === "dispatch" ? expectedArtifact(args.stage!) : null, expectedBodyVersionId: current.expectedBodyVersionId };
      return { collaboration: collaboration as unknown as JsonValue,
        ...(!current.ready && args.action === 'dispatch' ? { readiness: { status:'ready', reason:args.readinessReason!, nextStage:current.nextStage } } : {}),
        ...(args.action === "ask" ? { awaitingUserInput: { reason: args.reason, questions: args.questions, nextStage: current.nextStage, requiredArtifactVersionIds: current.inputs } } : {}) };
    },
  };
  const publicationCandidatesDefinition: ToolDefinition<{ candidates: PublicationCandidate[] }, JsonValue> = {
    name: 'submit_publication_candidates', version: '1.0.0', effect: 'local_idempotent', permissions: ['workflow:submit'],
    description: 'Title expert only: persist 1–6 publication title/distribution candidates for the exactly bound current body. This never selects a title or edits the body.',
    inputSchema: { type: 'object', properties: { candidates: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'object', properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 }, opening: { type: ['string', 'null'], maxLength: 4000 },
      distributionCopy: { type: ['string', 'null'], maxLength: 2000 }, rationale: { type: 'string', minLength: 1, maxLength: 2000 },
    }, required: ['title', 'opening', 'distributionCopy', 'rationale'], additionalProperties: false } } }, required: ['candidates'], additionalProperties: false },
    execute(args, context) {
      const current = state(context.runId);
      if (current.current?.actor !== 'title' || current.current.stage !== 'title') throw new ToolExecutionFault('TITLE_EXPERT_NOT_ACTIVE', 'Only the assigned title expert may submit publication candidates');
      const bodyVersionId = current.current.inputVersionIds[0];
      const project = storage.inspectProject(projectId);
      if (!bodyVersionId || project?.latestBodyVersionId !== bodyVersionId || current.current.expectedBodyVersionId !== bodyVersionId) {
        throw new ToolExecutionFault('PUBLICATION_CANDIDATES_STALE', 'The article changed; prepare candidates for its current version');
      }
      const saved = savePublicationCandidates(storage, projectId, context.operationId, bodyVersionId, args.candidates, context.runId);
      const choices = saved.candidates.map((candidate, index) => `${index + 1}. 「${candidate.title}」${candidate.distributionCopy === null ? '' : `；分发文案：${candidate.distributionCopy}`}`).join('\n');
      return { stage: 'title', candidateVersionId: saved.id, bodyVersionId, bodyUnchanged: true,
        awaitingUserInput: { kind: 'publication_selection', reason: PUBLICATION_SELECTION_WAIT_REASON,
          questions: [`${choices}\n请选择第几个；如果都不合适，也可以直接说明希望怎样调整。`], nextStage: 'fact_check', requiredArtifactVersionIds: [] } } as unknown as JsonValue;
    },
  };
  const requestPolicy = (runId: string): AgentRequestPolicy => {
    const current = state(runId);
    const assignment = current.ready ? current.current : null;
    const actor = assignment?.actor ?? "director";
    const inputs = assignment?.inputVersionIds ?? current.inputs;
    const findingsRequired = workflow.reviewFindingsRequired(runId);
    if (assignment?.stage === 'review_editor') {
      const body = stageArtifact(storage, projectId, runId, 'draft');
      if (!body || !inputs.includes(body.id)) throw new ToolExecutionFault('REVIEW_DRAFT_MISSING', 'Cold reading requires the exact workflow draft');
      const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
      const brief = briefId ? storage.getWritingBriefVersion(briefId)?.brief : null;
      const scopeId = `review_editor:${assignment.decisionId}:${body.id}`;
      return { scopeId, actor: 'review_editor', expectedBodyVersionId: body.id,
        systemPrompt: '你是第一次读到本文的编辑。只凭文章本身和目标读者判断阅读效果，不猜作者的写作计划。先判断读完后比只看题目多知道了什么；如果结论早能猜到、材料只是装饰，直说没有新收获。再定位最早会停止阅读的原句，以及核心判断最站不住的一步，说明阅读损失和最小修复；只把真正有内容的观察列为值得保留。优先处理最多三处真正影响阅读的问题，没有就如实保留。先查论证再查措辞：句子前后是否换了讨论对象，数字是否真能推出紧随的判断，是否把未测量的原因或变化说成已知。标明“推演”不能补上缺的一步；需要缩小判断或换掉例子，不建议加免责声明。不因没有故事、反方、金句或短段而扣分。不替代事实核查，不编造经历，不重写正文，不输出过程备注或内部编号。' + (findingsRequired ? `\n${FINDINGS_SUBMISSION}` : ''),
        userMessage: `请直接给作者简洁的审稿意见。\nCOLLABORATION_STATE=${JSON.stringify({ actor: 'review_editor', stage: 'review_editor',
          nextStage: current.nextStage, ready: true, finished: false, inputVersionIds: [body.id], unreadArtifactVersionIds: [], completedStages: [], materials: [],
          reviewFindingsRequired: findingsRequired, ...(findingsRequired ? { reviewOutputSchema } : {}),
          writingRequirements: { audience: brief?.audience, platform: brief?.platform, genre: brief?.genre },
          artifacts: [{ id: body.id, kind: 'body', content: body.content }] })}`,
        allowedTools: ['submit_writing_stage'], modelTools: [], toolChoice: 'none',
        ...(findingsRequired ? { roleToolFields: { submit_writing_stage: { allowed: ['stage', 'content', 'findings'], required: ['findings'], stringFields: ['content'] } } } : {}),
        ...(findingsRequired ? { textOutputTool: { name: 'submit_writing_stage', arguments: { stage: 'review_editor' }, format: 'json_object' } } : {}),
        ...(!findingsRequired ? { outputPreview: { id: `${runId}:preview:${scopeId}`, stage: 'review_editor' as const },
          textOutputTool: { name: 'submit_writing_stage', arguments: { stage: 'review_editor' }, contentArgument: 'content' } } : {}),
        authorizeTool: call => call.name === 'submit_writing_stage' && (call.arguments as { stage?: string }).stage === 'review_editor',
      };
    }
    if (assignment?.stage === 'review_publish') {
      const body = stageArtifact(storage, projectId, runId, 'draft');
      if (!body || !inputs.includes(body.id)) throw new ToolExecutionFault('REVIEW_DRAFT_MISSING', 'Publication review requires the exact workflow draft');
      const research = stageArtifact(storage, projectId, runId, 'research');
      const evidence = research && inputs.includes(research.id) ? research : null;
      const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
      const brief = briefId ? storage.getWritingBriefVersion(briefId)?.brief : null;
      const sources = storage.listMaterials(projectId).filter(material => options.materialIds.includes(material.id) &&
        (material.role === 'source_verified' || material.role === 'user_firsthand' || material.trustLabel === 'external_untrusted' || material.sourceKind === 'web_snapshot'));
      const modelTools = ['assess_writing_readiness', ...(sources.length > 0 ? ['read_material'] : [])];
      const scopeId = `review_publish:${assignment.decisionId}:${body.id}:${evidence?.id ?? 'none'}`;
      return { scopeId, actor: 'review_publish', expectedBodyVersionId: body.id,
        systemPrompt: PUBLICATION_REVIEW_INSTRUCTIONS + (findingsRequired ? `\n${FINDINGS_SUBMISSION}` : ''),
        userMessage: `请给出发布前的独立审校意见。\nCOLLABORATION_STATE=${JSON.stringify({ actor: 'review_publish', stage: 'review_publish',
          nextStage: current.nextStage, ready: true, finished: false, inputVersionIds: [body.id, ...(evidence ? [evidence.id] : [])],
          reviewFindingsRequired: findingsRequired, ...(findingsRequired ? { reviewOutputSchema } : {}),
          unreadArtifactVersionIds: [], completedStages: [], materials: [], writingRequirements: { audience: brief?.audience, platform: brief?.platform, genre: brief?.genre },
          firsthandMaterialIds: brief?.authorAuthorization.firsthandMaterialIds.filter(id => sources.some(source => source.id === id && source.role === 'user_firsthand')) ?? [],
          artifacts: [{ id: body.id, kind: 'body', content: body.content },
            ...(evidence ? [{ id: evidence.id, kind: 'evidence', content: publicationReviewEvidence(evidence.content) }] : [])],
          materialCatalog: factMaterialContext(sources).materialCatalog })}`,
        allowedTools: [...new Set(['submit_writing_stage', ...modelTools])], modelTools, toolChoice: 'auto',
        ...(findingsRequired ? { roleToolFields: { submit_writing_stage: { allowed: ['stage', 'content', 'findings'], required: ['findings'], stringFields: ['content'] } } } : {}),
        ...(findingsRequired ? { textOutputTool: { name: 'submit_writing_stage', arguments: { stage: 'review_publish' }, format: 'json_object' } } : {}),
        ...(!findingsRequired ? { outputPreview: { id: `${runId}:preview:${scopeId}`, stage: 'review_publish' as const },
          textOutputTool: { name: 'submit_writing_stage', arguments: { stage: 'review_publish' }, contentArgument: 'content' } } : {}),
        authorizeTool(call) {
          const args = call.arguments as Record<string, unknown>;
          if (call.name === 'submit_writing_stage') return args.stage === 'review_publish';
          if (call.name === 'read_material') return sources.some(source => source.id === args.materialId && source.contentVersionId === args.contentVersionId);
          return call.name === 'assess_writing_readiness' && args.status === 'needs_input';
        },
      };
    }
    const reviewClosure = workflow.reviewClosure(runId);
    const auditCandidates = assignment?.stage === 'language_review' ? workflow.revisionCandidates(runId) : null;
    if (assignment?.stage === 'language_review' && reviewClosure && auditCandidates) {
      const { original, revised, allowOriginal } = auditCandidates;
      const research = stageArtifact(storage, projectId, runId, 'research');
      const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
      const brief = briefId ? storage.getWritingBriefVersion(briefId)?.brief : null;
      const authorized = storage.listMaterials(projectId).filter(material => options.materialIds.includes(material.id));
      const authorInputs = authorized.filter(material => material.role === 'user_firsthand' || material.id.startsWith('intake-user-'));
      const sourceSlices = publicationReviewSourceSlices(storage, projectId, stageArtifact(storage, projectId, runId, 'review_publish'), authorized);
      return {
        scopeId: `language-audit:${assignment.decisionId}:${revised.id}`, actor: 'language_review', expectedBodyVersionId: revised.id,
        systemPrompt: `${FINAL_REVISION_AUDIT}\n${REVISION_COMPARISON_INSTRUCTIONS}`,
        userMessage: `请独立核对修订后的实际文章。\nCOLLABORATION_STATE=${JSON.stringify({
          actor: 'language_review', stage: 'language_review', nextStage: current.nextStage, ready: true, finished: false,
          inputVersionIds: inputs, unreadArtifactVersionIds: [], completedStages: [], materials: inlineMaterialContext(authorInputs), sourceSlices,
          writingRequirements: { audience: brief?.audience, platform: brief?.platform, genre: brief?.genre },
          authorDecisions: Array.isArray(options.authorReviewDiscussion) ? options.authorReviewDiscussion.filter(item =>
            item && typeof item === 'object' && !Array.isArray(item) && item.role === 'user') : [],
          reviewClosure: { ...reviewClosure, findings: reviewClosure.findings.map(({ id, quote, kind, severity, evidenceIds, bodyVersionId, reviewVersionId }) =>
            ({ id, quote, kind, severity, evidenceIds, bodyVersionId, reviewVersionId })) },
          revisionComparison: { originalVersionId: original.id, revisedVersionId: revised.id,
            allowedSelectionIds: allowOriginal ? [original.id, revised.id] : [revised.id] },
          artifacts: [{ id: original.id, kind: 'body', content: original.content }, { id: revised.id, kind: 'body', content: revised.content },
            ...(research ? [{ id: research.id, kind: 'evidence', content: publicationReviewEvidence(research.content) }] : [])],
          bodyOutputContract: { versions: [original, revised].map(version => ({ versionId: version.id,
            requiredHeadings: bodyArticleBaseline(version.content).split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)),
            articleCharacters: bodyArticleBaseline(version.content).length })), output: 'complete_article_only' },
        })}`,
        allowedTools: ['submit_writing_stage'], modelTools: ['submit_writing_stage'], toolChoice: 'required',
        roleToolFields: { submit_writing_stage: { allowed: ['stage', 'content', 'audit', 'comparison'], required: ['audit'], stringFields: ['content'] } },
        authorizeTool: call => call.name === 'submit_writing_stage' && (call.arguments as { stage?: string }).stage === 'language_review',
      };
    }
    const artifacts = inputs.map((id) => storage.getArtifactVersion(id)).filter((item) => item !== null).map((item) => ({ id: item.id, kind: item.kind, content: item.content }));
    if (assignment?.stage === 'review_reader') {
      const body = artifacts.find(item => item.kind === 'body');
      if (!body) throw new ToolExecutionFault('REVIEW_DRAFT_MISSING', 'Reader simulation requires the bound complete draft');
      const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
      const brief = briefId ? storage.getWritingBriefVersion(briefId)?.brief : null;
      const publication = selectedPublicationContext(storage, projectId);
      return {
        scopeId:`review_reader:${assignment.decisionId}:${body.id}`, actor:'review_reader', systemPrompt:'模拟读者阶段，由程序隔离分发。', userMessage:'只阅读绑定正文。',
        allowedTools:['submit_writing_stage'], modelTools:[], expectedBodyVersionId:body.id,
        textOutputTool:{ name:'submit_writing_stage', arguments:{ stage:'review_reader' }, contentArgument:'content' },
        parallelTextTasks:createReaderTextTasks({ article:bodyArticleBaseline(body.content), bodyVersionId:body.id,
          platform:brief?.platform ?? '', audience:brief?.audience ?? '',
          confirmationRequired:brief?.interactionMode === 'co_creation',
          ...(publication?.finalTitle ? { title:publication.finalTitle } : {}),
          ...(publication?.distributionCopy ? { distributionCopy:publication.distributionCopy } : {}) }),
        authorizeTool:call => call.name === 'submit_writing_stage' && (call.arguments as {stage?:string}).stage === 'review_reader',
      };
    }
    const isFactCheck = assignment?.stage === 'fact_check';
    const prepared = isFactCheck ? factPreparation(storage, runId, factBinding(runId)) : null;
    const authorizedMaterials = storage.listMaterials(projectId).filter(material => options.materialIds.includes(material.id));
    const authorizedVersions = new Map(authorizedMaterials.map(material => [material.id, material.contentVersionId]));
    const materialSlices = new Map<string, JsonValue>();
    for (const event of current.events) {
      const envelope = event.payload.result as any;
      if (event.type !== 'tool.completed' || envelope?.ok !== true || envelope?.toolName !== 'read_material') continue;
      const slice = envelope.result;
      if (!slice || authorizedVersions.get(slice.materialId) !== slice.contentVersionId) continue;
      materialSlices.set(JSON.stringify([slice.materialId, slice.contentVersionId, slice.offset, slice.nextOffset]), { ...slice,
        displayName: authorizedMaterials.find(material => material.id === slice.materialId)?.displayName ?? '' });
    }
    const cachedIds = new Set([...materialSlices.values()].map(slice => (slice as {materialId: string}).materialId));
    const materials = [...inlineMaterialContext(authorizedMaterials.filter(material => !cachedIds.has(material.id))), ...materialSlices.values()];
    const downstream = actor !== 'research' && artifacts.some(item => item.kind === 'evidence');
    const artifactContext = stageArtifactContext(actor, artifacts, { directorStage: current.nextStage });
    // Selection must not be undone by reinjecting an external source as pasted
    // text. Keep author experience/requirements; source originals stay readable.
    const authorMaterialIds = new Set(authorizedMaterials.filter(m => m.role === 'user_firsthand' || m.id.startsWith('intake-user-') ||
      m.sourceKind !== 'web_snapshot' && m.trustLabel !== 'external_untrusted' && m.role !== 'source_verified').map(m => m.id));
    const suppliedMaterials = actor === 'title' ? [] : downstream
      ? materials.filter(m => authorMaterialIds.has(String((m as { materialId: string }).materialId))) : materials;
    const comparisonCandidates = assignment?.stage === 'language_review' ? workflow.revisionCandidates(runId) : null;
    const boundBody = comparisonCandidates?.revised.content ?? artifacts.find(item => item.kind === 'body')?.content;
    const articleBaseline = boundBody === undefined ? undefined : bodyArticleBaseline(boundBody);
    const selectedStyle = projectStyleSelection(storage, projectId);
    const briefId = storage.inspectProject(projectId)?.currentBriefVersionId;
    const articleTargetCharacters = (briefId ? storage.getWritingBriefVersion(briefId)?.brief.lengthTarget.targetCharacters : undefined) ?? 1800;
    // Earlier reviews describe an older body after revision. Do not resurrect
    // those reports in late director scopes or advertise obsolete version IDs.
    const includeDiscussion = assignment?.stage === 'central_revision' || actor === 'director' &&
      ['research', 'outline', 'draft', 'central_revision'].includes(current.nextStage ?? '');
    const outputGuidance = {
      articleTargetCharacters,
      outlineTargetCharacters: Math.min(1600, Math.max(200, Math.round(articleTargetCharacters * 0.4))),
      researchNotesTargetCharacters: Math.min(600, Math.max(100, Math.round(articleTargetCharacters * 0.2))),
      delegationTargetCharacters: 200,
    };
    const summary = { actor, stage: assignment?.stage ?? null, nextStage: current.nextStage, inputVersionIds: inputs, ready: current.ready, finished: current.finished,
      ...(actor === 'director' && current.revisionReturn ? { revisionReturn: {
        reportId: current.revisionReturn.id, bodyVersionId: JSON.parse(current.revisionReturn.content).bodyVersionId } } : {}),
      ...(assignment?.stage === 'central_revision' && reviewClosure ? { reviewClosure } : {}),
      writingRequirements: briefId ? (() => { const brief = storage.getWritingBriefVersion(briefId)?.brief; return { audience: brief?.audience, platform: brief?.platform }; })() : undefined,
      outputGuidance,
      ...(assignment?.stage === 'research' && workflow.requireEditorialPlan ? { editorialPlanRequired: true } : {}),
      ...(comparisonCandidates ? { revisionComparison: {
        originalVersionId: comparisonCandidates.original.id, revisedVersionId: comparisonCandidates.revised.id,
        allowedSelectionIds: comparisonCandidates.allowOriginal ? [comparisonCandidates.original.id, comparisonCandidates.revised.id] : [comparisonCandidates.revised.id],
        instruction: comparisonCandidates.allowOriginal ? '选择阅读效果更好的版本再作最小润色；允许保留初稿。' : '原稿只供比较；保留作者已确认或返工修正的内容，不回退旧稿。',
      } } : {}),
      ...(assignment?.stage === 'research' ? { researchSearchBudget: researchSearch.budget(runId), externalSearchEnabled: researchSearch.enabled() } : {}),
      unreadArtifactVersionIds: workflow.unreadReadinessArtifactIds(runId),
      ...(assignment?.stage === "fact_check" ? { currentBodyVersionId: storage.inspectProject(projectId)?.latestBodyVersionId ?? null,
        validEvidenceIds: evidenceIdsFromLedger(artifacts.find(item => item.kind === 'evidence')?.content ?? ''), searchBudget: factSearch.budget(runId) } : {}),
      ...(assignment?.stage ? { taskInstruction: assignment.reason, expectedArtifact: assignment.expectedArtifact ?? expectedArtifact(assignment.stage) } : {}),
      completedStages: workflow.progress(runId).completedStages,
      artifacts: isFactCheck ? prepared ? factVerificationArtifacts(artifacts, prepared) : factExtractionArtifacts(artifacts) : artifactContext.artifacts,
      materials: suppliedMaterials,
      ...(downstream ? { materialCatalog: factMaterialContext(authorizedMaterials).materialCatalog } : {}),
      ...(isFactCheck ? { ...factMaterialContext(authorizedMaterials),
        factPhase: prepared ? 'verify' : 'extract', ...(prepared ? { preparedClaims: prepared.claims, noFactualClaimsReason: prepared.noFactualClaimsReason,
          savedSourceRecords: factRecordCatalog(storage, runId, prepared.preparationId) } : {}),
        authorAuthorization: briefId ? storage.getWritingBriefVersion(briefId)?.brief.authorAuthorization : null } : {}),
      ...(assignment?.stage === 'language_review' && articleBaseline !== undefined ? { bodyOutputContract: {
        ...(comparisonCandidates ? { versions: [comparisonCandidates.original, comparisonCandidates.revised].map(version => ({
          versionId: version.id, requiredHeadings: bodyArticleBaseline(version.content).split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)),
          articleCharacters: bodyArticleBaseline(version.content).length,
        })) } : { requiredHeadings: articleBaseline.split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)), articleCharacters: articleBaseline.length }),
        legacyProcessPostscript: articleBaseline !== boundBody?.trim(),
        preserveMeaning: LANGUAGE_REVIEW_SEMANTIC_CONTRACT,
        output: 'complete_article_only',
      } } : {}),
      ...(includeDiscussion ? { authorReviewDiscussion: deduplicateReviewDiscussion(options.authorReviewDiscussion ?? [],
        artifactContext.completeArtifacts, suppliedMaterials, true) } : {}),
      ...(isFactCheck || actor === 'director' ? { selectedPublication: selectedPublicationContext(storage, projectId) } : {}),
      ...(actor === "director" ? { factCheck: factStatusContext(storage.getFactCheckStatus(projectId), true) } : {}) };
    // ready is bound to this stage and exact material versions. Complete reads
    // are already injected above; changing a version reopens readiness/reading.
    const needsSourceAccess = downstream && actor !== 'title' && authorizedMaterials.some(m => !authorMaterialIds.has(m.id));
    const materialReadTools = !current.ready || isFactCheck || needsSourceAccess ? ['read_material'] : [];
    const artifactReadTools = isFactCheck ? ['read_fact_evidence', 'read_fact_record'] : inputs.length && (workflow.unreadReadinessArtifactIds(runId).length > 0 || artifactContext.needsArtifactAccess) ? ['read_artifact_version'] : [];
    const discussionReadTools = includeDiscussion && Array.isArray(options.authorReviewDiscussion) && options.authorReviewDiscussion.length ? ['read_review_discussion'] : [];
    const researchTools = assignment?.stage === 'research' && researchSearch.enabled() && researchSearch.budget(runId).remaining > 0 ? ['search_research_sources'] : [];
    const allowedTools = isFactCheck && !prepared ? ['prepare_fact_check'] : actor === "director" ? [...materialReadTools, ...artifactReadTools, ...discussionReadTools, "assess_writing_readiness", "director_decide"] : actor === 'title'
      ? [...artifactReadTools, 'submit_publication_candidates']
      : [...materialReadTools, ...artifactReadTools, ...discussionReadTools, ...researchTools, ...(isFactCheck ? [] : ["assess_writing_readiness"]), ...(assignment?.stage === "fact_check" ? ['read_fact_article', "submit_fact_check", ...(factSearch.enabled() ? [...(factSearch.budget(runId).remaining > 0 ? ['search_fact_sources'] : []), 'read_fact_source'] : [])] : ["submit_writing_stage"])];
    const commonPrompt = options.systemPrompt.split("\n").filter((line) => /^(?:材料安全：|文体规则：|作者声音：|方向决定状态：|没有已授权的一手|只有这些材料)/u.test(line))
      .map(line => selectedStyle === undefined ? line : line.replace(/风格决定状态：[^。]*。/u, selectedStyle === null ? '风格决定状态：用户已在项目设置取消指定风格。' : '风格决定状态：用户已在项目设置明确选定，下文提供按阶段筛选的参考。')).join("\n");
    let rolePrompt = actor === "director"
      ? "你是写作导演，只能调度独立专家、提问、返工或结束，不得直接写正文。director_decide.reason是传给专家的任务说明：明确本次解决什么、范围和预期输出。汇总评审分歧后给修订主笔取舍依据。nextStage仅约束普通dispatch，不覆盖用户当前修改要求；已完成正文需删改时先 rework central_revision，再dispatch central_revision→language_review→fact_check。不要直接dispatch已完成的language_review；它只能最小润色，不承担内容删改。事实blocked后若用户已授权删改，必须先实际修改当前被核查正文，再独立核查新版本，不能反复核查旧稿或再次索要同一授权；若只补充来源而无正文改动，可重新核查。提纲改向先rework outline再重新确认。全部阶段保存且当前事实门禁passed才finish，之后用一句话结束。"
      : actor === 'title'
        ? '你是独立标题专家。只基于绑定的当前最终正文生成少量真实且有差异的标题候选；调用 submit_publication_candidates 保存。不得改写正文，不得自行选择或声称用户已确认。'
        : stageInstruction(assignment!.stage as WritingWorkflowStage, options.systemPrompt, researchSearch.enabled(), workflow.requireEditorialPlan);
    if (actor === "director") rolePrompt += "\n区分新任务编辑现稿与同run返工：项目已有正文或旧run事实blocked，不代表本run完成过阶段。rework只能选择本run completedStages中且前置均完成的阶段。新run即使要求修改已有稿件，也应读取现稿、评估ready，从nextStage=research按原流程推进；只有本run已完成central_revision后再次收到删改授权，才使用rework central_revision。项目历史factCheck不是新run的阶段完成凭据。例外：若本run的completedStages非空，说明程序已把同会话上一中断run的连续完成阶段连同其有效产物承接进本run，它们就是本run自己的完成记录——直接从当前nextStage继续，不要再从research重来，也不要重新生成已承接的产物。";
    if (assignment?.stage === "fact_check") rolePrompt += `\n唯一事实核查对象是 CURRENT_BODY_VERSION=${storage.inspectProject(projectId)?.latestBodyVersionId ?? "missing"}。extract阶段artifacts提供正文全文；verify阶段preparedClaims提供其中待核实条目及原句，正文仅留目录，必要时按需读取。不得核查历史正文、评审报告、用户解释中的旧稿或版本技术说明。证据只从绑定的evidence和授权材料取。`;
    const drafted = storage.listArtifactVersions(projectId, "report", `workflow:${runId}:draft`).length > 0;
    // Readiness becomes false after each saved stage. That must not resurrect
    // the resume-time list of old bodies/reviews that the current scope forbids.
    const directorMessage = drafted ? `${options.expertMessage}\n当前正文版本：${storage.inspectProject(projectId)?.latestBodyVersionId ?? "无"}。仅此为当前正文，旧起始基线已退役。恢复读取义务仅以本次 COLLABORATION_STATE.unreadArtifactVersionIds 为准。` : options.directorMessage;
    const sharedStateRules = [
      'COLLABORATION_STATE是本次最新任务状态。materials中delivery=inline_full是已提供全文，其余是当前版本的已读片段；仅对授权目录中缺失或不完整的材料补读，不因角色切换或用户确认重读完整材料。只读当前绑定版本，旧失效产物仅供历史追溯。',
      'ready仅绑定当前阶段和输入版本，false不代表缓存失效。必要信息缺口用assess_writing_readiness needs_input提最多两个问题；收到回答仍须核对，不能把缺料说明当成果。每次只提交分配的一个stage，成功后自动交还导演。',
      ...(actor === 'director' ? ['director_decide省略inputVersionIds，程序自动绑定；research的空产物列表合法，不向作者索取内部ID。每阶段保存或输入变化后重新判断充分性；已有完整材料直接使用，不机械沿用上阶段结论。'] : []),
    ].join('\n');
    if (actor === 'director') rolePrompt += `\n精简交接：reason建议在${outputGuidance.delegationTargetCharacters}字内，只说明本阶段的关键目标、作者最新取舍与必要边界。专家已收到完整的当前方向、材料与产物，不要重复粘贴它们、逐条重述证据、写一份提纲再让提纲专家重写；不得要求提纲展示证据编号。保留确有必要的复杂要求，不以精简为由丢掉作者约束。`;
    if (assignment?.stage === 'research') rolePrompt += workflow.requireEditorialPlan ? `\n${EDITORIAL_PLAN_INSTRUCTIONS}\n本次比较2–3个切口；作者明确指定方向时选中它，其他候选只说明取舍，不改变授权。只入账与候选相关的材料，字数目标约${articleTargetCharacters}字；不用数字点缀观点，保留能解释原因、呈现差异或限制结论的材料。notes只写共同边界，不重复计划。` : '';
    if (assignment?.stage === 'outline' || assignment?.stage === 'draft') rolePrompt += '\n有editorialPlan时围绕选中的切口与读者收获写作，只使用use材料支撑主张，不重新拼成候选切口大合集。gaps决定能说到哪里；无法支撑的判断缩小或不写。内部计划不是文章结构模板，不能把字段、选材理由、证据编号或自检说明写进正文。';
    if (assignment?.stage === 'central_revision') rolePrompt += reviewClosure ? `\n${RESOLUTION_SUBMISSION}`
      : '\n沿用已经选定的切口和读者收获。完整证据仍可核对反例、事实和适用范围，避免把淘汰的切口和选材重新扩成正文。';
    if (assignment?.stage === 'outline') rolePrompt += `\n提纲篇幅目标：正文约${articleTargetCharacters}字，提纲建议约${outputGuidance.outlineTargetCharacters}字。只给各部分作用、少量关键要点、篇幅分配和开头结尾方向；不要扩写成小文章，不重复词汇表、证据账本、禁写清单或自检报告，不标注内部证据编号。作者明确要求详细提纲时可相应展开，重要约束不能省略。这是篇幅目标，不是保存硬上限，程序不截断正文或提纲。`;
    if (actor === 'director') rolePrompt += '\n核查问题归属：factCheck未通过是专家反馈，不等于作者缺材料。先核对主张是否真的在当前正文/选定标题中、是否为可核实事实、是否属于作者明确要求。Agent自行加入的无来源细节或误引，由你安排rework central_revision纠正并独立重查，不要求作者为Agent的错误补材料；不得改变作者立场、核心事实或已确认范围。若核查把修辞/创作性化用当成事实、核查了旧稿或正文不存在的句子，应安排fact_check重新审查并给出依据，不为凑passed删掉真正事实。只有确实依赖作者独有经历、来源或重要取舍时才needs_input/ask，直接说清需要哪一点及为何需要，不输出系统阻断通知。已知缺口必须在进入依赖它的阶段前解决；终审只能发现新增问题，不能替代前置沟通。';
    if (assignment?.stage === 'fact_check') rolePrompt += '\n先辨别可核实事实与作者表达：普通比喻、感受、明确虚构场景以及不冒充原文的创作性化用，不因缺少事实来源就列为UNSUPPORTED。涉及古籍原句、作者归属、具体出处、历史或科学论断则仍须核实；不能因为文体是散文而放行错误引文。每条claimText必须对应当前正文或选定标题中的真实主张，不把评审意见、建议改写或不存在的句子作为核查对象。第一人称亲历叙事的现场、动作、对白与感受属于作者本人的来源，不因合理加工、细节补写或语感润色被判为超范围，也不要求作者为记忆提供更逐字的证据；用词一致与文风对齐建议归语言终审，不生成核查编号。没有外部事实主张时直接给空 claims，不为显得尽责制造咬文嚼字。';
    if (actor === 'director') rolePrompt += '\n可选润色不是必要信息缺口：你认为某个比喻可以更好看、末句可以更贴原典，不等于作者必须再次确认。作者已表明这是现代比喻且未要求修改时，保持原句并安排独立核查区分事实与修辞；不要把核查专家的可选建议升级为新的写作要求。确实需要提问时用日常语言、每次1—2个不同的问题，不向作者暴露C008、rework、central_revision等后台术语，也不重复询问已经明确的选择。';
    if (actor === 'director') rolePrompt += '\n与作者交流一律使用中文角色名，禁止内部标识：研究与证据（不要写research）、文章提纲（不要写outline）、完整初稿（不要写draft）、编辑审校（不要写review_editor）、发布审校（不要写review_publish）、读者审校（不要写review_reader）、集中修订（不要写central_revision）、语言终审（不要写language_review）、事实核查（不要写fact_check）、标题专家（不要写title expert）。reason、提问和给作者看的任何文字都不出现英文阶段名、stage、rework、dispatch、C008等后台术语，也不中英混写（例如"先走language_review"）。';
    if (actor === 'director') rolePrompt += '\n提问只为真实业务缺口（缺素材、缺方向、缺取舍）。核查范围、阶段顺序、下一步流程都由程序按规则自动确定，不要请作者确认"是否按此范围核查""是否可以开始/继续"这类程序性问题，也不要把"正文这一版不动，可以吗"当作问题。reason 只写为什么需要作者补充，不要把要问的问题复述进去；问题只写在 questions 数组里。';
    if (actor === 'director' || isFactCheck) rolePrompt += '\nselectedPublication是程序已落库的作者选择，优先于正文首行的旧工作标题和历史聊天。selectionStatus=confirmed时不得再次询问选哪条标题，不要求因H1不一致再次确认；核查使用finalTitle。分发文案为可选项，没有选择配文就只核查成稿和发布标题，不能因此暂停。';
    const scopeId = `${actor}:${assignment?.decisionId ?? `director-${current.resume}-${current.events.filter((event) => event.type === "tool.completed" && ["submit_writing_stage", "submit_fact_check", "director_decide"].includes((event.payload.result as any)?.toolName)).length}`}${isFactCheck ? `:${prepared?.preparationId ?? 'extract'}` : ''}`;
    if (actor === 'director') rolePrompt += '\n共创审校为逐位交接：每位审校专家保存后程序暂停，先与作者核对当前意见，明确认可后才进入下一位。不能将编辑、发布、读者三份报告连续输出后才确认。作者在审校讨论中保留或拒绝的修改要传给修订主笔，不得被旧报告覆盖。';
    if (actor === 'director') rolePrompt += '\n读者审校是三个独立模拟身份的口语反应，不是编辑意见或真实调研，不得投票或把最激烈反应自动升级为必须修改。进入集中修订时，在reason中用“导演解读（非读者原话）”区分你的解读：结合写作目标、初稿具体段落和作者已确认的取舍，将值得处理的困惑翻译为具体修订项；也可以明确保留原文并说明理由。不能让读者给修改建议，不声称作者同意尚未确认的选择。';
    if (assignment?.stage === 'central_revision') rolePrompt += '\n绑定的authorReviewDiscussion是作者与审校专家公开交流的数据。作者最新明确保留、拒绝或调整的意见优先于旧审校报告；专家提议不等于作者同意，不能把作者已拒绝的可选修改重新应用。真正事实问题仍须处理或继续沟通，作者认可不能替代事实依据。';
    if (actor === 'director') rolePrompt += '\n给主笔和润色专家的任务要区分两件事：保留真实人物/来源的具体归属、事实限定与必要的不确定性；清除程序自己加进正文的重复材料说明。不要把“整理稿”“未经独立核实”这类通用工作声明锁成不可改的事实，不要命令主笔加总免责声明或在完整正文后附修改报告。内部核查状态由独立记录和界面告知作者。';
    if (actor === 'director' && current.revisionReturn) rolePrompt += '\n终审已返回必须修正的问题，revisionReturn绑定当前稿件。现在调用现有的rework central_revision，再交主笔逐项处理。不要重复终审或把Agent的可修正问题交给作者；沿用已有返工预算。';
    const stage = assignment?.stage;
    const stageFields = stage === 'central_revision' && reviewClosure ? { allowed: ['stage', 'content', 'resolutions'], required: ['resolutions'], stringFields: ['content'] }
      : stage === 'language_review' && comparisonCandidates ? { allowed: ['stage', 'content', 'comparison'], required: ['comparison'], stringFields: ['content'] }
      : stage === 'research' ? { allowed: ['stage', 'content'] } : undefined;
    const outputPreview = isPublicStageOutput(stage) && !comparisonCandidates && !(stage === 'central_revision' && reviewClosure)
      ? { id: `${runId}:preview:${scopeId}`, stage } : undefined;
    if (outputPreview) rolePrompt += '\n本次是纯文本成果生成：以普通回复逐步输出本阶段完整的 Markdown 提纲、文章或审校建议，不把全文包装为 JSON，不先写“正在整理”等开场说明。成果输出前仅在必要时调用已提供的读取工具补读目录中的原文，不重读本次已完整提供的内容。不输出私有推理、调度指令或内部字段。审校建议说明问题、阅读影响和修改建议，使用简短分段。程序会在完整响应结束后把这份原文交给 submit_writing_stage 校验保存，不需要你再次复制、调用或宣称保存成功。预览不代表已保存，也不代表作者已确认或事实核查已通过。';
    if (outputPreview) rolePrompt += '\n确实发现任务依赖的必要作者信息缺口时，不写成果或缺料说明，调用 assess_writing_readiness(status=needs_input) 提出最多两个具体问题并等待回答。当前 ready 已由程序按输入版本确认，不要重复提交 ready。';
    if (stage === 'language_review') rolePrompt += '\n最小润色包括消除旧稿中的工作备注、注释式真假标签和解释写作步骤的文字，这不等于删改文章事实。假设保留“如果/设想”等自然语气，不重复加“说明性假设，不是真事”；将内部材料标签改为材料确实支持的自然来源归属，不虚构来源、不移除实质限定。审校称赞过这些标签或提纲要求每节重复同一动作，不构成作者锁定要求；根据实际阅读效果修复，不按公式补齐。若确需改变核心论点或事实，交回主笔。任务说明中要求保留全部工作声明或附改动清单时，以本条与正文交付契约为准。';
    if (comparisonCandidates) rolePrompt += `\n${REVISION_COMPARISON_INSTRUCTIONS}\n本次必须调用submit_writing_stage，一次提交content和comparison；不另写正文外的普通回复。bodyOutputContract的标题和篇幅以选中版本为准。比较不意味着自动认可修订稿；事实、观点、作者明确取舍和有辨识度的表达优先于句子整齐。`;
    if (assignment?.stage && ['draft', 'central_revision', 'language_review'].includes(assignment.stage)) rolePrompt += '\n正文交付契约由程序规定，优先于任务说明中的输出格式建议：正文只含完整文章，不附改动说明、审校结论、版本号或“无需修改”等状态。没有修改时返回完整原文。语言润色必须保留所选版本在bodyOutputContract中对应的Markdown标题；不要因标题已确认而省略它。旧稿末尾如带明确的改动说明，说明不是文章，不复制进新正文，不把其字数算进正文基线。';
    if (actor === 'director' && !current.ready) rolePrompt += '\n先根据实际提供的材料判断本阶段是否充分。充分时优先一次调用 director_decide(action=dispatch, stage=nextStage, readinessReason=简短的充分性判断, reason=简短任务说明, questions=[])，程序会同时校验读取和阶段权限，无需先单独提交 ready。材料未完整提供时先补读；确有作者信息缺口时用 ask 或 assess_writing_readiness needs_input，不强行推进。';
    if (downstream && !isFactCheck) rolePrompt += '\n上下文按职责提供：evidence_table的claimFields是列名，claimRows每行按列对应一条完整主张，source_id对应sources。仅omittedFields列出的字段未提供；需要精确引语或事实依据时用read_artifact_version读取绑定证据版本，不猜省略内容。目录projection=evidence_catalog/artifact_catalog不等于全文，导演通常据阶段状态交接，不为调度重读全部产物。materialCatalog只是授权目录，不代表读过原文；需要上下文时用read_material读取。factCheck为状态与未解决主张，不改变门禁。';
    if (discussionReadTools.length) rolePrompt += '\nauthorReviewDiscussion保留作者每条决定及其顺序。contentFromMaterial指向本次materials中相同版本的完整原话，contentFromArtifactId指向本次完整产物；它们仍是原角色的发言，不代表同意。旧助手说明按sequence索引，遇到“这一条/第二处”等指代不清时，用read_review_discussion读取该sequence恢复上下文，不能根据目录猜测或忽略作者的否定。';
    // Once every stage and the current fact gate passed, there is no stage for
    // the model to choose. Bind the finish operation locally, using the same
    // validated tool path as normal decisions; recheck all gates at execution.
    const finishing = actor === 'director' && !current.finished && current.ready && current.nextStage === null
      && workflow.completion(runId).publicationReady;
    return {
      scopeId: finishing ? `${scopeId}:completion` : scopeId,
      ...(finishing ? { textOutputTool: { name: 'director_decide', arguments: { action: 'finish', stage: null, questions: [] }, contentArgument: 'reason' },
        modelTools: [], toolChoice: 'none' as const } : {}),
      ...(outputPreview ? { outputPreview } : {}),
      ...(outputPreview ? { textOutputTool: { name: 'submit_writing_stage', arguments: { stage: outputPreview.stage }, contentArgument: 'content' },
        modelTools: [...materialReadTools, ...artifactReadTools, ...discussionReadTools, 'assess_writing_readiness'], toolChoice: 'auto' as const } : {}),
      actor: isFactCheck && !prepared ? 'fact_extract' : actor,
      // Receipt IDs and remaining budget are observation metadata, not task
      // progress. Keep the exact business inputs/versions and deduplicated
      // material slices so new tasks or real reads still reset the guard.
      progressKey: JSON.stringify({ task: actor === 'director' ? directorMessage : actor === 'title' ? assignment!.reason : options.expertMessage,
        ...summary, savedSourceRecords: undefined, searchBudget: undefined, researchSearchBudget: undefined }),
      systemPrompt: finishing ? '你是写作导演。当前文章所有阶段均已完成，已保存的正文和选定标题已通过程序事实门禁。只用一至两句中文告诉作者可以查看当前稿件，后续想调整可以继续提出。不要重写文章、重新审校、索要确认或发起新任务；不输出JSON、阶段名或工具参数。程序会再次校验当前版本与完成条件并记录收尾。'
        : isFactCheck ? factReviewPrompt(prepared ? 'verify' : 'extract', factSearch.enabled())
        : `${commonPrompt}\nACTOR=${actor}\n${buildExpertInstructions(actor)}\n${rolePrompt}\n${sharedStateRules}${selectedStyle && !['research', 'review_reader'].includes(actor) ? `\n${STYLE_APPLICATION_POLICY}` : ''}`,
      userMessage: isFactCheck ? `核对当前文章的重要事实，不重新审稿。\nCOLLABORATION_STATE=${JSON.stringify({
        actor, stage: 'fact_check', ready: current.ready, finished: current.finished, nextStage: current.nextStage, inputVersionIds: inputs,
        artifacts: summary.artifacts, selectedPublication: summary.selectedPublication,
        factPhase: prepared ? 'verify' : 'extract',
        ...(prepared ? { preparedClaims: prepared.claims, noFactualClaimsReason: prepared.noFactualClaimsReason,
          savedSourceRecords: factRecordCatalog(storage, runId, prepared.preparationId) } : {}), searchBudget: factSearch.budget(runId),
      })}` : `${(actor === "director" ? directorMessage : actor === 'title' ? assignment!.reason : options.expertMessage).split("\n").filter((line) => !line.startsWith("必须先用 read_material") && !(selectedStyle !== undefined && line.startsWith('风格参考档案'))).join("\n")}\n${styleContext(selectedStyle, actor)}\nCOLLABORATION_STATE=${JSON.stringify(summary)}`,
      allowedTools: finishing ? ['director_decide'] : isFactCheck ? factReviewTools(prepared !== null, factSearch.budget(runId), factSearch.enabled()) : allowedTools,
      ...(stageFields ? { roleToolFields: { submit_writing_stage: stageFields } } : {}),
      ...(isFactCheck ? { projectHistory: projectFactHistory, toolFailureLoopKey: factToolFailureLoopKey } : {}),
      projectToolResult: (message, context) => isFactCheck ? projectFactToolResult(message, context, prepared ? {
        versionId: prepared.evidenceVersionId, evidenceIds: prepared.claims.flatMap(c => c.matchedEvidenceIds) } : undefined) : projectInlineRead(message, artifactContext.completeArtifacts, summary.materials, artifacts),
      toolValidationError: call => call.name === 'submit_fact_check' ? factSubmissionError(prepared, call.arguments)
        : call.name === 'search_fact_sources' && factSearch.budget(runId).retryQuery && (call.arguments as { query?: string }).query?.trim() !== factSearch.budget(runId).retryQuery
          ? { code: 'SEARCH_RETRY_QUERY_REQUIRED', message: '用户选择重试原检索词，不改写查询。', retryable: false, details: { query: factSearch.budget(runId).retryQuery } } : null,
      ...(!outputPreview && !current.finished && !finishing ? { toolChoice: 'required' as const } : {}),
      expectedBodyVersionId: assignment?.expectedBodyVersionId === undefined ? current.expectedBodyVersionId : assignment.expectedBodyVersionId,
      authorizeTool(call) {
        const args = call.arguments as Record<string, unknown>;
        if (call.name === "read_artifact_version") return inputs.includes(String(args.versionId));
        if (call.name === "read_material") return options.materialIds.includes(String(args.materialId));
        if (call.name === 'read_review_discussion') return actor === 'director' || assignment?.stage === 'central_revision';
        if (call.name === "submit_writing_stage") return args.stage === assignment?.stage;
        if (call.name === 'submit_publication_candidates') return actor === 'title';
        if (call.name === "read_fact_source" || call.name === 'search_fact_sources') return assignment?.stage === "fact_check" && factSearch.enabled();
        // tool.requested is already recorded at authorization time. The tool
        // excludes that operation when enforcing quota; do not charge it twice.
        if (call.name === 'search_research_sources') return assignment?.stage === 'research' && researchSearch.enabled();
        if (['read_fact_evidence', 'read_fact_record', 'read_fact_article', 'prepare_fact_check'].includes(call.name)) return isFactCheck;
        if (call.name === "submit_fact_check") {
          const project = storage.inspectProject(projectId);
          return project !== null && inputs.includes(project.currentEvidenceVersionId ?? "") && inputs.includes(project.latestBodyVersionId ?? "");
        }
        return true;
      },
    };
  };
  const discussionReader: ToolDefinition<{ sequence: number }, JsonValue> = {
    name: 'read_review_discussion', version: '1.0.0', effect: 'read_only', permissions: ['artifact:read'],
    description: 'Read one earlier public discussion entry by its sequence in the supplied authorReviewDiscussion. Only the bound project/session history is available. No private reasoning.',
    inputSchema: { type: 'object', properties: { sequence: { type: 'integer', minimum: 0 } }, required: ['sequence'], additionalProperties: false },
    execute(args) {
      const item = Array.isArray(options.authorReviewDiscussion) ? options.authorReviewDiscussion.find(item =>
        item && typeof item === 'object' && !Array.isArray(item) && item.sequence === args.sequence) : undefined;
      if (!item) throw new ToolExecutionFault('REVIEW_DISCUSSION_NOT_FOUND', 'Choose a sequence from the supplied authorReviewDiscussion, not another session.');
      return { item, instructionAuthority: 'none' };
    },
  };
  const reviewPause = (runId: string) => {
    const nextStage = workflow.progress(runId).nextStage;
    if (!nextStage?.startsWith('review_')) return null;
    const draft = stageArtifact(storage, projectId, runId, 'draft');
    if (!draft || storage.inspectProject(projectId)?.latestBodyVersionId === draft.id) return null;
    const confirmed = workflow.recoverConfirmedBody(runId);
    if (confirmed && storage.inspectProject(projectId)?.latestBodyVersionId === confirmed &&
        stageArtifact(storage, projectId, runId, 'draft')?.id === confirmed) return null;
    return { reason: 'WRITING_INPUT_REQUIRED', payload: {
      reason: '正文已在本次运行之外更新，原稿的审校已暂停，当前稿件已保留。',
      questions: ['是否要基于当前保存的稿件重新开始写作？请结束旧任务后，从当前稿件发起新任务。'],
      nextStage, requiredArtifactVersionIds: [],
    } };
  };
  return { definitions: [definition as unknown as ToolDefinition<never, JsonValue>, publicationCandidatesDefinition as unknown as ToolDefinition<never, JsonValue>, discussionReader as unknown as ToolDefinition<never, JsonValue>,
      ...createFactContextTools(storage, projectId, factBinding),
      createFactSourceTool({ storage, projectId, searchEnabled: factSearch.enabled, isDiscoveredSource: factSearch.isDiscoveredSource }) as unknown as ToolDefinition<never, JsonValue>, ...factSearch.definitions, ...researchSearch.definitions],
    requestPolicy, reviewPause, searchPause: factSearch.pause, finished: (runId: string) => state(runId).finished };
}
