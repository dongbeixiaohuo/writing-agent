import {
  ModelProviderBase,
  ModelProviderFailure,
  type CapabilitySupport,
  type JsonValue,
  type ModelCapabilities,
  type ModelError,
  type ModelMessage,
  type ModelRequest,
  type ProviderRequestSnapshot,
  type ProviderStreamEvent,
  type ProviderTokenUsage,
} from "../../../runtime/llm/src/index.js";
import { TransportDeadline } from "../../../runtime/llm/src/transport-deadline.js";
import { interruptedStream, sanitizeProviderErrorDetail, DEFAULT_MAX_OUTPUT_TOKENS } from "../../openai-compatible/src/index.js";

export interface AnthropicCompatibleModelCapabilities {
  readonly tools: CapabilitySupport;
  readonly usage: "reported" | "unknown";
}

export interface AnthropicCompatibleProviderOptions {
  readonly id: string;
  readonly baseURL: string;
  readonly credentialRef: string;
  readonly resolveCredential: (
    credentialRef: string,
  ) => Promise<string | undefined>;
  readonly models: Readonly<
    Record<string, AnthropicCompatibleModelCapabilities>
  >;
  readonly adapterVersion?: string;
  readonly timeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly defaultMaxOutputTokens?: number;
  readonly anthropicVersion?: string;
  readonly authHeader?: "x-api-key" | "authorization";
  readonly allowInsecureHttp?: boolean;
  // Vendor-specific extra request fields (e.g. DeepSeek's thinking toggle).
  // Added to the request body before protocol fields, so these can never
  // override model/messages/stream/tools or other adapter-owned keys.
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

type WireContentBlock =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string;
    };

interface WireMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly WireContentBlock[];
}

interface WireRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly system?: string;
  readonly messages: readonly WireMessage[];
  readonly stream: true;
  readonly tools?: readonly {
    readonly name: string;
    readonly description: string;
    readonly input_schema: Readonly<Record<string, unknown>>;
  }[];
  readonly temperature?: number;
  readonly stop_sequences?: readonly string[];
  readonly tool_choice?:
    | { readonly type: "auto" }
    | { readonly type: "any" }
    | { readonly type: "none" };
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

interface StreamBlock {
  readonly type: "text" | "tool_use" | "thinking";
  argumentsMode: "none" | "start" | "delta";
  stopped: boolean;
}

const ADAPTER_VERSION = "anthropic-messages-v1";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerFailure(error: ModelError): ModelProviderFailure {
  return new ModelProviderFailure(error);
}

function invalidRequest(message: string): ModelProviderFailure {
  return providerFailure({
    code: "INVALID_REQUEST",
    message,
    retryable: false,
  });
}

function invalidResponse(
  message: string,
  providerRequestId?: string,
): ModelProviderFailure {
  return providerFailure({
    code: "MODEL_RESPONSE_INVALID",
    message,
    retryable: false,
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  });
}

function validateBaseURL(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Anthropic-compatible baseURL 必须是有效 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Anthropic-compatible baseURL 只允许 http 或 https");
  }
  if (url.protocol === "http:" && !allowInsecureHttp) {
    throw new Error("非 HTTPS endpoint 必须显式启用 allowInsecureHttp");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("baseURL 不得包含凭据、查询参数或片段");
  }
  return url.toString().replace(/\/$/u, "");
}

function validateCredential(raw: string | undefined): string {
  const value = raw?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw providerFailure({
      code: "AUTH_FAILED",
      message: "模型凭据缺失或格式无效",
      retryable: false,
    });
  }
  return value;
}

function parseToolInput(raw: string): Readonly<Record<string, JsonValue>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidRequest("assistant 历史包含无效工具参数 JSON");
  }
  if (!isRecord(parsed)) {
    throw invalidRequest("assistant 历史工具参数必须是 JSON object");
  }
  return parsed as Readonly<Record<string, JsonValue>>;
}

function serializeMessages(messages: readonly ModelMessage[]): {
  readonly system?: string;
  readonly messages: readonly WireMessage[];
} {
  const system: string[] = [];
  const result: WireMessage[] = [];
  const awaitingResults = new Map<string, string>();
  let pendingResults: WireContentBlock[] = [];
  let conversationStarted = false;

  const flushResults = (): void => {
    if (pendingResults.length === 0) return;
    result.push({ role: "user", content: pendingResults });
    pendingResults = [];
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (conversationStarted || pendingResults.length > 0) {
        throw invalidRequest("system 消息只能出现在 Anthropic 对话开头");
      }
      if (message.content.length > 0) system.push(message.content);
      continue;
    }
    conversationStarted = true;

    if (message.role === "tool") {
      const expectedName = awaitingResults.get(message.toolCallId);
      if (expectedName === undefined || expectedName !== message.name) {
        throw invalidRequest("tool result 与 assistant tool use 不匹配");
      }
      awaitingResults.delete(message.toolCallId);
      pendingResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
      });
      continue;
    }

    flushResults();
    if (awaitingResults.size > 0) {
      throw invalidRequest("上一组工具调用仍缺少结果");
    }
    if (message.role === "user") {
      result.push({ role: "user", content: message.content });
      continue;
    }
    if (message.role !== "assistant") {
      throw invalidRequest("Anthropic 对话包含不支持的消息角色");
    }

    const blocks: WireContentBlock[] = [];
    if (message.content.length > 0) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of message.toolCalls ?? []) {
      if (
        call.id.length === 0 ||
        call.name.length === 0 ||
        awaitingResults.has(call.id)
      ) {
        throw invalidRequest("assistant 工具调用 id 或名称无效");
      }
      const input = parseToolInput(call.rawArguments);
      awaitingResults.set(call.id, call.name);
      blocks.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input,
      });
    }
    result.push({
      role: "assistant",
      content: blocks.length === 0 ? message.content : blocks,
    });
  }

  flushResults();
  if (awaitingResults.size > 0) {
    throw invalidRequest("模型请求缺少一个或多个工具调用结果");
  }
  if (result.length === 0) throw invalidRequest("模型请求缺少对话消息");
  return {
    ...(system.length === 0 ? {} : { system: system.join("\n\n") }),
    messages: result,
  };
}

function serializeRequest(
  request: ModelRequest,
  defaultMaxOutputTokens: number,
): WireRequest {
  const serialized = serializeMessages(request.messages);
  const maxTokens = request.parameters.maxOutputTokens ?? defaultMaxOutputTokens;
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw invalidRequest("Anthropic maxOutputTokens 必须是正整数");
  }
  if (
    request.parameters.toolChoice === "required" &&
    (request.tools?.length ?? 0) === 0
  ) {
    throw invalidRequest("required tool choice 必须提供至少一个工具");
  }
  const toolChoice =
    request.parameters.toolChoice === undefined
      ? undefined
      : request.parameters.toolChoice === "required"
        ? ({ type: "any" } as const)
        : ({ type: request.parameters.toolChoice } as const);
  return {
    model: request.model,
    max_tokens: maxTokens,
    ...serialized,
    stream: true,
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: { ...tool.inputSchema },
          })),
        }),
    ...(request.parameters.temperature === undefined
      ? {}
      : { temperature: request.parameters.temperature }),
    ...(request.parameters.stop === undefined
      ? {}
      : { stop_sequences: [...request.parameters.stop] }),
    ...(toolChoice === undefined ? {} : { tool_choice: toolChoice }),
  };
}

function nextSseLine(
  buffer: string,
  final: boolean,
): { readonly line: string; readonly rest: string } | undefined {
  const match = /\r\n|\r|\n/u.exec(buffer);
  if (match === null) return undefined;
  if (!final && match[0] === "\r" && match.index === buffer.length - 1) {
    return undefined;
  }
  return {
    line: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];

  const dispatch = (): SseEvent | undefined => {
    if (data.length === 0) {
      event = "message";
      return undefined;
    }
    const result = { event, data: data.join("\n") };
    event = "message";
    data = [];
    return result;
  };
  const acceptLine = (line: string): SseEvent | undefined => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    return undefined;
  };

  try {
    while (true) {
      const read = await reader.read();
      buffer += decoder.decode(read.value, { stream: !read.done });
      let line = nextSseLine(buffer, read.done);
      while (line !== undefined) {
        buffer = line.rest;
        const parsed = acceptLine(line.line);
        if (parsed !== undefined) yield parsed;
        line = nextSseLine(buffer, read.done);
      }
      if (read.done) break;
    }
    if (buffer.length > 0) acceptLine(buffer);
    const final = dispatch();
    if (final !== undefined) yield final;
  } finally {
    reader.releaseLock();
  }
}

function requiredTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(`模型 usage.${field} 无效`);
  }
  return value as number;
}

function optionalTokenCount(value: unknown, field: string): number {
  if (value === undefined) return 0;
  return requiredTokenCount(value, field);
}

function finalUsage(
  startUsage: Record<string, unknown>,
  deltaUsage: Record<string, unknown>,
): ProviderTokenUsage {
  const uncachedInput = requiredTokenCount(
    startUsage.input_tokens,
    "input_tokens",
  );
  const cacheCreation = optionalTokenCount(
    startUsage.cache_creation_input_tokens,
    "cache_creation_input_tokens",
  );
  const cacheRead = optionalTokenCount(
    startUsage.cache_read_input_tokens,
    "cache_read_input_tokens",
  );
  const output = requiredTokenCount(deltaUsage.output_tokens, "output_tokens");
  return {
    inputTokens: uncachedInput + cacheCreation,
    outputTokens: output,
    totalTokens: uncachedInput + cacheCreation + cacheRead + output,
    cacheReadTokens: cacheRead,
    reasoningTokens: null,
  };
}

function mapFinishReason(
  value: unknown,
): "stop" | "max_tokens" | "tool_calls" | "content_filter" {
  switch (value) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "content_filter";
    default:
      throw invalidResponse("模型返回了未知结束原因");
  }
}

async function readLimitedErrorBody(response: Response): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytes = 0;
  try {
    while (bytes < MAX_ERROR_BODY_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      result += decoder.decode(chunk.value, { stream: true });
      if (bytes >= MAX_ERROR_BODY_BYTES) {
        await reader.cancel();
        break;
      }
    }
    result += decoder.decode();
    return result.slice(0, MAX_ERROR_BODY_BYTES);
  } finally {
    reader.releaseLock();
  }
}

function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  if (/^\d+(?:\.\d+)?$/u.test(value)) {
    const milliseconds = Number(value) * 1_000;
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? milliseconds
      : undefined;
  }
  const milliseconds = Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? milliseconds
    : undefined;
}

function responseFacts(response: Response): {
  readonly status: number;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
} {
  const retry = retryAfterMs(response.headers);
  const requestId = response.headers.get("request-id") ?? undefined;
  return {
    status: response.status,
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
    ...(requestId === undefined || requestId.length === 0
      ? {}
      : { providerRequestId: requestId }),
  };
}

async function mapHttpError(response: Response, redact: readonly string[] = []): Promise<ModelError> {
  const rawBody = await readLimitedErrorBody(response);
  let type = "";
  let message = "";
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.type === "string") type = parsed.error.type;
      if (typeof parsed.error.message === "string") message = parsed.error.message;
    }
  } catch {
    // HTTP status remains authoritative for malformed gateway responses.
  }
  const detail = `${type} ${message}`.toLowerCase();
  const upstreamMessage = sanitizeProviderErrorDetail(message, redact);
  const facts = {
    ...responseFacts(response),
    ...(upstreamMessage === undefined ? {} : { providerDetail: upstreamMessage }),
  };
  if (response.status === 401 || response.status === 403) {
    return {
      code: "AUTH_FAILED",
      message: "模型服务拒绝了凭据或权限",
      retryable: false,
      ...facts,
    };
  }
  if (/billing|credit|quota|spend[_ -]?limit/u.test(detail)) {
    return {
      code: "QUOTA_EXCEEDED",
      message: "模型账户额度不足",
      retryable: false,
      ...facts,
    };
  }
  if (response.status === 429) {
    return {
      code: "RATE_LIMITED",
      message: "模型服务正在限流",
      retryable: true,
      ...facts,
    };
  }
  const modelUnavailable =
    /unknown[_ -]?model|model[_ -]?(?:not[_ -]?found|unsupported)|model\b.{0,80}\b(?:not found|does not exist|unavailable|not available)|(?:not found|does not exist|unavailable)\b.{0,80}\bmodel/u.test(
      detail,
    );
  if (modelUnavailable) {
    return {
      code: "MODEL_UNSUPPORTED",
      message: "模型标识不存在或当前账户不可用",
      retryable: false,
      ...facts,
    };
  }
  if (response.status === 404) {
    return {
      code: "INVALID_REQUEST",
      message: "模型服务 API 路径不存在",
      retryable: false,
      ...facts,
    };
  }
  if (response.status === 408) {
    return {
      code: "TIMEOUT",
      message: "模型服务响应超时",
      retryable: true,
      ...facts,
    };
  }
  if (response.status >= 500) {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "模型服务暂时不可用",
      retryable: true,
      ...facts,
    };
  }
  if (response.status === 400 || response.status === 413 || response.status === 422) {
    return {
      code: "INVALID_REQUEST",
      message: "模型服务拒绝了请求参数",
      retryable: false,
      ...facts,
    };
  }
  return {
    code: "UNKNOWN_PROVIDER_ERROR",
    message: "模型服务返回了未分类错误",
    retryable: false,
    ...facts,
  };
}

function embeddedStreamError(value: Record<string, unknown>, redact: readonly string[] = []): ModelError {
  const error = isRecord(value.error) ? value.error : {};
  const type = typeof error.type === "string" ? error.type : "";
  const providerDetail = sanitizeProviderErrorDetail(error.message, redact);
  const detailField = providerDetail === undefined ? {} : { providerDetail };
  if (type === "overloaded_error" || type === "api_error") {
    return {
      code: "PROVIDER_UNAVAILABLE",
      message: "模型服务在流中报告暂时不可用",
      retryable: true,
      ...detailField,
    };
  }
  if (type === "rate_limit_error") {
    return {
      code: "RATE_LIMITED",
      message: "模型服务在流中报告限流",
      retryable: true,
      ...detailField,
    };
  }
  return {
    code: "MODEL_RESPONSE_INVALID",
    message: "模型服务在流中报告错误",
    retryable: false,
    ...detailField,
  };
}

export class AnthropicCompatibleProvider extends ModelProviderBase {
  readonly maxRetries = 0;

  private readonly baseURL: string;
  private readonly credentialRef: string;
  private readonly resolveCredential: AnthropicCompatibleProviderOptions["resolveCredential"];
  private readonly models: AnthropicCompatibleProviderOptions["models"];
  private readonly firstResponseTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly defaultMaxOutputTokens: number | undefined;
  private readonly anthropicVersion: string;
  private readonly authHeader: "x-api-key" | "authorization";
  private readonly extraBody: AnthropicCompatibleProviderOptions["extraBody"];

  constructor(options: AnthropicCompatibleProviderOptions) {
    if (options.id.trim().length === 0) throw new Error("provider id 不能为空");
    if (options.credentialRef.trim().length === 0) {
      throw new Error("credentialRef 不能为空");
    }
    const firstResponseTimeoutMs = options.timeoutMs ?? 180_000;
    const streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? options.timeoutMs ?? 90_000;
    if (!Number.isSafeInteger(firstResponseTimeoutMs) || firstResponseTimeoutMs <= 0) {
      throw new Error("timeoutMs 必须是正整数");
    }
    if (!Number.isSafeInteger(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0) {
      throw new Error("streamIdleTimeoutMs 必须是正整数");
    }
    const defaultMaxOutputTokens = options.defaultMaxOutputTokens;
    if (
      defaultMaxOutputTokens !== undefined &&
      (!Number.isSafeInteger(defaultMaxOutputTokens) || defaultMaxOutputTokens <= 0)
    ) {
      throw new Error("defaultMaxOutputTokens 必须是正整数");
    }
    const anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(anthropicVersion)) {
      throw new Error("anthropicVersion 必须是 YYYY-MM-DD");
    }
    super(options.id, options.adapterVersion ?? ADAPTER_VERSION, {
      protocol: "anthropic-messages",
      streaming: "supported",
      tools: "unknown",
      usage: "unknown",
    });
    this.baseURL = validateBaseURL(
      options.baseURL,
      options.allowInsecureHttp === true,
    );
    this.credentialRef = options.credentialRef;
    this.resolveCredential = options.resolveCredential;
    this.models = { ...options.models };
    this.firstResponseTimeoutMs = firstResponseTimeoutMs;
    this.streamIdleTimeoutMs = streamIdleTimeoutMs;
    this.defaultMaxOutputTokens = defaultMaxOutputTokens;
    this.anthropicVersion = anthropicVersion;
    this.authHeader = options.authHeader ?? "x-api-key";
    this.extraBody = options.extraBody;
  }

  override capabilitiesFor(model: string): ModelCapabilities {
    const known = this.models[model];
    return {
      protocol: "anthropic-messages",
      streaming: "supported",
      tools: known?.tools ?? "unknown",
      usage: known?.usage ?? "unknown",
    };
  }

  override snapshotRequest(request: ModelRequest): ProviderRequestSnapshot {
    const outputTokenLimit = this.outputTokenLimit(request);
    return {
      normalizedPayload: JSON.parse(
        JSON.stringify(this.wireBody(request, outputTokenLimit.value)),
      ) as ProviderRequestSnapshot["normalizedPayload"],
      serializationVersion: this.adapterVersion,
      redactions: [this.authHeader],
      unreconstructableFields: [this.authHeader],
      outputTokenLimit,
    };
  }

  private wireBody(request: ModelRequest, outputTokenLimit: number): WireRequest {
    const body = serializeRequest(request, outputTokenLimit);
    return this.extraBody === undefined ? body : { ...this.extraBody, ...body } as WireRequest;
  }

  private outputTokenLimit(request: ModelRequest): NonNullable<ProviderRequestSnapshot["outputTokenLimit"]> {
    if (request.parameters.maxOutputTokens !== undefined) return { value: request.parameters.maxOutputTokens, source: "request" };
    if (this.defaultMaxOutputTokens !== undefined) return { value: this.defaultMaxOutputTokens, source: "configuration" };
    // Verified 2026-09-21: MiniMax Messages API recommends 128K for M3,
    // 64K for the supported M2 family (max 512K / 200K respectively).
    // https://platform.minimax.io/docs/api-reference/text-chat-anthropic
    if (request.model === "MiniMax-M3") return { value: 131_072, source: "model_default" };
    if (["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5", "MiniMax-M2.5-highspeed", "MiniMax-M2.1", "MiniMax-M2.1-highspeed", "MiniMax-M2"].includes(request.model)) {
      return { value: 65_536, source: "model_default" };
    }
    // Current Claude limits; do not infer capabilities for unknown aliases or older models.
    // https://platform.claude.com/docs/en/models/overview
    if (["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-6", "claude-sonnet-4-6"].includes(request.model)) {
      return { value: 131_072, source: "model_default" };
    }
    if (["claude-haiku-4-5", "claude-haiku-4-5-20251001"].includes(request.model)) {
      return { value: 65_536, source: "model_default" };
    }
    // Unknown models get the shared modern floor instead of the legacy 4096:
    // omitting or under-sizing this truncated full-article stages outright.
    return { value: DEFAULT_MAX_OUTPUT_TOKENS, source: "adapter_default" };
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    const deadline = new TransportDeadline(
      this.firstResponseTimeoutMs,
      this.streamIdleTimeoutMs,
      request.signal,
    );
    let providerRequestId: string | undefined;

    try {
      let rawCredential: string | undefined;
      try {
        rawCredential = await this.resolveCredential(this.credentialRef);
      } catch {
        throw providerFailure({
          code: "AUTH_FAILED",
          message: "无法读取模型凭据",
          retryable: false,
        });
      }
      const credential = validateCredential(rawCredential);
      const body = this.wireBody(request, this.outputTokenLimit(request).value);
      let encoded: string;
      try {
        encoded = JSON.stringify(body);
      } catch {
        throw invalidRequest("模型请求无法序列化为 JSON");
      }
      const authorization =
        this.authHeader === "authorization"
          ? { authorization: `Bearer ${credential}` }
          : { "x-api-key": credential };
      const response = await fetch(`${this.baseURL}/messages`, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "text/event-stream",
          "anthropic-version": this.anthropicVersion,
          "content-type": "application/json",
          "x-writing-agent-adapter-version": this.adapterVersion,
          ...authorization,
        },
        body: encoded,
        signal: deadline.signal,
      });
      if (!response.ok) throw providerFailure(await mapHttpError(response, [credential]));
      if (response.body === null) {
        throw invalidResponse(
          "模型服务返回了空响应体",
          response.headers.get("request-id") ?? undefined,
        );
      }

      providerRequestId = response.headers.get("request-id") ?? undefined;
      yield { type: "response_activity", phase: "headers" };
      const blocks = new Map<number, StreamBlock>();
      let startUsage: Record<string, unknown> | undefined;
      let finishReason:
        | "stop"
        | "max_tokens"
        | "tool_calls"
        | "content_filter"
        | undefined;
      let sawMessageStop = false;
      let sawMessageStart = false;
      let sawUsage = false;

      for await (const payload of parseSse(response.body)) {
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload.data) as unknown;
        } catch {
          throw invalidResponse("SSE data 包含无效 JSON", providerRequestId);
        }
        if (!isRecord(chunk) || typeof chunk.type !== "string") {
          throw invalidResponse("模型 stream event 结构无效", providerRequestId);
        }
        if (payload.event !== "message" && payload.event !== chunk.type) {
          throw invalidResponse("SSE event 名称与 data.type 不一致", providerRequestId);
        }

        switch (chunk.type) {
          case "ping":
            break;
          case "error":
            yield { type: "error", error: embeddedStreamError(chunk, [credential]) };
            return;
          case "message_start": {
            if (!isRecord(chunk.message)) {
              throw invalidResponse("message_start 结构无效", providerRequestId);
            }
            if (sawMessageStart || typeof chunk.message.id !== "string" || chunk.message.id.length === 0) {
              throw invalidResponse("message_start 缺少稳定的 message id 或出现重复", providerRequestId);
            }
            sawMessageStart = true;
            if (chunk.message.usage !== undefined) {
              if (!isRecord(chunk.message.usage)) {
                throw invalidResponse("message_start usage 无效", providerRequestId);
              }
              startUsage = chunk.message.usage;
            }
            break;
          }
          case "content_block_start": {
            if (
              !Number.isSafeInteger(chunk.index) ||
              (chunk.index as number) < 0 ||
              !isRecord(chunk.content_block)
            ) {
              throw invalidResponse("content_block_start 结构无效", providerRequestId);
            }
            const index = chunk.index as number;
            if (blocks.has(index)) {
              throw invalidResponse("content block index 重复", providerRequestId);
            }
            if (chunk.content_block.type === "text") {
              const text = chunk.content_block.text;
              if (typeof text !== "string") {
                throw invalidResponse("text content block 无效", providerRequestId);
              }
              blocks.set(index, { type: "text", argumentsMode: "none", stopped: false });
              if (text.length > 0) {
                deadline.content();
                yield { type: "response_activity", phase: "content" };
                yield { type: "text_delta", delta: text };
              }
              break;
            }
            if (chunk.content_block.type === "thinking") {
              blocks.set(index, { type: "thinking", argumentsMode: "none", stopped: false });
              const thinking = chunk.content_block.thinking;
              if (typeof thinking === "string" && thinking.length > 0) {
                deadline.content();
                yield { type: "response_activity", phase: "reasoning" };
              }
              break;
            }
            if (chunk.content_block.type === "tool_use") {
              const id = chunk.content_block.id;
              const name = chunk.content_block.name;
              if (
                typeof id !== "string" ||
                id.length === 0 ||
                typeof name !== "string" ||
                name.length === 0
              ) {
                throw invalidResponse("tool_use content block 无效", providerRequestId);
              }
              const input = chunk.content_block.input;
              if (!isRecord(input)) {
                throw invalidResponse("tool_use input 无效", providerRequestId);
              }
              const serializedInput =
                Object.keys(input).length === 0 ? "" : JSON.stringify(input);
              blocks.set(index, {
                type: "tool_use",
                argumentsMode: serializedInput.length === 0 ? "none" : "start",
                stopped: false,
              });
              deadline.content();
              yield { type: "response_activity", phase: "content" };
              yield {
                type: "tool_call_delta",
                index,
                id,
                name,
                argumentsDelta: serializedInput,
              };
              break;
            }
            throw invalidResponse("不支持的 content block 类型", providerRequestId);
          }
          case "content_block_delta": {
            if (
              !Number.isSafeInteger(chunk.index) ||
              (chunk.index as number) < 0 ||
              !isRecord(chunk.delta)
            ) {
              throw invalidResponse("content_block_delta 结构无效", providerRequestId);
            }
            const index = chunk.index as number;
            const block = blocks.get(index);
            if (block === undefined || block.stopped) {
              throw invalidResponse("content block delta 缺少 start", providerRequestId);
            }
            if (chunk.delta.type === "text_delta" && block.type === "text") {
              if (typeof chunk.delta.text !== "string") {
                throw invalidResponse("text delta 无效", providerRequestId);
              }
              if (chunk.delta.text.length > 0) {
                deadline.content();
                yield { type: "response_activity", phase: "content" };
                yield { type: "text_delta", delta: chunk.delta.text };
              }
              break;
            }
            if (
              chunk.delta.type === "input_json_delta" &&
              block.type === "tool_use"
            ) {
              if (typeof chunk.delta.partial_json !== "string") {
                throw invalidResponse("tool input JSON delta 无效", providerRequestId);
              }
              if (block.argumentsMode === "start") {
                throw invalidResponse(
                  "tool input 同时出现在 start 和 delta",
                  providerRequestId,
                );
              }
              block.argumentsMode = "delta";
              if (chunk.delta.partial_json.length > 0) {
                deadline.content();
                yield { type: "response_activity", phase: "content" };
              }
              yield {
                type: "tool_call_delta",
                index,
                argumentsDelta: chunk.delta.partial_json,
              };
              break;
            }
            if (chunk.delta.type === "thinking_delta" && block.type === "thinking") {
              if (typeof chunk.delta.thinking !== "string") {
                throw invalidResponse("thinking delta 无效", providerRequestId);
              }
              if (chunk.delta.thinking.length > 0) {
                deadline.content();
                yield { type: "response_activity", phase: "reasoning" };
              }
              break;
            }
            if (chunk.delta.type === "signature_delta" && block.type === "thinking") {
              break;
            }
            throw invalidResponse("content block delta 类型不匹配", providerRequestId);
          }
          case "content_block_stop": {
            if (
              !Number.isSafeInteger(chunk.index) ||
              (chunk.index as number) < 0
            ) {
              throw invalidResponse("content_block_stop 结构无效", providerRequestId);
            }
            const index = chunk.index as number;
            const block = blocks.get(index);
            if (block === undefined || block.stopped) {
              throw invalidResponse("content block stop 缺少 start", providerRequestId);
            }
            if (block.type === "tool_use" && block.argumentsMode === "none") {
              yield { type: "tool_call_delta", index, argumentsDelta: "{}" };
            }
            block.stopped = true;
            break;
          }
          case "message_delta": {
            if (!isRecord(chunk.delta)) {
              throw invalidResponse("message_delta 结构无效", providerRequestId);
            }
            if ([...blocks.values()].some((block) => !block.stopped)) {
              throw invalidResponse("message_delta 前存在未结束的 content block", providerRequestId);
            }
            finishReason = mapFinishReason(chunk.delta.stop_reason);
            if (chunk.usage !== undefined || startUsage !== undefined) {
              if (!isRecord(chunk.usage) || startUsage === undefined) {
                throw invalidResponse("message_delta usage 不完整", providerRequestId);
              }
              if (sawUsage) {
                throw invalidResponse("模型 stream 返回重复 usage", providerRequestId);
              }
              sawUsage = true;
              yield { type: "usage", usage: finalUsage(startUsage, chunk.usage) };
            }
            break;
          }
          case "message_stop":
            if (!sawMessageStart || [...blocks.values()].some((block) => !block.stopped)) {
              throw invalidResponse("message_stop 时响应结构仍不完整", providerRequestId);
            }
            sawMessageStop = true;
            break;
          default:
            throw invalidResponse("模型返回了未知 stream event", providerRequestId);
        }
      }

      if (!sawMessageStop) throw interruptedStream(providerRequestId);
      if (finishReason === undefined) throw invalidResponse("模型完成事件缺少结束原因", providerRequestId);
      yield {
        type: "completed",
        finishReason,
        ...(providerRequestId === undefined ? {} : { providerRequestId }),
      };
    } catch (error: unknown) {
      if (error instanceof ModelProviderFailure) {
        if (
          providerRequestId !== undefined &&
          error.failure.providerRequestId === undefined
        ) {
          throw new ModelProviderFailure(
            { ...error.failure, providerRequestId },
            { cause: error },
          );
        }
        throw error;
      }
      if (request.signal?.aborted) {
        throw providerFailure({
          code: "ABORTED",
          message: "模型请求已取消",
          retryable: false,
        });
      }
      const timeoutError = deadline.error(providerRequestId);
      if (timeoutError !== undefined) throw providerFailure(timeoutError);
      throw providerFailure({
        code: "NETWORK_ERROR",
        message: "无法连接模型服务",
        retryable: true,
      });
    } finally {
      deadline.dispose();
    }
  }
}
