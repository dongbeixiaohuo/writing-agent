import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MockModelProvider,
  probeModelConnection,
  type MockScenario,
} from "../src/index.js";

const probeScenario: MockScenario = {
  schemaVersion: 1,
  id: "connection-probe-success",
  provider: {
    id: "mock",
    adapterVersion: "mock-fixture-v1",
    capabilities: {
      protocol: "mock",
      streaming: "supported",
      tools: "unknown",
      usage: "reported",
    },
  },
  steps: [
    {
      type: "tool_call_delta",
      index: 0,
      id: "call-probe-1",
      name: "writing_agent_capability_probe",
      argumentsDelta: '{"value":"ok"}',
    },
    {
      type: "usage",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cacheReadTokens: null,
        reasoningTokens: null,
      },
    },
    { type: "completed", finishReason: "tool_calls" },
  ],
};

describe("model connection capability probe", () => {
  it("reports a declared missing tool capability without issuing a model request", async () => {
    let streamCalls = 0;
    const provider = new MockModelProvider({
      ...probeScenario,
      provider: {
        ...probeScenario.provider,
        capabilities: {
          ...probeScenario.provider.capabilities,
          tools: "unsupported",
        },
      },
    });
    const originalStream = provider.stream.bind(provider);
    provider.stream = (request) => {
      streamCalls += 1;
      return originalStream(request);
    };

    const result = await probeModelConnection(provider, {
      requestId: "connection-test-no-tools-1",
      model: "mock-no-tools",
      testTools: true,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "tools");
    assert.equal(result.error.code, "MODEL_UNSUPPORTED");
    assert.equal(streamCalls, 0);
  });

  it("tests streaming, tools and usage without executing a business tool", async () => {
    const result = await probeModelConnection(
      new MockModelProvider(probeScenario),
      {
        requestId: "connection-test-1",
        model: "mock-writer",
        testTools: true,
      },
    );

    assert.deepEqual(result, {
      ok: true,
      provider: "mock",
      model: "mock-writer",
      adapterVersion: "mock-fixture-v1",
      streaming: "supported",
      tools: "supported",
      usage: "reported",
    });
  });

  it("allows reasoning headroom in one request and still requires a valid tool call", async () => {
    const provider = new MockModelProvider(probeScenario);
    const originalStream = provider.stream.bind(provider);
    let calls = 0;
    provider.stream = request => {
      calls++;
      assert.equal(request.parameters.maxOutputTokens, 2048);
      assert.equal(request.parameters.toolChoice, "required");
      return originalStream(request);
    };
    assert.equal((await probeModelConnection(provider, {
      requestId: "bounded-probe", model: "mock-writer", testTools: true,
    })).ok, true);
    assert.equal(calls, 1);
  });

  it("does not mark a truncated or text-only response as tools verified", async () => {
    for (const steps of [
      [{ type: "error", error: { code: "MODEL_OUTPUT_TRUNCATED", message: "length", retryable: false } }],
      [{ type: "text_delta", delta: "OK" }, { type: "completed", finishReason: "stop" }],
    ] as const) {
      const result = await probeModelConnection(new MockModelProvider({ ...probeScenario, steps: [...steps] }), {
        requestId: "incomplete-probe", model: "mock-writer", testTools: true,
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.ok(["MODEL_OUTPUT_TRUNCATED", "MODEL_UNSUPPORTED"].includes(result.error.code));
    }
  });

  it("keeps provider error classification and identifies the failing stage", async () => {
    const scenario: MockScenario = {
      ...probeScenario,
      id: "connection-probe-auth-error",
      steps: [
        {
          type: "error",
          error: {
            code: "AUTH_FAILED",
            message: "测试凭据被拒绝",
            retryable: false,
            status: 401,
          },
        },
      ],
    };
    const result = await probeModelConnection(
      new MockModelProvider(scenario),
      {
        requestId: "connection-test-auth-1",
        model: "mock-writer",
        testTools: true,
      },
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "authentication");
    assert.equal(result.error.code, "AUTH_FAILED");
  });
});
