import type { AgentRuntimeOptions } from '../../runtime/agent/src/index.js';
import { isPublicStageOutput } from '../../writing-core/src/public-stage-output.js';

function stringAt(source: string, start: number): { value: string; end: number; complete: boolean } {
  let value = '';
  for (let i = start + 1; i < source.length; i++) {
    const character = source[i]!;
    if (character === '"') return { value, end: i + 1, complete: true };
    if (character !== '\\') { value += character; continue; }
    const escape = source[++i];
    if (escape === 'u') {
      const digits = source.slice(i + 1, i + 5);
      if (!/^[\da-f]{4}$/iu.test(digits)) break;
      value += String.fromCharCode(parseInt(digits, 16)); i += 4;
    } else {
      const decoded = ({ '"': '"', '\\': '\\', '/': '/', n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[escape ?? ''];
      if (decoded === undefined) break;
      value += decoded;
    }
  }
  return { value: value.replace(/[\uD800-\uDBFF]$/u, ''), end: source.length, complete: false };
}

/** Locate only a direct field, ignoring quoted braces and nested metadata. */
function topLevelValueStart(source: string, key: string): number | null {
  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    const character = source[i];
    if (character === '{' || character === '[') depth++;
    else if (character === '}' || character === ']') depth--;
    else if (character === '"') {
      const token = stringAt(source, i);
      if (!token.complete) return null;
      let next = token.end;
      while (/\s/u.test(source[next] ?? '') && next < source.length) next++;
      if (depth === 1 && token.value === key && source[next] === ':') {
        next++;
        while (/\s/u.test(source[next] ?? '') && next < source.length) next++;
        return next;
      }
      i = token.end - 1;
    }
  }
  return null;
}

/** Read one JSON string without exposing nested metadata or unfinished escape syntax. */
export function topLevelString(source: string, key: string): string | null {
  const start = topLevelValueStart(source, key);
  return start !== null && source[start] === '"' ? stringAt(source, start).value : null;
}

export interface LiveConversationReply { runId: string; requestId: string; text: string; id?: string; stage?: string; phase?: 'generating' | 'saving' }
export interface MaterialPreview { id: string; label: string; text: string }
/** Only existing public artifacts/material excerpts from the actual request.
 * No prompt, conversation history, model reasoning, IDs or raw ledger JSON. */
export function requestMaterialPreviews(messages: readonly { role: string; content: string }[]): MaterialPreview[] {
  const previews: MaterialPreview[] = [];
  const seenText = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const marker = '\nCOLLABORATION_STATE=';
    const offset = message.content.lastIndexOf(marker);
    let state: Record<string, unknown>;
    try { state = JSON.parse(offset >= 0 ? message.content.slice(offset + marker.length) : message.content); }
    catch { continue; }
    if (!state || typeof state !== 'object') continue;
    const requirements = state.writingRequirements as Record<string, unknown> | undefined;
    for (const [key, label] of [['audience', '目标读者'], ['platform', '发布平台']] as const) {
      const text = requirements?.[key];
      if (typeof text !== 'string' || !text.trim() || seenText.has(text)) continue;
      seenText.add(text);
      previews.push({ id: `requirement:${key}`, label, text: text.slice(0, 1200) });
    }
    const artifacts = Array.isArray(state.artifacts) ? state.artifacts : [];
    const materials = Array.isArray(state.materials) ? state.materials : Array.isArray(state.authorizedMaterials) ? state.authorizedMaterials : [];
    for (const raw of [...artifacts, ...materials]) {
      const item = raw?.kind === 'evidence' && typeof raw.content === 'object' && raw.content !== null
        ? { ...raw, content: typeof raw.content.notes === 'string' ? raw.content.notes : '' } : raw;
      if (!item || typeof item.content !== 'string') continue;
      const id = item.id ?? item.contentVersionId;
      if (typeof id !== 'string' || previews.some(p => p.id === id)) continue;
      let text = item.content;
      if (text.trimStart().startsWith('{')) {
        if (item.kind !== 'evidence') continue;
        text = topLevelString(text, 'notes') ?? '';
      }
      if (!text.trim() || text.trimStart().startsWith('[')) continue;
      // A link-only author message is not a second copy of the fetched article.
      if (/^https?:\/\/\S+$/u.test(text.trim()) || seenText.has(text)) continue;
      seenText.add(text);
      const title = typeof item.displayName === 'string' && !/^需求对话 /u.test(item.displayName) ? item.displayName : text.replace(/\s+/gu, ' ').trim();
      const shortTitle = title.length > 32 ? `${title.slice(0, 32)}…` : title;
      const category = typeof item.materialId === 'string' && item.materialId.startsWith('intake-user-') ? '需求补充' : item.sourceKind === 'web_snapshot' ? '网页素材' : '参考素材';
      previews.push({ id, label: item.kind === 'body' ? '本次提供的稿件' : item.kind === 'outline' ? '已保存的提纲' : item.kind === 'evidence' ? '研究素材摘要' : `${category} · ${shortTitle}`, text: text.slice(0, 1200) });
      if (previews.length >= 8) return previews;
    }
  }
  return previews;
}
export interface LiveConversationActivity {
  runId: string; requestId: string; actor: string; phase: 'waiting' | 'connected' | 'receiving';
  startedAt: number; lastActivityAt: number | null;
  segmentStartedAt: number; requestOrdinal: number;
  lastEventKind?: 'reasoning' | 'content' | 'tool_arguments';
  receivedEvents?: number;
  activeTool?: { name: string; startedAt: number };
  materials?: readonly MaterialPreview[];
  workPreview?: { label: string; text: string };
}
type StreamInput = Parameters<NonNullable<AgentRuntimeOptions['onModelStream']>>[0];

/** Ephemeral preview only: never a committed reply, tool result, or publication authority. */
export class ConversationStreamPreview {
  readonly #segments = new Map<string, { projectId: string; sessionId: string; startedAt: number; requests: number; workPreview?: { label: string; text: string }; previewRequestId?: string }>();
  readonly #runs = new Map<string, { projectId: string; sessionId: string; requestId: string; outputPreview?: StreamInput['outputPreview']; phase: 'generating' | 'saving'; carried: boolean; calls: Map<number, { name: string; raw: string }>; plainText: string; text: string; activity: LiveConversationActivity }>();
  observe = (input: StreamInput): void => {
    if (input.event === null && input.lifecycle !== 'started') {
      // Empty requestId is the runtime's execution-segment finally, including
      // pauses/cancellation. An individual failed request must not reset time.
      if (!input.requestId) this.#segments.delete(input.runId);
      const state = this.#runs.get(input.runId);
      if (input.lifecycle === 'finished' && state?.requestId === input.requestId) state.phase = 'saving';
      else this.#runs.delete(input.runId);
      return;
    }
    let state = this.#runs.get(input.runId);
    if (!state || state.requestId !== input.requestId) {
      let segment = this.#segments.get(input.runId);
      if (!segment || segment.projectId !== input.projectId || segment.sessionId !== input.sessionId) {
        segment = { projectId: input.projectId, sessionId: input.sessionId, startedAt: Date.now(), requests: 0 };
        this.#segments.set(input.runId, segment);
      }
      segment.requests++;
      // A pending decision/search describes this request, not the next expert.
      // Readable research excerpts may survive; stale execution claims may not.
      if (segment.previewRequestId && segment.previewRequestId !== input.requestId) {
        delete segment.workPreview;
        delete segment.previewRequestId;
      }
      const sameOutput = (input.outputPreview && state?.outputPreview?.id === input.outputPreview.id)
        || (input.actor === 'intake' && input.textAudience === 'conversation' && state?.activity.actor === 'intake' && state.phase === 'saving');
      const carry = state?.projectId === input.projectId && state.sessionId === input.sessionId && sameOutput ? state.text : '';
      state = { ...input, phase: carry ? 'saving' : 'generating', carried: !!carry, calls: new Map(), plainText: '', text: carry || '', activity: {
        runId: input.runId, requestId: input.requestId, actor: input.actor ?? 'assistant', phase: 'waiting', startedAt: Date.now(), lastActivityAt: null,
        segmentStartedAt: segment.startedAt, requestOrdinal: segment.requests,
        ...(segment.workPreview ? { workPreview: segment.workPreview } : {}),
      } };
      this.#runs.set(input.runId, state);
    }
    const event = input.event;
    if (event === null) return;
    if (event.type === 'response_activity' && event.phase === 'headers' && state.activity.phase === 'waiting') state.activity.phase = 'connected';
    if ((event.type === 'response_activity' && (event.phase === 'content' || event.phase === 'reasoning')) || (event.type === 'text_delta' && event.delta.length > 0)
      || (event.type === 'tool_call_delta' && event.argumentsDelta.length > 0)) {
      state.activity.phase = 'receiving'; state.activity.lastActivityAt = Date.now();
      state.activity.receivedEvents = (state.activity.receivedEvents ?? 0) + 1;
      state.activity.lastEventKind = event.type === 'tool_call_delta' ? 'tool_arguments'
        : event.type === 'response_activity' && event.phase === 'reasoning' ? 'reasoning' : 'content';
    }
    if (event.type === 'text_delta' && (input.textAudience === 'conversation' || input.outputPreview)) {
      state.plainText = (state.plainText + event.delta).slice(0, 100_000);
      if (input.outputPreview && event.delta.length > 0) { state.carried = false; state.phase = 'generating'; }
      if (!state.carried) state.text = state.plainText;
      return;
    }
    if (event.type !== 'tool_call_delta') return;
    const call = state.calls.get(event.index) ?? { name: '', raw: '' };
    call.name = event.name ?? call.name;
    call.raw = (call.raw + event.argumentsDelta).slice(0, 1_000_000);
    state.calls.set(event.index, call);
    let text: string | null = null;
    // These fields are explicitly public operation summaries, not private
    // reasoning. A partial call is only being prepared, not executed or saved.
    const processField = call.name === 'director_decide' ? { key: 'reason', label: '下一步任务说明 · 整理中，尚未执行' }
      : call.name === 'assess_writing_readiness' ? { key: 'reason', label: '写作信息检查 · 整理中，尚未得出结论' }
      : call.name === 'search_fact_sources' ? { key: 'query', label: '正在准备检索词 · 待执行' } : null;
    if (processField) {
      const summary = topLevelString(call.raw, processField.key);
      if (summary) {
        const preview = { label: processField.label, text: summary.slice(0, 2400) };
        state.activity.workPreview = preview;
        const segment = this.#segments.get(input.runId);
        if (segment) { segment.workPreview = preview; segment.previewRequestId = input.requestId; }
      }
    }
    if ((call.name === 'respond_author' && input.actor !== 'fact_check') || call.name === 'respond_writing_intake') text = topLevelString(call.raw, 'reply');
    if (input.actor === 'research' && call.name === 'submit_writing_stage' && [null, 'research'].includes(topLevelString(call.raw, 'stage'))) {
      const content = topLevelString(call.raw, 'content');
      const contentStart = topLevelValueStart(call.raw, 'content');
      const readable = contentStart !== null && call.raw[contentStart] === '{'
        ? topLevelString(call.raw.slice(contentStart), 'notes')
        : content?.trimStart().startsWith('{') ? topLevelString(content, 'notes') : content;
      if (readable) {
        const preview = { label: '研究素材 · 整理中，尚非最终结论', text: readable.slice(0, 2400) };
        state.activity.workPreview = preview;
        const segment = this.#segments.get(input.runId);
        if (segment) segment.workPreview = preview;
      }
    }
    if (call.name === 'submit_fact_check') {
      // Only the quoted passage under review, never a provisional verdict or
      // evidence IDs. Keep it in the ephemeral area across request handoffs.
      const start = call.raw.lastIndexOf('"claimText"');
      const claim = start < 0 ? null : topLevelString(`{${call.raw.slice(start)}`, 'claimText');
      if (claim) {
        const preview = { label: '事实核查 · 处理中，尚未得出结论', text: `正在核对原文：${claim.slice(0, 500)}` };
        state.activity.workPreview = preview;
        const segment = this.#segments.get(input.runId);
        if (segment) segment.workPreview = preview;
      }
    }
    if (call.name === 'submit_writing_stage') {
      const stage = topLevelString(call.raw, 'stage');
      // The assigned stage is trusted application policy. JSON property order is
      // not a reason to buffer an already authorized public deliverable.
      if (input.outputPreview && stage !== null && !input.outputPreview.stage.startsWith(stage)) { state.text = ''; return; }
      if (input.outputPreview || isPublicStageOutput(stage)) text = topLevelString(call.raw, 'content');
    }
    if (text && !state.text.startsWith(text) && !(state.carried && text.length < state.text.length)) state.text = text.slice(0, 100_000);
  };
  get(projectId: string, sessionId: string, runId: string): LiveConversationReply | null {
    const state = this.#runs.get(runId);
    return state && state.projectId === projectId && state.sessionId === sessionId && state.text
      ? { runId, requestId: state.requestId, text: state.text, ...(state.outputPreview ? { ...state.outputPreview, phase: state.phase }
        : state.activity.actor === 'intake' ? { id: `live:intake:${runId}`, phase: state.phase }
        : isPublicStageOutput(state.activity.actor) ? { stage: state.activity.actor, phase: state.phase } : {}) } : null;
  }
  getActivity(projectId: string, sessionId: string, runId: string): LiveConversationActivity | null {
    const state = this.#runs.get(runId);
    return state && state.projectId === projectId && state.sessionId === sessionId ? { ...state.activity } : null;
  }
}
