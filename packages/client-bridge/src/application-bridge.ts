import { isReviewConfirmation, isReviewStage } from '../../application/src/review-checkpoint.js';
import type {
  ResumeDraftInput,
  RunDraftInput,
  WritingApplicationService,
  WritingProjectProjection,
} from "../../application/src/index.js";
import type { MutationResult, RevisionEdit } from "../../writing-core/src/index.js";
import { withoutFirstMarkdownHeading } from '../../writing-core/src/index.js';
import type { RunRecord } from "../../runtime/session/src/index.js";
import { loopBudgetUsage } from "../../runtime/session/src/index.js";
import { recoveryInterruption, runDiagnostics } from './run-diagnostics.js';
import { isPublicationSelectionWait, isUsablePublicationTitle } from '../../application/src/publication-choice.js';
import {
  workflowStageSequence,
  type WritingWorkflowStage,
} from "../../writing-pack/src/index.js";
import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type BridgeCommandOptions,
  type BridgeHandshake,
  type BridgeSnapshot,
  type ClientBridge,
  type CreateProjectInput,
  type DeliveryExportView,
  type ExportPublicationOptions,
  type ResumeRunOptions,
  type RunRecordView,
  type SessionSummary,
  type TimelineItem,
  type RecoverableRunSummary,
  type UiSettings,
  type UpdateBriefInput,
  type WorkflowArtifactView,
  type WorkflowStageView,
} from "./protocol.js";

export interface ApplicationBridgeModelConfig {
  readonly model: string;
  readonly providerLabel: string;
  readonly credentialReference: string | null;
  readonly parameters: RunDraftInput["parameters"];
  readonly budget?: RunDraftInput["budget"];
}

export type PersistedUiSettings = Pick<UiSettings, "theme" | "contentFontSize">;

export interface UiSettingsPersistence {
  load(): PersistedUiSettings | null;
  save(value: PersistedUiSettings): void;
}

export interface ApplicationBridgeOptions {
  readonly service: WritingApplicationService;
  readonly workspaceId: string;
  readonly model: ApplicationBridgeModelConfig;
  readonly clientBuild?: string;
  readonly runtimeBuild?: string;
  readonly pollIntervalMs?: number;
  readonly operationIdFactory?: () => string;
  readonly initialProjectId?: string;
  readonly initialSessionId?: string;
  readonly initialGeneration?: number;
  readonly uiSettingsPersistence?: UiSettingsPersistence;
}

interface CachedCommand<T> {
  readonly kind: string;
  readonly input: string;
  readonly result: Promise<T>;
}

const ACTIVE_STATUSES = new Set<RunRecord["status"]>([
  "queued",
  "running",
  "paused",
]);

const SAVED_DRAFT_MESSAGE =
  "当前稿件已保存，事实核查通过，可以正式导出。需要调整时直接在这里告诉我；历史版本可在“稿件与版本”查看。";

function successfulToolResult(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  const envelope = payload.result;
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) return null;
  const value = envelope as Record<string, unknown>;
  return value.ok === true && typeof value.result === 'object' && value.result !== null && !Array.isArray(value.result)
    ? value.result as Record<string, unknown> : null;
}

function collaborationResult(payload: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  const value = successfulToolResult(payload)?.collaboration;
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

const WORKFLOW_STAGE_LABELS: Readonly<Record<WritingWorkflowStage, string>> = {
  research: "研究与证据",
  outline: "文章提纲",
  draft: "完整初稿",
  review_editor: "编辑审校",
  review_publish: "发布审校",
  review_reader: "读者审校",
  central_revision: "集中修订",
  language_review: "语言终审",
  fact_check: "事实核查",
};

function budgetForProject(
  budget: RunDraftInput["budget"],
  mode: WritingProjectProjection["project"]["mode"],
): RunDraftInput["budget"] {
  if (budget === undefined) return undefined;
  return {
    ...budget,
    maxMajorRevisions: Math.min(
      budget.maxMajorRevisions,
      mode === "quick" ? 1 : 2,
    ),
  };
}

function textPayload(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function workflowStageArgument(
  payload: Readonly<Record<string, unknown>>,
): WritingWorkflowStage | null {
  const args = payload.arguments;
  if (typeof args !== "object" || args === null || Array.isArray(args)) return null;
  const stage = (args as Readonly<Record<string, unknown>>).stage;
  if (typeof stage !== "string" || !(stage in WORKFLOW_STAGE_LABELS)) return null;
  return stage as WritingWorkflowStage;
}

function workflowStagePayload(
  payload: Readonly<Record<string, unknown>>,
  key: string,
): WritingWorkflowStage | null {
  const stage = textPayload(payload, key);
  return stage !== null && stage in WORKFLOW_STAGE_LABELS
    ? stage as WritingWorkflowStage
    : null;
}

function checkpointStages(
  projection: WritingProjectProjection,
  runId: string,
): Pick<RecoverableRunSummary, 'checkpointStage' | 'nextStage' | 'inputRequest'> {
  const event = [...projection.events].reverse().find(
    (candidate) => candidate.runId === runId && candidate.type === "run.waiting_user",
  );
  if (event && isPublicationSelectionWait(event.payload)) {
    const saved = projection.publicationCandidates;
    // Keep displayed ordinals identical to the persisted choices. A partly
    // invalid legacy batch needs regeneration, not filtering and renumbering.
    const candidates = saved?.bodyVersionId === projection.project.latestBodyVersionId &&
      saved.candidates.every(candidate => isUsablePublicationTitle(candidate.title, projection.currentBody?.content))
      ? saved.candidates : [];
    return { checkpointStage: null, nextStage: 'fact_check', inputRequest: {
      kind: 'publication_selection',
      reason: candidates.length ? '正文已保存，接下来一起确定发布标题。可以选择，也可以直接说哪里不满意。'
        : '正文已保存，但还没有合适的标题候选。可以直接告诉我想要的方向，标题专家会重新拟题。',
      questions: candidates.length ? [] : ['这一步只讨论标题，不会改动正文或直接开始核查。'], candidates,
    } };
  }
  return event === undefined
    ? { checkpointStage: null, nextStage: null }
    : {
        checkpointStage: workflowStagePayload(event.payload, "stage"),
        nextStage: workflowStagePayload(event.payload, "nextStage"),
        ...(writingInputRequest(event.payload) === null ? {} : { inputRequest: writingInputRequest(event.payload)! }),
      };
}

function writingInputRequest(payload: Readonly<Record<string, unknown>>): { reason: string; questions: readonly string[] } | null {
  if (payload.stopReason !== 'WRITING_INPUT_REQUIRED') return null;
  const reason = textPayload(payload, 'reason');
  const questions = payload.questions;
  if (reason === null || !Array.isArray(questions) || questions.length === 0 ||
    !questions.every((question): question is string => typeof question === 'string')) return null;
  return { reason, questions };
}

function toolDisplayLabel(
  toolName: string | null,
  payload: Readonly<Record<string, unknown>>,
): string {
  if (toolName === "list_project_materials") return "整理参考材料";
  if (toolName === "read_material") return "读取参考材料";
  if (toolName === "read_artifact_version") return "读取现有稿件";
  if (toolName === "assess_writing_readiness") return "检查写作信息是否充分";
  if (toolName === "director_decide") return "写作导演 · 安排下一步";
  if (toolName === "submit_publication_candidates") return "准备标题候选";
  if (toolName === "respond_writing_intake") return "整理本轮回复";
  const authorLabels: Record<string, string> = { delegate_author_expert: '安排专项专家', respond_author: '整理回复', attach_author_material: '保存补充材料',
    read_author_web: '读取你提供的网页', read_legacy_style: '读取风格档案', read_style_methodology: '参考风格分析方法',
    propose_author_revision: '准备改稿对比', propose_publication_choices: '准备标题与分发候选', choose_publication: '保存你的标题选择',
    propose_illustration_plan: '准备配图方案', confirm_illustration_plan: '保存配图方案确认', request_author_fact_check: '安排独立事实核查', read_conversation_history: '回顾此前交流' };
  if (toolName && authorLabels[toolName]) return authorLabels[toolName]!;
  if (toolName === "submit_writing_stage") {
    const stage = workflowStageArgument(payload);
    return stage === null ? "保存写作阶段" : WORKFLOW_STAGE_LABELS[stage];
  }
  if (toolName === "submit_fact_check") return WORKFLOW_STAGE_LABELS.fact_check;
  return "使用写作工具";
}

function nestedErrorCode(payload: Readonly<Record<string, unknown>>): string | null {
  const directError = payload.error;
  const result = payload.result;
  const nestedResult = typeof result === "object" && result !== null && !Array.isArray(result)
    ? result as Readonly<Record<string, unknown>>
    : null;
  const error = typeof directError === "object" && directError !== null && !Array.isArray(directError)
    ? directError as Readonly<Record<string, unknown>>
    : nestedResult !== null && typeof nestedResult.error === "object" && nestedResult.error !== null && !Array.isArray(nestedResult.error)
      ? nestedResult.error as Readonly<Record<string, unknown>>
      : null;
  if (error === null) return null;
  const code = error.code;
  if (code === 'MODEL_RESPONSE_INVALID' && error.message === '模型在工具参数完成前达到输出上限') return 'MODEL_OUTPUT_TRUNCATED';
  return typeof code === "string" && code.length > 0 ? code : null;
}

export function toolFailureDetail(code: string | null): string {
  const messages: Readonly<Record<string, string>> = {
    INTAKE_SOURCE_QUOTE_INVALID:
      '系统发现模型转述的原话与已保存内容不一致，未保存这次方案；你的原始消息仍在，不需要重新填写。',
    INTAKE_ASSUMPTION_DISCLOSURE_REQUIRED:
      '这次方案没有明确区分已知信息与助手建议，系统未保存方案；你的原始消息仍在。',
    INTAKE_PROPOSAL_PROVENANCE_REQUIRED:
      '系统未能找到这次方案对应的原始消息，尚未保存方案或开始写作。',
    INTAKE_BRIEF_INVALID:
      '模型提交的写作方案格式不完整，尚未保存；不是你漏填了表单。',
    INTAKE_AUTHORIZATION_SOURCE_INVALID:
      '模型引用的授权与原始消息不符，系统未采纳这项授权，也未开始写作。',
    INTAKE_FIRSTHAND_AUTHORIZATION_INVALID:
      '系统没有找到明确的亲历授权，不会把案例擅自当成你的真实经历。',
    INTAKE_STYLE_AUTHORIZATION_INVALID:
      '模型提出的风格授权与原始消息不符，系统未将它记为你的选择。',
    INTAKE_INTERACTION_AUTHORIZATION_INVALID:
      '系统没有找到相应的推进方式授权，不会擅自改为自主写作。',
    INTAKE_CONFIRMATION_SOURCE_INVALID:
      '这条消息还不能视为对完整方案的明确确认，系统尚未开始写作。',
    INTAKE_STATE_CONFLICT:
      '对话已更新，系统没有让旧回复覆盖新内容；请以当前对话为准。',
    FACT_CHECK_EVIDENCE_REFERENCE_INVALID:
      "核查引用的证据编号不在已保存的证据账本中；系统已拒绝这次核查，稿件没有被覆盖。",
    FACT_CHECK_SOURCE_REQUIRED:
      "核查把主张标为已支持，但没有提供账本证据或可复核来源；系统已拒绝保存。",
    FACT_CHECK_CLAIMS_INVALID:
      "核查清单格式不完整；系统已拒绝保存，稿件没有被覆盖。",
    WORKFLOW_STAGE_OUT_OF_ORDER:
      "模型重复提交了已保存阶段；系统已拒绝覆盖，并保留现有稿件。",
    MATERIAL_READ_REQUIRED:
      "授权材料尚未全部读取；系统已阻止继续写作。",
    WRITING_READINESS_REQUIRED:
      "尚未确认必要信息是否充分；系统已阻止直接写作。",
    READINESS_MATERIAL_READ_REQUIRED:
      "本次还未完整读取授权材料；系统已阻止跳过材料继续写作。",
    READINESS_CONTEXT_READ_REQUIRED:
      "恢复后还未重新读取必要稿件和阶段成果；系统已阻止脱离现稿继续写作。",
    WRITING_READINESS_INVALID:
      "模型的信息判断或问题不完整；系统已拒绝保存，尚未继续写作。",
    DIRECTOR_INPUT_VERSION_MISMATCH:
      '导演引用的版本与当前任务不一致，系统已拒绝调度，要求重新确认当前版本。',
    DIRECTOR_STAGE_INVALID:
      '下一步安排与已保存进度不一致，系统已要求导演重新安排。',
    OUTLINE_REWORK_REQUIRED:
      '你提出了提纲修改，系统已阻止直接写正文，必须先修改提纲并再次确认。',
    DIRECTOR_FINISH_BLOCKED:
      '仍有阶段或核查问题未处理，系统已阻止提前结束。',
    TOOL_PERMISSION_DENIED:
      '本角色无权执行这项操作，系统已阻止越权，稿件没有被覆盖。',
    TOOL_INPUT_INVALID:
      "模型提交的工具参数不完整；系统未更新正式稿件。",
    BODY_STAGE_CONTAINS_PROCESS_NOTES:
      "模型把审校说明混入了正文；系统已拒绝覆盖，并要求只提交纯净文章。",
    BASE_VERSION_CONFLICT:
      '你已保存更新的稿件，系统已阻止模型覆盖它。请确认是否基于你的新版继续修改。',
    INTERNAL_METADATA_NOT_USER_GAP:
      '系统正在纠正内部调度参数，无需你补充版本编号；尚未继续写作。',
  };
  return code === null
    ? "写作工具执行失败，系统未更新正式稿件。"
    : messages[code] ?? "写作工具执行失败，系统未更新正式稿件。";
}

export function mergeWorkflowStageStatus(
  current: WorkflowStageView["status"] | undefined,
  incoming: WorkflowStageView["status"],
): WorkflowStageView["status"] {
  if (current === "completed") return "completed";
  return incoming;
}

function nestedProviderDetail(payload: Readonly<Record<string, unknown>>): string | null {
  // Sanitized by the adapter before persistence; only its presence is checked.
  const detail = payload.providerDetail;
  return typeof detail === "string" && detail.length > 0 ? detail : null;
}

function modelFailureDetail(code: string | null, providerDetail: string | null = null): string {
  const messages: Readonly<Record<string, string>> = {
    ABORTED: "模型请求已停止。",
    AUTH_FAILED: "API Key 无效或没有访问权限，请在“设置 → 模型”中更新 Key 并验证连接。",
    INVALID_REQUEST: "模型服务拒绝了请求，请检查服务类型、API 地址和模型 ID。",
    MODEL_RESPONSE_INVALID: "模型回复未通过格式校验，本轮未完成；你的输入仍保留，可以重试。若反复出现，请反馈运行记录，无需重新填写资料。",
    STAGE_OUTPUT_NOT_SAVED: "这一阶段的内容反复未通过保存校验，已停止自动重写。上一版稿件仍保留；不是模型账户额度或网络故障。请反馈此阶段的运行记录，不必重新填写材料。",
    MODEL_OUTPUT_TRUNCATED: "模型回复达到单次输出长度上限而被截断，本阶段未完成；残缺内容没有写入稿件，已保存的阶段仍保留。请反馈这条运行记录，无需重新填写资料。",
    MODEL_UNSUPPORTED: "模型名称不可用，请检查服务商提供的模型 ID，并在“设置 → 模型”中验证连接。",
    NETWORK_ERROR: "无法连接模型服务，请检查 API 地址和网络后验证连接。",
    PROVIDER_UNAVAILABLE: "模型服务暂不可用，请稍后验证连接或重试。",
    QUOTA_EXCEEDED: "模型账户额度不足，请在服务商后台检查余额或套餐。",
    RATE_LIMITED: "模型请求过于频繁，请稍后重试。",
    TIMEOUT: "模型服务响应超时，请检查网络后重试。",
    UNKNOWN_PROVIDER_ERROR: "模型服务返回未知错误，请验证连接并检查服务商状态。",
  };
  const base = code === null
    ? "模型请求失败，请在“设置 → 模型”中验证连接后重试。"
    : messages[code] ?? "模型请求失败，请在“设置 → 模型”中验证连接后重试。";
  return providerDetail === null ? base : `${base}（上游返回：${providerDetail}）`;
}

function sessionStatus(runs: readonly RunRecord[]): SessionSummary["status"] {
  const latest = runs.at(-1);
  if (latest === undefined) return "idle";
  if (ACTIVE_STATUSES.has(latest.status)) return "running";
  if (
    latest.status === "interrupted" ||
    latest.status === "waiting_user" ||
    latest.status === "completed" ||
    latest.status === "failed" ||
    latest.status === "cancelled"
  ) {
    return latest.status;
  }
  return "failed";
}

function relativeTime(iso: string): string {
  const milliseconds = Date.now() - Date.parse(iso);
  if (!Number.isFinite(milliseconds) || milliseconds < 60_000) return "刚刚";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

function timeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "已保存";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function titleFromBody(body: string, fallback: string): string {
  const heading = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^#{1,6}\s+\S/u.test(line));
  return heading?.replace(/^#{1,6}\s+/u, "") ?? fallback;
}

function timelineForSession(
  projection: WritingProjectProjection,
  sessionId: string,
  onlyRunId?: string,
): readonly TimelineItem[] {
  const runIds = new Set(
    projection.runs
      .filter((run) => run.sessionId === sessionId && (onlyRunId === undefined || run.id === onlyRunId))
      .map((run) => run.id),
  );
  const items: TimelineItem[] = [];
  const operationRows = new Map<string, number>();
  const modelRows = new Map<string, number>();
  const completedRunIds = new Set(
    projection.runs.filter((run) => run.status === "completed").map((run) => run.id),
  );
  const displayedArtifactIds = new Set<string>();
  const outputPreviewIds = new Map<string, string>();
  const stageMessageRows = new Map<string, number>();
  const intakeRunIds = new Set(projection.events.filter(event => event.type === 'run.started' &&
    ['writing-pack:intake', 'writing-pack:author-conversation'].includes(String(event.payload.purpose))).map(event => event.runId));
  const savedIntakeReplyRunIds = new Set<string>();
  const latestToolFailureCodes = new Map<string, string>();
  const latestModelFailureCodes = new Map<string, string>();
  const latestModelFailureDetails = new Map<string, string>();
  const deliveryReady = (versionId: string | null): boolean => versionId !== null &&
    projection.currentBody?.id === versionId && projection.factCheck.status === 'passed';

  for (const event of projection.events) {
    if (event.runId === undefined || !runIds.has(event.runId)) continue;
    const createdAt = timeLabel(event.occurredAt);
    const intake = intakeRunIds.has(event.runId);
    if (event.type === 'tool.requested' && typeof event.payload.previewId === 'string') outputPreviewIds.set(event.operationId, event.payload.previewId);
    if (event.type === 'request.failed') {
      const code = nestedErrorCode(event.payload);
      if (code !== null) latestModelFailureCodes.set(event.runId, code);
      const providerDetail = nestedProviderDetail(event.payload);
      if (providerDetail !== null) latestModelFailureDetails.set(event.runId, providerDetail);
    }
    if (event.type === 'tool.failed') {
      const failureCode = nestedErrorCode(event.payload);
      if (failureCode !== null) latestToolFailureCodes.set(event.runId, failureCode);
    }
    if (intake && event.type === 'run.completed') continue;
    if (event.type === 'tool.completed') {
      const reply = intake ? successfulToolResult(event.payload)?.reply : null;
      if (typeof reply === 'string') {
        savedIntakeReplyRunIds.add(event.runId);
        const replyStage = workflowStagePayload(successfulToolResult(event.payload) ?? {}, 'expertStage');
        items.push({ id: `${event.id}:reply`, kind: 'message', role: 'assistant', body: reply, createdAt,
          ...(replyStage ? { stage: replyStage } : {}) });
      }
      const collaboration = collaborationResult(event.payload);
      if (collaboration !== null && typeof collaboration.reason === 'string') {
        const stage = workflowStagePayload(collaboration, 'stage');
        items.push({ id: `${event.id}:director`, kind: 'message', audience: 'diagnostic', role: 'assistant', createdAt,
          body: `**写作导演**${stage === null ? '' : ` · ${WORKFLOW_STAGE_LABELS[stage]}`}\n\n${collaboration.reason}${Array.isArray(collaboration.invalidatedStages) && collaboration.invalidatedStages.length > 0 ? '\n\n受影响阶段将重新处理；旧结果保留在历史中，不再计作本轮完成。' : ''}` });
        modelRows.delete(event.runId);
      }
      const result = successfulToolResult(event.payload);
      const stage = result === null ? null : workflowStagePayload(result, 'stage');
      const artifactId = result === null ? null : textPayload(result, 'artifactVersionId');
      if (stage !== null && artifactId !== null && !displayedArtifactIds.has(artifactId)) {
        const artifact = [...projection.workflowArtifacts, ...projection.bodyVersions].find(version => version.id === artifactId);
        if (artifact !== undefined && artifact.kind !== 'evidence') {
          stageMessageRows.set(`${event.runId}:${stage}`, items.length);
          items.push({ id: outputPreviewIds.get(event.operationId) ?? `${event.id}:artifact`, kind: 'message', role: 'assistant', createdAt,
            stage,
            body: `**${WORKFLOW_STAGE_LABELS[stage]} · 已保存**\n\n${workflowArtifactView(artifact)?.content ?? artifact.content}` });
          displayedArtifactIds.add(artifactId);
          modelRows.delete(event.runId);
        }
      }
    }
    if (event.type === "run.started" || event.type === "run.resumed") {
      // Each resumed segment needs visible activity below the user's new answer.
      modelRows.delete(event.runId);
      const instruction =
        textPayload(event.payload, "displayInstruction") ??
        (event.type === "run.resumed"
          ? "从已保存边界继续写作"
          : "生成草稿");
      items.push({
        id: event.id,
        kind: "message",
        role: "user",
        body: instruction,
        createdAt,
      });
      continue;
    }
    if (
      event.type === "request.dispatch_attempted" ||
      event.type === "tool.requested"
    ) {
      const isTool = event.type === "tool.requested";
      if (!isTool) {
        const existingRow = modelRows.get(event.runId);
        if (existingRow !== undefined) {
          items[existingRow] = {
            id: event.id,
            kind: "tool",
            label: intake ? "正在思考你的想法" : "写作模型",
            detail: Number(event.payload.outputRecoveryAttempt) > 0 ? '回复达到输出上限，正在重新生成完整结果；残缺内容不会保存。' : intake ? "整理这轮交流" : "正在处理下一阶段",
            state: "pending",
          };
          operationRows.set(event.operationId, existingRow);
          continue;
        }
      }
      const item: TimelineItem = {
        id: event.id,
        kind: "tool",
        label: isTool
          ? toolDisplayLabel(textPayload(event.payload, "toolName"), event.payload)
          : intake ? '正在思考你的想法' : "写作模型",
        detail: intake ? '整理这轮交流' : isTool ? "正在保存阶段结果" : "正在处理下一阶段",
        state: "pending",
      };
      operationRows.set(event.operationId, items.length);
      if (!isTool) modelRows.set(event.runId, items.length);
      items.push(item);
      continue;
    }
    if (
      event.type === "request.completed" ||
      event.type === "tool.completed" ||
      event.type === "request.failed" ||
      event.type === "tool.failed" ||
      event.type === "request.outcome_unknown" ||
      event.type === "tool.outcome_unknown"
    ) {
      const row = operationRows.get(event.operationId);
      if (row !== undefined) {
        const current = items[row];
        if (current?.kind === "tool") {
          const succeeded = event.type.endsWith(".completed");
          const factNeedsWork = event.type === 'tool.completed' &&
            (event.payload.result as { toolName?: string } | undefined)?.toolName === 'submit_fact_check' &&
            successfulToolResult(event.payload)?.status !== 'passed';
          const recovered = event.type === "tool.failed" && completedRunIds.has(event.runId);
          const outputRecovery = event.type === 'request.failed' &&
            (event.payload.recovery as { kind?: string } | undefined)?.kind === 'output_truncation';
          items[row] = {
            ...current,
            detail: outputRecovery ? '回复达到输出上限，正在重新生成完整结果；残缺内容不会保存。' : factNeedsWork ? '核查结果已保存 · 问题待处理，写作暂停' : recovered
              ? "已自动纠正，最终结果不受影响"
              : succeeded
              ? "已完成"
              : event.type.endsWith("outcome_unknown")
                ? "外部结果未知，需要用户决定"
                : event.type === "request.failed"
                  ? modelFailureDetail(nestedErrorCode(event.payload), nestedProviderDetail(event.payload))
                  : toolFailureDetail(nestedErrorCode(event.payload)),
            state: outputRecovery ? 'pending' : !factNeedsWork && (succeeded || recovered) ? "success" : "failure",
          };
        }
      }
      continue;
    }
    if (event.type === "run.completed") {
      const versionId = textPayload(event.payload, "artifactVersionId");
      if (versionId !== null) {
        const savedBody = projection.bodyVersions.find((version) => version.id === versionId);
        if (savedBody !== undefined && savedBody.content.trim().length > 0 && !displayedArtifactIds.has(versionId)) {
          items.push({
            id: `${event.id}:draft`,
            kind: "message",
            role: "assistant",
            body: savedBody.content,
            createdAt,
          });
        }
        items.push({
          id: `${event.id}:saved`,
          kind: "message",
          role: "assistant",
          body: deliveryReady(versionId) ? SAVED_DRAFT_MESSAGE : '工作稿和阶段结果已保存，但尚未达到正式交付条件。请查看当前核查问题，并在这里补充材料或告诉我如何修改。',
          createdAt,
        });
      }
    }
    if (event.type === "run.waiting_user") {
      const inputRequest = writingInputRequest(event.payload);
      if (inputRequest !== null) {
        items.push({ id: event.id, kind: 'message', role: 'assistant', createdAt,
          body: `需要补充信息，写作已暂停。\n\n${inputRequest.reason}\n\n${inputRequest.questions.map((question, index) => `${index + 1}. ${question}`).join('\n')}\n\n请直接回复下面的问题；收到补充并确认信息充分后才会继续。` });
        continue;
      }
      const reason = textPayload(event.payload, "stopReason");
      const stage = textPayload(event.payload, "stage");
      if (reason === 'STAGE_OUTPUT_NOT_SAVED') {
        items.push({ id:event.id, kind:'tool', audience:'conversation', label:'自动重写已暂停',
          detail:'本阶段保存校验反复未通过；上一版稿件仍保留，可查看原因或重试这一步。', state:'failure' });
        continue;
      }
      if (reason === 'CO_CREATION_CHECKPOINT') {
        const question = stage === 'outline' ? '这个方向可以吗？确认后我继续写初稿，也可以直接告诉我怎么改。'
          : stage === 'draft' ? '初稿这样写可以吗？确认后我继续审校，也可以直接告诉我怎么改。'
          : stage === 'review_editor' ? `编辑审校的建议你认可吗？可以先讨论、调整；确认后才交给${textPayload(event.payload, 'nextStage') === 'review_publish' ? '发布' : '读者'}审校专家。`
          : stage === 'review_publish' ? '发布审校的建议你认可吗？可以先讨论、调整；确认后才交给读者审校专家。'
          : stage === 'review_reader' ? '读者审校的建议你认可吗？可以先讨论、调整；确认后主笔才按已确认的意见修订。'
          : '这一阶段的结果可以吗？确认后我继续下一步，也可以直接告诉我怎么改。';
        const row = stageMessageRows.get(`${event.runId}:${stage}`);
        const message = row === undefined ? undefined : items[row];
        if (row !== undefined && message?.kind === 'message') {
          if (!message.body.endsWith(`**${question}**`)) items[row] = { ...message, body: `${message.body}\n\n**${question}**` };
        } else {
          // Older records can lack a projected artifact. Keep the next action
          // understandable without fabricating or copying a different result.
          items.push({ id: event.id, kind: 'message', role: 'assistant', body: question, createdAt });
        }
        continue;
      }
      items.push({
        id: event.id,
        kind: "tool",
        audience: 'conversation',
        label: "需要你的决定",
        detail: "存在结果未知的外部请求，请确认是否重试。",
        state: "success",
      });
      continue;
    }
    const terminal: Readonly<Record<string, { label: string; state: "success" | "failure" | "cancelled" }>> = {
      "run.completed": { label: "运行完成", state: "success" },
      "run.cancelled": { label: "运行已停止", state: "cancelled" },
      "run.failed": { label: "运行失败", state: "failure" },
      "run.budget_exhausted": { label: "已触发运行保护", state: "failure" },
      "run.interrupted": { label: "进程中断，等待继续", state: "failure" },
    };
    const terminalState = terminal[event.type];
    if (terminalState !== undefined) {
      items.push({
        id: event.id,
        kind: "tool",
        ...(event.type === 'run.completed' ? {} : { audience: 'conversation' as const }),
        label: event.type === 'run.completed' && !deliveryReady(textPayload(event.payload, 'artifactVersionId')) ? '阶段已保存 · 交付待处理' : terminalState.label,
        detail:
          event.type === "run.failed"
            ? modelFailureDetail(
                (textPayload(event.payload, 'code') ?? textPayload(event.payload, 'stopReason')) === 'MODEL_RESPONSE_INVALID'
                  && latestModelFailureCodes.get(event.runId) === 'MODEL_OUTPUT_TRUNCATED'
                  ? 'MODEL_OUTPUT_TRUNCATED' : textPayload(event.payload, 'code') ?? textPayload(event.payload, 'stopReason'),
                latestModelFailureDetails.get(event.runId) ?? null,
              )
            : event.type === "run.budget_exhausted"
              ? intake
                ? savedIntakeReplyRunIds.has(event.runId)
                  ? "本轮回复已保存，但后续收尾触发了程序内部调用上限；不是服务商账户额度不足。你可以直接继续对话。"
                  : latestToolFailureCodes.get(event.runId)?.startsWith('INTAKE_')
                    ? `本轮需求回复未能保存。${toolFailureDetail(latestToolFailureCodes.get(event.runId)!)}为避免重复失败，已停止继续调用；不是服务商账户额度不足。`
                  : "模型多次尝试后仍未能保存本轮回复，已达到程序内部调用上限；不是服务商账户额度不足。你的消息仍保留，可以重试；若再次出现，请反馈这条运行记录。"
                : "本轮自动处理已暂停，不是服务商账户额度不足。已保存稿件和已确认选择保留；请点击下方继续按钮，从未完成的步骤接着处理。"
              : event.type === "run.interrupted"
                ? "进程中断；已保存内容仍在，可从当前状态继续。"
                : event.type === "run.completed"
                  ? deliveryReady(textPayload(event.payload, 'artifactVersionId')) ? '稿件已保存，当前版本可正式导出' : '尚未达到交付条件，请处理当前问题'
                  : terminalState.label,
        state: event.type === 'run.completed' && !deliveryReady(textPayload(event.payload, 'artifactVersionId')) ? 'failure' : terminalState.state,
      });
    }
  }
  return items;
}

function runRecordView(
  projection: WritingProjectProjection,
  run: RunRecord,
): RunRecordView {
  const startEvent = projection.events.find(
    (event) => event.runId === run.id && event.type === "run.started",
  );
  const displayInstruction =
    (startEvent === undefined
      ? null
      : textPayload(startEvent.payload, "displayInstruction")) ?? "写作任务";
  const factCheckOnly = displayInstruction === "重新核查当前稿件";
  const purpose = startEvent === undefined ? undefined : textPayload(startEvent.payload, 'purpose') ?? undefined;
  const sequence: readonly WritingWorkflowStage[] = ['writing-pack:intake', 'writing-pack:author-conversation'].includes(purpose ?? '') ? [] : factCheckOnly
    ? ["fact_check"]
    : workflowStageSequence(projection.project.mode);
  const state = new Map<WritingWorkflowStage, WorkflowStageView["status"]>();
  const operationStages = new Map<string, WritingWorkflowStage>();
  let sawWorkflowTool = false;

  for (const event of projection.events) {
    if (event.runId !== run.id) continue;
    if (event.type === 'tool.completed') {
      const invalidated = collaborationResult(event.payload)?.invalidatedStages;
      if (Array.isArray(invalidated)) {
        for (const stage of invalidated) {
          if (typeof stage === 'string' && sequence.includes(stage as WritingWorkflowStage)) state.set(stage as WritingWorkflowStage, 'pending');
        }
      }
    }
    if (event.type === "tool.requested") {
      const toolName = textPayload(event.payload, "toolName");
      const stage = toolName === "submit_fact_check"
        ? "fact_check"
        : toolName === "submit_writing_stage"
          ? workflowStageArgument(event.payload)
          : null;
      if (stage !== null) {
        sawWorkflowTool = true;
        operationStages.set(event.operationId, stage);
        state.set(stage, mergeWorkflowStageStatus(state.get(stage), "running"));
      }
      continue;
    }
    const stage = operationStages.get(event.operationId);
    if (stage === undefined) continue;
    if (event.type === "tool.completed") {
      state.set(stage, stage === 'fact_check' && successfulToolResult(event.payload)?.status !== 'passed'
        ? 'failed'
        : mergeWorkflowStageStatus(state.get(stage), "completed"));
    }
    if (event.type === "tool.failed" || event.type === "tool.outcome_unknown") {
      state.set(stage, mergeWorkflowStageStatus(state.get(stage), "failed"));
    }
  }

  const active = ACTIVE_STATUSES.has(run.status);
  if (active && ![...state.values()].includes("running")) {
    const next = sequence.find((stage) => state.get(stage) !== "completed");
    if (next !== undefined) state.set(next, "running");
  }
  const showStages = sawWorkflowTool || active;
  const stages: WorkflowStageView[] = showStages
    ? sequence.map((stage) => {
        const status = state.get(stage) ?? "pending";
        return {
          id: stage,
          label: WORKFLOW_STAGE_LABELS[stage],
          status,
          detail:
            status === "completed"
              ? "已保存"
              : status === "running"
                ? "正在处理"
                : status === "failed"
                  ? stage === 'fact_check' ? '核查问题待处理' : "此阶段执行失败"
                  : "等待前序阶段",
        };
      })
    : [];
  const completedStages = stages.filter((stage) => stage.status === "completed").length;
  const reply = projection.events.filter(event => event.runId === run.id && event.type === 'tool.completed')
    .map(event => successfulToolResult(event.payload)?.reply).findLast(value => typeof value === 'string');
  const replyText = typeof reply === 'string' ? reply.replace(/\s+/gu, ' ').trim() : '';
  return {
    id: run.id,
    diagnostics: runDiagnostics(projection, run),
    ...(replyText ? { replyPreview: replyText.length > 240 ? `${replyText.slice(0, 240)}…` : replyText } : {}),
    ...(purpose === undefined ? {} : { purpose }),
    ...(run.status === 'waiting_user' && checkpointStages(projection, run.id).inputRequest?.kind === 'publication_selection'
      ? { waitingFor: 'publication_selection' as const } : {}),
    status: run.status,
    displayInstruction,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    stopReason: run.stopReason === 'MODEL_RESPONSE_INVALID' && nestedErrorCode(projection.events.findLast(event =>
      event.runId === run.id && event.type === 'request.failed')?.payload ?? {}) === 'MODEL_OUTPUT_TRUNCATED'
      ? 'MODEL_OUTPUT_TRUNCATED' : run.stopReason,
    modelRequests: loopBudgetUsage(run, projection.events.filter(event => event.runId === run.id)).modelRequests,
    maxModelRequests: run.budget.maxModelRequests,
    toolCalls: loopBudgetUsage(run, projection.events.filter(event => event.runId === run.id)).toolCalls,
    maxToolCalls: run.budget.maxToolCalls,
    totalTokens: run.usage.totalTokens,
    stages,
    completedStages,
    totalStages: stages.length,
    publicationReady:
      run.status === "completed" &&
      state.get("fact_check") === "completed" &&
      projection.factCheck.status === "passed",
  };
}

function commandInput(kind: string, values: readonly string[]): string {
  return JSON.stringify([kind, ...values]);
}

function mutationValue<T>(result: MutationResult<T>): T {
  if (result.ok) return result.result;
  return throwMutation(result);
}

function throwMutation<T>(
  result: Extract<MutationResult<T>, { ok: false }>,
): never {
  const error = new Error(result.message) as Error & { code: string };
  error.code = result.code;
  throw error;
}

function actorLabel(actor: WritingProjectProjection["bodyVersions"][number]["actor"]): string {
  if (actor.kind === "user") return "用户";
  if (actor.kind === "agent") return "Writing Agent";
  if (actor.kind === "legacy_import") return "旧数据导入";
  return "本地运行时";
}

function readableEvidenceContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return content;
    }
    const ledger = parsed as Readonly<Record<string, unknown>>;
    const sections: string[] = [];
    if (typeof ledger.notes === "string" && ledger.notes.trim().length > 0) {
      sections.push(ledger.notes.trim());
    }
    if (Array.isArray(ledger.claims) && ledger.claims.length > 0) {
      const lines = ledger.claims.map((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          return `- 证据 ${index + 1}：${String(entry)}`;
        }
        const claim = entry as Readonly<Record<string, unknown>>;
        const statement = [claim.claimText, claim.claim, claim.statement, claim.summary]
          .find((value) => typeof value === "string" && value.trim().length > 0);
        const source = [claim.sourceReference, claim.source, claim.url]
          .find((value) => typeof value === "string" && value.trim().length > 0);
        const statementText = typeof statement === "string"
          ? statement.trim()
          : `证据 ${index + 1}`;
        return typeof source === "string"
          ? `- ${statementText}\n  来源：${source.trim()}`
          : `- ${statementText}`;
      });
      sections.push(`已整理证据\n${lines.join("\n")}`);
    }
    return sections.length > 0 ? sections.join("\n\n") : "本次研究没有形成外部事实条目。";
  } catch {
    return content;
  }
}

const PROCESS_ARTIFACT_LABELS = {
  research: "研究与证据",
  outline: "文章提纲",
  review_editor: "编辑审校",
  review_publish: "发布审校",
  review_reader: "读者审校",
} as const;

function workflowArtifactView(
  artifact: WritingProjectProjection["workflowArtifacts"][number],
): WorkflowArtifactView | null {
  const runId = artifact.actor.kind === "agent" ? artifact.actor.runId : null;
  if (artifact.kind === "evidence") {
    return {
      id: artifact.id,
      kind: "evidence",
      stage: "research",
      label: PROCESS_ARTIFACT_LABELS.research,
      content: readableEvidenceContent(artifact.content),
      createdAt: artifact.createdAt,
      runId,
      bodyVersionId: null,
    };
  }
  if (artifact.kind === "outline") {
    return {
      id: artifact.id,
      kind: "outline",
      stage: "outline",
      label: PROCESS_ARTIFACT_LABELS.outline,
      content: artifact.content,
      createdAt: artifact.createdAt,
      runId,
      bodyVersionId: null,
    };
  }
  if (artifact.kind !== "review") return null;

  const logicalStage = artifact.logicalKey.split(":", 1)[0];
  const fallbackStage = logicalStage === "review_editor" ||
    logicalStage === "review_publish" ||
    logicalStage === "review_reader"
    ? logicalStage
    : null;
  try {
    const parsed = JSON.parse(artifact.content) as Readonly<Record<string, unknown>>;
    const reviewType = parsed.reviewType;
    const stage = reviewType === "review_editor" ||
      reviewType === "review_publish" ||
      reviewType === "review_reader"
      ? reviewType
      : fallbackStage;
    if (stage === null) return null;
    return {
      id: artifact.id,
      kind: "review",
      stage,
      label: PROCESS_ARTIFACT_LABELS[stage],
      content: typeof parsed.content === "string" ? parsed.content : artifact.content,
      createdAt: artifact.createdAt,
      runId: typeof parsed.runId === "string" ? parsed.runId : runId,
      bodyVersionId:
        typeof parsed.bodyVersionId === "string" ? parsed.bodyVersionId : null,
    };
  } catch {
    if (fallbackStage === null) return null;
    return {
      id: artifact.id,
      kind: "review",
      stage: fallbackStage,
      label: PROCESS_ARTIFACT_LABELS[fallbackStage],
      content: artifact.content,
      createdAt: artifact.createdAt,
      runId,
      bodyVersionId: null,
    };
  }
}

function deliveryExportView(
  record: WritingProjectProjection["exports"][number],
): DeliveryExportView {
  return {
    id: record.id,
    operationId: record.operationId,
    mode: record.mode,
    format: record.format,
    state: record.state,
    gateStatus: record.gateStatus,
    relativePath: record.relativePath,
    manifestRelativePath: record.manifestRelativePath,
    contentHash: record.contentHash,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
  };
}

export class ApplicationClientBridge implements ClientBridge {
  readonly #service: WritingApplicationService;
  readonly #workspaceId: string;
  readonly #model: ApplicationBridgeModelConfig;
  readonly #clientBuild: string;
  readonly #runtimeBuild: string;
  readonly #pollIntervalMs: number;
  readonly #operationIdFactory: () => string;
  readonly #uiSettingsPersistence: UiSettingsPersistence | null;
  readonly #listeners = new Set<() => void>();
  readonly #commands = new Map<string, CachedCommand<unknown>>();
  #snapshot: BridgeSnapshot;
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  #disposed = false;
  #handoffError: { projectId: string; error: NonNullable<BridgeSnapshot['lastError']> } | null = null;

  constructor(options: ApplicationBridgeOptions) {
    this.#service = options.service;
    this.#workspaceId = options.workspaceId.trim();
    if (this.#workspaceId.length === 0) throw new Error("WORKSPACE_ID_REQUIRED");
    this.#model = options.model;
    this.#clientBuild = options.clientBuild ?? "wa-web-v4";
    this.#runtimeBuild = options.runtimeBuild ?? "writing-runtime-v1";
    this.#pollIntervalMs = options.pollIntervalMs ?? 100;
    this.#operationIdFactory =
      options.operationIdFactory ?? (() => globalThis.crypto.randomUUID());
    this.#uiSettingsPersistence = options.uiSettingsPersistence ?? null;
    const persistedSettings = this.#uiSettingsPersistence?.load() ?? null;
    const initialTheme = persistedSettings?.theme ?? "system";
    const initialContentFontSize = persistedSettings?.contentFontSize ?? 14;
    if (!(["light", "dark", "system"] as const).includes(initialTheme)) {
      throw new Error("THEME_INVALID");
    }
    if (![13, 14, 16].includes(initialContentFontSize)) {
      throw new Error("CONTENT_FONT_SIZE_INVALID");
    }
    this.#snapshot = this.#buildSnapshot(
      options.initialProjectId ?? "",
      options.initialSessionId,
      options.initialGeneration ?? 1,
      1,
      {
        theme: initialTheme,
        language: "zh-CN",
        contentFontSize: initialContentFontSize,
        providerLabel: this.#model.providerLabel,
        credentialReference: this.#model.credentialReference,
      },
      null,
    );
  }

  async handshake(): Promise<BridgeHandshake> {
    return {
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      clientBuild: this.#clientBuild,
      runtimeBuild: this.#runtimeBuild,
      capabilities: [
        "snapshot.persisted",
        "events.project-seq-replay",
        "project.select",
        "session.select",
        "project.create",
        "brief.update",
        "run.start",
        "run.cancel",
        "run.resume",
        "fact-check.run",
        "revision.propose",
        "revision.accept",
        "revision.reject",
        "body.save",
        "body.block-lock",
        "body.rollback",
        "fact-check.current-snapshot",
        "provenance.query",
        "export.working-copy",
        "export.publication.txt",
        "export.publication.html",
        "settings.persisted",
      ],
      mock: false,
      persistsUserProjects: true,
      workspaceId: this.#workspaceId,
    };
  }

  getSnapshot = (): BridgeSnapshot => this.#snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    if (this.#pollTimer === null) {
      this.#pollTimer = setInterval(() => {
        void this.refresh();
      }, this.#pollIntervalMs);
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#pollTimer !== null) {
        clearInterval(this.#pollTimer);
        this.#pollTimer = null;
      }
    };
  };

  async selectProject(projectId: string): Promise<void> {
    this.#ensureLive();
    const normalizedProjectId = projectId.trim();
    if (normalizedProjectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
    const projection = this.#service.getProjectProjection(normalizedProjectId);
    this.#replace(
      this.#buildSnapshot(
        projection.project.id,
        null,
        this.#snapshot.generation + 1,
        this.#snapshot.revision + 1,
        this.#snapshot.settings,
        null,
      ),
      true,
    );
  }

  async selectSession(projectId: string, sessionId: string): Promise<void> {
    this.#ensureLive();
    const projection = this.#service.getProjectProjection(projectId);
    if (!projection.sessions.some((session) => session.id === sessionId)) {
      throw new Error("SESSION_SCOPE_MISMATCH");
    }
    this.#replace(
      this.#buildSnapshot(
        projectId,
        sessionId,
        this.#snapshot.generation + 1,
        this.#snapshot.revision + 1,
        this.#snapshot.settings,
        null,
      ),
      true,
    );
  }

  async updateSettings(
    patch: Partial<Pick<UiSettings, "theme" | "contentFontSize">>,
  ): Promise<void> {
    this.#ensureLive();
    const contentFontSize =
      patch.contentFontSize ?? this.#snapshot.settings.contentFontSize;
    if (![13, 14, 16].includes(contentFontSize)) {
      throw new Error("CONTENT_FONT_SIZE_INVALID");
    }
    const theme = patch.theme ?? this.#snapshot.settings.theme;
    if (!(["light", "dark", "system"] as const).includes(theme)) {
      throw new Error("THEME_INVALID");
    }
    this.#uiSettingsPersistence?.save({ theme, contentFontSize });
    this.#replace(
      {
        ...this.#snapshot,
        revision: this.#snapshot.revision + 1,
        settings: { ...this.#snapshot.settings, theme, contentFontSize },
      },
      true,
    );
  }

  async createProject(
    input: CreateProjectInput,
    options: BridgeCommandOptions = {},
  ): Promise<{ projectId: string }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    const projectId = `project:${operationId}`;
    return this.#once(
      operationId,
      "project.create",
      commandInput("project.create", [JSON.stringify(input)]),
      async () => {
        const actor = { kind: "user", id: "local-ui" } as const;
        mutationValue(this.#service.createProject({
          operationId: `${operationId}:project`,
          projectId,
          name: input.name,
          mode: input.mode,
          actor,
        }));
        let projectRevision = 0;
        const materialIds: string[] = [];
        const firsthandMaterialIds: string[] = [];
        for (const [index, material] of input.materials.entries()) {
          const materialId = `material:${operationId}:${index + 1}`;
          const imported = this.#service.importMaterial({
            operationId: `${operationId}:material:${index + 1}`,
            projectId,
            expectedProjectRevision: projectRevision,
            materialId,
            displayName: material.name,
            sourceKind: material.sourceKind,
            sourceReference: material.sourceReference,
            role: material.role,
            trustLabel:
              material.sourceKind === "web_snapshot"
                ? "external_untrusted"
                : "user_provided_untrusted",
            permissionScope: "project_only",
            content: material.content,
            actor,
          });
          if (!imported.ok) throwMutation(imported);
          const importedValue = imported.result;
          projectRevision = imported.projectRevision;
          materialIds.push(materialId);
          if (material.role === "user_firsthand") {
            firsthandMaterialIds.push(materialId);
          }
          void importedValue;
        }
        const savedBrief = this.#service.saveWritingBrief({
          operationId: `${operationId}:brief`,
          projectId,
          expectedProjectRevision: projectRevision,
          baseVersionId: null,
          brief: {
            schemaVersion: 1,
            topic: input.topic,
            genre: input.genre,
            audience: input.audience,
            lengthTarget: { targetCharacters: input.targetCharacters },
            materialIds,
            constraints: [...input.constraints],
            interactionMode: input.interactionMode,
            authorAuthorization: {
              voice: input.authorVoice,
              styleReference: input.styleReference,
              styleDecision: input.styleDecision,
              directionDecision: input.directionDecision,
              firsthandMaterialIds,
            },
            platform: input.platform,
            publicationGoal: input.publicationGoal,
            confirmationStatus: "tentative",
          },
          actor,
        });
        if (!savedBrief.ok) mutationValue(savedBrief);
        mutationValue(this.#service.recordDecision({
          operationId: `${operationId}:decision`,
          projectId,
          expectedProjectRevision: savedBrief.ok ? savedBrief.projectRevision : 0,
          decisionId: `decision:${operationId}`,
          type: "brief",
          value: {
            confirmationStatus: "tentative",
            styleDecision: input.styleDecision,
            directionDecision: input.directionDecision,
          },
          scope: "current_article",
          sourceEventId: null,
          actor,
        }));
        this.#replace(
          this.#buildSnapshot(
            projectId,
            "",
            this.#snapshot.generation + 1,
            this.#snapshot.revision + 1,
            this.#snapshot.settings,
            null,
          ),
          true,
        );
        return { projectId };
      },
    );
  }

  async updateBrief(
    input: UpdateBriefInput,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    await this.#once(
      operationId,
      "brief.update",
      commandInput("brief.update", [this.#snapshot.selectedProjectId, JSON.stringify(input)]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        if (projection.brief === null) throw new Error("WRITING_BRIEF_REQUIRED");
        if (projection.runs.some((run) => ACTIVE_STATUSES.has(run.status))) {
          throw new Error("RUN_ALREADY_ACTIVE");
        }
        const current = projection.brief.brief;
        const actor = { kind: "user", id: "local-ui" } as const;
        const saved = this.#service.saveWritingBrief({
          operationId: `${operationId}:brief`,
          projectId,
          expectedProjectRevision: projection.project.revision,
          baseVersionId: projection.brief.id,
          brief: {
            ...current,
            topic: input.topic,
            genre: input.genre,
            audience: input.audience,
            lengthTarget: { targetCharacters: input.targetCharacters },
            constraints: [...input.constraints],
            interactionMode: input.interactionMode,
            authorAuthorization: {
              ...current.authorAuthorization,
              voice: input.authorVoice,
              styleReference: input.styleReference,
              styleDecision: input.styleDecision,
              directionDecision: input.directionDecision,
            },
            platform: input.platform,
            publicationGoal: input.publicationGoal,
            confirmationStatus: "tentative",
          },
          actor,
        });
        if (!saved.ok) throwMutation(saved);
        mutationValue(this.#service.recordDecision({
          operationId: `${operationId}:decision`,
          projectId,
          expectedProjectRevision: saved.projectRevision,
          decisionId: `decision:${operationId}`,
          type: "brief",
          value: {
            confirmationStatus: "tentative",
            styleDecision: input.styleDecision,
            directionDecision: input.directionDecision,
          },
          scope: "current_article",
          sourceEventId: null,
          actor,
        }));
        this.#replace(
          this.#buildSnapshot(
            projectId,
            this.#snapshot.selectedSessionId,
            this.#snapshot.generation + 1,
            this.#snapshot.revision + 1,
            this.#snapshot.settings,
            null,
          ),
          true,
        );
      },
    );
  }

  async confirmBrief(options: BridgeCommandOptions = {}): Promise<void> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    await this.#once(
      operationId,
      "brief.confirm",
      commandInput("brief.confirm", [this.#snapshot.selectedProjectId]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        if (projection.brief === null) throw new Error("WRITING_BRIEF_REQUIRED");
        const current = projection.brief.brief;
        const directionDecision =
          current.authorAuthorization.directionDecision === "tentative"
            ? "user_confirmed"
            : current.authorAuthorization.directionDecision;
        const actor = { kind: "user", id: "local-ui" } as const;
        const saved = this.#service.saveWritingBrief({
          operationId: `${operationId}:brief`,
          projectId,
          expectedProjectRevision: projection.project.revision,
          baseVersionId: projection.brief.id,
          brief: {
            ...current,
            authorAuthorization: {
              ...current.authorAuthorization,
              directionDecision,
            },
            confirmationStatus: "confirmed",
          },
          actor,
        });
        if (!saved.ok) throwMutation(saved);
        mutationValue(this.#service.recordDecision({
          operationId: `${operationId}:decision`,
          projectId,
          expectedProjectRevision: saved.projectRevision,
          decisionId: `decision:${operationId}`,
          type: "brief",
          value: {
            confirmationStatus: "confirmed",
            styleDecision: current.authorAuthorization.styleDecision,
            directionDecision,
          },
          scope: "current_article",
          sourceEventId: null,
          actor,
        }));
        this.#replace(
          this.#buildSnapshot(
            projectId,
            this.#snapshot.selectedSessionId,
            this.#snapshot.generation + 1,
            this.#snapshot.revision + 1,
            this.#snapshot.settings,
            null,
          ),
          true,
        );
      },
    );
  }

  async startConversation(text: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    this.#ensureLive();
    const body = text.trim();
    if (!body) throw new Error('EMPTY_MESSAGE');
    if (body.length > 20_000) throw new Error('MESSAGE_TOO_LONG');
    if (this.#model.credentialReference === null) throw new Error('MODEL_CONFIGURATION_REQUIRED');
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(operationId, 'conversation.start', commandInput('conversation.start', [body]), async () => {
      const projectId = `project:${operationId}`;
      mutationValue(this.#service.createProject({ operationId: `${operationId}:project`, projectId,
        name: body.split(/\r?\n/u)[0]!.slice(0, 40), mode: 'deep', actor: { kind: 'user', id: 'local-ui' } }));
      this.#replace(this.#buildSnapshot(projectId, null, this.#snapshot.generation + 1,
        this.#snapshot.revision + 1, this.#snapshot.settings, null), true);
      return this.#startIntake(projectId, undefined, body, operationId);
    });
  }

  async confirmConversation(proposalVersionId: string, options: BridgeCommandOptions = {}): Promise<{ runId: string }> {
    this.#ensureLive();
    const projectId = this.#snapshot.selectedProjectId;
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(operationId, 'conversation.confirm', commandInput('conversation.confirm', [projectId, proposalVersionId]), async () => {
      if (!projectId) throw new Error('PROJECT_SELECTION_REQUIRED');
      const projection = this.#service.getProjectProjection(projectId);
      if (projection.runs.some(run => ACTIVE_STATUSES.has(run.status))) throw new Error('RUN_ALREADY_ACTIVE');
      const state = this.#service.confirmConversationBrief(projectId, proposalVersionId, operationId);
      return this.#startConfirmedWriting(projectId, state.sessionId ?? this.#snapshot.selectedSessionId, state.summary, `${operationId}:writing`);
    });
  }

  #startConfirmedWriting(projectId: string, sessionId: string, instruction: string, operationId: string): { runId: string } {
    const projection = this.#service.getProjectProjection(projectId);
    if (projection.brief?.brief.confirmationStatus !== 'confirmed') throw new Error('WRITING_BRIEF_NOT_CONFIRMED');
    const budget = budgetForProject(this.#model.budget, projection.project.mode);
    const handle = this.#service.startDraft({ projectId, sessionId, expectedProjectRevision: projection.project.revision,
      expectedBriefVersionId: projection.brief.id, model: this.#model.model, parameters: this.#model.parameters,
      userInstruction: `按刚才确认的方向继续：${instruction}`, operationId, ...(budget === undefined ? {} : { budget }) });
    this.#handoffError = null;
    if (this.#snapshot.selectedSessionId === sessionId || this.#snapshot.selectedSessionId === '') this.#refreshStartedRun(projectId, handle.sessionId);
    void handle.result.finally(() => this.refresh()).catch(() => undefined);
    return { runId: handle.runId };
  }

  #refreshStartedRun(projectId: string, sessionId: string): void {
    if (this.#disposed || this.#snapshot.selectedProjectId !== projectId) return;
    this.#replace(this.#buildSnapshot(projectId, sessionId, this.#snapshot.generation,
      this.#snapshot.revision + 1, this.#snapshot.settings, null), true);
  }

  #startIntake(projectId: string, sessionId: string | undefined, body: string, operationId: string): { runId: string } {
    const handle = this.#service.startConversationTurn({ projectId,
      ...(sessionId === undefined ? {} : { sessionId }), model: this.#model.model, parameters: this.#model.parameters,
      userInstruction: body, operationId });
    this.#handoffError = null;
    this.#refreshStartedRun(projectId, handle.sessionId);
    void handle.result.then(result => {
      if (!this.#disposed && result.ok && result.intake.phase === 'confirmed') {
        this.#startConfirmedWriting(projectId, handle.sessionId, result.intake.summary, `${operationId}:writing`);
      }
    }).catch(error => {
      // Keep the confirmed plan durable; a failed handoff is shown in the main
      // conversation and the user can retry without losing the exchange.
      if (this.#disposed || this.#snapshot.selectedProjectId !== projectId) return;
      this.#handoffError = { projectId, error: { code: 'CONVERSATION_HANDOFF_FAILED',
        message: '方向已经保存，但暂时没有成功开始写作。请在这里回复“继续”，或检查模型连接后重试。' } };
    }).finally(() => this.refresh());
    return { runId: handle.runId };
  }

  async sendMessage(
    text: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    this.#ensureLive();
    const body = text.trim();
    if (body.length === 0) throw new Error("EMPTY_MESSAGE");
    if (body.length > 20_000) throw new Error('MESSAGE_TOO_LONG');
    if (this.#snapshot.selectedProjectId.length === 0) return this.startConversation(body, options);
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "run.start",
      commandInput("run.start", [this.#snapshot.selectedProjectId, body]),
      async () => {
        const generation = this.#snapshot.generation;
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        const active = projection.runs.find((run) => ACTIVE_STATUSES.has(run.status));
        if (active !== undefined) throw new Error("RUN_ALREADY_ACTIVE");
        if (projection.brief?.brief.confirmationStatus !== 'confirmed') {
          return this.#startIntake(projectId, this.#snapshot.selectedSessionId || undefined, body, operationId);
        }
        // Explicit full-writing commands remain available. Ordinary feedback is
        // a bounded conversation, never implicit permission to rewrite the work.
        const explicitlyWrite = /^(?:请)?(?:开始(?:吧|写作)?|继续(?:写作)?|按已确认简报生成草稿|先生成完整稿件|按确认方向开始完整写作|基于同一简报重新生成一版)[。！!\s]*$/u.test(body);
        const discussion = /(?:先别|先不|不要(?:改|写)|讨论|解释|建议|选题|标题|开头|风格|配图|核查|核验|补充材料|来源原文|亲身经历|https:\/\/)|^(?:我)?(?:选|选择|采用|确认)(?:第)?[1-6一二三四五六]/u.test(body);
        const waitingTitle = projection.runs.find(run => run.sessionId === this.#snapshot.selectedSessionId && run.status === 'waiting_user' &&
          isPublicationSelectionWait(projection.events.filter(event => event.runId === run.id && event.type === 'run.waiting_user').at(-1)?.payload));
        const waiting = projection.runs.some(run => run.sessionId === this.#snapshot.selectedSessionId && run.status === 'waiting_user');
        const waitingReview = projection.runs.find(run => run.sessionId === this.#snapshot.selectedSessionId &&
          run.status === 'waiting_user' && run.stopReason === 'CO_CREATION_CHECKPOINT' &&
          isReviewStage(checkpointStages(projection, run.id).checkpointStage));
        const reviewDiscussion = waitingReview !== undefined && !isReviewConfirmation(body);
        if (reviewDiscussion || (waitingTitle && !projection.publicationSelectionCurrent) ||
          (!waitingReview && !explicitlyWrite && (!waiting || discussion))) {
          const handle = this.#service.startAuthorTurn({ projectId,
            ...(this.#snapshot.selectedSessionId ? { sessionId: this.#snapshot.selectedSessionId } : {}),
            model: this.#model.model, parameters: this.#model.parameters, userInstruction: body, operationId });
          this.#handoffError = null;
          this.#refreshStartedRun(projectId, handle.sessionId);
          void handle.result.then(async result => {
            if (!result.ok || this.#disposed || this.#snapshot.selectedProjectId !== projectId || this.#snapshot.selectedSessionId !== handle.sessionId) return;
            const latest = this.#service.getProjectProjection(projectId);
            const action = latest.events.filter(event => event.runId === handle.runId && event.type === 'tool.completed')
              .map(event => successfulToolResult(event.payload)).find(value => value?.requestedAction === 'fact_check' || value?.requestedAction === 'full_writing');
            if (action && action.bodyVersionId === latest.project.latestBodyVersionId) {
              if (action.requestedAction === 'fact_check') await this.runFactCheck({ operationId: `${operationId}:fact-check` });
              else await this.sendMessage('按已确认简报生成草稿', { operationId: `${operationId}:full-writing` });
            } else {
              const selected = latest.events.filter(event => event.runId === handle.runId && event.type === 'tool.completed')
                .map(event => successfulToolResult(event.payload)).find(value => typeof value?.titleVersionId === 'string' && value.titleVersionId === latest.project.currentTitleVersionId);
              const awaitingTitle = latest.runs.find(run => run.sessionId === handle.sessionId && run.status === 'waiting_user' &&
                isPublicationSelectionWait(latest.events.filter(event => event.runId === run.id && event.type === 'run.waiting_user').at(-1)?.payload));
              if (selected && awaitingTitle) await this.resumeRun(awaitingTitle.id, 'resume', { feedback: '标题已确认，请继续核查当前稿件', operationId: `${operationId}:continue-after-title` });
            }
          }).catch(error => {
            if (!this.#disposed && this.#snapshot.selectedProjectId === projectId) this.#handoffError = { projectId, error: { code: 'AUTHOR_ACTION_FAILED', message: '专项操作尚未开始，请先确认发布标题及证据材料，再使用下方“重新核查”。稿件未被改写。' } };
          }).finally(() => this.refresh());
          return { runId: handle.runId };
        }
        const awaitingInput = projection.runs.find(run =>
          run.sessionId === this.#snapshot.selectedSessionId &&
          run.status === 'waiting_user' && (run.stopReason === 'WRITING_INPUT_REQUIRED' || run.stopReason === 'CO_CREATION_CHECKPOINT'));
        if (awaitingInput !== undefined) {
          await this.resumeRun(awaitingInput.id, 'resume', { feedback: body, operationId: `${operationId}:answer` });
          return { runId: awaitingInput.id };
        }
        const budget = budgetForProject(this.#model.budget, projection.project.mode);
        const handle = this.#service.startDraft({
          projectId,
          expectedProjectRevision: projection.project.revision,
          expectedBriefVersionId: projection.brief.id,
          model: this.#model.model,
          parameters: this.#model.parameters,
          userInstruction: body,
          operationId,
          ...(this.#snapshot.selectedSessionId.length === 0
            ? {}
            : { sessionId: this.#snapshot.selectedSessionId }),
          ...(budget === undefined ? {} : { budget }),
        });
        this.#handoffError = null;
        if (
          this.#snapshot.generation === generation &&
          this.#snapshot.selectedProjectId === projectId
        ) {
          this.#replace(
            this.#buildSnapshot(
              projectId,
              handle.sessionId,
              generation,
              this.#snapshot.revision + 1,
              this.#snapshot.settings,
              null,
            ),
            true,
          );
        }
        void handle.result.finally(() => this.refresh()).catch(() => undefined);
        return { runId: handle.runId };
      },
    );
  }

  async runFactCheck(
    options: BridgeCommandOptions = {},
  ): Promise<{ runId: string }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "fact-check.run",
      commandInput("fact-check.run", [this.#snapshot.selectedProjectId]),
      async () => {
        const generation = this.#snapshot.generation;
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        const active = projection.runs.find((run) => ACTIVE_STATUSES.has(run.status));
        if (active !== undefined) throw new Error("RUN_ALREADY_ACTIVE");
        const budget = this.#model.budget === undefined
          ? undefined
          : { ...this.#model.budget, maxMajorRevisions: 0 };
        const handle = this.#service.startFactCheck({
          projectId,
          expectedProjectRevision: projection.project.revision,
          model: this.#model.model,
          parameters: this.#model.parameters,
          operationId,
          ...(this.#snapshot.selectedSessionId.length === 0
            ? {}
            : { sessionId: this.#snapshot.selectedSessionId }),
          ...(budget === undefined ? {} : { budget }),
        });
        if (
          this.#snapshot.generation === generation &&
          this.#snapshot.selectedProjectId === projectId
        ) {
          this.#replace(
            this.#buildSnapshot(
              projectId,
              handle.sessionId,
              generation,
              this.#snapshot.revision + 1,
              this.#snapshot.settings,
              null,
            ),
            true,
          );
        }
        void handle.result.finally(() => this.refresh()).catch(() => undefined);
        return { runId: handle.runId };
      },
    );
  }

  async cancelRun(
    runId: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "run.cancel",
      commandInput("run.cancel", [this.#snapshot.selectedProjectId, runId]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        const projection = this.#service.getProjectProjection(projectId);
        const run = projection.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) throw new Error("RUN_SCOPE_INVALID");
        this.#service.cancelDraft({ projectId, runId, operationId });
        await this.refresh();
      },
    );
  }

  async resumeRun(
    runId: string,
    decision: ResumeDraftInput["decision"],
    options: ResumeRunOptions = {},
  ): Promise<void> {
    this.#ensureLive();
    const feedback = options.feedback?.trim() ?? "";
    if (feedback.length > 4_000) throw new Error("CHECKPOINT_FEEDBACK_TOO_LONG");
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "run.resume",
      commandInput("run.resume", [
        this.#snapshot.selectedProjectId,
        runId,
        decision,
        feedback,
      ]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        const projection = this.#service.getProjectProjection(projectId);
        const run = projection.runs.find((candidate) => candidate.id === runId);
        if (run === undefined) throw new Error("RUN_SCOPE_INVALID");
        const waitingEvent = projection.events.filter(event => event.runId === runId && event.type === 'run.waiting_user').at(-1);
        if (run.status === 'waiting_user' && isPublicationSelectionWait(waitingEvent?.payload) && !projection.publicationSelectionCurrent) {
          if (!feedback) throw new Error('EMPTY_MESSAGE');
          if (projection.runs.some(candidate => ACTIVE_STATUSES.has(candidate.status))) throw new Error('RUN_ALREADY_ACTIVE');
          await this.selectSession(projectId, run.sessionId);
          await this.sendMessage(feedback, { operationId: `${operationId}:title-discussion` });
          return;
        }
        const start = projection.events.find(event => event.runId === runId && event.type === 'run.started');
        if (start?.payload.purpose === 'writing-pack:author-conversation') {
          if (run.status !== 'interrupted' && run.status !== 'waiting_user') throw new Error('RUN_NOT_RECOVERABLE');
          if (run.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' && decision !== 'retry_unknown') throw new Error('UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION');
          if (projection.runs.some(candidate => candidate.id !== runId && ACTIVE_STATUSES.has(candidate.status))) throw new Error('RUN_ALREADY_ACTIVE');
          const instruction = feedback || textPayload(start.payload, 'displayInstruction');
          if (!instruction) throw new Error('EMPTY_MESSAGE');
          // Retry the scoped author request, never resume it as a full-writing run.
          this.#service.cancelConversationTurn({ projectId, runId, operationId: `${operationId}:retire`, reason: 'author_retry_authorized' });
          await this.selectSession(projectId, run.sessionId);
          await this.sendMessage(instruction, { operationId: `${operationId}:author-retry` });
          return;
        }
        if (start?.payload.purpose === 'writing-pack:intake') {
          if (run.status !== 'interrupted' && run.status !== 'waiting_user') throw new Error('RUN_NOT_RECOVERABLE');
          if (run.stopReason === 'UNKNOWN_EXTERNAL_OUTCOME' && decision !== 'retry_unknown') throw new Error('UNKNOWN_OUTCOME_REQUIRES_CONFIRMATION');
          if (projection.runs.some(candidate => candidate.id !== runId && ACTIVE_STATUSES.has(candidate.status))) throw new Error('RUN_ALREADY_ACTIVE');
          // Intake has no draft prerequisites. Retire the interrupted attempt,
          // preserve its audit trail, and retry only after this user decision.
          this.#service.cancelConversationTurn({ projectId, runId, operationId: `${operationId}:retire`, reason: 'conversation_retry_authorized' });
          const state = this.#service.getConversationIntake(projectId);
          if (state.phase === 'confirmed') {
            this.#startConfirmedWriting(projectId, run.sessionId, state.summary, `${operationId}:writing`);
          } else {
            this.#startIntake(projectId, run.sessionId, feedback || textPayload(start.payload, 'displayInstruction') || '请继续刚才的交流。', `${operationId}:intake`);
          }
          return;
        }
        if (feedback.length > 0 && run.stopReason !== "CO_CREATION_CHECKPOINT" && run.stopReason !== 'WRITING_INPUT_REQUIRED') {
          throw new Error("CHECKPOINT_FEEDBACK_NOT_ALLOWED");
        }
        if (run.stopReason === 'WRITING_INPUT_REQUIRED' && feedback.length === 0) {
          throw new Error('WRITING_INPUT_ANSWER_REQUIRED');
        }
        if (
          projection.runs.some(
            (candidate) =>
              candidate.id !== runId && ACTIVE_STATUSES.has(candidate.status),
          )
        ) {
          throw new Error("RUN_ALREADY_ACTIVE");
        }
        if (projection.brief === null) throw new Error("WRITING_BRIEF_REQUIRED");
        const budget = budgetForProject(this.#model.budget, projection.project.mode);
        const handle = this.#service.resumeDraft({
          projectId,
          runId,
          operationId,
          decision,
          expectedProjectRevision: projection.project.revision,
          expectedBriefVersionId: projection.brief.id,
          model: this.#model.model,
          parameters: this.#model.parameters,
          // Retrying transport is not a new author instruction. A synthetic
          // instruction would invalidate the still-pending expert assignment.
          ...((decision === 'retry_unknown' || ['BUDGET_EXHAUSTED', 'STAGE_OUTPUT_NOT_SAVED'].includes(run.stopReason ?? '')) && feedback.length === 0 ? {} : {
            userInstruction: feedback.length > 0
              ? feedback
              : run.stopReason === "CO_CREATION_CHECKPOINT"
                ? "认可当前阶段，继续下一步"
                : "从已保存状态继续写作",
          }),
          sessionId: run.sessionId,
          ...(budget === undefined ? {} : { budget }),
        });
        await this.refresh();
        void handle.result.finally(() => this.refresh()).catch(() => undefined);
      },
    );
  }

  async proposeRevision(
    input: {
      baseBodyVersionId: string;
      instruction: string;
      constraints?: readonly string[];
      edits: readonly import("./protocol.js").RevisionEditRequest[];
    },
    options: BridgeCommandOptions = {},
  ): Promise<{ proposalId: string }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    const proposalId = `proposal:${operationId}`;
    return this.#once(
      operationId,
      "revision.propose",
      commandInput("revision.propose", [
        this.#snapshot.selectedProjectId,
        input.baseBodyVersionId,
        input.instruction,
        JSON.stringify(input.constraints ?? []),
        JSON.stringify(input.edits),
      ]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const edits = input.edits.map((edit): RevisionEdit => {
          if (edit.type === "delete") {
            return {
              type: "delete",
              targetBlockId: edit.targetBlockId,
              baseBlockHash: edit.baseBlockHash,
            };
          }
          if (edit.content === undefined) throw new Error("REVISION_CONTENT_REQUIRED");
          return {
            type: edit.type,
            targetBlockId: edit.targetBlockId,
            baseBlockHash: edit.baseBlockHash,
            content: edit.content,
          };
        });
        const result = mutationValue(this.#service.proposeRevision({
          operationId,
          proposalId,
          projectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          baseBodyVersionId: input.baseBodyVersionId,
          instruction: input.instruction,
          constraints: [...(input.constraints ?? [])],
          edits,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return { proposalId: result.proposalId };
      },
    );
  }

  async acceptRevision(
    proposalId: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "revision.accept",
      commandInput("revision.accept", [this.#snapshot.selectedProjectId, proposalId]),
      async () => {
        const result = mutationValue(this.#service.acceptRevisionProposal({
          operationId,
          proposalId,
          projectId: this.#snapshot.selectedProjectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return {
          versionId: result.versionId,
          status: result.status === "no_change" ? "no_change" : "created",
        };
      },
    );
  }

  async rejectRevision(
    proposalId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "revision.reject",
      commandInput("revision.reject", [this.#snapshot.selectedProjectId, proposalId, reason]),
      async () => {
        mutationValue(this.#service.rejectRevisionProposal({
          operationId,
          proposalId,
          projectId: this.#snapshot.selectedProjectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          reason,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
      },
    );
  }

  async saveBody(
    baseBodyVersionId: string,
    content: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string; status: "created" | "no_change" }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "body.save",
      commandInput("body.save", [this.#snapshot.selectedProjectId, baseBodyVersionId, content, reason]),
      async () => {
        const result = mutationValue(this.#service.saveBody({
          operationId,
          projectId: this.#snapshot.selectedProjectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          baseBodyVersionId,
          content,
          reason,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return {
          versionId: result.versionId,
          status: result.status === "no_change" ? "no_change" : "created",
        };
      },
    );
  }

  async setBlockLock(
    baseBodyVersionId: string,
    blockId: string,
    blockHash: string,
    action: "lock" | "unlock",
    options: BridgeCommandOptions = {},
  ): Promise<void> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "body.block-lock",
      commandInput("body.block-lock", [
        this.#snapshot.selectedProjectId,
        baseBodyVersionId,
        blockId,
        blockHash,
        action,
      ]),
      async () => {
        mutationValue(this.#service.setBodyBlockLock({
          operationId,
          projectId: this.#snapshot.selectedProjectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          baseBodyVersionId,
          blockId,
          blockHash,
          action,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
      },
    );
  }

  async rollbackBody(
    targetVersionId: string,
    reason: string,
    options: BridgeCommandOptions = {},
  ): Promise<{ versionId: string }> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "body.rollback",
      commandInput("body.rollback", [this.#snapshot.selectedProjectId, targetVersionId, reason]),
      async () => {
        const baseVersionId = this.#snapshot.revisionWorkspace.bodyVersionId;
        if (baseVersionId === null) throw new Error("BODY_VERSION_REQUIRED");
        const result = mutationValue(this.#service.rollbackBody({
          operationId,
          projectId: this.#snapshot.selectedProjectId,
          expectedProjectRevision: this.#snapshot.revisionWorkspace.projectRevision,
          baseVersionId,
          targetVersionId,
          reason,
          requestSnapshotId: null,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return { versionId: result.versionId };
      },
    );
  }

  async saveWorkingCopy(
    options: BridgeCommandOptions = {},
  ): Promise<DeliveryExportView> {
    this.#ensureLive();
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "export.working-copy",
      commandInput("export.working-copy", [this.#snapshot.selectedProjectId]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        const prior = projection.exports.find(
          (record) => record.operationId === operationId,
        );
        const bodyVersionId = prior?.bodyVersionId ?? projection.currentBody?.id;
        if (bodyVersionId === undefined) throw new Error("BODY_VERSION_REQUIRED");
        const result = mutationValue(this.#service.saveWorkingCopy({
          operationId,
          projectId,
          expectedProjectRevision:
            prior?.expectedProjectRevision ?? projection.project.revision,
          bodyVersionId,
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return deliveryExportView(result);
      },
    );
  }

  async exportPublication(
    format: "txt" | "html",
    options: ExportPublicationOptions = {},
  ): Promise<DeliveryExportView> {
    this.#ensureLive();
    if (format !== "txt" && format !== "html") {
      throw new Error("EXPORT_FORMAT_INVALID");
    }
    const operationId = options.operationId ?? this.#operationIdFactory();
    return this.#once(
      operationId,
      "export.publication",
      commandInput("export.publication", [
        this.#snapshot.selectedProjectId,
        format,
        options.layoutPreset ?? "clean",
      ]),
      async () => {
        const projectId = this.#snapshot.selectedProjectId;
        if (projectId.length === 0) throw new Error("PROJECT_SELECTION_REQUIRED");
        const projection = this.#service.getProjectProjection(projectId);
        const prior = projection.exports.find(
          (record) => record.operationId === operationId,
        );
        const bodyVersionId = prior?.bodyVersionId ?? projection.currentBody?.id;
        if (bodyVersionId === undefined) throw new Error("BODY_VERSION_REQUIRED");
        const factSnapshotId =
          prior?.factSnapshotId ?? projection.factCheck.currentSnapshotId;
        if (factSnapshotId === null) throw new Error("FACT_GATE_NOT_PASSED");
        const result = mutationValue(this.#service.exportPublication({
          operationId,
          projectId,
          expectedProjectRevision:
            prior?.expectedProjectRevision ?? projection.project.revision,
          bodyVersionId,
          factSnapshotId,
          format,
          layoutPreset: options.layoutPreset ?? "clean",
          actor: { kind: "user", id: "local-ui" },
        }));
        await this.refresh();
        return deliveryExportView(result);
      },
    );
  }

  async refresh(): Promise<void> {
    if (this.#disposed) return;
    try {
      const next = this.#buildSnapshot(
        this.#snapshot.selectedProjectId,
        this.#snapshot.selectedSessionId,
        this.#snapshot.generation,
        this.#snapshot.revision + 1,
        this.#snapshot.settings,
        null,
      );
      this.#replace(next, false);
    } catch (error) {
      const nextError = {
        code:
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : error instanceof Error
              ? error.name
              : "BRIDGE_REFRESH_FAILED",
        message: error instanceof Error ? error.message : "Bridge refresh failed",
      };
      if (
        this.#snapshot.connection !== "offline" ||
        this.#snapshot.lastError?.code !== nextError.code
      ) {
        this.#replace(
          {
            ...this.#snapshot,
            revision: this.#snapshot.revision + 1,
            connection: "offline",
            lastError: nextError,
          },
          true,
        );
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#pollTimer !== null) clearInterval(this.#pollTimer);
    this.#pollTimer = null;
    this.#listeners.clear();
    this.#commands.clear();
  }

  async #once<T>(
    operationId: string,
    kind: string,
    input: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const existing = this.#commands.get(operationId);
    if (existing !== undefined) {
      if (existing.kind !== kind || existing.input !== input) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }
      return existing.result as Promise<T>;
    }
    const result = action();
    this.#commands.set(operationId, { kind, input, result });
    return result;
  }

  #ensureLive(): void {
    if (this.#disposed) throw new Error("BRIDGE_DISPOSED");
  }

  #replace(next: BridgeSnapshot, force: boolean): void {
    const before = JSON.stringify({ ...this.#snapshot, revision: 0 });
    const after = JSON.stringify({ ...next, revision: 0 });
    if (!force && before === after) return;
    this.#snapshot = next;
    for (const listener of this.#listeners) listener();
  }

  #buildSnapshot(
    requestedProjectId: string,
    requestedSessionId: string | null | undefined,
    generation: number,
    revision: number,
    settings: UiSettings,
    lastError: BridgeSnapshot["lastError"],
  ): BridgeSnapshot {
    const projections = this.#service
      .listProjects()
      .map((project) => this.#service.getProjectProjection(project.id));
    const selectedProjection =
      projections.find(
        (projection) => projection.project.id === requestedProjectId,
      ) ?? projections[0];
    const selectedProjectId = selectedProjection?.project.id ?? "";
    const selectedSession = requestedSessionId === null || requestedSessionId === ''
      ? undefined
      : selectedProjection?.sessions.find(
          (session) => session.id === requestedSessionId,
        ) ?? selectedProjection?.sessions.at(-1);
    const selectedSessionId = selectedSession?.id ?? "";
    const allRuns = projections.flatMap((projection) => projection.runs);
    const selectedRuns = allRuns.filter(
      (run) => run.sessionId === selectedSessionId,
    );
    const activeRun = [...selectedRuns]
      .reverse()
      .find((run) => ACTIVE_STATUSES.has(run.status));
    const currentBody = selectedProjection?.currentBody ?? null;
    const fallbackTitle = selectedProjection?.brief?.brief.topic ?? "尚未生成稿件";
    const processArtifacts = selectedProjection?.workflowArtifacts
      .map(workflowArtifactView)
      .filter((artifact): artifact is WorkflowArtifactView => artifact !== null) ?? [];
    const selectedRunViews = selectedProjection === undefined
      ? []
      : selectedRuns.map((run) => runRecordView(selectedProjection, run));
    const latestWritingRunId = [...selectedRunViews]
      .reverse()
      .find((run) => run.displayInstruction !== "重新核查当前稿件")?.id ?? null;

    return {
      revision,
      generation,
      workspaceId: this.#workspaceId,
      mode: "application",
      connection: activeRun === undefined ? "ready" : "running",
      selectedProjectId,
      selectedSessionId,
      projects: projections.map((projection) => ({
        id: projection.project.id,
        name: projection.project.name,
        sessionIds: projection.sessions.map((session) => session.id),
        revision: projection.project.revision,
        latestProjectSeq: projection.latestProjectSeq,
      })),
      sessions: projections.flatMap((projection) =>
        projection.sessions.map((session) => {
          const runs = projection.runs.filter(
            (run) => run.sessionId === session.id,
          );
          return {
            id: session.id,
            projectId: session.projectId,
            title:
              session.purpose === "writing-pack:draft"
                ? "写作草稿"
                : ['writing-pack:intake', 'writing-pack:author-conversation'].includes(session.purpose) ? '共创对话'
                : session.purpose,
            relativeTime: relativeTime(session.createdAt),
            status: sessionStatus(runs),
          };
        }),
      ),
      timelineBySession: Object.fromEntries(
        projections.flatMap((projection) =>
          projection.sessions.map((session) => [
            session.id,
            timelineForSession(projection, session.id),
          ]),
        ),
      ),
      runRecords: selectedRunViews,
      materialProcessWorkspace: {
        materials: selectedProjection?.materials.map((material) => ({
          id: material.id,
          displayName: material.displayName,
          sourceKind: material.sourceKind,
          role: material.role,
          trustLabel: material.trustLabel,
          importedAt: material.importedAt,
        })) ?? [],
        evidence:
          processArtifacts.filter((artifact) => artifact.kind === "evidence").at(-1) ?? null,
        outline:
          processArtifacts.filter((artifact) => artifact.kind === "outline").at(-1) ?? null,
        reviews: processArtifacts.filter((artifact) =>
          artifact.kind === "review" &&
          (latestWritingRunId === null || artifact.runId === latestWritingRunId)
        ),
        notice:
          "这里展示写作实际使用的材料目录和已保存过程产物；本机源文件路径与材料正文不会作为目录信息外发。",
      },
      previewDocument: {
        id: currentBody?.id ?? null,
        title:
          selectedProjection?.publicationTitle ?? (currentBody === null
            ? fallbackTitle
            : titleFromBody(currentBody.content, fallbackTitle)),
        version: selectedProjection?.bodyVersionCount ?? 0,
        status: currentBody === null ? "empty" : "draft",
        body:
          currentBody && selectedProjection?.publicationTitle
            ? `# ${selectedProjection.publicationTitle.replace(/([\\`*_{}\[\]<>])/gu, '\\$1')}\n\n${withoutFirstMarkdownHeading(currentBody.content)}`
            : currentBody?.content ?? "尚无已保存稿件。确认简报并提交写作指令后，已持久保存的正文会显示在这里。",
      },
      liveReply: activeRun ? this.#service.getLiveReply(selectedProjection!.project.id, selectedSessionId, activeRun.id) : null,
      liveActivity: activeRun ? this.#service.getLiveActivity(selectedProjection!.project.id, selectedSessionId, activeRun.id) : null,
      revisionWorkspace: {
        bodyVersionId: currentBody?.id ?? null,
        projectRevision: selectedProjection?.project.revision ?? 0,
        blocks:
          currentBody?.document.blocks.map((block) => ({
            ...block,
            locked:
              selectedProjection?.blockLocks.some(
                (lock) => lock.blockId === block.id,
              ) ?? false,
          })) ?? [],
        versions:
          selectedProjection?.bodyVersions.map((version, index) => ({
            id: version.id,
            ordinal: index + 1,
            reason: version.reason,
            actorLabel: actorLabel(version.actor),
            createdAt: version.createdAt,
            current: version.id === currentBody?.id,
          })) ?? [],
        proposals:
          selectedProjection?.revisionProposals.map((proposal) => ({
            id: proposal.id,
            baseBodyVersionId: proposal.baseBodyVersionId,
            instruction: proposal.instruction,
            status: proposal.status,
            conflictCode: proposal.conflictCode,
            diff: proposal.diff,
            createdAt: proposal.createdAt,
          })) ?? [],
      },
      factCheckWorkspace: {
        status: selectedProjection?.factCheck.status ?? "not_checked",
        snapshot:
          selectedProjection?.factCheck.snapshot === null ||
          selectedProjection?.factCheck.snapshot === undefined
            ? null
            : {
                id: selectedProjection.factCheck.snapshot.snapshotId,
                policyVersion: selectedProjection.factCheck.snapshot.policyVersion,
                bodyVersionId: selectedProjection.factCheck.snapshot.bodyVersionId,
                bodyHash: selectedProjection.factCheck.snapshot.bodyHash,
                titleVersionId: selectedProjection.factCheck.snapshot.titleVersionId,
                titleHash: selectedProjection.factCheck.snapshot.titleHash,
                distributionCopyHash:
                  selectedProjection.factCheck.snapshot.distributionCopyHash,
                evidenceVersionId:
                  selectedProjection.factCheck.snapshot.evidenceVersionId,
                evidenceHash: selectedProjection.factCheck.snapshot.evidenceHash,
              },
        assessment:
          selectedProjection?.factCheck.assessment === null ||
          selectedProjection?.factCheck.assessment === undefined
            ? null
            : {
                status: selectedProjection.factCheck.assessment.status,
                claimsHash: selectedProjection.factCheck.assessment.claimsHash,
                reportHash: selectedProjection.factCheck.assessment.reportHash,
                blockers: selectedProjection.factCheck.assessment.blockers,
                claims: selectedProjection.factCheck.assessment.payload.claims.map(
                  (claim) => ({
                    claimId: claim.claimId,
                    claimText: claim.claimText,
                    location: claim.location,
                    status: claim.status,
                    risk: claim.risk,
                    supportScope: claim.supportScope,
                    evidenceId: claim.matchedEvidenceId,
                    sourceReference: claim.sourceReference,
                    evidenceSummary: claim.evidenceSummary,
                    recommendedAction: claim.recommendedAction,
                  }),
                ),
              },
        invalidations:
          selectedProjection?.factCheck.invalidations.map((invalidation) => ({
            reason: invalidation.reason,
            changedVersionId: invalidation.changedVersionId,
            createdAt: invalidation.createdAt,
          })) ?? [],
        provenance:
          selectedProjection?.provenance.map((edge) => ({
            fromId: edge.fromId,
            relation: edge.relation,
            toId: edge.toId,
            evidenceRef: edge.evidenceRef,
          })) ?? [],
        notice:
          "来源关系仅说明产物如何形成；核查通过表示该输入快照通过既定流程，不承诺事实绝对正确。",
      },
      deliveryWorkspace: {
        bodyVersionId: currentBody?.id ?? null,
        projectRevision: selectedProjection?.project.revision ?? 0,
        gateStatus: selectedProjection?.factCheck.status ?? "not_checked",
        formalExportEnabled:
          currentBody !== null && selectedProjection?.factCheck.status === "passed",
        exports: selectedProjection?.exports.map(deliveryExportView) ?? [],
        notice:
          "工作备份不代表可发布；正式 TXT/HTML 仅在当前正文、标题、证据与核查快照一致时生成。",
      },
      settings,
      activeRunId: activeRun?.id ?? null,
      conversationIntake: selectedProjection === undefined ? null : (() => {
        const state = this.#service.getConversationIntake(selectedProjectId);
        return { phase: state.phase, summary: state.summary, proposalVersionId: state.proposalVersionId };
      })(),
      brief:
        selectedProjection?.brief === null || selectedProjection?.brief === undefined
          ? null
          : {
              versionId: selectedProjection.brief.id,
              topic: selectedProjection.brief.brief.topic,
              genre: selectedProjection.brief.brief.genre,
              audience: selectedProjection.brief.brief.audience,
              targetCharacters:
                selectedProjection.brief.brief.lengthTarget.targetCharacters,
              constraints: selectedProjection.brief.brief.constraints,
              interactionMode: selectedProjection.brief.brief.interactionMode,
              authorVoice:
                selectedProjection.brief.brief.authorAuthorization.voice,
              styleReference:
                selectedProjection.brief.brief.authorAuthorization.styleReference,
              styleDecision:
                selectedProjection.brief.brief.authorAuthorization.styleDecision,
              confirmationStatus:
                selectedProjection.brief.brief.confirmationStatus,
              directionDecision:
                selectedProjection.brief.brief.authorAuthorization
                  .directionDecision,
              platform: selectedProjection.brief.brief.platform,
              publicationGoal: selectedProjection.brief.brief.publicationGoal,
              materialCount: selectedProjection.materials.length,
            },
      recoverableRuns: selectedRuns
        .filter(
          (run) => run.status === "interrupted" || run.status === "waiting_user" ||
            (run.status === 'budget_exhausted' && selectedProjection?.events.some(event => event.runId === run.id && event.type === 'run.started' && event.payload.purpose === 'writing-pack:draft')),
        )
        .map((run) => {
          const checkpoint = selectedProjection === undefined || run.status === 'budget_exhausted'
            ? { checkpointStage: null, nextStage: null }
            : checkpointStages(selectedProjection, run.id);
          const interruption = selectedProjection === undefined ? undefined : recoveryInterruption(selectedProjection, run);
          return {
            runId: run.id,
            sessionId: run.sessionId,
            status: run.status as "interrupted" | "waiting_user" | "budget_exhausted",
            stopReason: run.stopReason,
            ...(interruption === undefined ? {} : { interruption }),
            ...checkpoint,
          };
        }),
      lastError: lastError ?? (this.#handoffError?.projectId === selectedProjectId ? this.#handoffError.error : null),
      environmentNotice:
        activeRun === undefined
          ? "本地保存已就绪"
          : "正在写作；已保存的内容会自动保留",
      composerHint:
        "Enter 发送 · Shift+Enter 换行 · 项目和稿件会保存在这台电脑上",
    };
  }
}

export function createApplicationBridge(
  options: ApplicationBridgeOptions,
): ClientBridge {
  return new ApplicationClientBridge(options);
}
