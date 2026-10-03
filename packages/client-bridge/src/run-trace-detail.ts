import type { WritingApplicationService } from '../../application/src/index.js';
import type { RunTraceDetail } from './protocol.js';
import { explainRunFailure } from './run-failure-explanation.js';

const REDACTED = '[已隐藏敏感信息]';
const PRIVATE = '[不展示私有推理或服务商续传数据]';
const SECRET_KEY = /^(?:authorization|proxyAuthorization|api[-_]?key|access[-_]?token|refresh[-_]?token|secret|client[-_]?secret|password|credential(?:Reference)?|cookie|set-cookie|signature)$/iu;
const PRIVATE_KEY = /^(?:reasoning(?:_content)?|thinking|providerContinuation|encrypted_content|reasoning_details)$/iu;

function redactText(text: string): string {
  return text
    .replace(/<(think|thinking|analysis|reasoning)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/giu, PRIVATE)
    .replace(/\b(?:sk|tvly|sk-ant)-[\w-]{8,}/gu, REDACTED)
    .replace(/\bBearer\s+[A-Za-z\d._~+\/-]+=*/giu, `Bearer ${REDACTED}`)
    .replace(/((?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|authorization|credentialReference)\s*[=:]\s*["']?)[^\s"',;&}\]]+/giu, `$1${REDACTED}`)
    .replace(/https?:\/\/[^\s<>"']+/giu, value => {
      try {
        const url = new URL(value);
        if (url.username || url.password) { url.username = ''; url.password = ''; }
        for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key) || /token|signature|secret|key/iu.test(key)) url.searchParams.set(key, REDACTED);
        return url.toString();
      } catch { return value; }
    })
    .replace(/\b[A-Z]:[\\/][^\r\n"<>]+/giu, '[本机路径已隐藏]')
    .replace(/\/(?:Users|home)\/[^\s"<>]+/gu, '[本机路径已隐藏]');
}

/** Best-effort local display redaction; this is not an authorization to publish project content. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 40) return '[嵌套过深，未展开]';
  if (typeof value === 'string') {
    // Tool results often contain serialized JSON inside message.content.
    if (/^\s*[\[{]/u.test(value)) {
      try { return JSON.stringify(redact(JSON.parse(value), depth + 1), null, 2); } catch { /* ordinary text */ }
    }
    return redactText(value);
  }
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    SECRET_KEY.test(key) ? REDACTED : PRIVATE_KEY.test(key) ? PRIVATE : redact(item, depth + 1)]));
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function terminalErrorCode(payload: Readonly<Record<string, unknown>>): string | null {
  const error = object(payload.error);
  const result = object(payload.result);
  const nested = object(result?.error);
  for (const value of [error?.code, nested?.code, payload.code]) if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) return value;
  return null;
}

export function runTraceDetail(source: ReturnType<WritingApplicationService['getRunTraceSource']>): RunTraceDetail {
  const { step, events, snapshot } = source;
  const isModel = step.type === 'request.dispatch_attempted';
  const requestId = typeof step.payload.requestId === 'string' ? step.payload.requestId : null;
  const callId = typeof step.payload.callId === 'string' ? step.payload.callId : null;
  const terminal = events.findLast(event => event.operationId === step.operationId && event.type.startsWith(isModel ? 'request.' : 'tool.')
    && /\.(completed|failed|outcome_unknown)$/u.test(event.type));
  const sections: RunTraceDetail['sections'][number][] = [];
  const notes: string[] = ['仅展示本机已记录内容；常见密钥与私有推理已隐藏。输入可能包含你的文章和材料，请勿未经检查公开分享。'];
  const add = (id: 'input' | 'output' | 'schema', label: string, value: unknown, format: 'json' | 'text' = 'json') => {
    const clean = redact(value);
    const text = typeof clean === 'string' && format === 'text' ? clean : JSON.stringify(clean, null, 2) ?? '';
    sections.push({ id, label, format, text: text.slice(0, 64_000), totalCharacters: text.length, truncated: text.length > 64_000 });
  };
  if (isModel) {
    if (snapshot) {
      add('input', '实际发送的消息与参数', { model: snapshot.model, messages: snapshot.request.messages, parameters: snapshot.request.parameters,
        adapterVersion: snapshot.adapterVersion, assemblyVersion: snapshot.assemblyVersion, requestHash: snapshot.requestHash });
      add('schema', '当次请求可用工具定义', snapshot.toolSchemas);
    } else notes.push('历史请求快照未记录，无法还原实际输入与当时的工具定义。');
    if (terminal) {
      const returnedCallIds = Array.isArray(terminal.payload.toolCallIds) ? terminal.payload.toolCallIds : [];
      const calls = events.filter(event => event.type === 'tool.requested' && event.payload.requestId === requestId && requestId !== null
        && returnedCallIds.includes(event.payload.callId))
        .map(event => ({ callId: event.payload.callId, name: event.payload.toolName, arguments: event.payload.arguments }));
      add('output', '模型回复与实际工具调用', { status: terminal.type, reply: terminal.payload.responseText ?? null,
        finishReason: terminal.payload.finishReason ?? null, toolCalls: calls, error: terminal.payload.error ?? null, usage: terminal.payload.usage ?? null });
      if (typeof terminal.payload.responseText !== 'string') notes.push('本次事件未记录文本回复；没有文本不代表没有工具调用。');
    }
  } else {
    if (step.payload.arguments !== undefined) add('input', '实际工具参数', step.payload.arguments);
    else notes.push('历史工具参数未记录。');
    const schema = snapshot?.toolSchemas.find(tool => tool.name === step.payload.toolName);
    if (schema) add('schema', '当次调用的工具定义', schema);
    else notes.push('当次调用的工具定义未记录；不会用当前定义冒充历史定义。');
    const searchProgress = events.filter(event => event.type === 'search.progress' && event.operationId === step.operationId)
      .map(event => ({ at: event.occurredAt, message: event.payload.message }));
    if (searchProgress.length > 0) add('output', '搜索执行过程与实际结果', {
      progress: searchProgress, result: terminal ? terminal.payload.result ?? terminal.payload : null,
    });
    else if (terminal) add('output', '工具实际结果', terminal.payload.result ?? terminal.payload);
    if (step.payload.origin === 'harness_text_output') notes.push('此调用由程序将模型文本转换为保存操作，不是模型直接发起的工具调用。');
  }
  if (terminal && /\.(?:failed|outcome_unknown)$/u.test(terminal.type)) {
    const status = terminal.type.endsWith('.failed') ? 'failed' : 'outcome_unknown';
    const transport = object(terminal.payload.transport);
    const phase = transport?.phase === 'first_response' || transport?.phase === 'stream_idle' ? transport.phase : undefined;
    const explanation = explainRunFailure({ kind: isModel ? 'model' : step.payload.toolName === 'director_decide' || step.payload.toolName === 'delegate_author_expert' ? 'agent' : 'tool',
      status, technicalName: typeof step.payload.toolName === 'string' ? step.payload.toolName : undefined,
      errorCode: terminalErrorCode(terminal.payload), transportPhase: phase });
    notes.push(`${explanation.title}：${explanation.detail}`);
    notes.push(`处理建议：${explanation.remediation}`);
    notes.push(`技术代码：${terminalErrorCode(terminal.payload) ?? '未记录'}`);
  }
  if (!terminal) notes.push('尚未记录完成结果；运行中请等待，若已停止则保留为结果未记录。');
  if (sections.some(section => section.truncated)) notes.push('长内容仅展示前 64,000 字符；本机原始记录未被修改。');
  return { runId: step.runId, stepId: step.id, requestId, callId,
    provider: snapshot ? redactText(snapshot.provider) : null, model: snapshot ? redactText(snapshot.model) : null, sections, notes };
}
