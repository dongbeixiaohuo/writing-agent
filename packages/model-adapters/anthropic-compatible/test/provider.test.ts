import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, it } from "node:test";

import {
  collectModelEvents,
  type ModelRequest,
} from "../../../runtime/llm/src/index.js";
import { AnthropicCompatibleProvider } from "../src/index.js";

const fakeApiKey = "test-anthropic-key-not-a-real-secret";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendEvents(
  response: ServerResponse,
  events: readonly { readonly event: string; readonly data: unknown }[],
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "request-id": "anthropic-request-1",
  });
  for (const entry of events) {
    response.write(`event: ${entry.event}\n`);
    response.write(`data: ${JSON.stringify(entry.data)}\n\n`);
  }
  response.end();
}

async function withLocalServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (baseURL: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  if (address === null || typeof address === "string") return;
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    server.close();
    await once(server, "close");
  }
}

function createProvider(baseURL: string): AnthropicCompatibleProvider {
  return new AnthropicCompatibleProvider({
    id: "local-anthropic-compatible",
    baseURL,
    credentialRef: "test/anthropic-compatible",
    resolveCredential: async (reference) => {
      assert.equal(reference, "test/anthropic-compatible");
      return fakeApiKey;
    },
    allowInsecureHttp: true,
    timeoutMs: 2_000,
    defaultMaxOutputTokens: 128,
    models: {
      "fixture-tool-model": { tools: "supported", usage: "reported" },
      "fixture-text-model": { tools: "supported", usage: "reported" },
    },
  });
}

const readMaterialTool = {
  name: "read_material",
  description: "读取已导入材料",
  inputSchema: {
    type: "object",
    properties: { materialId: { type: "string" } },
    required: ["materialId"],
    additionalProperties: false,
  },
} as const;

describe("Anthropic-compatible provider", () => {
  it("uses verified model output defaults and respects explicit request or configuration limits", () => {
    const create = (defaultMaxOutputTokens?: number) => new AnthropicCompatibleProvider({
      id: 'test', baseURL: 'https://api.example.test/v1', credentialRef: 'test/key',
      models: {},
      resolveCredential: async () => fakeApiKey,
      ...(defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens }),
    });
    const request: ModelRequest = { requestId: 'limits', model: 'MiniMax-M3', parameters: {}, messages: [{ role: 'user', content: '研究' }] };
    const automatic = create().snapshotRequest(request);
    assert.equal((automatic.normalizedPayload as any).max_tokens, 131072);
    assert.deepEqual(automatic.outputTokenLimit, { value: 131072, source: 'model_default' });
    assert.equal((create().snapshotRequest({ ...request, model: 'MiniMax-M2.7' }).normalizedPayload as any).max_tokens, 65536);
    assert.equal((create().snapshotRequest({ ...request, model: 'unknown-model' }).normalizedPayload as any).max_tokens, 4096);
    assert.deepEqual(create(2048).snapshotRequest(request).outputTokenLimit, { value: 2048, source: 'configuration' });
    assert.deepEqual(create(2048).snapshotRequest({ ...request, parameters: { maxOutputTokens: 1024 } }).outputTokenLimit,
      { value: 1024, source: 'request' });
  });
  it("round-trips streamed tool use/results without putting the key in snapshots", async () => {
    const bodies: Record<string, unknown>[] = [];
    const apiKeyHeaders: Array<string | undefined> = [];
    const versionHeaders: Array<string | undefined> = [];

    await withLocalServer((request, response) => {
      void (async () => {
        assert.equal(request.url, "/v1/messages");
        apiKeyHeaders.push(
          Array.isArray(request.headers["x-api-key"])
            ? request.headers["x-api-key"][0]
            : request.headers["x-api-key"],
        );
        versionHeaders.push(
          Array.isArray(request.headers["anthropic-version"])
            ? request.headers["anthropic-version"][0]
            : request.headers["anthropic-version"],
        );
        const body = await readJson(request);
        bodies.push(body);

        if (bodies.length === 1) {
          sendEvents(response, [
            {
              event: "message_start",
              data: {
                type: "message_start",
                message: {
                  id: "msg-tool-1",
                  usage: {
                    input_tokens: 21,
                    cache_read_input_tokens: 3,
                    cache_creation_input_tokens: 0,
                    output_tokens: 1,
                  },
                },
              },
            },
            {
              event: "content_block_start",
              data: {
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "tool_use",
                  id: "toolu-material-1",
                  name: "read_material",
                  input: {},
                },
              },
            },
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: "{\"material",
                },
              },
            },
            {
              event: "content_block_delta",
              data: {
                type: "content_block_delta",
                index: 0,
                delta: {
                  type: "input_json_delta",
                  partial_json: "Id\":\"material-1\"}",
                },
              },
            },
            {
              event: "content_block_stop",
              data: { type: "content_block_stop", index: 0 },
            },
            {
              event: "message_delta",
              data: {
                type: "message_delta",
                delta: { stop_reason: "tool_use", stop_sequence: null },
                usage: { output_tokens: 5 },
              },
            },
            { event: "message_stop", data: { type: "message_stop" } },
          ]);
          return;
        }

        sendEvents(response, [
          {
            event: "message_start",
            data: {
              type: "message_start",
              message: {
                id: "msg-text-1",
                usage: { input_tokens: 30, output_tokens: 1 },
              },
            },
          },
          {
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          },
          {
            event: "content_block_delta",
            data: {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "材料正文已整理。" },
            },
          },
          {
            event: "content_block_stop",
            data: { type: "content_block_stop", index: 0 },
          },
          {
            event: "message_delta",
            data: {
              type: "message_delta",
              delta: { stop_reason: "end_turn", stop_sequence: null },
              usage: { output_tokens: 8 },
            },
          },
          { event: "message_stop", data: { type: "message_stop" } },
        ]);
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const firstRequest: ModelRequest = {
        requestId: "anthropic-tool-1",
        model: "fixture-tool-model",
        messages: [
          { role: "system", content: "只使用已声明工具。" },
          { role: "user", content: "读取材料" },
        ],
        tools: [readMaterialTool],
        parameters: {
          temperature: 0,
          maxOutputTokens: 128,
          toolChoice: "required",
        },
      };
      const firstSnapshot = provider.snapshotRequest(firstRequest);
      const first = await collectModelEvents(provider.stream(firstRequest));
      const completedCall = first.find(
        (event) => event.type === "tool_call_complete",
      );
      assert.equal(completedCall?.type, "tool_call_complete");
      if (completedCall?.type !== "tool_call_complete") return;

      const secondRequest: ModelRequest = {
        requestId: "anthropic-text-1",
        model: "fixture-text-model",
        messages: [
          { role: "system", content: "只使用已声明工具。" },
          { role: "user", content: "读取材料" },
          { role: "assistant", content: "", toolCalls: [completedCall.call] },
          {
            role: "tool",
            toolCallId: completedCall.call.id,
            name: completedCall.call.name,
            content: "材料正文",
          },
        ],
        tools: [readMaterialTool],
        parameters: { temperature: 0, maxOutputTokens: 128 },
      };
      const secondSnapshot = provider.snapshotRequest(secondRequest);
      const second = await collectModelEvents(provider.stream(secondRequest));

      assert.deepEqual(
        first.filter((event) => event.type !== "response_activity").map((event) => event.type),
        [
          "tool_call_delta",
          "tool_call_delta",
          "tool_call_delta",
          "usage",
          "tool_call_complete",
          "completed",
        ],
      );
      assert.deepEqual(
        second.filter((event) => event.type !== "response_activity").map((event) => event.type),
        ["text_delta", "usage", "completed"],
      );
      assert.equal(
        second.find((event) => event.type === "text_delta")?.delta,
        "材料正文已整理。",
      );
      assert.equal(firstSnapshot.serializationVersion, provider.adapterVersion);
      assert.deepEqual(firstSnapshot.normalizedPayload, bodies[0]);
      assert.deepEqual(secondSnapshot.normalizedPayload, bodies[1]);
      assert.deepEqual(firstSnapshot.redactions, ["x-api-key"]);
      assert.deepEqual(firstSnapshot.unreconstructableFields, ["x-api-key"]);
      assert.deepEqual(bodies[0], {
        model: "fixture-tool-model",
        max_tokens: 128,
        system: "只使用已声明工具。",
        messages: [{ role: "user", content: "读取材料" }],
        stream: true,
        tools: [
          {
            name: "read_material",
            description: "读取已导入材料",
            input_schema: readMaterialTool.inputSchema,
          },
        ],
        temperature: 0,
        tool_choice: { type: "any" },
      });
      assert.deepEqual(bodies[1]?.messages, [
        { role: "user", content: "读取材料" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-material-1",
              name: "read_material",
              input: { materialId: "material-1" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu-material-1",
              content: "材料正文",
            },
          ],
        },
      ]);
      assert.deepEqual(apiKeyHeaders, [fakeApiKey, fakeApiKey]);
      assert.deepEqual(versionHeaders, ["2023-06-01", "2023-06-01"]);
      assert.equal(JSON.stringify(bodies).includes(fakeApiKey), false);
      assert.equal(provider.maxRetries, 0);
      assert.equal(provider.capabilities.protocol, "anthropic-messages");
    });
  });

  it("completes a compatible stream that omits usage without inventing zero cost", async () => {
    await withLocalServer((_request, response) => {
      sendEvents(response, [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: { id: "msg-no-usage", content: [] },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "OK" },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "anthropic-no-usage",
          model: "fixture-text-model",
          messages: [{ role: "user", content: "仅回复 OK" }],
          parameters: { maxOutputTokens: 16 },
        }),
      );

      assert.deepEqual(
        events.filter((event) => event.type !== "response_activity").map((event) => event.type),
        ["text_delta", "completed"],
      );
      assert.equal(JSON.stringify(events).includes('"amount":0'), false);
    });
  });

  it("preserves a complete tool input supplied in content_block_start", async () => {
    await withLocalServer((_request, response) => {
      sendEvents(response, [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg-complete-input",
              usage: { input_tokens: 4, output_tokens: 1 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu-complete-input",
              name: "read_material",
              input: { materialId: "material-complete" },
            },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "anthropic-complete-input",
          model: "fixture-tool-model",
          messages: [{ role: "user", content: "读取材料" }],
          tools: [readMaterialTool],
          parameters: {
            maxOutputTokens: 32,
            toolChoice: "required",
          },
        }),
      );
      const call = events.find((event) => event.type === "tool_call_complete");
      assert.equal(call?.type, "tool_call_complete");
      if (call?.type !== "tool_call_complete") return;
      assert.deepEqual(call.call.arguments, { materialId: "material-complete" });
    });
  });

  it("classifies auth, route/model 404, quota, rate-limit and 5xx responses without exposing provider bodies", async () => {
    await withLocalServer((request, response) => {
      void (async () => {
        const body = await readJson(request);
        const model = String(body.model);
        const cases: Record<
          string,
          { status: number; type: string; message: string; retryAfter?: string }
        > = {
          "wrong-key": {
            status: 401,
            type: "authentication_error",
            message: `invalid ${fakeApiKey}`,
          },
          "no-quota": {
            status: 400,
            type: "billing_error",
            message: `credit balance at C:\\private\\key.txt`,
          },
          "rate-limited": {
            status: 429,
            type: "rate_limit_error",
            message: "too many requests",
            retryAfter: "1.5",
          },
          unavailable: {
            status: 503,
            type: "overloaded_error",
            message: "temporarily unavailable",
          },
          "missing-route": {
            status: 404,
            type: "not_found_error",
            message: "route not found",
          },
          "unknown-model": {
            status: 404,
            type: "not_found_error",
            message: "model MiniMax-X not found",
          },
        };
        const selected = cases[model];
        assert.notEqual(selected, undefined);
        if (selected === undefined) return;
        response.writeHead(selected.status, {
          "content-type": "application/json",
          "request-id": `anthropic-${model}`,
          ...(selected.retryAfter === undefined
            ? {}
            : { "retry-after": selected.retryAfter }),
        });
        response.end(
          JSON.stringify({
            type: "error",
            error: { type: selected.type, message: selected.message },
          }),
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const cases = [
        ["wrong-key", "AUTH_FAILED", false],
        ["no-quota", "QUOTA_EXCEEDED", false],
        ["rate-limited", "RATE_LIMITED", true],
        ["unavailable", "PROVIDER_UNAVAILABLE", true],
        ["missing-route", "INVALID_REQUEST", false],
        ["unknown-model", "MODEL_UNSUPPORTED", false],
      ] as const;

      for (const [model, expectedCode, retryable] of cases) {
        const events = await collectModelEvents(
          provider.stream({
            requestId: `anthropic-${model}`,
            model,
            messages: [{ role: "user", content: "连接测试" }],
            parameters: { maxOutputTokens: 16 },
          }),
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]?.type, "error");
        if (events[0]?.type !== "error") continue;
        assert.equal(events[0].error.code, expectedCode);
        assert.equal(events[0].error.retryable, retryable);
        assert.equal(events[0].error.providerRequestId, `anthropic-${model}`);
        assert.equal(JSON.stringify(events).includes(fakeApiKey), false);
        assert.equal(JSON.stringify(events).includes("C:\\private"), false);
        if (model === "rate-limited") {
          assert.equal(events[0].error.retryAfterMs, 1_500);
        }
      }
    });
  });

  it("rejects a stream truncated after its finish delta", async () => {
    await withLocalServer((_request, response) => {
      sendEvents(response, [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg-truncated",
              usage: { input_tokens: 2, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial" },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
        },
      ]);
    }, async (baseURL) => {
      const events = await collectModelEvents(
        createProvider(baseURL).stream({
          requestId: "anthropic-truncated",
          model: "fixture-text-model",
          messages: [{ role: "user", content: "测试截断" }],
          parameters: { maxOutputTokens: 16 },
        }),
      );

      assert.deepEqual(
        events.filter((event) => event.type !== "response_activity").map((event) => event.type),
        ["text_delta", "usage", "error"],
      );
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.code, "MODEL_RESPONSE_INVALID");
      assert.equal(terminal.error.providerRequestId, "anthropic-request-1");
    });
  });

  for (const stopReason of ['tool_use', 'max_tokens']) it(`rejects truncated tool JSON without executing it (${stopReason})`, async () => {
    await withLocalServer((_request, response) => {
      sendEvents(response, [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "msg-bad-json",
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "toolu-bad-json",
              name: "read_material",
              input: {},
            },
          },
        },
        {
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: '{"materialId":"unfinished',
            },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: stopReason },
            usage: { output_tokens: stopReason === 'max_tokens' ? 4096 : 5 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ]);
    }, async (baseURL) => {
      const events = await collectModelEvents(
        createProvider(baseURL).stream({
          requestId: "anthropic-bad-json",
          model: "fixture-tool-model",
          messages: [{ role: "user", content: "读取材料" }],
          tools: [readMaterialTool],
          parameters: { maxOutputTokens: stopReason === 'max_tokens' ? 4096 : 16, toolChoice: "required" },
        }),
      );

      assert.equal(events.at(-1)?.type, "error");
      const terminal = events.at(-1);
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.code, stopReason === 'max_tokens' ? 'MODEL_OUTPUT_TRUNCATED' : 'MODEL_RESPONSE_INVALID');
      if (stopReason === 'max_tokens') assert.ok(terminal.error.providerRequestId);
      assert.equal(
        events.some((event) => event.type === "tool_call_complete"),
        false,
      );
    });
  });

  it("propagates cancellation while waiting for the next stream event", async () => {
    await withLocalServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "request-id": "anthropic-abort-1",
      });
      response.write(
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg-abort",
            usage: { input_tokens: 2, output_tokens: 0 },
          },
        })}\n\n`,
      );
      response.write(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        })}\n\n`,
      );
      response.write(
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "start" },
        })}\n\n`,
      );
    }, async (baseURL) => {
      const controller = new AbortController();
      const iterator = createProvider(baseURL)
        .stream({
          requestId: "anthropic-abort",
          model: "fixture-text-model",
          messages: [{ role: "user", content: "开始后停止" }],
          parameters: { maxOutputTokens: 16 },
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();

      let first = await iterator.next();
      while (first.value?.type === "response_activity") first = await iterator.next();
      assert.equal(first.value?.type, "text_delta");
      controller.abort("fixture cancellation");
      const terminal = await iterator.next();
      assert.equal(terminal.value?.type, "error");
      if (terminal.value?.type !== "error") return;
      assert.equal(terminal.value.error.code, "ABORTED");
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    });
  });
});
