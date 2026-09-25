import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MockModelProvider,
  collectModelEvents,
  loadMockScenario,
  type MockScenario,
  type ModelRequest,
} from "../src/index.js";

const toolFixturePath = fileURLToPath(
  new URL("./fixtures/tool-call-success.json", import.meta.url),
);

const toolRequest: ModelRequest = {
  requestId: "request-tool-1",
  model: "mock-writer",
  messages: [{ role: "user", content: "读取材料后写作" }],
  tools: [
    {
      name: "read_material",
      description: "读取已导入的材料",
      inputSchema: {
        type: "object",
        properties: { materialId: { type: "string", minLength: 1 } },
        required: ["materialId"],
        additionalProperties: false,
      },
    },
  ],
  parameters: { temperature: 0 },
};

function scenarioWithArguments(
  argumentsDelta: string,
  finishReason: "tool_calls" | "max_tokens" = "tool_calls",
): MockScenario {
  return {
    schemaVersion: 1,
    id: `tool-${finishReason}`,
    provider: {
      id: "mock",
      adapterVersion: "mock-fixture-v1",
      capabilities: {
        protocol: "mock",
        streaming: "supported",
        tools: "supported",
        usage: "reported",
      },
    },
    steps: [
      {
        type: "tool_call_delta",
        index: 0,
        id: "call-material-1",
        name: "read_material",
        argumentsDelta,
      },
      { type: "completed", finishReason },
    ],
  };
}

describe("safe streamed tool-call assembly", () => {
  it("emits an executable call only after complete JSON passes its tool schema", async () => {
    const provider = new MockModelProvider(loadMockScenario(toolFixturePath));
    const events = await collectModelEvents(provider.stream(toolRequest));

    assert.deepEqual(events, [
      {
        type: "tool_call_delta",
        sequence: 1,
        index: 0,
        id: "call-material-1",
        name: "read_material",
        argumentsDelta: "{\"material",
      },
      {
        type: "tool_call_delta",
        sequence: 2,
        index: 0,
        id: "call-material-1",
        name: "read_material",
        argumentsDelta: "Id\":\"material-1\"}",
      },
      {
        type: "tool_call_complete",
        sequence: 3,
        index: 0,
        call: {
          id: "call-material-1",
          name: "read_material",
          arguments: { materialId: "material-1" },
          rawArguments: "{\"materialId\":\"material-1\"}",
        },
      },
      {
        type: "completed",
        sequence: 4,
        finishReason: "tool_calls",
        provider: "mock",
        model: "mock-writer",
        adapterVersion: "mock-fixture-v1",
      },
    ]);
  });

  it("does not emit a complete call or success for truncated JSON", async () => {
    const provider = new MockModelProvider(
      scenarioWithArguments('{"materialId":', "max_tokens"),
    );
    const events = await collectModelEvents(provider.stream(toolRequest));

    assert.deepEqual(
      events.map((event) => event.type),
      ["tool_call_delta", "error"],
    );
    assert.equal(events[1]?.type, "error");
    if (events[1]?.type !== "error") return;
    assert.equal(events[1].error.code, "MODEL_OUTPUT_TRUNCATED");
    assert.equal(events[1].error.retryable, false);
  });

  it("classifies truncated plain text as incomplete output, never a successful response", async () => {
    const scenario = scenarioWithArguments('{}');
    const provider = new MockModelProvider({ ...scenario, steps: [
      { type: 'text_delta', delta: 'unfinished article' },
      { type: 'completed', finishReason: 'max_tokens' },
    ] });
    const events = await collectModelEvents(provider.stream(toolRequest));
    assert.deepEqual(events.map(event => event.type), ['text_delta', 'error']);
    assert.equal(events[1]?.type === 'error' && events[1].error.code, 'MODEL_OUTPUT_TRUNCATED');
  });

  it("does not emit a complete call when JSON violates the declared schema", async () => {
    const provider = new MockModelProvider(
      scenarioWithArguments('{"materialId":42}'),
    );
    const events = await collectModelEvents(provider.stream(toolRequest));

    assert.deepEqual(
      events.map((event) => event.type),
      ["tool_call_delta", "error"],
    );
    assert.equal(events[1]?.type, "error");
    if (events[1]?.type !== "error") return;
    assert.equal(events[1].error.code, "MODEL_RESPONSE_INVALID");
  });

  it("fails capability preflight before replaying a tool request", async () => {
    const scenario: MockScenario = {
      ...scenarioWithArguments('{"materialId":"material-1"}'),
      provider: {
        id: "mock-no-tools",
        adapterVersion: "mock-fixture-v1",
        capabilities: {
          protocol: "mock",
          streaming: "supported",
          tools: "unsupported",
          usage: "reported",
        },
      },
    };
    const provider = new MockModelProvider(scenario);
    const events = await collectModelEvents(provider.stream(toolRequest));

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type !== "error") return;
    assert.equal(events[0].error.code, "MODEL_UNSUPPORTED");
  });
});
