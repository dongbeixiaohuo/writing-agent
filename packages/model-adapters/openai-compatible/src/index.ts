import {
  ModelProviderBase,
  ModelProviderFailure,
  type CapabilitySupport,
  type ModelCapabilities,
  type ModelError,
  type ModelMessage,
  type ModelRequest,
  type ProviderRequestSnapshot,
  type ProviderStreamEvent,
  type ProviderTokenUsage,
} from "../../../runtime/llm/src/index.js";
import { TransportDeadline } from "../../../runtime/llm/src/transport-deadline.js";

export interface OpenAICompatibleModelCapabilities {
  readonly tools: CapabilitySupport;
  readonly usage: "reported" | "unknown";
}

export interface OpenAICompatibleProviderOptions {
  readonly id: string;
  readonly baseURL: string;
  readonly credentialRef: string;
  readonly resolveCredential: (
    credentialRef: string,
  ) => Promise<string | undefined>;
  readonly models: Readonly<Record<string, OpenAICompatibleModelCapabilities>>;
  readonly adapterVersion?: string;
  readonly timeoutMs?: number;
  readonly streamIdleTimeoutMs?: number;
  readonly allowInsecureHttp?: boolean;
}

type WireMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly tool_calls?: readonly {
        readonly id: string;
        readonly type: "function";
        readonly function: {
          readonly name: string;
          readonly arguments: string;
        };
      }[];
    }
  | {
      readonly role: "tool";
      readonly tool_call_id: string;
      readonly content: string;
    };

interface WireRequest {
  readonly model: string;
  readonly messages: readonly WireMessage[];
  readonly stream: true;
  readonly stream_options: { readonly include_usage: true };
  readonly tools?: readonly {
    readonly type: "function";
    readonly function: {
      readonly name: string;
      readonly description: string;
      readonly parameters: Readonly<Record<string, unknown>>;
    };
  }[];
  readonly temperature?: number;
  readonly max_tokens?: number;
  readonly stop?: readonly string[];
  readonly tool_choice?: "auto" | "required" | "none";
}

const ADAPTER_VERSION = "openai-chat-completions-v1";
const MAX_ERROR_BODY_BYTES = 64 * 1024;

function validateBaseURL(raw: string, allowInsecureHttp: boolean): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OpenAI-compatible baseURL 必须是有效 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAI-compatible baseURL 只允许 http 或 https");
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
  return url.toString().replace(/\/$/, "");
}

function validateCredential(raw: string | undefined): string {
  const value = raw?.trim();
  if (
    value === undefined ||
    value.length === 0 ||
    !/^[\x21-\x7E]+$/.test(value)
  ) {
    throw new ModelProviderFailure({
      code: "AUTH_FAILED",
      message: "模型凭据缺失或格式无效",
      retryable: false,
    });
  }
  return value;
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

function serializeMessages(messages: readonly ModelMessage[]): WireMessage[] {
  const result: WireMessage[] = [];
  const awaitingResults = new Map<string, string>();

  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "user":
        if (awaitingResults.size > 0) {
          throw invalidRequest("工具调用结果必须紧跟对应 assistant 消息");
        }
        result.push({ role: message.role, content: message.content });
        break;
      case "assistant": {
        if (awaitingResults.size > 0) {
          throw invalidRequest("上一组工具调用仍缺少结果");
        }
        const toolCalls = message.toolCalls?.map((call) => {
          if (
            call.id.length === 0 ||
            call.name.length === 0 ||
            awaitingResults.has(call.id)
          ) {
            throw invalidRequest("assistant 工具调用 id 或名称无效");
          }
          try {
            JSON.parse(call.rawArguments);
          } catch {
            throw invalidRequest("assistant 历史包含无效工具参数 JSON");
          }
          awaitingResults.set(call.id, call.name);
          return {
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: call.rawArguments },
          };
        });
        result.push({
          role: "assistant",
          content: message.content,
          ...(toolCalls === undefined || toolCalls.length === 0
            ? {}
            : { tool_calls: toolCalls }),
        });
        break;
      }
      case "tool": {
        const expectedName = awaitingResults.get(message.toolCallId);
        if (expectedName === undefined || expectedName !== message.name) {
          throw invalidRequest("tool result 与 assistant tool call 不匹配");
        }
        awaitingResults.delete(message.toolCallId);
        result.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        });
        break;
      }
    }
  }

  if (awaitingResults.size > 0) {
    throw invalidRequest("模型请求缺少一个或多个工具调用结果");
  }
  return result;
}

function serializeRequest(request: ModelRequest): WireRequest {
  return {
    model: request.model,
    messages: serializeMessages(request.messages),
    stream: true,
    stream_options: { include_usage: true },
    ...(request.tools === undefined || request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function" as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: { ...tool.inputSchema },
            },
          })),
        }),
    ...(request.parameters.temperature === undefined
      ? {}
      : { temperature: request.parameters.temperature }),
    ...(request.parameters.maxOutputTokens === undefined
      ? {}
      : { max_tokens: request.parameters.maxOutputTokens }),
    ...(request.parameters.stop === undefined
      ? {}
      : { stop: [...request.parameters.stop] }),
    ...(request.parameters.toolChoice === undefined
      ? {}
      : { tool_choice: request.parameters.toolChoice }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredTokenCount(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidResponse(`模型 usage.${field} 无效`);
  }
  return value as number;
}

function optionalTokenCount(value: unknown, field: string): number | null {
  if (value === undefined) return null;
  return requiredTokenCount(value, field);
}

function mapUsage(value: unknown): ProviderTokenUsage {
  if (!isRecord(value)) throw invalidResponse("模型 usage 结构无效");
  const prompt = requiredTokenCount(value.prompt_tokens, "prompt_tokens");
  const output = requiredTokenCount(
    value.completion_tokens,
    "completion_tokens",
  );
  const total = requiredTokenCount(value.total_tokens, "total_tokens");
  const promptDetails = value.prompt_tokens_details;
  const completionDetails = value.completion_tokens_details;
  if (promptDetails !== undefined && !isRecord(promptDetails)) {
    throw invalidResponse("模型 usage.prompt_tokens_details 结构无效");
  }
  if (completionDetails !== undefined && !isRecord(completionDetails)) {
    throw invalidResponse("模型 usage.completion_tokens_details 结构无效");
  }
  const cacheRead = optionalTokenCount(
    promptDetails?.cached_tokens,
    "prompt_tokens_details.cached_tokens",
  );
  const reasoning = optionalTokenCount(
    completionDetails?.reasoning_tokens,
    "completion_tokens_details.reasoning_tokens",
  );
  return {
    inputTokens: Math.max(0, prompt - (cacheRead ?? 0)),
    outputTokens: output,
    totalTokens: total,
    cacheReadTokens: cacheRead,
    reasoningTokens: reasoning,
  };
}

function mapFinishReason(
  value: unknown,
): "stop" | "max_tokens" | "tool_calls" | "content_filter" | undefined {
  if (value === null || value === undefined) return undefined;
  switch (value) {
    case "stop":
      return "stop";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "content_filter":
      return "content_filter";
    default:
      throw invalidResponse("模型返回了未知结束原因");
  }
}

function nextSseLine(
  buffer: string,
  final: boolean,
): { readonly line: string; readonly rest: string } | undefined {
  const match = /\r\n|\r|\n/.exec(buffer);
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
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let reachedDone = false;

  const dispatch = (): string | undefined => {
    if (data.length === 0) return undefined;
    const payload = data.join("\n");
    data = [];
    return payload;
  };

  const acceptLine = (line: string): string | undefined => {
    if (line.length === 0) return dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
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
        const payload = acceptLine(line.line);
        if (payload === "[DONE]") {
          reachedDone = true;
          await reader.cancel();
          return;
        }
        if (payload !== undefined) yield payload;
        line = nextSseLine(buffer, read.done);
      }
      if (read.done) break;
    }
  } finally {
    reader.releaseLock();
  }

  if (!reachedDone) {
    throw invalidResponse("SSE 流在 [DONE] 前结束");
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
  if (/^\d+(?:\.\d+)?$/.test(value)) {
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
  const requestId = response.headers.get("x-request-id") ?? undefined;
  return {
    status: response.status,
    ...(retry === undefined ? {} : { retryAfterMs: retry }),
    ...(requestId === undefined || requestId.length === 0
      ? {}
      : { providerRequestId: requestId }),
  };
}

async function mapHttpError(response: Response): Promise<ModelError> {
  const rawBody = await readLimitedErrorBody(response);
  let code = "";
  let type = "";
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.code === "string") code = parsed.error.code;
      if (typeof parsed.error.type === "string") type = parsed.error.type;
    }
  } catch {
    // HTTP status remains authoritative when a gateway returns malformed JSON.
  }
  const detail = `${code} ${type}`.toLowerCase();
  const facts = responseFacts(response);
  if (response.status === 401 || response.status === 403) {
    return {
      code: "AUTH_FAILED",
      message: "模型服务拒绝了凭据或权限",
      retryable: false,
      ...facts,
    };
  }
  if (/insufficient[_ -]?quota|quota[_ -]?exceeded|billing|credit/.test(detail)) {
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
  if (
    response.status === 404 ||
    /model[_ -]?not[_ -]?found|unknown[_ -]?model/.test(detail)
  ) {
    return {
      code: "MODEL_UNSUPPORTED",
      message: "模型标识不存在或当前账户不可用",
      retryable: false,
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
  if (response.status === 408) {
    return {
      code: "TIMEOUT",
      message: "模型服务响应超时",
      retryable: true,
      ...facts,
    };
  }
  if (response.status === 400 || response.status === 422) {
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

function wireChoices(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw invalidResponse("模型 choices 结构无效");
  }
  return value;
}

export class OpenAICompatibleProvider extends ModelProviderBase {
  readonly maxRetries = 0;

  private readonly baseURL: string;
  private readonly credentialRef: string;
  private readonly resolveCredential: OpenAICompatibleProviderOptions["resolveCredential"];
  private readonly models: OpenAICompatibleProviderOptions["models"];
  private readonly firstResponseTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions) {
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
    super(options.id, options.adapterVersion ?? ADAPTER_VERSION, {
      protocol: "openai-chat-completions",
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
  }

  override capabilitiesFor(model: string): ModelCapabilities {
    const known = this.models[model];
    return {
      protocol: "openai-chat-completions",
      streaming: "supported",
      tools: known?.tools ?? "unknown",
      usage: known?.usage ?? "unknown",
    };
  }

  override snapshotRequest(request: ModelRequest): ProviderRequestSnapshot {
    return {
      normalizedPayload: JSON.parse(
        JSON.stringify(serializeRequest(request)),
      ) as ProviderRequestSnapshot["normalizedPayload"],
      serializationVersion: ADAPTER_VERSION,
      redactions: ["authorization"],
      unreconstructableFields: [],
    };
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
      const body = serializeRequest(request);
      let encoded: string;
      try {
        encoded = JSON.stringify(body);
      } catch {
        throw invalidRequest("模型请求无法序列化为 JSON");
      }

      const response = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${validateCredential(rawCredential)}`,
          "content-type": "application/json",
          "x-writing-agent-adapter-version": this.adapterVersion,
        },
        body: encoded,
        signal: deadline.signal,
      });
      if (!response.ok) throw providerFailure(await mapHttpError(response));
      if (response.body === null) {
        throw invalidResponse(
          "模型服务返回了空响应体",
          response.headers.get("x-request-id") ?? undefined,
        );
      }

      providerRequestId = response.headers.get("x-request-id") ?? undefined;
      yield { type: "response_activity", phase: "headers" };
      let finishReason:
        | "stop"
        | "max_tokens"
        | "tool_calls"
        | "content_filter"
        | undefined;

      for await (const payload of parseSse(response.body)) {
        let chunk: unknown;
        try {
          chunk = JSON.parse(payload);
        } catch {
          throw invalidResponse("SSE data 包含无效 JSON", providerRequestId);
        }
        if (!isRecord(chunk)) {
          throw invalidResponse("模型 chunk 结构无效", providerRequestId);
        }
        for (const choice of wireChoices(chunk.choices)) {
          if (choice.index !== 0) continue;
          if (!isRecord(choice.delta)) {
            throw invalidResponse("模型 choice.delta 结构无效", providerRequestId);
          }
          const content = choice.delta.content;
          if (content !== undefined && content !== null) {
            if (typeof content !== "string") {
              throw invalidResponse("模型文本增量结构无效", providerRequestId);
            }
            if (content.length > 0) {
              deadline.content();
              yield { type: "response_activity", phase: "content" };
              yield { type: "text_delta", delta: content };
            }
          }

          const toolCalls = choice.delta.tool_calls;
          if (toolCalls !== undefined) {
            if (!Array.isArray(toolCalls) || !toolCalls.every(isRecord)) {
              throw invalidResponse("模型工具调用增量结构无效", providerRequestId);
            }
            for (const call of toolCalls) {
              if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) {
                throw invalidResponse("模型工具调用 index 无效", providerRequestId);
              }
              const fn = call.function;
              if (fn !== undefined && !isRecord(fn)) {
                throw invalidResponse("模型工具调用 function 结构无效", providerRequestId);
              }
              const id = call.id;
              const name = fn?.name;
              const argumentsDelta = fn?.arguments;
              if (id !== undefined && id !== null && typeof id !== "string") {
                throw invalidResponse("模型工具调用 id 无效", providerRequestId);
              }
              if (
                name !== undefined &&
                name !== null &&
                typeof name !== "string"
              ) {
                throw invalidResponse("模型工具调用名称无效", providerRequestId);
              }
              if (
                argumentsDelta !== undefined &&
                argumentsDelta !== null &&
                typeof argumentsDelta !== "string"
              ) {
                throw invalidResponse("模型工具参数增量无效", providerRequestId);
              }
              if (
                (typeof id === "string" && id.length > 0) ||
                (typeof name === "string" && name.length > 0) ||
                (typeof argumentsDelta === "string" && argumentsDelta.length > 0)
              ) {
                deadline.content();
                yield { type: "response_activity", phase: "content" };
              }
              yield {
                type: "tool_call_delta",
                index: call.index as number,
                ...(typeof id === "string" && id.length > 0 ? { id } : {}),
                ...(typeof name === "string" && name.length > 0 ? { name } : {}),
                argumentsDelta:
                  typeof argumentsDelta === "string" ? argumentsDelta : "",
              };
            }
          }

          const mappedFinish = mapFinishReason(choice.finish_reason);
          if (mappedFinish !== undefined) finishReason = mappedFinish;
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          yield { type: "usage", usage: mapUsage(chunk.usage) };
        }
      }

      if (finishReason === undefined) {
        throw invalidResponse("模型流缺少结束原因", providerRequestId);
      }
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
