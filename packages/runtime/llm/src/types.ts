export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type CapabilitySupport = "supported" | "unsupported" | "unknown";

export interface ModelCapabilities {
  readonly protocol:
    | "mock"
    | "openai-chat-completions"
    | "openai-responses"
    | "anthropic-messages";
  readonly streaming: CapabilitySupport;
  readonly tools: CapabilitySupport;
  readonly usage: "reported" | "unknown";
}

export type ModelMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls?: readonly CompletedToolCall[];
    }
  | {
      readonly role: "tool";
      readonly toolCallId: string;
      readonly name: string;
      readonly content: string;
    };

export interface ModelToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelParameters {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly stop?: readonly string[];
  readonly toolChoice?: "auto" | "required" | "none";
}

export interface ModelRequest {
  readonly requestId: string;
  readonly model: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolSchema[];
  readonly parameters: ModelParameters;
  readonly signal?: AbortSignal;
}

export interface ProviderRequestSnapshot {
  readonly normalizedPayload: JsonValue;
  readonly serializationVersion: string;
  readonly redactions: readonly string[];
  readonly unreconstructableFields: readonly string[];
  // Adapter-owned capability metadata, never inferred from token usage or model text.
  readonly outputTokenLimit?: {
    readonly value: number;
    readonly source: "model_default" | "adapter_default" | "configuration" | "request";
  };
}

export interface CompletedToolCall {
  // Opaque adapter-owned continuation, never tool arguments or public reasoning.
  readonly providerContinuation?: { readonly scope: string; readonly items: readonly JsonValue[] };
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly rawArguments: string;
}

export interface TokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly estimated: boolean;
  readonly cost: {
    readonly amount: number;
    readonly currency: "USD" | "CNY";
    readonly pricingVersion: string;
    readonly verifiedAt: string;
  } | null;
}

export type ModelErrorCode =
  | "ABORTED"
  | "AUTH_FAILED"
  | "INVALID_REQUEST"
  | "MODEL_RESPONSE_INVALID"
  | "MODEL_OUTPUT_TRUNCATED"
  | "MODEL_UNSUPPORTED"
  | "NETWORK_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "QUOTA_EXCEEDED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "UNKNOWN_PROVIDER_ERROR";

export interface ModelError {
  readonly code: ModelErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  // Sanitized upstream error reason (control chars stripped, whitespace
  // collapsed, truncated). Never the raw response body; may still be absent
  // when the provider returned no usable message.
  readonly providerDetail?: string;
  readonly toolSchemaFeedback?: {
    readonly toolName: string;
    readonly issues: readonly { readonly path: string; readonly rule: string; readonly message: string; readonly expected: JsonValue }[];
  };
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerRequestId?: string;
  readonly transport?: {
    readonly phase: "first_response" | "stream_idle";
    readonly timeoutMs: number;
    readonly elapsedMs: number;
    // Elapsed from request deadline start to first meaningful content, not headers.
    readonly firstResponseMs: number | null;
    // Elapsed from request deadline start to last meaningful content; heartbeats excluded.
    readonly lastActivityMs: number | null;
  };
}

interface SequencedEvent {
  readonly sequence: number;
}

interface ProviderTerminalMetadata {
  readonly provider: string;
  readonly model: string;
  readonly adapterVersion: string;
  readonly providerRequestId?: string;
}

export type ModelEvent =
  | (SequencedEvent & {
      readonly type: "response_activity";
      readonly phase: "headers" | "content";
    })
  | (SequencedEvent & {
      readonly type: "text_delta";
      readonly delta: string;
    })
  | (SequencedEvent & {
      readonly type: "tool_call_delta";
      readonly index: number;
      readonly id: string;
      readonly name?: string;
      readonly argumentsDelta: string;
    })
  | (SequencedEvent & {
      readonly type: "tool_call_complete";
      readonly index: number;
      readonly call: CompletedToolCall;
    })
  | (SequencedEvent & {
      readonly type: "usage";
      readonly usage: TokenUsage;
    })
  | (SequencedEvent &
      ProviderTerminalMetadata & {
        readonly type: "completed";
        readonly finishReason:
          | "stop"
          | "tool_calls"
          | "max_tokens"
          | "content_filter";
      })
  | (SequencedEvent &
      Omit<ProviderTerminalMetadata, "providerRequestId"> & {
        readonly type: "error";
        readonly error: ModelError;
      });

export interface ModelProvider {
  readonly id: string;
  readonly adapterVersion: string;
  readonly capabilities: ModelCapabilities;
  capabilitiesFor(model: string): ModelCapabilities;
  snapshotRequest(request: ModelRequest): ProviderRequestSnapshot;
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export async function collectModelEvents(
  stream: AsyncIterable<ModelEvent>,
): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
