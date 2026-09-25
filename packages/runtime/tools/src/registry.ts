import { Buffer } from "node:buffer";

import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import {
  canonicalJson,
  contentHash,
  JsonValueSchema,
  type JsonValue,
} from "../../../writing-core/src/index.js";
import { isIssuedPermissionGrant } from "./permission-grant.js";
import {
  ToolExecutionFault,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionError,
  type ToolExecutionResult,
  type ToolEffect,
  type ToolInvocation,
  type ToolSchemaSnapshot,
} from "./types.js";

interface RegisteredTool {
  readonly definition: ToolDefinition<Record<string, JsonValue>, JsonValue>;
  readonly validate: ValidateFunction;
  readonly snapshot: ToolSchemaSnapshot;
}

export interface ToolRegistryOptions {
  readonly maxOutputBytes?: number;
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

function cloneSchema(
  schema: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return deepFreeze(structuredClone(schema));
}

function schemaSnapshot(
  definition: ToolDefinition<never, JsonValue>,
): ToolSchemaSnapshot {
  const inputSchema = cloneSchema(definition.inputSchema);
  const snapshot = {
    name: definition.name,
    version: definition.version,
    description: definition.description,
    inputSchema,
    schemaHash: contentHash(
      canonicalJson({
        name: definition.name,
        version: definition.version,
        description: definition.description,
        inputSchema,
      }),
    ),
  };
  return deepFreeze(snapshot);
}

function invocationErrorDetails(
  errors: readonly ErrorObject[] | null | undefined,
): Readonly<Record<string, JsonValue>> {
  return {
    issues: (errors ?? []).map((error) => ({
      instancePath: error.instancePath,
      keyword: error.keyword,
    })),
  };
}

function failure(
  invocation: ToolInvocation,
  context: ToolExecutionContext,
  error: ToolExecutionError,
): ToolExecutionResult {
  return {
    ok: false,
    callId: invocation.id,
    toolName: invocation.name,
    operationId: context.operationId,
    runId: context.runId,
    error,
  };
}

function fixedError(
  code: string,
  message: string,
  details: Readonly<Record<string, JsonValue>> = {},
): ToolExecutionError {
  return { code, message, retryable: false, details };
}

function assertInvocationMatchesRaw(invocation: ToolInvocation): boolean {
  try {
    const parsed = JSON.parse(invocation.rawArguments) as unknown;
    return canonicalJson(parsed) === canonicalJson(invocation.arguments);
  } catch {
    return false;
  }
}

function hasRequiredPermissions(
  permissions: readonly string[],
  context: ToolExecutionContext,
): boolean {
  const grant = context.permissionGrant;
  if (!isIssuedPermissionGrant(grant)) return false;
  if (grant.projectId !== context.projectId || grant.runId !== context.runId) {
    return false;
  }
  const granted = new Set(grant.permissions);
  return permissions.every((permission) => granted.has(permission));
}

function abortError(): ToolExecutionError {
  return fixedError("ABORTED", "Tool execution was cancelled");
}

export class ToolRegistry {
  readonly #tools: ReadonlyMap<string, RegisteredTool>;
  readonly #snapshots: readonly ToolSchemaSnapshot[];
  readonly #maxOutputBytes: number;

  private constructor(
    tools: ReadonlyMap<string, RegisteredTool>,
    snapshots: readonly ToolSchemaSnapshot[],
    maxOutputBytes: number,
  ) {
    this.#tools = tools;
    this.#snapshots = snapshots;
    this.#maxOutputBytes = maxOutputBytes;
  }

  static create(
    definitions: readonly ToolDefinition<never, JsonValue>[],
    options: ToolRegistryOptions = {},
  ): ToolRegistry {
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
      throw new TypeError("maxOutputBytes must be a positive safe integer");
    }
    const ajv = new Ajv({
      allErrors: true,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
    });
    const tools = new Map<string, RegisteredTool>();
    const snapshots: ToolSchemaSnapshot[] = [];

    for (const rawDefinition of definitions) {
      if (!TOOL_NAME.test(rawDefinition.name)) {
        throw new TypeError(`Invalid tool name: ${rawDefinition.name}`);
      }
      if (!TOOL_VERSION.test(rawDefinition.version)) {
        throw new TypeError(`Invalid tool version: ${rawDefinition.version}`);
      }
      if (rawDefinition.description.trim().length === 0) {
        throw new TypeError(`Tool description must not be empty: ${rawDefinition.name}`);
      }
      if (tools.has(rawDefinition.name)) {
        throw new TypeError(`Duplicate tool name: ${rawDefinition.name}`);
      }
      const snapshot = schemaSnapshot(rawDefinition);
      const validate = ajv.compile(snapshot.inputSchema);
      const definition = Object.freeze({
        ...rawDefinition,
        inputSchema: snapshot.inputSchema,
        permissions: Object.freeze([...new Set(rawDefinition.permissions)].sort()),
      }) as unknown as ToolDefinition<Record<string, JsonValue>, JsonValue>;
      tools.set(rawDefinition.name, { definition, validate, snapshot });
      snapshots.push(snapshot);
    }

    return new ToolRegistry(
      tools,
      Object.freeze(snapshots.sort((left, right) => left.name.localeCompare(right.name))),
      maxOutputBytes,
    );
  }

  schemaSnapshots(): readonly ToolSchemaSnapshot[] {
    return this.#snapshots;
  }

  effectFor(name: string): ToolEffect | null {
    return this.#tools.get(name)?.definition.effect ?? null;
  }

  async execute(
    invocation: ToolInvocation,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const registered = this.#tools.get(invocation.name);
    if (registered === undefined) {
      return failure(
        invocation,
        context,
        fixedError("TOOL_NOT_FOUND", "Requested tool is not registered"),
      );
    }

    if (
      !assertInvocationMatchesRaw(invocation) ||
      !registered.validate(invocation.arguments)
    ) {
      return failure(
        invocation,
        context,
        fixedError(
          "TOOL_INPUT_INVALID",
          "Tool arguments did not match the registered schema",
          invocationErrorDetails(registered.validate.errors),
        ),
      );
    }

    if (!hasRequiredPermissions(registered.definition.permissions, context)) {
      return failure(
        invocation,
        context,
        fixedError(
          "TOOL_PERMISSION_DENIED",
          "The application did not grant this tool permission",
        ),
      );
    }

    if (context.abortSignal.aborted) {
      return failure(invocation, context, abortError());
    }

    const args = invocation.arguments as Record<string, JsonValue>;
    try {
      await registered.definition.validateTarget?.(args, context);
    } catch (error) {
      if (error instanceof ToolExecutionFault) {
        return failure(invocation, context, {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        });
      }
      return failure(
        invocation,
        context,
        fixedError("TOOL_TARGET_INVALID", "The requested tool target is not available"),
      );
    }

    if (context.abortSignal.aborted) {
      return failure(invocation, context, abortError());
    }

    let output: JsonValue;
    try {
      output = await registered.definition.execute(args, context);
    } catch (error) {
      if (error instanceof ToolExecutionFault) {
        return failure(invocation, context, {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: error.details,
        });
      }
      return failure(
        invocation,
        context,
        fixedError("TOOL_EXECUTION_FAILED", "The tool could not complete"),
      );
    }

    if (context.abortSignal.aborted) {
      return failure(invocation, context, abortError());
    }
    const parsedOutput = JsonValueSchema.safeParse(output);
    if (!parsedOutput.success) {
      return failure(
        invocation,
        context,
        fixedError("TOOL_OUTPUT_INVALID", "The tool returned an invalid result"),
      );
    }
    const outputBytes = Buffer.byteLength(canonicalJson(parsedOutput.data), "utf8");
    if (outputBytes > this.#maxOutputBytes) {
      return failure(
        invocation,
        context,
        fixedError("TOOL_OUTPUT_TOO_LARGE", "The tool result exceeded the output limit", {
          maxOutputBytes: this.#maxOutputBytes,
        }),
      );
    }

    return {
      ok: true,
      callId: invocation.id,
      toolName: invocation.name,
      toolVersion: registered.definition.version,
      effect: registered.definition.effect,
      operationId: context.operationId,
      runId: context.runId,
      result: parsedOutput.data,
      outputBytes,
    };
  }
}
