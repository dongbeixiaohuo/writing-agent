import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { describe, it } from "node:test";

import { collectModelEvents, type ModelRequest } from "../../../runtime/llm/src/index.js";
import { OpenAICompatibleProvider } from "../src/index.js";

const fakeApiKey = "test-key-not-a-real-secret";

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendSse(response: ServerResponse, chunks: readonly unknown[]): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "x-request-id": "provider-request-1",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
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

function createProvider(baseURL: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id: "local-openai-compatible",
    baseURL,
    credentialRef: "test/openai-compatible",
    resolveCredential: async (reference) => {
      assert.equal(reference, "test/openai-compatible");
      return fakeApiKey;
    },
    allowInsecureHttp: true,
    timeoutMs: 2_000,
    models: {
      "mock-tool-model": { tools: "supported", usage: "reported" },
      "mock-text-model": { tools: "supported", usage: "reported" },
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

describe("OpenAI-compatible provider", () => {
  it("round-trips streamed tool calls/results and then streams article text", async () => {
    const bodies: Record<string, unknown>[] = [];
    const authorizationHeaders: Array<string | undefined> = [];

    await withLocalServer((request, response) => {
      void (async () => {
        assert.equal(request.url, "/v1/chat/completions");
        authorizationHeaders.push(request.headers.authorization);
        const body = await readJson(request);
        bodies.push(body);

        if (bodies.length === 1) {
          sendSse(response, [
            {
              id: "chatcmpl-tool-1",
              choices: [
                {
                  index: 0,
                  delta: {
                    role: "assistant",
                    tool_calls: [
                      {
                        index: 0,
                        id: "call-material-1",
                        type: "function",
                        function: {
                          name: "read_material",
                          arguments: "{\"material",
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-tool-1",
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        function: { arguments: "Id\":\"material-1\"}" },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "chatcmpl-tool-1",
              choices: [
                { index: 0, delta: {}, finish_reason: "tool_calls" },
              ],
            },
            {
              id: "chatcmpl-tool-1",
              choices: [],
              usage: {
                prompt_tokens: 21,
                completion_tokens: 5,
                total_tokens: 26,
              },
            },
          ]);
          return;
        }

        sendSse(response, [
          {
            id: "chatcmpl-text-1",
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "材料正文已整理。" },
                finish_reason: null,
              },
            ],
          },
          {
            id: "chatcmpl-text-1",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          },
          {
            id: "chatcmpl-text-1",
            choices: [],
            usage: {
              prompt_tokens: 30,
              completion_tokens: 8,
              total_tokens: 38,
            },
          },
        ]);
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const firstRequest: ModelRequest = {
        requestId: "request-tool-1",
        model: "mock-tool-model",
        messages: [{ role: "user", content: "读取材料" }],
        tools: [readMaterialTool],
        parameters: { temperature: 0, toolChoice: "required" },
      };
      const firstSnapshot = provider.snapshotRequest(firstRequest);
      const first = await collectModelEvents(
        provider.stream(firstRequest),
      );

      assert.deepEqual(first.filter((event) => event.type !== "response_activity").map((event) => event.type), [
        "tool_call_delta",
        "tool_call_delta",
        "usage",
        "tool_call_complete",
        "completed",
      ]);
      const completedCall = first.find(
        (event) => event.type === "tool_call_complete",
      );
      assert.equal(completedCall?.type, "tool_call_complete");
      if (completedCall?.type !== "tool_call_complete") return;

      const secondRequest: ModelRequest = {
        requestId: "request-text-1",
        model: "mock-text-model",
        messages: [
          { role: "user", content: "读取材料" },
          {
            role: "assistant",
            content: "",
            toolCalls: [completedCall.call],
          },
          {
            role: "tool",
            toolCallId: completedCall.call.id,
            name: completedCall.call.name,
            content: "材料正文",
          },
        ],
        tools: [readMaterialTool],
        parameters: { temperature: 0 },
      };
      const secondSnapshot = provider.snapshotRequest(secondRequest);
      const second = await collectModelEvents(provider.stream(secondRequest));

      assert.deepEqual(second.filter((event) => event.type !== "response_activity").map((event) => event.type), [
        "text_delta",
        "usage",
        "completed",
      ]);
      assert.equal(
        second.find((event) => event.type === "text_delta")?.delta,
        "材料正文已整理。",
      );
      assert.equal(bodies.length, 2);
      assert.deepEqual(firstSnapshot.normalizedPayload, bodies[0]);
      assert.deepEqual(secondSnapshot.normalizedPayload, bodies[1]);
      assert.equal(firstSnapshot.serializationVersion, provider.adapterVersion);
      assert.deepEqual(firstSnapshot.redactions, ["authorization"]);
      assert.equal(bodies[0]?.tool_choice, "required");
      assert.deepEqual(bodies[1]?.messages, [
        { role: "user", content: "读取材料" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-material-1",
              type: "function",
              function: {
                name: "read_material",
                arguments: "{\"materialId\":\"material-1\"}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call-material-1",
          content: "材料正文",
        },
      ]);
      assert.deepEqual(authorizationHeaders, [
        `Bearer ${fakeApiKey}`,
        `Bearer ${fakeApiKey}`,
      ]);
      assert.equal(JSON.stringify(bodies).includes(fakeApiKey), false);
      assert.equal(provider.maxRetries, 0);
    });
  });

  it("classifies auth, model, quota, rate-limit and 5xx responses without SDK retries", async () => {
    const seenModels: string[] = [];
    await withLocalServer((request, response) => {
      void (async () => {
        const body = await readJson(request);
        const model = String(body.model);
        seenModels.push(model);
        const cases: Record<
          string,
          { status: number; code: string; type: string; retryAfter?: string }
        > = {
          "wrong-key": { status: 401, code: "invalid_api_key", type: "authentication_error" },
          "bad-model": { status: 404, code: "model_not_found", type: "invalid_request_error" },
          "no-quota": { status: 429, code: "insufficient_quota", type: "insufficient_quota" },
          "rate-limited": { status: 429, code: "rate_limit_exceeded", type: "rate_limit_error", retryAfter: "2" },
          unavailable: { status: 503, code: "server_error", type: "server_error" },
        };
        const selected = cases[model];
        assert.notEqual(selected, undefined);
        if (selected === undefined) return;
        response.writeHead(selected.status, {
          "content-type": "application/json",
          "x-request-id": `request-${model}`,
          ...(selected.retryAfter === undefined
            ? {}
            : { "retry-after": selected.retryAfter }),
        });
        response.end(
          JSON.stringify({
            error: {
              message: `fixture ${model}`,
              code: selected.code,
              type: selected.type,
            },
          }),
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const cases = [
        ["wrong-key", "AUTH_FAILED", false],
        ["bad-model", "MODEL_UNSUPPORTED", false],
        ["no-quota", "QUOTA_EXCEEDED", false],
        ["rate-limited", "RATE_LIMITED", true],
        ["unavailable", "PROVIDER_UNAVAILABLE", true],
      ] as const;

      for (const [model, expectedCode, expectedRetryable] of cases) {
        const events = await collectModelEvents(
          provider.stream({
            requestId: `request-${model}`,
            model,
            messages: [{ role: "user", content: "连接测试" }],
            parameters: {},
          }),
        );
        assert.equal(events.length, 1);
        assert.equal(events[0]?.type, "error");
        if (events[0]?.type !== "error") continue;
        assert.equal(events[0].error.code, expectedCode);
        assert.equal(events[0].error.retryable, expectedRetryable);
        if (model === "rate-limited") {
          assert.equal(events[0].error.retryAfterMs, 2_000);
        }
      }

      assert.deepEqual(seenModels, cases.map(([model]) => model));
    });
  });

  it("exposes a sanitized, credential-masked and truncated upstream error detail", async () => {
    await withLocalServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: `unknown parameter: include\n参见 ${fakeApiKey} ${"x".repeat(500)}`,
            code: "invalid_request_error",
            type: "invalid_request_error",
            debug: "RAW_BODY_MARKER",
          },
        }),
      );
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "request-upstream-detail",
          model: "mock-text-model",
          messages: [{ role: "user", content: "连接测试" }],
          parameters: {},
        }),
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "error");
      if (events[0]?.type !== "error") return;
      assert.equal(events[0].error.code, "INVALID_REQUEST");
      const detail = events[0].error.providerDetail;
      assert.equal(typeof detail, "string");
      if (typeof detail !== "string") return;
      assert.ok(detail.startsWith("unknown parameter: include 参见 *** "), detail);
      assert.equal(detail.includes(fakeApiKey), false);
      assert.ok(detail.endsWith("…"), detail);
      assert.ok(detail.length <= 241, detail);
      // eslint-disable-next-line no-control-regex
      assert.equal(/[\x00-\x1F\x7F-\x9F]/u.test(detail), false);
      assert.equal(JSON.stringify(events).includes("RAW_BODY_MARKER"), false);
    });
  });

  it("omits the upstream detail when the error message is missing or not a string", async () => {
    await withLocalServer((_request, response) => {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "invalid_request_error", type: "invalid_request_error" } }));
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "request-upstream-detail-missing",
          model: "mock-text-model",
          messages: [{ role: "user", content: "连接测试" }],
          parameters: {},
        }),
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "error");
      if (events[0]?.type !== "error") return;
      assert.equal(events[0].error.code, "INVALID_REQUEST");
      assert.equal(events[0].error.providerDetail, undefined);
    });
  });

  it("merges vendor extraBody into the wire body without overriding protocol fields", async () => {
    const bodies: Record<string, unknown>[] = [];
    await withLocalServer((request, response) => {
      void (async () => {
        bodies.push(await readJson(request));
        sendSse(response, [
          { id: "chatcmpl-text-1", choices: [{ index: 0, delta: { role: "assistant", content: "完成。" }, finish_reason: null }] },
          { id: "chatcmpl-text-1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { id: "chatcmpl-text-1", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
        ]);
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    }, async (baseURL) => {
      const provider = new OpenAICompatibleProvider({
        id: "local-openai-extra",
        baseURL,
        credentialRef: "test/openai-compatible",
        resolveCredential: async () => fakeApiKey,
        allowInsecureHttp: true,
        timeoutMs: 2_000,
        models: { "mock-text-model": { tools: "supported", usage: "reported" } },
        extraBody: { thinking: { type: "disabled" }, model: "must-not-win", stream: false },
      });
      const request = {
        requestId: "request-extra-body",
        model: "mock-text-model",
        messages: [{ role: "user" as const, content: "连接测试" }],
        parameters: {},
      };
      const events = await collectModelEvents(provider.stream(request));
      assert.equal(events.at(-1)?.type, "completed");
      assert.equal(bodies.length, 1);
      assert.deepEqual(bodies[0]?.thinking, { type: "disabled" });
      assert.equal(bodies[0]?.model, "mock-text-model");
      assert.equal(bodies[0]?.stream, true);
      const snapshot = provider.snapshotRequest(request);
      assert.deepEqual(
        (snapshot.normalizedPayload as Record<string, unknown>).thinking,
        { type: "disabled" },
      );
    });
  });

  it("classifies a transport reset as a retryable network error", async () => {
    await withLocalServer((request) => {
      request.socket.destroy();
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "request-network-reset-1",
          model: "mock-text-model",
          messages: [{ role: "user", content: "连接测试" }],
          parameters: {},
        }),
      );

      assert.equal(events.length, 1);
      assert.equal(events[0]?.type, "error");
      if (events[0]?.type !== "error") return;
      assert.equal(events[0].error.code, "NETWORK_ERROR");
      assert.equal(events[0].error.retryable, true);
    });
  });

  it("fails closed when the credential reference cannot be resolved", async () => {
    const provider = new OpenAICompatibleProvider({
      id: "missing-key",
      baseURL: "https://example.invalid/v1",
      credentialRef: "missing/key",
      resolveCredential: async () => undefined,
      models: {},
    });

    const events = await collectModelEvents(
      provider.stream({
        requestId: "request-missing-key",
        model: "any-model",
        messages: [{ role: "user", content: "不会发送" }],
        parameters: {},
      }),
    );

    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "error");
    if (events[0]?.type !== "error") return;
    assert.equal(events[0].error.code, "AUTH_FAILED");
    assert.equal(JSON.stringify(events).includes("missing/key"), false);
  });

  it("rejects a truncated SSE stream even when a finish reason arrived", async () => {
    await withLocalServer((_request, response) => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-request-id": "provider-truncated-1",
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: "未完成" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.end(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
    }, async (baseURL) => {
      const provider = createProvider(baseURL);
      const events = await collectModelEvents(
        provider.stream({
          requestId: "request-truncated-1",
          model: "mock-text-model",
          messages: [{ role: "user", content: "测试截断" }],
          parameters: {},
        }),
      );

      assert.deepEqual(events.filter((event) => event.type !== "response_activity").map((event) => event.type), ["text_delta", "error"]);
      const terminal = events.at(-1);
      assert.equal(terminal?.type, "error");
      if (terminal?.type !== "error") return;
      assert.equal(terminal.error.code, "MODEL_RESPONSE_INVALID");
      assert.equal(terminal.error.providerRequestId, "provider-truncated-1");
    });
  });

  it("propagates abort while waiting for the next SSE frame", async () => {
    let responseRef: ServerResponse | undefined;
    await withLocalServer((_request, response) => {
      responseRef = response;
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              index: 0,
              delta: { content: "开始" },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
    }, async (baseURL) => {
      const controller = new AbortController();
      const provider = createProvider(baseURL);
      const iterator = provider
        .stream({
          requestId: "request-abort-live-1",
          model: "mock-text-model",
          messages: [{ role: "user", content: "开始后停止" }],
          parameters: {},
          signal: controller.signal,
        })
        [Symbol.asyncIterator]();

      let first = await iterator.next();
      while (first.value?.type === "response_activity") first = await iterator.next();
      assert.equal(first.value?.type, "text_delta");
      controller.abort("用户停止");
      const terminal = await iterator.next();
      assert.equal(terminal.value?.type, "error");
      if (terminal.value?.type !== "error") return;
      assert.equal(terminal.value.error.code, "ABORTED");
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    });
    responseRef?.destroy();
  });
});
