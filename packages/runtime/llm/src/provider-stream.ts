import { Ajv, type ValidateFunction } from "ajv";

import type {
  CompletedToolCall,
  JsonValue,
  ModelCapabilities,
  ModelError,
  ModelEvent,
  ModelProvider,
  ModelRequest,
  ProviderRequestSnapshot,
  TokenUsage,
} from "./types.js";
import { isConnectionProbeRequest } from "./connection-probe-guard.js";

export interface ProviderTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly reasoningTokens: number | null;
}

export type ProviderStreamEvent =
  | { readonly type: "response_activity"; readonly phase: "headers" | "content" }
  | { readonly type: "text_delta"; readonly delta: string }
  | {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id?: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    }
  | { readonly type: "usage"; readonly usage: ProviderTokenUsage }
  | {
      readonly type: "completed";
      readonly finishReason:
        | "stop"
        | "tool_calls"
        | "max_tokens"
        | "content_filter";
      readonly providerRequestId?: string;
      readonly toolContinuation?: CompletedToolCall['providerContinuation'];
    }
  | { readonly type: "error"; readonly error: ModelError };

export class ModelProviderFailure extends Error {
  constructor(
    public readonly failure: ModelError,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = "ModelProviderFailure";
  }
}

interface ToolCallBuffer {
  readonly index: number;
  id: string;
  name: string;
  rawArguments: string;
}

interface CompiledTool {
  readonly validate: ValidateFunction;
}

function terminalError(
  sequence: number,
  provider: ModelProviderBase,
  request: ModelRequest,
  error: ModelError,
): ModelEvent {
  return {
    type: "error",
    sequence,
    error,
    provider: provider.id,
    model: request.model,
    adapterVersion: provider.adapterVersion,
  };
}

function abortedError(): ModelError {
  return {
    code: "ABORTED",
    message: "模型请求已取消",
    retryable: false,
  };
}

function invalidResponse(message: string): ModelError {
  return {
    code: "MODEL_RESPONSE_INVALID",
    message,
    retryable: false,
  };
}

function compileTools(request: ModelRequest):
  | { readonly ok: true; readonly tools: ReadonlyMap<string, CompiledTool> }
  | { readonly ok: false; readonly error: ModelError } {
  const compiled = new Map<string, CompiledTool>();
  const ajv = new Ajv({ allErrors: true, strict: false });

  for (const tool of request.tools ?? []) {
    if (compiled.has(tool.name)) {
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `工具名称重复：${tool.name}`,
          retryable: false,
        },
      };
    }
    try {
      compiled.set(tool.name, { validate: ajv.compile(tool.inputSchema) });
    } catch {
      return {
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: `工具 ${tool.name} 的 JSON Schema 无效`,
          retryable: false,
        },
      };
    }
  }
  return { ok: true, tools: compiled };
}

function asExecutableToolCall(
  buffer: ToolCallBuffer,
  tools: ReadonlyMap<string, CompiledTool>,
):
  | { readonly ok: true; readonly call: CompletedToolCall }
  | { readonly ok: false; readonly error: ModelError } {
  if (buffer.id.length === 0 || buffer.name.length === 0) {
    return {
      ok: false,
      error: invalidResponse("工具调用缺少稳定的 id 或名称"),
    };
  }
  const tool = tools.get(buffer.name);
  if (tool === undefined) {
    return {
      ok: false,
      error: {
        ...invalidResponse(`模型请求了未声明的工具：${buffer.name}`),
        toolSchemaFeedback: { toolName: buffer.name, issues: [{ path: '/name', rule: 'allowed_tools', message: 'Tool is not currently available. Follow the current task prerequisites and select only a declared tool.', expected: { allowedTools: [...tools.keys()] } }] },
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buffer.rawArguments);
  } catch {
    return {
      ok: false,
      error: invalidResponse(`工具 ${buffer.name} 的参数 JSON 不完整或无效`),
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !tool.validate(parsed)
  ) {
    return {
      ok: false,
      error: {
        ...invalidResponse(`工具 ${buffer.name} 的参数未通过 JSON Schema 校验`),
        toolSchemaFeedback: {
          toolName: buffer.name,
          issues: (tool.validate.errors ?? []).slice(0, 12).map((issue) => ({
            path: issue.instancePath, rule: issue.keyword, message: issue.message ?? "Schema mismatch",
            expected: JSON.parse(JSON.stringify(issue.params)) as JsonValue,
          })),
        },
      },
    };
  }

  return {
    ok: true,
    call: {
      id: buffer.id,
      name: buffer.name,
      arguments: parsed as Readonly<Record<string, JsonValue>>,
      rawArguments: buffer.rawArguments,
    },
  };
}

function reportedUsage(usage: ProviderTokenUsage): TokenUsage {
  return {
    ...usage,
    estimated: false,
    cost: null,
  };
}

export abstract class ModelProviderBase implements ModelProvider {
  protected constructor(
    public readonly id: string,
    public readonly adapterVersion: string,
    public readonly capabilities: ModelCapabilities,
  ) {}

  capabilitiesFor(_model: string): ModelCapabilities {
    return this.capabilities;
  }

  snapshotRequest(request: ModelRequest): ProviderRequestSnapshot {
    const normalizedPayload = JSON.parse(
      JSON.stringify({
        requestId: request.requestId,
        model: request.model,
        messages: request.messages,
        ...(request.tools === undefined ? {} : { tools: request.tools }),
        parameters: request.parameters,
      }),
    ) as JsonValue;
    return {
      normalizedPayload,
      serializationVersion: "provider-neutral-request-v1",
      redactions: [],
      unreconstructableFields: [],
    };
  }

  protected abstract providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent>;

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let sequence = 0;
    const capabilities = this.capabilitiesFor(request.model);
    const emitError = (error: ModelError): ModelEvent =>
      terminalError(++sequence, this, request, error);

    if (request.signal?.aborted) {
      yield emitError(abortedError());
      return;
    }
    if (capabilities.streaming !== "supported") {
      yield emitError({
        code: "MODEL_UNSUPPORTED",
        message: "当前 provider 未确认支持流式响应",
        retryable: false,
      });
      return;
    }
    if (
      (request.tools?.length ?? 0) > 0 &&
      capabilities.tools !== "supported" &&
      !(
        isConnectionProbeRequest(request) &&
        capabilities.tools === "unknown"
      )
    ) {
      yield emitError({
        code: "MODEL_UNSUPPORTED",
        message: "当前 provider/model 未确认支持工具调用",
        retryable: false,
      });
      return;
    }

    const compiled = compileTools(request);
    if (!compiled.ok) {
      yield emitError(compiled.error);
      return;
    }

    const calls = new Map<number, ToolCallBuffer>();
    let sawTerminal = false;
    try {
      for await (const event of this.providerStream(request)) {
        if (request.signal?.aborted) {
          yield emitError(abortedError());
          return;
        }
        switch (event.type) {
          case "response_activity":
            yield { type: "response_activity", sequence: ++sequence, phase: event.phase };
            break;
          case "text_delta":
            yield { type: "text_delta", sequence: ++sequence, delta: event.delta };
            break;
          case "tool_call_delta": {
            if (!Number.isSafeInteger(event.index) || event.index < 0) {
              yield emitError(invalidResponse("工具调用 index 无效"));
              return;
            }
            let call = calls.get(event.index);
            if (call === undefined) {
              call = {
                index: event.index,
                id: event.id ?? "",
                name: event.name ?? "",
                rawArguments: "",
              };
              calls.set(event.index, call);
            } else {
              if (event.id !== undefined && event.id.length > 0) {
                if (call.id.length > 0 && call.id !== event.id) {
                  yield emitError(invalidResponse("同一工具调用出现冲突的 id"));
                  return;
                }
                call.id = event.id;
              }
              if (event.name !== undefined && event.name.length > 0) {
                if (call.name.length > 0 && call.name !== event.name) {
                  yield emitError(invalidResponse("同一工具调用出现冲突的名称"));
                  return;
                }
                call.name = event.name;
              }
            }
            call.rawArguments += event.argumentsDelta;
            yield {
              type: "tool_call_delta",
              sequence: ++sequence,
              index: call.index,
              id: call.id,
              ...(call.name.length === 0 ? {} : { name: call.name }),
              argumentsDelta: event.argumentsDelta,
            };
            break;
          }
          case "usage":
            yield {
              type: "usage",
              sequence: ++sequence,
              usage: reportedUsage(event.usage),
            };
            break;
          case "error":
            sawTerminal = true;
            yield emitError(event.error);
            return;
          case "completed": {
            sawTerminal = true;
            if (event.finishReason === "tool_calls" && calls.size === 0) {
              yield emitError(
                invalidResponse("模型声明了工具调用结束原因，但没有返回工具调用"),
              );
              return;
            }
            if (event.finishReason === "max_tokens") {
              yield emitError({
                code: "MODEL_OUTPUT_TRUNCATED",
                message: "模型回复达到单次输出长度上限，结果不完整，未执行本批工具或保存正文",
                retryable: false,
                ...(event.providerRequestId === undefined ? {} : { providerRequestId: event.providerRequestId }),
              });
              return;
            }
            if (calls.size > 0 && event.finishReason !== "tool_calls") {
              yield emitError(
                invalidResponse("工具调用流与模型结束原因不一致"),
              );
              return;
            }
            for (const call of [...calls.values()].sort(
              (left, right) => left.index - right.index,
            )) {
              const executable = asExecutableToolCall(call, compiled.tools);
              if (!executable.ok) {
                yield emitError(executable.error);
                return;
              }
              yield {
                type: "tool_call_complete",
                sequence: ++sequence,
                index: call.index,
                call: event.toolContinuation === undefined ? executable.call : { ...executable.call, providerContinuation: event.toolContinuation },
              };
            }
            yield {
              type: "completed",
              sequence: ++sequence,
              finishReason: event.finishReason,
              provider: this.id,
              model: request.model,
              adapterVersion: this.adapterVersion,
              ...(event.providerRequestId === undefined
                ? {}
                : { providerRequestId: event.providerRequestId }),
            };
            return;
          }
        }
      }
    } catch (cause: unknown) {
      if (request.signal?.aborted) {
        yield emitError(abortedError());
        return;
      }
      if (cause instanceof ModelProviderFailure) {
        yield emitError(cause.failure);
        return;
      }
      yield emitError({
        code: "UNKNOWN_PROVIDER_ERROR",
        message: "模型 provider 返回了未分类错误",
        retryable: false,
      });
      return;
    }

    if (request.signal?.aborted) {
      yield emitError(abortedError());
    } else if (!sawTerminal) {
      yield emitError(invalidResponse("模型流在终态事件前结束"));
    }
  }
}
