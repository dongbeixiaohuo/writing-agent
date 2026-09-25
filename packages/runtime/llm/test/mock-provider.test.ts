import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  MockModelProvider,
  collectModelEvents,
  loadMockScenario,
} from "../src/index.js";

const textFixturePath = fileURLToPath(
  new URL("./fixtures/text-success.json", import.meta.url),
);
const authErrorFixturePath = fileURLToPath(
  new URL("./fixtures/auth-error.json", import.meta.url),
);

describe("provider-neutral mock model stream", () => {
  it("streams text and reported usage before one successful terminal event", async () => {
    const provider = new MockModelProvider(loadMockScenario(textFixturePath));

    const events = await collectModelEvents(
      provider.stream({
        requestId: "request-text-1",
        model: "mock-writer",
        messages: [{ role: "user", content: "写两段文字" }],
        parameters: { temperature: 0 },
      }),
    );

    assert.deepEqual(events, [
      { type: "text_delta", sequence: 1, delta: "第一段" },
      { type: "text_delta", sequence: 2, delta: "，第二段。" },
      {
        type: "usage",
        sequence: 3,
        usage: {
          inputTokens: 12,
          outputTokens: 6,
          totalTokens: 18,
          cacheReadTokens: null,
          reasoningTokens: null,
          estimated: false,
          cost: null,
        },
      },
      {
        type: "completed",
        sequence: 4,
        finishReason: "stop",
        provider: "mock",
        model: "mock-writer",
        adapterVersion: "mock-fixture-v1",
        providerRequestId: "mock-response-1",
      },
    ]);
  });

  it("propagates active cancellation and emits no late mock output", async () => {
    const provider = new MockModelProvider({
      schemaVersion: 1,
      id: "abort-after-first-token",
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
        { type: "text_delta", delta: "已收到" },
        { type: "wait", delayMs: 10_000 },
        { type: "text_delta", delta: "不会发出" },
        { type: "completed", finishReason: "stop" },
      ],
    });
    const controller = new AbortController();
    const iterator = provider
      .stream({
        requestId: "request-abort-1",
        model: "mock-writer",
        messages: [{ role: "user", content: "停止" }],
        parameters: {},
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    assert.deepEqual(await iterator.next(), {
      done: false,
      value: { type: "text_delta", sequence: 1, delta: "已收到" },
    });
    controller.abort("用户停止");
    assert.deepEqual(await iterator.next(), {
      done: false,
      value: {
        type: "error",
        sequence: 2,
        error: {
          code: "ABORTED",
          message: "模型请求已取消",
          retryable: false,
        },
        provider: "mock",
        model: "mock-writer",
        adapterVersion: "mock-fixture-v1",
      },
    });
    assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  });

  it("replays classified terminal failures without any API key", async () => {
    const provider = new MockModelProvider(loadMockScenario(authErrorFixturePath));
    const events = await collectModelEvents(
      provider.stream({
        requestId: "request-error-1",
        model: "mock-writer",
        messages: [{ role: "user", content: "连接测试" }],
        parameters: {},
      }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type !== "error") return;
    assert.deepEqual(events[0].error, {
      code: "AUTH_FAILED",
      message: "测试凭据被拒绝",
      retryable: false,
      status: 401,
      providerRequestId: "mock-error-1",
    });
  });
});
