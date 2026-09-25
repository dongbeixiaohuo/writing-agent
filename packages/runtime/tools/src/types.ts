import type {
  CompletedToolCall,
  JsonValue,
  ModelToolSchema,
} from "../../llm/src/index.js";

declare const permissionGrantBrand: unique symbol;

export type ToolEffect =
  | "read_only"
  | "local_idempotent"
  | "external_side_effect";

export interface ToolPermissionGrant {
  readonly projectId: string;
  readonly runId: string;
  readonly permissions: readonly string[];
  readonly [permissionGrantBrand]: true;
}

export interface ToolExecutionContext {
  readonly projectId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly abortSignal: AbortSignal;
  readonly expectedBodyVersionId: string | null;
  readonly permissionGrant: ToolPermissionGrant;
}

export interface ToolDefinition<TArgs, TResult extends JsonValue> {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly effect: ToolEffect;
  readonly permissions: readonly string[];
  readonly validateTarget?: (
    args: TArgs,
    context: ToolExecutionContext,
  ) => void | Promise<void>;
  readonly execute: (
    args: TArgs,
    context: ToolExecutionContext,
  ) => TResult | Promise<TResult>;
}

export interface ToolSchemaSnapshot extends ModelToolSchema {
  readonly version: string;
  readonly schemaHash: string;
}

export type ToolErrorCode =
  | "ABORTED"
  | "TOOL_INPUT_INVALID"
  | "TOOL_NOT_FOUND"
  | "TOOL_OUTPUT_INVALID"
  | "TOOL_OUTPUT_TOO_LARGE"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_TARGET_INVALID"
  | "TOOL_EXECUTION_FAILED";

export interface ToolExecutionError {
  readonly code: ToolErrorCode | string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, JsonValue>>;
}

interface ToolExecutionEnvelope {
  readonly callId: string;
  readonly toolName: string;
  readonly operationId: string;
  readonly runId: string;
}

export type ToolExecutionResult =
  | (ToolExecutionEnvelope & {
      readonly ok: true;
      readonly toolVersion: string;
      readonly effect: ToolEffect;
      readonly result: JsonValue;
      readonly outputBytes: number;
    })
  | (ToolExecutionEnvelope & {
      readonly ok: false;
      readonly error: ToolExecutionError;
    });

export type ToolInvocation = CompletedToolCall;

export class ToolExecutionFault extends Error {
  constructor(
    public readonly code: ToolErrorCode | string,
    message: string,
    public readonly retryable = false,
    public readonly details: Readonly<Record<string, JsonValue>> = {},
  ) {
    super(message);
    this.name = "ToolExecutionFault";
  }
}
