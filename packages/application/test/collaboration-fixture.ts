import type { ModelRequest, ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { isPublicStageOutput } from '../../writing-core/src/public-stage-output.js';
import { expandResearchEvidence } from '../src/research-evidence.js';
import type { BoundReviewFinding } from '../src/review-closure.js';

export function editorialPlanFixture(evidenceIds: readonly string[], omittedIds: readonly string[] = []) {
  const selected = evidenceIds.filter(id => !omittedIds.includes(id));
  return {
    angles: [
      { id: 'A1', readerProblem: '读者难以找到文本中最直接的观察。', readerGain: '能复述作者最值得留下的观察。', angle: '从现有材料中提炼一条具体观察。', supportingEvidenceIds: selected.slice(0, 12) },
      { id: 'A2', readerProblem: '读者难以判断例子能否推广。', readerGain: '分清个别感受与可推广的结论。', angle: '讨论原材料可以支持的适用边界。', supportingEvidenceIds: [] },
    ],
    selectedAngleId: 'A1', selectionReason: '第一种切口紧扣原材料和当前读者。',
    materialDecisions: evidenceIds.map(evidenceId => ({ evidenceId, decision: omittedIds.includes(evidenceId) ? 'omit' : 'use', reason: '测试夹具的选材决定。' })),
    gaps: selected.length === 0 ? ['只写作者提供的感受，不补造外部事实。'] : [],
  };
}

function plannedResearchContent(content: unknown) {
  try {
    const ledger = typeof content === 'string' ? JSON.parse(content) : content;
    if (!ledger || !Array.isArray(ledger.claims) || 'editorialPlan' in ledger) return content;
    const expanded = expandResearchEvidence(ledger) as { claims: { evidence_id: string }[] };
    const planned = { ...ledger, editorialPlan: editorialPlanFixture(expanded.claims.map(claim => claim.evidence_id)) };
    return typeof content === 'string' ? JSON.stringify(planned) : planned;
  } catch {
    // Let deliberately malformed fixture responses reach the real validator.
    return content;
  }
}

export function revisionComparisonFixture(state: CollaborationFixtureState, finalContent: string, chooseOriginal = false) {
  const comparison = state.revisionComparison!;
  const original = state.artifacts?.find(a => a.id === comparison.originalVersionId)?.content;
  const revised = state.artifacts?.find(a => a.id === comparison.revisedVersionId)?.content;
  if (typeof original !== 'string' || typeof revised !== 'string') throw new Error('Missing bound articles in fixture request');
  const selected = chooseOriginal ? original : revised;
  const selectedVersionId = chooseOriginal ? comparison.originalVersionId : comparison.revisedVersionId;
  const retained = selected.split(/\r?\n/u).find(line => line.trim() && line.length <= 500 && finalContent.includes(line));
  const before = original.replaceAll('\r\n', '\n').trim();
  const after = revised.replaceAll('\r\n', '\n').trim();
  const entries = before === after ? [] : [comparisonExcerpt(original, revised)];
  return {
    selectedVersionId,
    reason: chooseOriginal ? '保留初稿中已经清楚的表达。' : '保留修订稿及其当前阅读顺序。',
    gains: chooseOriginal ? [] : entries,
    losses: chooseOriginal ? entries : [],
    retainedQuotes: retained ? [retained] : [],
  };
}

function comparisonExcerpt(original: string, revised: string) {
  let prefix = 0;
  while (prefix < original.length && prefix < revised.length && original[prefix] === revised[prefix]) prefix++;
  const start = Math.max(0, prefix - 100);
  const before = original.slice(start, prefix + 200);
  const after = revised.slice(start, prefix + 200);
  return { before, after, why: '测试夹具记录两个输入版本实际发生的变化。' };
}

/** Workflow mocks don't perform semantic extraction. The extraction contract
 * itself is covered by fact-context and the claim-first integration test. */
export function factPreparationFixtureEvents(request: ModelRequest): ProviderStreamEvent[] | null {
  if (request.tools?.length !== 1 || request.tools[0]?.name !== 'prepare_fact_check') return null;
  return [{ type: 'tool_call_delta', index: 0, id: `prepare-${request.requestId}`, name: 'prepare_fact_check',
    argumentsDelta: JSON.stringify({ claims: [], noFactualClaimsReason: '此工作流测试使用已授权的个人感受，不模拟事实语义判断。' }) },
    { type: 'completed', finishReason: 'tool_calls' }];
}

/** Adapt synthetic responses to the actual policy of the current request. */
export function publicStageFixtureEvents(request: ModelRequest, name: string, args: any): ProviderStreamEvent[] | null {
  const reader = readerSimulationFixtureEvents(request);
  if (reader) return reader;
  const state = collaborationState(request);
  if (name === 'director_decide' && args.action === 'finish' && state?.actor === 'director'
      && state.nextStage === null && request.parameters.toolChoice === 'none') {
    return [{ type: 'text_delta', delta: args.reason }, { type: 'completed', finishReason: 'stop' }];
  }
  if (name === 'submit_writing_stage' && state && state.stage === args.stage) {
    const structured = structuredStageFixtureArgs(state, args);
    if (structured && (state.stage === 'review_editor' || state.stage === 'review_publish') && !request.tools?.some(t => t.name === name)) {
      const { stage: _stage, ...output } = structured as Record<string, unknown>;
      return [{ type: 'text_delta', delta: JSON.stringify(output) }, { type: 'completed', finishReason: 'stop' }];
    }
    if (structured) return [{ type: 'tool_call_delta', index: 0, id: `stage-${request.requestId}`, name,
      argumentsDelta: JSON.stringify(structured) }, { type: 'completed', finishReason: 'tool_calls' }];
  }
  return name === 'submit_writing_stage' && isPublicStageOutput(state?.stage) && state.stage === args.stage
    && !request.tools?.some(t => t.name === name)
    ? [{ type: 'text_delta', delta: args.content }, { type: 'completed', finishReason: 'stop' }] : null;
}

function structuredStageFixtureArgs(state: CollaborationFixtureState, args: Record<string, unknown>) {
  if (state.stage === 'research' && state.editorialPlanRequired) return { ...args, content: plannedResearchContent(args.content) };
  if ((state.stage === 'review_editor' || state.stage === 'review_publish') && state.reviewFindingsRequired) {
    return { ...args, findings: args.findings === undefined ? [] : args.findings };
  }
  if (state.stage === 'central_revision' && state.reviewClosure) {
    if (args.resolutions === undefined && state.reviewClosure.findings.length > 0) {
      throw new Error('Fixture with findings must explicitly supply revision resolutions');
    }
    return { ...args, resolutions: args.resolutions === undefined ? [] : args.resolutions };
  }
  if (state.stage === 'language_review' && (state.revisionComparison || state.reviewClosure)) {
    if (args.audit === undefined && state.reviewClosure?.findings.length) {
      throw new Error('Fixture with findings must explicitly supply a terminal audit');
    }
    return { ...args,
      ...(state.revisionComparison && args.comparison === undefined ? { comparison: revisionComparisonFixture(state, args.content as string) } : {}),
      ...(state.reviewClosure && args.audit === undefined ? { audit: { checks: [], newFindings: [] } } : {}),
    };
  }
  return null;
}

export interface CollaborationFixtureState {
  actor: string; stage: string | null; nextStage: string | null; ready: boolean; finished: boolean;
  inputVersionIds: string[]; completedStages: string[];
  unreadArtifactVersionIds: string[];
  materials: { materialId: string }[];
  artifacts?: { id: string; kind: string; content: unknown }[];
  editorialPlanRequired?: boolean;
  reviewFindingsRequired?: boolean;
  reviewClosure?: { findings: BoundReviewFinding[]; reviewVersionIds: string[]; reportVersionIds: string[]; evidenceIds: string[] };
  revisionReturn?: { reportId: string; bodyVersionId: string };
  revisionComparison?: { originalVersionId: string; revisedVersionId: string; allowedSelectionIds: string[] };
}
export function collaborationState(request: ModelRequest): CollaborationFixtureState | null {
  if (request.messages[0]?.content.startsWith('READER_SIMULATION_V1=')) {
    const body = JSON.parse(request.messages[1]!.content.slice('READER_ARTICLE='.length));
    return { actor:'review_reader', stage:'review_reader', nextStage:'central_revision', ready:true, finished:false,
      inputVersionIds:[body.bodyVersionId], completedStages:[], unreadArtifactVersionIds:[], materials:[] };
  }
  const message = request.messages.find((item) => item.role === "user")?.content ?? "";
  const raw = message.split("\nCOLLABORATION_STATE=")[1];
  return raw === undefined ? null : { completedStages: [], unreadArtifactVersionIds: [], materials: [], ...JSON.parse(raw) } as CollaborationFixtureState;
}
/** Fixed ordinary reactions, not old editor-report fixtures. Production request
 * isolation/parallelism/persistence is tested through the real runtime. */
export function readerSimulationFixtureEvents(request: ModelRequest): ProviderStreamEvent[] | null {
  const id = request.messages[0]?.content.match(/^READER_SIMULATION_V1=([abc])/u)?.[1];
  return id ? [{ type:'text_delta', delta:JSON.stringify({ whyOpen:'标题让我好奇', leaveAt:'没有特别想划走的地方',
    verdict:`SECRET_OPINION_review_reader_${id}：还行，有收获`, shareOrSave:'想留着再读', memorableLine:'我喜欢这样的安静' }) },
    { type:'completed', finishReason:'stop' }] : null;
}
/** Scripted director for deterministic tests only; production always calls its provider. */
export function directorFixtureTurn(request: ModelRequest): ProviderStreamEvent[] | null {
  const state = collaborationState(request);
  if (state === null || state.actor !== "director") return null;
  if (state.revisionReturn) return [{ type: 'tool_call_delta', index: 0, id: `director-rework-${request.requestId}`, name: 'director_decide',
    argumentsDelta: JSON.stringify({ action: 'rework', stage: 'central_revision', reason: '处理语言终审返回的未解决问题。', questions: [] }) },
    { type: 'completed', finishReason: 'tool_calls' }];
  if (state.finished || state.nextStage === null && request.parameters.toolChoice === 'none') return [{ type: "text_delta", delta: "全部阶段和事实门禁已通过。" }, { type: "completed", finishReason: "stop" }];
  const ready = state.ready || request.messages.some((message) => message.role === "tool" && message.name === "assess_writing_readiness" && JSON.parse(message.content).result?.status === "ready");
  if (!ready) return null;
  return [{ type: "tool_call_delta", index: 0, id: `director-${request.requestId}`, name: "director_decide", argumentsDelta: JSON.stringify({ action: state.nextStage === null ? "finish" : "dispatch", stage: state.nextStage, reason: "基于绑定输入与已完成阶段安排下一专家；修订时综合独立意见。", questions: [], inputVersionIds: state.inputVersionIds }) }, { type: "completed", finishReason: "tool_calls" }];
}
