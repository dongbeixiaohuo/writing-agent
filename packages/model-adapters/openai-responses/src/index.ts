import {
  ModelProviderBase, ModelProviderFailure, type JsonValue, type ModelCapabilities, type ModelRequest,
  type ProviderRequestSnapshot, type ProviderStreamEvent, type ProviderTokenUsage,
} from '../../../runtime/llm/src/index.js';
import { TransportDeadline } from '../../../runtime/llm/src/transport-deadline.js';
import {
  validateBaseURL, validateCredential, serializeMessages, invalidRequest, invalidResponse,
  mapHttpError, parseSse, sanitizeProviderErrorDetail, DEFAULT_MAX_OUTPUT_TOKENS, type OpenAICompatibleProviderOptions,
} from '../../openai-compatible/src/index.js';

const VERSION = 'openai-responses-v1';
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function serialize(request: ModelRequest, scope: string) {
  // Reuse the history validator, not the Chat Completions wire protocol.
  const messages = serializeMessages(request.messages);
  if (request.parameters.stop?.length) throw invalidRequest('Responses 不支持 stop 参数');
  const input: Record<string, unknown>[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content });
    else {
      const original = request.messages[index];
      const continuation = original?.role === 'assistant' ? original.toolCalls?.find(call => call.providerContinuation?.scope === scope)?.providerContinuation : undefined;
      if (continuation) input.push(...continuation.items.map(item => {
        if (!record(item) || item.type !== 'reasoning' || !nonempty(item.id) || !nonempty(item.encrypted_content)) throw invalidRequest('Responses 续接信息无效');
        return { type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary: [] };
      }));
      if (message.content) input.push({ role: message.role, content: message.content });
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return {
    model: request.model, input, stream: true, store: false, include: ['reasoning.encrypted_content'],
    ...(request.tools?.length ? { tools: request.tools.map(tool => ({ type: 'function', name: tool.name,
      description: tool.description, parameters: tool.inputSchema, strict: false })) } : {}),
    ...(request.parameters.maxOutputTokens === undefined ? { max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS } : { max_output_tokens: request.parameters.maxOutputTokens }),
    ...(request.parameters.toolChoice === undefined ? {} : { tool_choice: request.parameters.toolChoice }),
    // Responses uses model-default sampling: reasoning models can reject the runtime's temperature=0.
  };
}

function usage(value: unknown): ProviderTokenUsage {
  if (!record(value)) throw invalidResponse('Responses usage 格式无效');
  const count = (v: unknown): number => {
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw invalidResponse('Responses token 计数无效');
    return v as number;
  };
  return { inputTokens: count(value.input_tokens), outputTokens: count(value.output_tokens), totalTokens: count(value.total_tokens),
    cacheReadTokens: record(value.input_tokens_details) && value.input_tokens_details.cached_tokens !== undefined ? count(value.input_tokens_details.cached_tokens) : null,
    reasoningTokens: record(value.output_tokens_details) && value.output_tokens_details.reasoning_tokens !== undefined ? count(value.output_tokens_details.reasoning_tokens) : null };
}

export class OpenAIResponsesProvider extends ModelProviderBase {
  readonly maxRetries = 0;
  private readonly baseURL: string;
  private readonly firstTimeout: number;
  private readonly idleTimeout: number;

  constructor(private readonly options: OpenAICompatibleProviderOptions) {
    super(options.id, options.adapterVersion ?? VERSION, { protocol: 'openai-responses', streaming: 'supported', tools: 'unknown', usage: 'unknown' });
    this.baseURL = validateBaseURL(options.baseURL, options.allowInsecureHttp === true);
    this.firstTimeout = options.timeoutMs ?? 180_000;
    this.idleTimeout = options.streamIdleTimeoutMs ?? options.timeoutMs ?? 90_000;
    if (!options.id.trim() || !options.credentialRef.trim() || ![this.firstTimeout, this.idleTimeout].every(n => Number.isSafeInteger(n) && n > 0)) {
      throw new Error('Responses adapter 配置无效');
    }
  }

  override capabilitiesFor(model: string): ModelCapabilities {
    return { protocol: 'openai-responses', streaming: 'supported', tools: this.options.models[model]?.tools ?? 'unknown', usage: this.options.models[model]?.usage ?? 'unknown' };
  }

  override snapshotRequest(request: ModelRequest): ProviderRequestSnapshot {
    return { normalizedPayload: JSON.parse(JSON.stringify(this.wireBody(request))) as ProviderRequestSnapshot['normalizedPayload'],
      serializationVersion: VERSION, redactions: ['authorization'], unreconstructableFields: [],
      ...(request.parameters.maxOutputTokens === undefined ? {} : { outputTokenLimit: { value: request.parameters.maxOutputTokens, source: 'request' as const } }) };
  }

  private scope(model: string): string { return JSON.stringify([VERSION, this.id, this.baseURL, model]); }

  private wireBody(request: ModelRequest): Record<string, unknown> {
    const body = serialize(request, this.scope(request.model));
    const extraBody = this.options.extraBody;
    return extraBody === undefined ? body : { ...extraBody, ...body };
  }

  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    const deadline = new TransportDeadline(this.firstTimeout, this.idleTimeout, request.signal);
    let providerRequestId: string | undefined;
    try {
      let key: string | undefined;
      try { key = await this.options.resolveCredential(this.options.credentialRef); }
      catch { throw new ModelProviderFailure({ code: 'AUTH_FAILED', message: '无法读取模型凭据', retryable: false }); }
      const response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST', redirect: 'error', signal: deadline.signal,
        headers: { authorization: `Bearer ${validateCredential(key)}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(this.wireBody(request)),
      });
      providerRequestId = response.headers.get('x-request-id') ?? undefined;
      if (!response.ok) throw new ModelProviderFailure(await mapHttpError(response, false, key === undefined ? [] : [key]));
      if (!response.body) throw invalidResponse('Responses 响应体为空');
      yield { type: 'response_activity', phase: 'headers' };
      const calls = new Map<number, { id: string; itemId: string; name: string; arguments: string; done: boolean }>();
      const reasoning = new Map<number, JsonValue>();
      let hasText = false;
      let refusal = false;
      for await (const raw of parseSse(response.body, false)) {
        let e: unknown;
        try { e = JSON.parse(raw); } catch { throw invalidResponse('Responses SSE JSON 无效'); }
        if (!record(e) || !nonempty(e.type)) throw invalidResponse('Responses 事件格式无效');
        const type = e.type;
        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          if (typeof e.delta !== 'string') throw invalidResponse('Responses 文本增量无效');
          if (e.delta) {
            deadline.content(); yield { type: 'response_activity', phase: 'content' };
            if (type === 'response.refusal.delta') refusal = true;
            else { hasText = true; yield { type: 'text_delta', delta: e.delta }; }
          }
        } else if (type === 'response.output_item.added' && record(e.item) && e.item.type === 'function_call') {
          if (!Number.isSafeInteger(e.output_index) || (e.output_index as number) < 0 || !nonempty(e.item.call_id) || !nonempty(e.item.name) || !nonempty(e.item.id) || calls.has(e.output_index as number)) {
            throw invalidResponse('Responses 工具标识无效');
          }
          const args = e.item.arguments;
          if (typeof args !== 'string') throw invalidResponse('Responses 工具参数无效');
          const index = e.output_index as number;
          calls.set(index, { id: e.item.call_id, itemId: e.item.id, name: e.item.name, arguments: args, done: false });
          deadline.content(); yield { type: 'response_activity', phase: 'content' };
          yield { type: 'tool_call_delta', index, id: e.item.call_id, name: e.item.name, argumentsDelta: args };
        } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
          const index = e.output_index as number;
          const call = calls.get(index);
          if (!call || (e.item_id !== undefined && e.item_id !== call.itemId)) throw invalidResponse('Responses 工具参数缺少对应调用');
          if (type.endsWith('.delta')) {
            if (call.done || typeof e.delta !== 'string') throw invalidResponse('Responses 工具增量顺序无效');
            call.arguments += e.delta;
            if (e.delta) { deadline.content(); yield { type: 'response_activity', phase: 'content' }; }
            yield { type: 'tool_call_delta', index, argumentsDelta: e.delta };
          } else {
            if (typeof e.arguments !== 'string' || e.arguments !== call.arguments) throw invalidResponse('Responses 工具完整参数与增量不一致');
            call.done = true;
          }
        } else if (type === 'response.output_item.done' && record(e.item) && e.item.type === 'reasoning') {
          if (!nonempty(e.item.id) || !nonempty(e.item.encrypted_content) || !Number.isSafeInteger(e.output_index)) throw invalidResponse('Responses 缺少可续接的加密推理信息');
          reasoning.set(e.output_index as number, { type: 'reasoning', id: e.item.id, encrypted_content: e.item.encrypted_content, summary: [] });
        } else if (type === 'response.output_item.done' && record(e.item) && e.item.type === 'function_call') {
          const call = calls.get(e.output_index as number);
          if (!call || call.id !== e.item.call_id || call.name !== e.item.name || call.arguments !== e.item.arguments) throw invalidResponse('Responses 完成工具与增量不一致');
          call.done = true;
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          if (!record(e.response)) throw invalidResponse('Responses 结束事件无效');
          if (e.response.usage != null) yield { type: 'usage', usage: usage(e.response.usage) };
          if (type === 'response.incomplete') {
            const reason = record(e.response.incomplete_details) ? e.response.incomplete_details.reason : undefined;
            if (reason !== 'max_output_tokens' && reason !== 'content_filter') throw invalidResponse('Responses 未完整完成');
            yield { type: 'completed', finishReason: reason === 'max_output_tokens' ? 'max_tokens' : 'content_filter' }; return;
          }
          if (e.response.status !== 'completed' || [...calls.values()].some(call => !call.done) || (!hasText && calls.size === 0 && !refusal)) throw invalidResponse('Responses 缺少完整结果');
          yield { type: 'completed', finishReason: refusal ? 'content_filter' : calls.size ? 'tool_calls' : 'stop',
            ...(reasoning.size ? { toolContinuation: { scope: this.scope(request.model), items: [...reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item) } } : {}),
            ...(providerRequestId ? { providerRequestId } : {}) }; return;
        } else if (type === 'response.failed' || type === 'error') {
          const detail = record(e.response) && record(e.response.error) ? e.response.error : e;
          const code = detail.code;
          const providerDetail = sanitizeProviderErrorDetail(detail.message, key === undefined ? [] : [key]);
          // Map only stable codes; never expose raw provider error bodies.
          throw new ModelProviderFailure({ code: code === 'rate_limit_exceeded' ? 'RATE_LIMITED' : code === 'server_error' ? 'PROVIDER_UNAVAILABLE' : 'MODEL_RESPONSE_INVALID',
            message: '模型服务未完成本次 Responses 请求', retryable: code === 'rate_limit_exceeded' || code === 'server_error',
            ...(providerDetail === undefined ? {} : { providerDetail }) });
        } else if (type.startsWith('response.reasoning') && typeof e.delta === 'string' && e.delta.length > 0) {
          // Activity only. Internal reasoning is not article text or a user-visible answer.
          deadline.content(); yield { type: 'response_activity', phase: 'content' };
        } else if (!['response.created', 'response.queued', 'response.in_progress', 'response.output_item.added', 'response.output_item.done',
          'response.content_part.added', 'response.content_part.done', 'response.output_text.done', 'response.output_text.annotation.added', 'response.refusal.done'].includes(type) && !type.startsWith('response.reasoning')) {
          throw invalidResponse('Responses 返回了未支持的事件');
        }
      }
      throw invalidResponse('Responses 流缺少完成事件');
    } catch (error) {
      if (request.signal?.aborted) throw new ModelProviderFailure({ code: 'ABORTED', message: '模型请求已取消', retryable: false });
      const timeout = deadline.error(providerRequestId);
      if (timeout) throw new ModelProviderFailure(timeout);
      if (error instanceof ModelProviderFailure) throw new ModelProviderFailure({ ...error.failure, ...(providerRequestId ? { providerRequestId } : {}) });
      throw new ModelProviderFailure({ code: 'NETWORK_ERROR', message: '无法连接模型服务', retryable: true });
    } finally { deadline.dispose(); }
  }
}
