import type { RuntimeEvent, SessionStore, ResumeRunInput } from '../../runtime/session/src/index.js';
import { ToolExecutionFault } from '../../runtime/tools/src/index.js';

export const FACT_SEARCH_DECISION_REQUIRED = 'FACT_SEARCH_DECISION_REQUIRED';
export type FactSearchDecision = NonNullable<ResumeRunInput['factSearchDecision']>;
export interface FactSearchRecoveryRequest {
  requestId: string;
  kind: 'timeout' | 'failure' | 'limit';
  query: string;
  used: number;
  limit: number;
  attemptsUsed: number;
  attemptsLimit: number;
  reason: string;
}

export function searchRecoveryRequests(events: readonly RuntimeEvent[]): FactSearchRecoveryRequest[] {
  return events.filter(e => e.type === 'tool.completed').flatMap(e => {
    const envelope = e.payload.result as any;
    const request = envelope?.result?.recoveryRequired;
    return envelope?.ok === true && envelope.toolName === 'search_fact_sources' && !envelope.result.cacheHit &&
      request?.requestId === e.operationId ? [request as FactSearchRecoveryRequest] : [];
  });
}

export function searchDecisions(events: readonly RuntimeEvent[]): FactSearchDecision[] {
  return events.filter(e => e.type === 'run.resumed' && e.payload.factSearchDecision).map(e => e.payload.factSearchDecision as unknown as FactSearchDecision);
}

export function pendingFactSearchRecovery(events: readonly RuntimeEvent[]): FactSearchRecoveryRequest | null {
  const decisions = searchDecisions(events);
  return searchRecoveryRequests(events).findLast(r => !decisions.some(d => d.requestId === r.requestId)) ?? null;
}

/** Host-owned button decisions, never model arguments. */
export function validateFactSearchDecision(storage: Pick<SessionStore, 'listRunEvents'>, runId: string,
  decision: FactSearchDecision | undefined, searchEnabled = true): FactSearchDecision | undefined {
  const pending = pendingFactSearchRecovery(storage.listRunEvents(runId));
  if (!pending && !decision) return undefined;
  if (!pending || !decision || decision.requestId !== pending.requestId ||
    !['retry', 'extend', 'continue'].includes(decision.action) ||
    (decision.action === 'retry' && pending.kind === 'limit') ||
    (decision.action === 'extend' && pending.kind !== 'limit')) {
    throw new ToolExecutionFault(FACT_SEARCH_DECISION_REQUIRED, '请在当前搜索提示中选择重试、追加搜索或不追加；旧提示不能授予新的搜索额度。');
  }
  if (decision.action !== 'continue' && !searchEnabled) {
    throw new ToolExecutionFault('SEARCH_DISABLED', '当前已关闭全部搜索服务。请重新开启搜索后重试，或选择“不再搜索，继续核查”。你的等待项和已取得结果仍保留。');
  }
  return { requestId: pending.requestId, action: decision.action };
}

export function searchRecoveryPause(events: readonly RuntimeEvent[]) {
  const request = pendingFactSearchRecovery(events);
  return request ? { reason: FACT_SEARCH_DECISION_REQUIRED, payload: {
    kind: 'search_recovery', reason: request.reason, searchRecovery: { ...request }, nextStage: 'fact_check',
  } } : null;
}

export function factSearchLimitations(events: readonly RuntimeEvent[]) {
  const requests = searchRecoveryRequests(events);
  return searchDecisions(events).filter(d => d.action === 'continue').flatMap(d => {
    const request = requests.find(r => r.requestId === d.requestId);
    return request ? [{ query: request.query, reason: request.reason, userDeclined: true as const }] : [];
  });
}
