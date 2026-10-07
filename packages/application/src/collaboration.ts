import type { AgentRequestPolicy } from "../../runtime/agent/src/index.js";
import { isPublicStageOutput } from '../../writing-core/src/public-stage-output.js';
import type { SessionStore } from "../../runtime/session/src/index.js";
import { ToolExecutionFault, type ToolDefinition } from "../../runtime/tools/src/index.js";
import type { JsonValue, StoragePort } from "../../writing-core/src/index.js";
import { FactClaimStatusSchema, FactClaimTypeSchema } from "../../writing-core/src/index.js";
import { workflowStageSequence, type WritingWorkflowStage } from "../../writing-pack/src/index.js";
import { buildExpertInstructions } from '../../writing-pack/src/expert-instructions.js';
import { assertBusinessInputQuestions, bodyArticleBaseline, evidenceIdsFromLedger, type WritingWorkflowTools } from "./workflow-tools.js";
import { getPublicationCandidates, savePublicationCandidates, isPublicationSelectionCurrent, isUsablePublicationTitle,
  PUBLICATION_SELECTION_WAIT_REASON, selectedPublicationContext, type PublicationCandidate } from './publication-choice.js';
import { createFactSourceTool } from './fact-web.js';
import { createFactSearchTools, type FactSearchConfiguration } from './fact-search.js';
import { checkpointIntentReceipt } from './conversation-intent.js';
import { inlineMaterialContext } from './material-context.js';
import { deduplicateReviewDiscussion, factStatusContext, projectInlineRead, stageArtifactContext } from './agent-context.js';
import { factMaterialContext, FACT_CONTEXT_GUIDANCE, projectFactToolResult, createFactContextTools, factPreparation, factExtractionArtifacts, factVerificationArtifacts, factSubmissionCoversPreparation, factRecordCatalog, type FactBinding } from './fact-context.js';

type Decision = { action: "dispatch" | "ask" | "rework" | "finish"; stage: WritingWorkflowStage | null; reason: string; questions: string[]; inputVersionIds?: string[]; readinessReason?: string };

type CollaborationStage = WritingWorkflowStage | "title";
type ArtifactExpectation = { kind: "evidence" | "outline" | "body" | "review" | "fact_assessment" | "publication_candidates"; mayCommitBody: boolean };
type Assignment = { actor: string; stage: CollaborationStage | null; decisionId: string; inputVersionIds: string[]; reason: string; status: string; invalidatedStages: readonly string[]; expectedArtifact: ArtifactExpectation | null; expectedBodyVersionId?: string | null };

function expectedArtifact(stage: CollaborationStage): ArtifactExpectation {
  if (stage === 'title') return { kind: 'publication_candidates', mayCommitBody: false };
  if (stage === "research") return { kind: "evidence", mayCommitBody: false };
  if (stage === "outline") return { kind: "outline", mayCommitBody: false };
  if (stage.startsWith("review_")) return { kind: "review", mayCommitBody: false };
  if (stage === "fact_check") return { kind: "fact_assessment", mayCommitBody: false };
  return { kind: "body", mayCommitBody: true };
}

function stageInstruction(stage: WritingWorkflowStage, basePrompt: string): string {
  if (stage === "research") return '当前为材料整理模式，没有外部搜索工具：从本次授权材料提取正文所需证据；多来源矛盾只对照实际提供的内容，不臆造检索或核验结果。只提交研究账本，content直接用对象{sources,claims,notes}，不要转成带转义的JSON字符串。sources按来源列一次source_id、source_title、source_publisher、accessed_at及可选source_url；每条claim用source_id引用，填写claim_type、claim_text、source_quote、reliability、use_boundary、verification_status。evidence_id可省略，由程序编号；确需保留旧编号时明确填写。仅illustrative允许空引句，其余必须引用连续原文；用户材料不能自动标为已外部核实。无事实时sources和claims用空数组，notes说明原因。关键前提存在必要证据缺口时暂停提问，不用猜测补足；成稿后仍须独立事实核查。不要设计开头、结尾、标题或提纲；明确排除的材料只在notes简记理由和必要风险，不另造完整证据条目。';
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
  const state = (runId: string) => {
    const confirmedBodyVersionId = workflow.recoverConfirmedBody(runId);
    const events = storage.listRunEvents(runId);
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
    const completedAfter = latest !== undefined && events.some((event) => event.projectSeq > latest.projectSeq && event.type === "tool.completed" &&
      ["submit_writing_stage", "submit_fact_check", "submit_publication_candidates"].includes((event.payload.result as any)?.toolName) &&
      (event.payload.result as any)?.result?.stage === assignment?.stage);
    const current = assignment !== undefined && assignment.status === "dispatched" && !completedAfter ? assignment : null;
    const nextStage = workflow.progress(runId).nextStage;
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
    return { events, segment, resume, latest, current, nextStage, inputs, ready, finished, expectedBodyVersionId };
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
        if (!current.ready && !(args.action === 'dispatch' && args.readinessReason?.trim())) throw new ToolExecutionFault("WRITING_READINESS_REQUIRED", "Read authorized inputs, then assess readiness or supply readinessReason with dispatch for the current next stage");
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
        inputVersionIds: current.inputs, reason: args.reason.trim(), status: args.action === "dispatch" ? "dispatched" : args.action === "finish" ? "finished" : args.action === "rework" ? "rework" : "waiting_user", invalidatedStages,
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
    const artifacts = inputs.map((id) => storage.getArtifactVersion(id)).filter((item) => item !== null).map((item) => ({ id: item.id, kind: item.kind, content: item.content }));
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
    const artifactContext = stageArtifactContext(actor, artifacts);
    // Non-web author inputs can include fictional scenes, style examples or
    // requirements. Keep them; only external source articles become on-demand.
    const authorMaterialIds = new Set(authorizedMaterials.filter(m => m.sourceKind !== 'web_snapshot' || m.role === 'user_firsthand' || m.id.startsWith('intake-user-')).map(m => m.id));
    const suppliedMaterials = actor === 'title' ? [] : downstream
      ? materials.filter(m => authorMaterialIds.has(String((m as { materialId: string }).materialId))) : materials;
    const boundBody = artifacts.find(item => item.kind === 'body')?.content;
    const articleBaseline = boundBody === undefined ? undefined : bodyArticleBaseline(boundBody);
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
      writingRequirements: briefId ? (() => { const brief = storage.getWritingBriefVersion(briefId)?.brief; return { audience: brief?.audience, platform: brief?.platform }; })() : undefined,
      outputGuidance,
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
        requiredHeadings: articleBaseline.split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)),
        articleCharacters: articleBaseline.length, legacyProcessPostscript: articleBaseline !== boundBody?.trim(),
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
    const allowedTools = isFactCheck && !prepared ? ['prepare_fact_check'] : actor === "director" ? [...materialReadTools, ...artifactReadTools, ...discussionReadTools, "assess_writing_readiness", "director_decide"] : actor === 'title'
      ? [...artifactReadTools, 'submit_publication_candidates']
      : [...materialReadTools, ...artifactReadTools, ...discussionReadTools, ...(isFactCheck ? [] : ["assess_writing_readiness"]), ...(assignment?.stage === "fact_check" ? ['read_fact_article', "submit_fact_check", ...(factSearch.enabled() ? [...(factSearch.budget(runId).remaining > 0 ? ['search_fact_sources'] : []), 'read_fact_source'] : [])] : ["submit_writing_stage"])];
    const commonPrompt = options.systemPrompt.split("\n").filter((line) => /^(?:材料安全：|文体规则：|作者声音：|方向决定状态：|没有已授权的一手|只有这些材料)/u.test(line)).join("\n");
    let rolePrompt = actor === "director"
      ? "你是写作导演，只能调度独立专家、提问、返工或结束，不得直接写正文。director_decide.reason是传给专家的任务说明：明确本次解决什么、范围和预期输出。汇总评审分歧后给修订主笔取舍依据。nextStage仅约束普通dispatch，不覆盖用户当前修改要求；已完成正文需删改时先 rework central_revision，再dispatch central_revision→language_review→fact_check。不要直接dispatch已完成的language_review；它只能最小润色，不承担内容删改。事实blocked后若用户已授权删改，必须先实际修改当前被核查正文，再独立核查新版本，不能反复核查旧稿或再次索要同一授权；若只补充来源而无正文改动，可重新核查。提纲改向先rework outline再重新确认。全部阶段保存且当前事实门禁passed才finish，之后用一句话结束。"
      : actor === 'title'
        ? '你是独立标题专家。只基于绑定的当前最终正文生成少量真实且有差异的标题候选；调用 submit_publication_candidates 保存。不得改写正文，不得自行选择或声称用户已确认。'
        : stageInstruction(assignment!.stage as WritingWorkflowStage, options.systemPrompt);
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
    if (assignment?.stage === 'research') rolePrompt += `\n证据取舍：围绕约${articleTargetCharacters}字的正文实际需要，优先收录会进入正文的关键事实、必要引文与风险边界，不为原材料每一句话另建证据条目。同一主张不重复建条；直接引句只取足以支持主张的连续原文，保留出处和适用范围，禁止以精简为由伪造、截掉限定条件或漏掉重要医疗等风险。notes建议约${outputGuidance.researchNotesTargetCharacters}字，只列未解决缺口和共同边界，不重复claims、长篇分析或提前拟提纲。这是篇幅目标，不是保存硬上限；程序不截断内容。`;
    if (assignment?.stage === 'outline') rolePrompt += `\n提纲篇幅目标：正文约${articleTargetCharacters}字，提纲建议约${outputGuidance.outlineTargetCharacters}字。只给各部分作用、少量关键要点、篇幅分配和开头结尾方向；不要扩写成小文章，不重复词汇表、证据账本、禁写清单或自检报告，不标注内部证据编号。作者明确要求详细提纲时可相应展开，重要约束不能省略。这是篇幅目标，不是保存硬上限，程序不截断正文或提纲。`;
    if (actor === 'director') rolePrompt += '\n核查问题归属：factCheck未通过是专家反馈，不等于作者缺材料。先核对主张是否真的在当前正文/选定标题中、是否为可核实事实、是否属于作者明确要求。Agent自行加入的无来源细节或误引，由你安排rework central_revision纠正并独立重查，不要求作者为Agent的错误补材料；不得改变作者立场、核心事实或已确认范围。若核查把修辞/创作性化用当成事实、核查了旧稿或正文不存在的句子，应安排fact_check重新审查并给出依据，不为凑passed删掉真正事实。只有确实依赖作者独有经历、来源或重要取舍时才needs_input/ask，直接说清需要哪一点及为何需要，不输出系统阻断通知。已知缺口必须在进入依赖它的阶段前解决；终审只能发现新增问题，不能替代前置沟通。';
    if (assignment?.stage === 'fact_check') rolePrompt += '\n先辨别可核实事实与作者表达：普通比喻、感受、明确虚构场景以及不冒充原文的创作性化用，不因缺少事实来源就列为UNSUPPORTED。涉及古籍原句、作者归属、具体出处、历史或科学论断则仍须核实；不能因为文体是散文而放行错误引文。每条claimText必须对应当前正文或选定标题中的真实主张，不把评审意见、建议改写或不存在的句子作为核查对象。第一人称亲历叙事的现场、动作、对白与感受属于作者本人的来源，不因合理加工、细节补写或语感润色被判为超范围，也不要求作者为记忆提供更逐字的证据；用词一致与文风对齐建议归语言终审，不生成核查编号。没有外部事实主张时直接给空 claims，不为显得尽责制造咬文嚼字。';
    if (actor === 'director') rolePrompt += '\n可选润色不是必要信息缺口：你认为某个比喻可以更好看、末句可以更贴原典，不等于作者必须再次确认。作者已表明这是现代比喻且未要求修改时，保持原句并安排独立核查区分事实与修辞；不要把核查专家的可选建议升级为新的写作要求。确实需要提问时用日常语言、每次1—2个不同的问题，不向作者暴露C008、rework、central_revision等后台术语，也不重复询问已经明确的选择。';
    if (actor === 'director') rolePrompt += '\n与作者交流一律使用中文角色名，禁止内部标识：研究与证据（不要写research）、文章提纲（不要写outline）、完整初稿（不要写draft）、编辑审校（不要写review_editor）、发布审校（不要写review_publish）、读者审校（不要写review_reader）、集中修订（不要写central_revision）、语言终审（不要写language_review）、事实核查（不要写fact_check）、标题专家（不要写title expert）。reason、提问和给作者看的任何文字都不出现英文阶段名、stage、rework、dispatch、C008等后台术语，也不中英混写（例如"先走language_review"）。';
    if (actor === 'director') rolePrompt += '\n提问只为真实业务缺口（缺素材、缺方向、缺取舍）。核查范围、阶段顺序、下一步流程都由程序按规则自动确定，不要请作者确认"是否按此范围核查""是否可以开始/继续"这类程序性问题，也不要把"正文这一版不动，可以吗"当作问题。reason 只写为什么需要作者补充，不要把要问的问题复述进去；问题只写在 questions 数组里。';
    if (actor === 'director' || isFactCheck) rolePrompt += '\nselectedPublication是程序已落库的作者选择，优先于正文首行的旧工作标题和历史聊天。selectionStatus=confirmed时不得再次询问选哪条标题，不要求因H1不一致再次确认；核查使用finalTitle。分发文案为可选项，没有选择配文就只核查成稿和发布标题，不能因此暂停。';
    const scopeId = `${actor}:${assignment?.decisionId ?? `director-${current.resume}-${current.events.filter((event) => event.type === "tool.completed" && ["submit_writing_stage", "submit_fact_check", "director_decide"].includes((event.payload.result as any)?.toolName)).length}`}${isFactCheck ? `:${prepared?.preparationId ?? 'extract'}` : ''}`;
    if (actor === 'director') rolePrompt += '\n共创审校为逐位交接：每位审校专家保存后程序暂停，先与作者核对当前意见，明确认可后才进入下一位。不能将编辑、发布、读者三份报告连续输出后才确认。作者在审校讨论中保留或拒绝的修改要传给修订主笔，不得被旧报告覆盖。';
    if (assignment?.stage === 'central_revision') rolePrompt += '\n绑定的authorReviewDiscussion是作者与审校专家公开交流的数据。作者最新明确保留、拒绝或调整的意见优先于旧审校报告；专家提议不等于作者同意，不能把作者已拒绝的可选修改重新应用。真正事实问题仍须处理或继续沟通，作者认可不能替代事实依据。';
    if (actor === 'director') rolePrompt += '\n给主笔和润色专家的任务要区分两件事：保留真实人物/来源的具体归属、事实限定与必要的不确定性；清除程序自己加进正文的重复材料说明。不要把“整理稿”“未经独立核实”这类通用工作声明锁成不可改的事实，不要命令主笔加总免责声明或在完整正文后附修改报告。内部核查状态由独立记录和界面告知作者。';
    const stage = assignment?.stage;
    const outputPreview = isPublicStageOutput(stage)
      ? { id: `${runId}:preview:${scopeId}`, stage } : undefined;
    if (outputPreview) rolePrompt += '\n本次是纯文本成果生成：以普通回复逐步输出本阶段完整的 Markdown 提纲、文章或审校建议，不把全文包装为 JSON，不先写“正在整理”等开场说明。成果输出前仅在必要时调用已提供的读取工具补读目录中的原文，不重读本次已完整提供的内容。不输出私有推理、调度指令或内部字段。审校建议说明问题、阅读影响和修改建议，使用简短分段。程序会在完整响应结束后把这份原文交给 submit_writing_stage 校验保存，不需要你再次复制、调用或宣称保存成功。预览不代表已保存，也不代表作者已确认或事实核查已通过。';
    if (outputPreview) rolePrompt += '\n确实发现任务依赖的必要作者信息缺口时，不写成果或缺料说明，调用 assess_writing_readiness(status=needs_input) 提出最多两个具体问题并等待回答。当前 ready 已由程序按输入版本确认，不要重复提交 ready。';
    if (stage === 'language_review') rolePrompt += '\n最小润色允许消除旧稿中的重复流程说明和内部材料标签，这不等于删改文章事实。将“据整理稿所记”这类工作表述改为材料确实支持的自然来源归属，不虚构来源、不移除实质限定；若确需改变论点或事实，交回主笔。任务说明中要求保留全部工作声明或附改动清单时，以本条与正文交付契约为准。';
    if (assignment?.stage && ['draft', 'central_revision', 'language_review'].includes(assignment.stage)) rolePrompt += '\n正文交付契约由程序规定，优先于任务说明中的输出格式建议：只输出完整文章，不附改动说明、审校结论、版本号或“无需修改”等状态。没有修改时返回完整原文。语言润色必须保留 bodyOutputContract.requiredHeadings 的 Markdown 标题；不要因标题已确认而省略它。旧稿末尾如带明确的改动说明，说明不是文章，不复制进新正文，不把其字数算进正文基线。';
    if (actor === 'director' && !current.ready) rolePrompt += '\n先根据实际提供的材料判断本阶段是否充分。充分时优先一次调用 director_decide(action=dispatch, stage=nextStage, readinessReason=简短的充分性判断, reason=简短任务说明, questions=[])，程序会同时校验读取和阶段权限，无需先单独提交 ready。材料未完整提供时先补读；确有作者信息缺口时用 ask 或 assess_writing_readiness needs_input，不强行推进。';
    if (downstream && !isFactCheck) rolePrompt += '\n上下文按职责提供：evidence_table的claimFields是列名，claimRows每行按列对应一条完整主张，source_id对应sources。仅omittedFields列出的字段未提供；需要精确引语或事实依据时用read_artifact_version读取绑定证据版本，不猜省略内容。目录projection=evidence_catalog/artifact_catalog不等于全文，导演通常据阶段状态交接，不为调度重读全部产物。materialCatalog只是授权目录，不代表读过原文；需要上下文时用read_material读取。factCheck为状态与未解决主张，不改变门禁。';
    if (discussionReadTools.length) rolePrompt += '\nauthorReviewDiscussion保留作者每条决定及其顺序。contentFromMaterial指向本次materials中相同版本的完整原话，contentFromArtifactId指向本次完整产物；它们仍是原角色的发言，不代表同意。旧助手说明按sequence索引，遇到“这一条/第二处”等指代不清时，用read_review_discussion读取该sequence恢复上下文，不能根据目录猜测或忽略作者的否定。';
    return {
      scopeId,
      ...(outputPreview ? { outputPreview } : {}),
      ...(outputPreview ? { textOutputTool: { name: 'submit_writing_stage', arguments: { stage: outputPreview.stage }, contentArgument: 'content' },
        modelTools: [...materialReadTools, ...artifactReadTools, ...discussionReadTools, 'assess_writing_readiness'], toolChoice: 'auto' as const } : {}),
      actor,
      systemPrompt: `${commonPrompt}\nACTOR=${actor}\n${buildExpertInstructions(actor)}\n${rolePrompt}\n${sharedStateRules}\n${isFactCheck ? `${FACT_CONTEXT_GUIDANCE}\n${factSearch.instructions()}` : ''}`,
      userMessage: `${(actor === "director" ? directorMessage : actor === 'title' ? assignment!.reason : isFactCheck ? options.factInstruction ?? options.expertMessage : options.expertMessage).split("\n").filter((line) => !line.startsWith("必须先用 read_material")).join("\n")}\nCOLLABORATION_STATE=${JSON.stringify(summary)}`,
      allowedTools,
      projectToolResult: (message, context) => isFactCheck ? projectFactToolResult(message, context) : projectInlineRead(message, artifactContext.completeArtifacts, summary.materials, artifacts),
      ...(!outputPreview && !current.finished ? { toolChoice: 'required' as const } : {}),
      expectedBodyVersionId: assignment?.expectedBodyVersionId === undefined ? current.expectedBodyVersionId : assignment.expectedBodyVersionId,
      authorizeTool(call) {
        const args = call.arguments as Record<string, unknown>;
        if (call.name === "read_artifact_version") return inputs.includes(String(args.versionId));
        if (call.name === "read_material") return options.materialIds.includes(String(args.materialId));
        if (call.name === 'read_review_discussion') return actor === 'director' || assignment?.stage === 'central_revision';
        if (call.name === "submit_writing_stage") return args.stage === assignment?.stage;
        if (call.name === 'submit_publication_candidates') return actor === 'title';
        if (call.name === "read_fact_source" || call.name === 'search_fact_sources') return assignment?.stage === "fact_check" && factSearch.enabled();
        if (['read_fact_evidence', 'read_fact_record', 'read_fact_article', 'prepare_fact_check'].includes(call.name)) return isFactCheck;
        if (call.name === "submit_fact_check") {
          const project = storage.inspectProject(projectId);
          return project !== null && inputs.includes(project.currentEvidenceVersionId ?? "") && inputs.includes(project.latestBodyVersionId ?? "") && factSubmissionCoversPreparation(prepared, args);
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
  return { definitions: [definition as unknown as ToolDefinition<never, JsonValue>, publicationCandidatesDefinition as unknown as ToolDefinition<never, JsonValue>, discussionReader as unknown as ToolDefinition<never, JsonValue>,
      ...createFactContextTools(storage, projectId, factBinding),
      createFactSourceTool({ storage, projectId, searchEnabled: factSearch.enabled, isDiscoveredSource: factSearch.isDiscoveredSource }) as unknown as ToolDefinition<never, JsonValue>, ...factSearch.definitions],
    requestPolicy, finished: (runId: string) => state(runId).finished };
}
