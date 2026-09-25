import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

import type {
  ModelCapabilities,
  ModelRequest,
} from "./types.js";
import {
  ModelProviderBase,
  type ProviderStreamEvent,
} from "./provider-stream.js";

const CapabilitiesSchema = z
  .object({
    protocol: z.literal("mock"),
    streaming: z.enum(["supported", "unsupported", "unknown"]),
    tools: z.enum(["supported", "unsupported", "unknown"]),
    usage: z.enum(["reported", "unknown"]),
  })
  .strict();

const ReportedUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    totalTokens: z.number().int().nonnegative().nullable(),
    cacheReadTokens: z.number().int().nonnegative().nullable(),
    reasoningTokens: z.number().int().nonnegative().nullable(),
  })
  .strict();

const ModelErrorCodeSchema = z.enum([
  "ABORTED",
  "AUTH_FAILED",
  "INVALID_REQUEST",
  "MODEL_RESPONSE_INVALID",
  "MODEL_OUTPUT_TRUNCATED",
  "MODEL_UNSUPPORTED",
  "NETWORK_ERROR",
  "PROVIDER_UNAVAILABLE",
  "QUOTA_EXCEEDED",
  "RATE_LIMITED",
  "TIMEOUT",
  "UNKNOWN_PROVIDER_ERROR",
]);

const ModelErrorSchema = z
  .object({
    code: ModelErrorCodeSchema,
    message: z.string().min(1),
    retryable: z.boolean(),
    status: z.number().int().min(100).max(599).optional(),
    retryAfterMs: z.number().positive().optional(),
    providerRequestId: z.string().min(1).optional(),
  })
  .strict();

const MockStepSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_delta"), delta: z.string() }).strict(),
  z
    .object({
      type: z.literal("wait"),
      delayMs: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool_call_delta"),
      index: z.number().int().nonnegative(),
      id: z.string().optional(),
      name: z.string().optional(),
      argumentsDelta: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("usage"), usage: ReportedUsageSchema }).strict(),
  z.object({ type: z.literal("error"), error: ModelErrorSchema }).strict(),
  z
    .object({
      type: z.literal("completed"),
      finishReason: z.enum([
        "stop",
        "tool_calls",
        "max_tokens",
        "content_filter",
      ]),
      providerRequestId: z.string().min(1).optional(),
    })
    .strict(),
]);

export const MockScenarioSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    provider: z
      .object({
        id: z.string().min(1),
        adapterVersion: z.string().min(1),
        capabilities: CapabilitiesSchema,
      })
      .strict(),
    steps: z.array(MockStepSchema).min(1),
  })
  .strict();

export type MockScenario = z.infer<typeof MockScenarioSchema>;

export function loadMockScenario(path: string): MockScenario {
  return MockScenarioSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export class MockModelProvider extends ModelProviderBase {
  private readonly scenario: MockScenario;

  constructor(input: MockScenario) {
    const scenario = MockScenarioSchema.parse(input);
    super(
      scenario.provider.id,
      scenario.provider.adapterVersion,
      scenario.provider.capabilities as ModelCapabilities,
    );
    this.scenario = scenario;
  }

  protected async *providerStream(
    request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    for (const step of this.scenario.steps) {
      if (request.signal?.aborted) return;

      switch (step.type) {
        case "text_delta":
          yield { type: "text_delta", delta: step.delta };
          break;
        case "wait":
          await sleep(
            step.delayMs,
            undefined,
            request.signal === undefined ? {} : { signal: request.signal },
          );
          break;
        case "tool_call_delta":
          yield {
            type: "tool_call_delta",
            index: step.index,
            ...(step.id === undefined ? {} : { id: step.id }),
            ...(step.name === undefined ? {} : { name: step.name }),
            argumentsDelta: step.argumentsDelta,
          };
          break;
        case "usage":
          yield { type: "usage", usage: step.usage };
          break;
        case "error":
          yield {
            type: "error",
            error: {
              code: step.error.code,
              message: step.error.message,
              retryable: step.error.retryable,
              ...(step.error.status === undefined
                ? {}
                : { status: step.error.status }),
              ...(step.error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: step.error.retryAfterMs }),
              ...(step.error.providerRequestId === undefined
                ? {}
                : { providerRequestId: step.error.providerRequestId }),
            },
          };
          return;
        case "completed":
          yield {
            type: "completed",
            finishReason: step.finishReason,
            ...(step.providerRequestId === undefined
              ? {}
              : { providerRequestId: step.providerRequestId }),
          };
          return;
      }
    }

  }
}
