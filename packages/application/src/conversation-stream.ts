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

/** Read one JSON string without exposing nested metadata or unfinished escape syntax. */
export function topLevelString(source: string, key: string): string | null {
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
        return source[next] === '"' ? stringAt(source, next).value : null;
      }
      i = token.end - 1;
    }
  }
  return null;
}

export interface LiveConversationReply { runId: string; requestId: string; text: string; id?: string; stage?: string; phase?: 'generating' | 'saving' }
export interface LiveConversationActivity {
  runId: string; requestId: string; actor: string; phase: 'waiting' | 'connected' | 'receiving';
  startedAt: number; lastActivityAt: number | null;
  segmentStartedAt: number; requestOrdinal: number;
  workPreview?: { label: string; text: string };
}
type StreamInput = Parameters<NonNullable<AgentRuntimeOptions['onModelStream']>>[0];

/** Ephemeral preview only: never a committed reply, tool result, or publication authority. */
export class ConversationStreamPreview {
  readonly #segments = new Map<string, { projectId: string; sessionId: string; startedAt: number; requests: number; workPreview?: { label: string; text: string } }>();
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
    if ((event.type === 'response_activity' && event.phase === 'content') || (event.type === 'text_delta' && event.delta.length > 0)
      || (event.type === 'tool_call_delta' && event.argumentsDelta.length > 0)) {
      state.activity.phase = 'receiving'; state.activity.lastActivityAt = Date.now();
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
    if ((call.name === 'respond_author' && input.actor !== 'fact_check') || call.name === 'respond_writing_intake') text = topLevelString(call.raw, 'reply');
    if (input.actor === 'research' && call.name === 'submit_writing_stage' && [null, 'research'].includes(topLevelString(call.raw, 'stage'))) {
      const content = topLevelString(call.raw, 'content');
      const readable = content?.trimStart().startsWith('{') ? topLevelString(content, 'notes') : content;
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
