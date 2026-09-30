import assert from 'node:assert/strict';
import test from 'node:test';
import * as search from '../src/fact-search.js';

test('disabled search never makes a network request', async () => {
  assert.equal(typeof search.createFactSearchTools, 'function');
  let requests = 0;
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: false }),
    fetch: async () => { requests++; throw new Error('network must not run'); } });
  const result = await scope.search('a public factual question');
  assert.equal(result.mode, 'model_only');
  assert.equal(requests, 0);
  assert.match(scope.instructions(), /未联网/);
});

test('Tavily uses an authorization header and returns bounded untrusted evidence', async () => {
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, getTavilyKey: async () => 'private-test-key' }),
    fetch: async (url, init) => {
      assert.equal(String(url), 'https://api.tavily.com/search');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer private-test-key');
      assert.ok(!String(init?.body).includes('private-test-key'));
      return Response.json({ results: [{ title: 'Official', url: 'https://example.com/fact', content: 'Supporting evidence' }] });
    } });
  const result = await scope.search('public fact');
  assert.equal(result.provider, 'tavily');
  assert.equal(result.instructionAuthority, 'none');
  assert.ok(JSON.stringify(result).includes('Supporting evidence'));
  assert.ok(!JSON.stringify(result).includes('private-test-key'));
  assert.equal(scope.isDiscoveredSource('https://example.com/fact', 'direct'), true);
  assert.equal(scope.isDiscoveredSource('https://example.com/fact', 'other-run'), false);
});

test('Parallel failure falls back only to enabled Tavily, failures never imply verification', async () => {
  const urls: string[] = [];
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: true, getTavilyKey: async () => 'test-key' }),
    fetch: async url => { urls.push(String(url)); return String(url).includes('parallel') ? new Response('no', { status: 429 }) : Response.json({ results: [] }); } });
  const result = await scope.search('public fact');
  assert.equal(result.provider, 'tavily');
  assert.equal(urls.length, 2);
  assert.match(result.notice, /Parallel/);
  const failed = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: false }),
    fetch: async () => { throw new Error('private-provider-error'); } });
  const outcome = await failed.search('public fact');
  assert.equal(outcome.mode, 'unavailable');
  assert.ok(!JSON.stringify(outcome).includes('private-provider-error'));
});

test('Parallel MCP handshake and SSE tool response produce evidence; repeated queries use cache', async () => {
  const methods: string[] = [];
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: false }),
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); methods.push(body.method);
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      assert.equal(body.params.name, 'web_search');
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Official https://example.com/fact explains the fact.' }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    } });
  const first = await scope.search('public fact');
  const second = await scope.search('public fact');
  assert.deepEqual(second, first);
  assert.equal(first.provider, 'parallel');
  assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call']);
});

test('model-only instructions distinguish knowledge review from external evidence', () => {
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: false }) });
  assert.match(scope.instructions(), /model-knowledge:unverified/);
  assert.match(scope.instructions(), /不确定/);
});

test('search is bounded per run, cancellation does not trigger paid fallback', async () => {
  let calls = 0;
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, getTavilyKey: async () => 'test' }),
    fetch: async () => { calls++; return Response.json({ results: [] }); } });
  for (let i = 0; i < 7; i++) await scope.search(`query ${i}`);
  assert.equal(calls, 6);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scope.search('new run', controller.signal, 'r2'));
  assert.equal(calls, 6);
});
