import assert from 'node:assert/strict';
import test from 'node:test';
import * as search from '../src/fact-search.js';

test('external search is fail-closed without host authorization, including short private queries', async () => {
  let requests = 0;
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: false }),
    fetch: async () => { requests++; throw new Error('must not send'); } });
  for (const query of ['客户张先生的未公开合同金额', 'account private@example.test', '公开事实问题']) {
    const result = await scope.search(query);
    assert.equal(result.mode, 'unavailable');
    assert.match(result.notice, /未获.*授权/);
  }
  assert.equal(requests, 0);
});

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

test('host sees exact query and enabled destinations; refusal stops this run without network or retry prompts', async () => {
  const approvals: unknown[] = []; let requests = 0;
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: true,
    authorizeQuery: async request => { approvals.push(request); return false; } }),
    fetch: async () => { requests++; throw new Error('must not send'); } });
  await scope.search('  私人合同摘录  ', undefined, 'r');
  await scope.search('改写后的同一个私人问题', undefined, 'r');
  assert.deepEqual(approvals, [{ query: '私人合同摘录', providers: ['parallel', 'tavily'], runId: 'r' }]);
  assert.equal(requests, 0);
});

test('cancelling while author approval is pending prevents all network calls', async () => {
  const controller = new AbortController(); let calls = 0;
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true,
    authorizeQuery: async () => { controller.abort(); return true; } }),
    fetch: async () => { calls++; return Response.json({ results: [] }); } });
  await assert.rejects(scope.search('公开问题', controller.signal));
  assert.equal(calls, 0);
});

test('Tavily uses an authorization header and returns bounded untrusted evidence', async () => {
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, authorizeQuery: async () => true, getTavilyKey: async () => 'private-test-key' }),
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
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: true, authorizeQuery: async () => true, getTavilyKey: async () => 'test-key' }),
    fetch: async url => { urls.push(String(url)); return String(url).includes('parallel') ? new Response('no', { status: 429 }) : Response.json({ results: [] }); } });
  const result = await scope.search('public fact');
  assert.equal(result.provider, 'tavily');
  assert.equal(urls.length, 2);
  assert.match(result.notice, /Parallel/);
  const failed = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: false, authorizeQuery: async () => true }),
    fetch: async () => { throw new Error('private-provider-error'); } });
  const outcome = await failed.search('public fact');
  assert.equal(outcome.mode, 'unavailable');
  assert.ok(!JSON.stringify(outcome).includes('private-provider-error'));
});

test('Parallel MCP handshake and SSE tool response produce evidence; repeated queries use cache', async () => {
  const methods: string[] = [];
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: false, authorizeQuery: async () => true }),
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
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, authorizeQuery: async () => true, getTavilyKey: async () => 'test' }),
    fetch: async () => { calls++; return Response.json({ results: [] }); } });
  for (let i = 0; i < 7; i++) await scope.search(`query ${i}`);
  assert.equal(calls, 6);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(scope.search('new run', controller.signal, 'r2'));
  assert.equal(calls, 6);
});

test('search aborts promptly while host authorization ignores the supplied signal', async () => {
  const controller = new AbortController();
  let requests = 0;
  const scope = search.createFactSearchTools({
    configuration: () => ({
      parallelEnabled: true,
      tavilyEnabled: false,
      authorizeQuery: async () => await new Promise<boolean>(() => undefined),
    }),
    fetch: async () => { requests++; throw new Error('must not send'); },
    overallTimeoutMs: 1_000,
  });

  const pending = scope.search('public fact', controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError');
  assert.equal(requests, 0);
});

test('search has an overall bound even when host authorization never settles', async () => {
  let requests = 0;
  const scope = search.createFactSearchTools({
    configuration: () => ({
      parallelEnabled: true,
      tavilyEnabled: false,
      authorizeQuery: async () => await new Promise<boolean>(() => undefined),
    }),
    fetch: async () => { requests++; throw new Error('must not send'); },
    overallTimeoutMs: 20,
  });

  const result = await scope.search('public fact');
  assert.equal(result.mode, 'unavailable');
  assert.equal(result.failureCode, 'SEARCH_TIMEOUT');
  assert.match(result.notice, /SEARCH_TIMEOUT/);
  assert.equal(requests, 0);
});

test('each provider request is bounded and Parallel timeout can fall back to Tavily', async () => {
  const requested: string[] = [];
  const scope = search.createFactSearchTools({
    configuration: () => ({
      parallelEnabled: true,
      tavilyEnabled: true,
      authorizeQuery: async () => true,
      getTavilyKey: async () => 'test-key',
    }),
    requestTimeoutMs: 15,
    overallTimeoutMs: 200,
    fetch: async url => {
      requested.push(String(url));
      if (String(url).includes('parallel')) return await new Promise<Response>(() => undefined);
      return Response.json({ results: [{ title: 'Official', url: 'https://example.com/fact', content: 'evidence' }] });
    },
  });

  const result = await scope.search('public fact');
  assert.equal(result.mode, 'external');
  assert.equal(result.provider, 'tavily');
  assert.deepEqual(requested, ['https://search.parallel.ai/mcp', 'https://api.tavily.com/search']);
});

test('the per-request bound includes reading a response body that never completes', async () => {
  const requested: string[] = [];
  const scope = search.createFactSearchTools({
    configuration: () => ({
      parallelEnabled: true,
      tavilyEnabled: true,
      authorizeQuery: async () => true,
      getTavilyKey: async () => 'test-key',
    }),
    requestTimeoutMs: 15,
    overallTimeoutMs: 200,
    fetch: async url => {
      requested.push(String(url));
      if (String(url).includes('parallel')) {
        return new Response(new ReadableStream({ start() { /* intentionally never closes */ } }), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }
      return Response.json({ results: [{ title: 'Official', url: 'https://example.com/fact', content: 'evidence' }] });
    },
  });

  const result = await Promise.race([
    scope.search('public fact'),
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('search did not honor the response-body deadline')), 1_000);
      timer.unref?.();
    }),
  ]);
  assert.equal(result.provider, 'tavily');
  assert.deepEqual(requested, ['https://search.parallel.ai/mcp', 'https://api.tavily.com/search']);
});

test('one search shares a hard overall deadline across provider fallback', async () => {
  const scope = search.createFactSearchTools({
    configuration: () => ({
      parallelEnabled: true,
      tavilyEnabled: true,
      authorizeQuery: async () => true,
      getTavilyKey: async () => 'test-key',
    }),
    requestTimeoutMs: 1_000,
    overallTimeoutMs: 25,
    fetch: async () => await new Promise<Response>(() => undefined),
  });

  const startedAt = Date.now();
  const result = await scope.search('public fact');
  const elapsedMs = Date.now() - startedAt;
  assert.equal(result.mode, 'unavailable');
  assert.equal(result.failureCode, 'SEARCH_TIMEOUT');
  assert.ok(elapsedMs < 250, `search took ${elapsedMs}ms`);
});
