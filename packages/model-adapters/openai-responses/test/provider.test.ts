import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { collectModelEvents, type ModelRequest } from '../../../runtime/llm/src/index.js';
import { parseProviderConfig, createConfiguredProvider } from '../../../runtime/provider-config/src/index.js';
import { CredentialBroker } from '../../../runtime/credentials/src/index.js';
import { OpenAIResponsesProvider } from '../src/index.js';

const tool = { name: 'read_material', description: '读取材料', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } };
const request: ModelRequest = { requestId: 'r', model: 'test-model', messages: [{ role: 'user', content: '帮我写文章' }], tools: [tool], parameters: { maxOutputTokens: 16000 } };
const event = (res: ServerResponse, value: unknown) => res.write(`data: ${JSON.stringify(value)}\n\n`);

test('Responses times out/cancels an idle stream, sanitizes HTTP errors and refuses unsafe endpoints', async () => {
  let code = 200;
  const server = createServer((_req, res) => {
    if (code !== 200) { res.writeHead(code); res.end(JSON.stringify({ error: { code: 'SECRET_ERROR' } })); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const options = { id: 'test', baseURL: `http://127.0.0.1:${address.port}/v1`, credentialRef: 'test', resolveCredential: async () => 'fake-responses-key',
      models: { 'test-model': { tools: 'supported' as const, usage: 'unknown' as const } }, allowInsecureHttp: true, timeoutMs: 150 };
    for (const [status, expected] of [[401, 'AUTH_FAILED'], [404, 'INVALID_REQUEST'], [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE'], [200, 'TIMEOUT']] as const) {
      code = status;
      const events = await collectModelEvents(new OpenAIResponsesProvider(options).stream(request));
      const terminal = events.at(-1); assert.ok(terminal?.type === 'error'); assert.equal(terminal.error.code, expected);
      assert.equal(JSON.stringify(events).includes('SECRET_ERROR'), false);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30);
    const events = await collectModelEvents(new OpenAIResponsesProvider(options).stream({ ...request, signal: controller.signal }));
    clearTimeout(timer);
    const terminal = events.at(-1); assert.ok(terminal?.type === 'error'); assert.equal(terminal.error.code, 'ABORTED');
    assert.throws(() => new OpenAIResponsesProvider({ ...options, allowInsecureHttp: false }));
    assert.throws(() => new OpenAIResponsesProvider({ ...options, baseURL: 'https://secret@example.test/v1' }));
    const missing = await collectModelEvents(new OpenAIResponsesProvider({ ...options, resolveCredential: async () => undefined }).stream(request));
    const last = missing.at(-1); assert.ok(last?.type === 'error'); assert.equal(last.error.code, 'AUTH_FAILED');
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

async function fixture(events: (res: ServerResponse, body: any, call: number) => void | Promise<void>, run: (provider: ReturnType<typeof createConfiguredProvider>, bodies: any[], recreate: () => ReturnType<typeof createConfiguredProvider>) => Promise<void>) {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/responses');
    assert.equal(req.headers.authorization, 'Bearer fake-responses-key');
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    res.setHeader('content-type', 'text/event-stream');
    await events(res, body, bodies.length);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const config = parseProviderConfig({ schemaVersion: 2, kind: 'openai_responses', providerId: 'responses',
      baseURL: `http://127.0.0.1:${address.port}/v1`, credentialRef: 'env:TEST_KEY', model: 'test-model', tools: 'supported', usage: 'reported', allowInsecureHttp: true });
    const recreate = () => createConfiguredProvider(config, new CredentialBroker({ environment: { TEST_KEY: 'fake-responses-key' } }));
    await run(recreate(), bodies, recreate);
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close'); }
}

test('Responses streams text before completion, then round-trips function calls without duplicate arguments', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await fixture(async (res, _body, call) => {
    if (call === 1) {
      event(res, { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-fixture', summary: [] } });
      event(res, { type: 'response.output_text.delta', delta: '先查看材料。' });
      await gate;
      event(res, { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: tool.name, arguments: '' } });
      event(res, { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"id":' });
      event(res, { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"材料"}' });
      event(res, { type: 'response.function_call_arguments.done', output_index: 1, arguments: '{"id":"材料"}' });
    } else event(res, { type: 'response.output_text.delta', delta: '# 完整稿件\n\n正文。' });
    event(res, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 50, output_tokens: 20, total_tokens: 70 } } }); res.end();
  }, async (provider, bodies, recreate) => {
    const stream = provider.stream(request);
    const first = [];
    for await (const e of stream) { first.push(e); if (e.type === 'text_delta') release(); }
    const call = first.find(e => e.type === 'tool_call_complete'); assert.ok(call && call.type === 'tool_call_complete');
    assert.deepEqual(call.call.arguments, { id: '材料' }); assert.equal(call.call.id, 'call_1');
    assert.equal(first.at(-1)?.type, 'completed');
    assert.ok(first.some(e => e.type === 'usage' && e.usage.totalTokens === 70));
    const next = { ...request, requestId: 'r2', messages: [...request.messages,
      { role: 'assistant' as const, content: '先查看材料。', toolCalls: [call.call] },
      { role: 'tool' as const, toolCallId: call.call.id, name: call.call.name, content: '材料内容' }] };
    // A new adapter and JSON history must retain the opaque continuation (restart/recovery).
    const second = await collectModelEvents(recreate().stream(JSON.parse(JSON.stringify(next))));
    assert.equal(second.at(-1)?.type, 'completed');
    assert.equal(bodies[0].store, false); assert.equal(bodies[0].stream, true);
    assert.equal(bodies[0].max_output_tokens, 16000); assert.equal(bodies[0].tools[0].name, tool.name);
    assert.equal(bodies[0].tools[0].strict, false);
    assert.deepEqual(bodies[1].input[1], { type: 'reasoning', id: 'rs_1', encrypted_content: 'encrypted-fixture', summary: [] });
    assert.ok(bodies[1].input.some((i: any) => i.type === 'function_call_output' && i.call_id === 'call_1' && i.output === '材料内容'));
    assert.equal(JSON.stringify(provider.snapshotRequest(next)).includes('fake-responses-key'), false);
    assert.equal(JSON.stringify(provider.snapshotRequest({ ...next, model: 'another-model' })).includes('encrypted-fixture'), false);
  });
});

for (const [name, terminal] of [['truncated', null], ['incomplete', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }], ['failed', { type: 'response.failed', response: { error: { code: 'server_error', message: 'SECRET_BODY' } } }]] as const) {
  test(`Responses ${name} never releases incomplete tools`, async () => {
    await fixture(res => {
      event(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: tool.name, arguments: '' } });
      event(res, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"id":"x"}' });
      if (terminal) event(res, terminal); res.end();
    }, async provider => {
      const events = await collectModelEvents(provider.stream(request));
      assert.equal(events.some(e => e.type === 'tool_call_complete'), false);
      assert.equal(events.at(-1)?.type, 'error');
      assert.equal(JSON.stringify(events).includes('SECRET_BODY'), false);
    });
  });
}
