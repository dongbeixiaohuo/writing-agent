import type {
  ModelError,
  ModelEvent,
  ModelProvider,
  ModelToolSchema,
} from "./types.js";
import { markConnectionProbeRequest } from "./connection-probe-guard.js";

const PROBE_TOOL_NAME = "writing_agent_capability_probe";
const probeTool: ModelToolSchema = {
  name: PROBE_TOOL_NAME,
  description: "验证模型是否支持符合 JSON Schema 的工具调用；不执行任何业务操作",
  inputSchema: {
    type: "object",
    properties: { value: { const: "ok" } },
    required: ["value"],
    additionalProperties: false,
  },
};

export interface ModelConnectionProbeOptions {
  readonly requestId: string;
  readonly model: string;
  readonly testTools: boolean;
  readonly signal?: AbortSignal;
}

export type ModelConnectionProbeStage =
  | "authentication"
  | "cancelled"
  | "model"
  | "network"
  | "provider"
  | "stream"
  | "tools";

interface ModelConnectionProbeBase {
  readonly provider: string;
  readonly model: string;
  readonly adapterVersion: string;
}

export type ModelConnectionProbeResult =
  | (ModelConnectionProbeBase & {
      readonly ok: true;
      readonly streaming: "supported";
      readonly tools: "supported" | "not_tested";
      readonly usage: "reported" | "not_reported";
      readonly providerRequestId?: string;
    })
  | (ModelConnectionProbeBase & {
      readonly ok: false;
      readonly stage: ModelConnectionProbeStage;
      readonly error: ModelError;
    });

function failureStage(
  error: ModelError,
  provider: ModelProvider,
  model: string,
  testTools: boolean,
): ModelConnectionProbeStage {
  switch (error.code) {
    case "AUTH_FAILED":
      return "authentication";
    case "ABORTED":
      return "cancelled";
    case "NETWORK_ERROR":
    case "PROVIDER_UNAVAILABLE":
    case "TIMEOUT":
      return "network";
    case "MODEL_RESPONSE_INVALID":
    case "MODEL_OUTPUT_TRUNCATED":
      return "stream";
    case "MODEL_UNSUPPORTED":
      return testTools && provider.capabilitiesFor(model).tools === "unsupported"
        ? "tools"
        : "model";
    default:
      return "provider";
  }
}

function failed(
  provider: ModelProvider,
  options: ModelConnectionProbeOptions,
  stage: ModelConnectionProbeStage,
  error: ModelError,
): ModelConnectionProbeResult {
  return {
    ok: false,
    provider: provider.id,
    model: options.model,
    adapterVersion: provider.adapterVersion,
    stage,
    error,
  };
}

export async function probeModelConnection(
  provider: ModelProvider,
  options: ModelConnectionProbeOptions,
): Promise<ModelConnectionProbeResult> {
  if (
    options.testTools &&
    provider.capabilitiesFor(options.model).tools === "unsupported"
  ) {
    return failed(provider, options, "tools", {
      code: "MODEL_UNSUPPORTED",
      message: "当前模型已声明不支持所需工具能力",
      retryable: false,
    });
  }
  let sawDelta = false;
  let sawUsage = false;
  let validProbeCall = false;
  let completed: Extract<ModelEvent, { type: "completed" }> | undefined;

  const request = markConnectionProbeRequest({
    requestId: options.requestId,
    model: options.model,
    messages: [
      {
        role: "user",
        content: options.testTools
          ? `仅调用 ${PROBE_TOOL_NAME}，参数 value 必须为 \"ok\"；不要输出其他内容。`
          : "仅回复 OK。",
      },
    ],
    ...(options.testTools ? { tools: [probeTool] } : {}),
    parameters: {
      temperature: 0,
      maxOutputTokens: 64,
      ...(options.testTools ? { toolChoice: "required" as const } : {}),
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const stream = provider.stream(request);

  for await (const event of stream) {
    switch (event.type) {
      case "text_delta":
      case "tool_call_delta":
        sawDelta = true;
        break;
      case "tool_call_complete":
        validProbeCall =
          event.call.name === PROBE_TOOL_NAME && event.call.arguments.value === "ok";
        break;
      case "usage":
        sawUsage = true;
        break;
      case "completed":
        completed = event;
        break;
      case "error":
        return failed(
          provider,
          options,
          failureStage(event.error, provider, options.model, options.testTools),
          event.error,
        );
    }
  }

  if (!sawDelta || completed === undefined) {
    return failed(provider, options, "stream", {
      code: "MODEL_RESPONSE_INVALID",
      message: "连接测试未观察到完整流式响应",
      retryable: false,
    });
  }
  if (options.testTools && !validProbeCall) {
    return failed(provider, options, "tools", {
      code: "MODEL_UNSUPPORTED",
      message: "模型未完成受控工具能力探测",
      retryable: false,
    });
  }

  return {
    ok: true,
    provider: provider.id,
    model: options.model,
    adapterVersion: provider.adapterVersion,
    streaming: "supported",
    tools: options.testTools ? "supported" : "not_tested",
    usage: sawUsage ? "reported" : "not_reported",
    ...(completed.providerRequestId === undefined
      ? {}
      : { providerRequestId: completed.providerRequestId }),
  };
}
