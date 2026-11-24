import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BridgeSnapshot, RunDiagnosticTraceStep, RunTraceDetailInput } from '../../../packages/client-bridge/src/protocol.js';
import { explainRunFailure } from '../../../packages/client-bridge/src/run-failure-explanation.js';
import { toolPresentation } from '../../../packages/client-bridge/src/tool-presentation.js';
import type { GroupModelSelection } from '../../../packages/client-bridge/src/model-groups.js';
import type { ModelProvider, ModelRequest } from '../../../packages/runtime/llm/src/index.js';

export function saveFailureAnalysisModel(path: string, selection: GroupModelSelection | null): void {
  const temporary = path + '.tmp-' + randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(temporary, JSON.stringify(selection) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const traceSelection = z.object({
  projectId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
  runId: z.string().min(1).max(256),
  stepId: z.string().min(1).max(256),
}).strict();

export function parseFailureAnalysisTarget(input: unknown): RunTraceDetailInput {
  const parsed = traceSelection.safeParse(input);
  if (!parsed.success) throw new Error('INVALID_ARGUMENT');
  return parsed.data;
}

function summarizeStep(step: RunDiagnosticTraceStep) {
  const technicalName = step.technicalName && toolPresentation(step.technicalName).label !== '未登记的工具' ? step.technicalName : undefined;
  const httpStatus = step.httpStatus ?? step.providerHttpStatus;
  const transportPhase = step.transport?.phase;
  return {
    kind: step.kind,
    stage: step.actorLabel,
    action: step.label,
    technicalName,
    status: step.status,
    errorCode: step.errorCode,
    durationMs: step.durationMs,
    httpStatus,
    transportPhase,
  };
}

export function failureAnalysisContext(snapshot: BridgeSnapshot, target: RunTraceDetailInput, appVersion: string) {
  if (target.projectId !== snapshot.selectedProjectId || target.sessionId !== snapshot.selectedSessionId) {
    throw new Error('TRACE_SCOPE_MISMATCH');
  }
  const run = snapshot.runRecords.find(record => record.id === target.runId);
  const trace = run?.diagnostics?.trace ?? [];
  const index = trace.findIndex(step => step.id === target.stepId);
  const step = trace[index];
  if (!run || !step || (step.status !== 'failed' && step.status !== 'outcome_unknown')) {
    throw new Error('FAILURE_ANALYSIS_NO_FAILURE');
  }
  const failure = summarizeStep(step);
  // Only structured, locally projected status. No trace previews, payloads, IDs or URLs.
  return {
    appVersion,
    runStatus: run.status,
    failure,
    localExplanation: explainRunFailure(failure),
    nearbySteps: trace.slice(Math.max(0, index - 2), index + 3)
      .filter(neighbor => neighbor !== step && neighbor.segmentId === step.segmentId)
      .map(summarizeStep),
  };
}

const resultSchema = z.object({
  problem: z.string().trim().min(1).max(200),
  finding: z.string().trim().min(1).max(420),
  nextStep: z.string().trim().min(1).max(320),
}).strict();

async function readAnalysis(provider: ModelProvider, request: ModelRequest) {
  let text = '';
  let completed = false;
  for await (const event of provider.stream(request)) {
    if (request.signal?.aborted) throw request.signal.reason;
    if (event.type === 'error') throw new Error('FAILURE_ANALYSIS_REQUEST_FAILED');
    if (event.type === 'text_delta') {
      text += event.delta;
      if (text.length > 4000) throw new Error('FAILURE_ANALYSIS_RESPONSE_INVALID');
    }
    if (event.type === 'completed') {
      completed = event.finishReason === 'stop';
      break;
    }
  }
  if (!completed) throw new Error('FAILURE_ANALYSIS_RESPONSE_INVALID');
  let value: unknown;
  try {
    value = JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/iu, '$1'));
  } catch {
    throw new Error('FAILURE_ANALYSIS_RESPONSE_INVALID');
  }
  const result = resultSchema.safeParse(value);
  if (!result.success) throw new Error('FAILURE_ANALYSIS_RESPONSE_INVALID');
  return result.data;
}

export async function requestFailureAnalysis(
  provider: ModelProvider, model: string, context: ReturnType<typeof failureAnalysisContext>, signal: AbortSignal,
) {
  const timeout = AbortSignal.timeout(35_000);
  const requestSignal = AbortSignal.any([timeout, signal]);
  const abortError = () => new Error(timeout.aborted ? 'FAILURE_ANALYSIS_TIMEOUT' : 'FAILURE_ANALYSIS_REQUEST_FAILED');
  if (requestSignal.aborted) throw abortError();

  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError());
    requestSignal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, readAnalysis(provider, {
      requestId: 'desktop-failure-analysis-' + randomUUID(),
      model,
      signal: requestSignal,
      parameters: { maxOutputTokens: 2048 },
      messages: [
        { role: 'system', content: '用简体中文给普通用户解释一次失败。只依据记录和应用提供的解释，区分已确认的事实和未知原因。不要把本地拦截推断成网络或服务商故障。返回 JSON 对象，仅包含三个字符串：problem 用一句短话说卡在哪一步，finding 只说对排障有帮助的已确认事实，nextStep 从 localExplanation.remediation 中选一个能执行的动作。不要重复阶段名、复述字段或添加记录中没有的功能入口。三项分别不超过 35、90、65 字。' },
        { role: 'user', content: JSON.stringify(context) },
      ],
    })]);
  } finally {
    requestSignal.removeEventListener('abort', onAbort);
  }
}
