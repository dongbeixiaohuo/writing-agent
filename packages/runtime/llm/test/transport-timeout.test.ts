import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import { OpenAICompatibleProvider } from "../../../model-adapters/openai-compatible/src/index.js";
import { AnthropicCompatibleProvider } from "../../../model-adapters/anthropic-compatible/src/index.js";
import { collectModelEvents, type ModelEvent, type ModelRequest } from "../src/index.js";

const request: ModelRequest = {
  requestId: "transport-local",
  model: "test-model",
  messages: [{ role: "user", content: "hello" }],
  parameters: {},
};

type Protocol = "openai" | "anthropic";

function provider(protocol: Protocol, baseURL: string, timeoutMs: number) {
  const options = {
    id: protocol,
    baseURL,
    credentialRef: "local/test",
    resolveCredential: async () => "not-a-real-key",
    allowInsecureHttp: true,
    timeoutMs,
    models: { "test-model": { tools: "supported" as const, usage: "reported" as const } },
  };
  return protocol === "openai"
    ? new OpenAICompatibleProvider(options)
    : new AnthropicCompatibleProvider(options);
}

function headers(response: ServerResponse, protocol: Protocol): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    [protocol === "openai" ? "x-request-id" : "request-id"]: "local-request-id",
  });
  response.flushHeaders();
}

function content(response: ServerResponse, protocol: Protocol, text: string): void {
  if (protocol === "openai") {
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`);
  } else {
    response.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`);
  }
}

function start(response: ServerResponse, protocol: Protocol): void {
  if (protocol === "anthropic") {
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"local-message-id"}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
  }
}

function finish(response: ServerResponse, protocol: Protocol): void {
  if (protocol === "openai") {
    response.end('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  } else {
    response.end('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }
}

async function localRun(
  protocol: Protocol,
  timeoutMs: number,
  handler: (response: ServerResponse) => void,
  signal?: AbortSignal,
): Promise<ModelEvent[]> {
  const server = createServer((_req, response) => handler(response));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    return await collectModelEvents(provider(protocol, `http://127.0.0.1:${address.port}/v1`, timeoutMs).stream({
      ...request,
      ...(signal === undefined ? {} : { signal }),
    }));
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
}

for (const protocol of ["openai", "anthropic"] as const) {
  describe(`${protocol} local transport deadlines`, () => {
    it("allows a continuously progressing stream to exceed the per-phase timeout", async () => {
      // Real HTTP and shared CI scheduling need headroom. Keep total stream time
      // above the phase deadline so a whole-request timeout still fails this test.
      const phaseTimeoutMs = 1_000;
      let streamStartedAt = 0;
      let streamFinishedAt = 0;
      const events = await localRun(protocol, phaseTimeoutMs, (response) => {
        streamStartedAt = performance.now();
        headers(response, protocol);
        start(response, protocol);
        let count = 0;
        const interval = setInterval(() => {
          content(response, protocol, "x");
          if (++count === 5) {
            clearInterval(interval);
            streamFinishedAt = performance.now();
            finish(response, protocol);
          }
        }, 300);
        response.on("close", () => clearInterval(interval));
      });
      assert.equal(events.filter((event) => event.type === "text_delta").length, 5);
      assert.equal(events.at(-1)?.type, "completed");
      assert.ok(streamFinishedAt - streamStartedAt > phaseTimeoutMs);
      assert.ok(events.some((event) => event.type === "response_activity" && event.phase === "headers"));
      assert.ok(events.some((event) => event.type === "response_activity" && event.phase === "content"));
    });

    it("times out before meaningful content even after headers and heartbeats", async () => {
      const events = await localRun(protocol, 65, (response) => {
        headers(response, protocol);
        const interval = setInterval(() => response.write(protocol === "openai" ? ": ping\n\n" : 'event: ping\ndata: {"type":"ping"}\n\n'), 15);
        response.on("close", () => clearInterval(interval));
      });
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.code, "TIMEOUT");
      assert.equal(terminal.error.transport?.phase, "first_response");
      assert.equal(terminal.error.transport?.timeoutMs, 65);
      assert.equal(terminal.error.transport?.firstResponseMs, null);
      assert.equal(terminal.error.providerRequestId, "local-request-id");
    });

    it("times out before headers and emits no late content", async () => {
      const events = await localRun(protocol, 45, (response) => {
        const late = setTimeout(() => {
          headers(response, protocol);
          start(response, protocol);
          content(response, protocol, "too late");
          finish(response, protocol);
        }, 120);
        response.on("close", () => clearTimeout(late));
      });
      assert.deepEqual(events.map((event) => event.type), ["error"]);
      const terminal = events[0];
      if (terminal?.type === "error") {
        assert.equal(terminal.error.transport?.phase, "first_response");
        assert.equal(terminal.error.providerRequestId, undefined);
      }
    });

    it("times out after content stalls despite heartbeats", async () => {
      const events = await localRun(protocol, 70, (response) => {
        headers(response, protocol);
        start(response, protocol);
        content(response, protocol, "first");
        const interval = setInterval(() => response.write(protocol === "openai" ? ": ping\n\n" : 'event: ping\ndata: {"type":"ping"}\n\n'), 15);
        response.on("close", () => clearInterval(interval));
      });
      assert.equal(events.filter((event) => event.type === "text_delta").length, 1);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.transport?.phase, "stream_idle");
      assert.ok((terminal.error.transport?.lastActivityMs ?? -1) >= 0);
      assert.equal(terminal.error.providerRequestId, "local-request-id");
    });

    it("keeps user cancellation distinct from timeout", async () => {
      const controller = new AbortController();
      const events = await localRun(protocol, 100, (response) => {
        headers(response, protocol);
        start(response, protocol);
        content(response, protocol, "first");
        setTimeout(() => controller.abort(), 20);
      }, controller.signal);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type === "error") assert.equal(terminal.error.code, "ABORTED");
    });

    it("closes the response when the consumer stops iterating after headers", async () => {
      let responseClosed: (() => void) | undefined;
      const closed = new Promise<void>((resolve) => { responseClosed = resolve; });
      const server = createServer((_req, response) => {
        response.on("close", () => responseClosed?.());
        headers(response, protocol);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      try {
        const iterator = provider(protocol, `http://127.0.0.1:${address.port}/v1`, 1_000)
          .stream(request)[Symbol.asyncIterator]();
        assert.deepEqual((await iterator.next()).value?.type, "response_activity");
        await iterator.return?.();
        const closedInTime = await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
        ]);
        assert.equal(closedInTime, true);
      } finally {
        server.closeAllConnections();
        server.close();
        await once(server, "close");
      }
    });
  });
}

it("Anthropic thinking deltas count as private progress without exposing their text", async () => {
  const events = await localRun("anthropic", 75, (response) => {
    headers(response, "anthropic");
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"local-thinking-message-id"}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n');
    let count = 0;
    const interval = setInterval(() => {
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"private thought"}}\n\n');
      if (++count === 4) {
        clearInterval(interval);
        finish(response, "anthropic");
      }
    }, 30);
    response.on("close", () => clearInterval(interval));
  });
  assert.equal(events.at(-1)?.type, "completed");
  assert.equal(events.filter((event) => event.type === "response_activity" && event.phase === "reasoning").length, 4);
  assert.ok(events.every((event) => JSON.stringify(event).includes("private thought") === false));
});
