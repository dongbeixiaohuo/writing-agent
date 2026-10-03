import assert from 'node:assert/strict';
import test from 'node:test';
import * as search from '../src/fact-search.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createToolPermissionGrant } from '../../runtime/tools/src/index.js';

test('HTTP sources returned by search remain discovered without changing their protocol', async () => {
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true,
    getTavilyKey: async () => 'test-key', authorizeQuery: async () => true }),
    fetch: async () => Response.json({ results: [{ url: 'http://www.scio.gov.cn/report.html', content: '公开原文' }] }) });
  await scope.search('公开日期', undefined, 'r');
  assert.equal(scope.isDiscoveredSource('http://www.scio.gov.cn/report.html', 'r'), true);
  assert.equal(scope.isDiscoveredSource('https://www.scio.gov.cn/report.html', 'r'), false);
  assert.equal(scope.isDiscoveredSource('https://www.scio.gov.cn/other.html', 'r'), false);
  assert.equal(scope.isDiscoveredSource('https://www.scio.gov.cn/report.html', 'other'), false);
});

test('search budget and evidence survive runtime recreation; cached queries consume no new search', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-resume-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  let requests = 0;
  storage.createProject({ projectId: 'p', operationId: 'create', name: 'Search test', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'fact-check' });
  storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', planVersion: 'test' });
  const scope = () => search.createFactSearchTools({ storage,
    configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, getTavilyKey: async () => 'test-key', authorizeQuery: async () => true }),
    fetch: async () => { requests++; return Response.json({ results: [{ url: 'https://example.com/fact', content: 'Evidence' }, { url: 'http://example.com/public-fact', content: 'HTTP evidence' }] }); },
  });
  let operation = 0;
  const invoke = async (query: string) => {
    const operationId = `tool-${++operation}`;
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId, type: 'tool.requested', payload: { toolName: 'search_fact_sources', arguments: { query } } });
    const result = await scope().search(query, undefined, 'r', { projectId: 'p', runId: 'r', operationId,
      abortSignal: new AbortController().signal, expectedBodyVersionId: null,
      permissionGrant: createToolPermissionGrant({ projectId: 'p', runId: 'r', permissions: ['network:https:read'] }) });
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId, type: 'tool.completed', payload: { result: { toolName: 'search_fact_sources', ok: true, result } } });
    return result;
  };
  try {
    assert.equal((await invoke('fact 0')).searchOrdinal, 1);
    assert.equal(scope().isDiscoveredSource('https://example.com/fact', 'r'), true);
    assert.equal(scope().isDiscoveredSource('http://example.com/public-fact', 'r'), true, 'HTTP search sources survive runtime recreation');
    for (let i = 0; i < 8; i++) assert.equal((await invoke('fact 0')).cacheHit, true);
    for (let i = 1; i < 6; i++) assert.equal((await invoke(`fact ${i}`)).searchOrdinal, i + 1);
    assert.equal((await invoke('fact 6')).failureCode, 'SEARCH_LIMIT_REACHED');
    assert.equal(requests, 6);
    const progress = storage.listRunEvents('r').filter(e => e.type === 'search.progress');
    assert.ok(progress.some(e => String(e.payload.message).includes('Tavily 已发出')));
    assert.doesNotMatch(JSON.stringify(progress), /test-key/);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test('enabled-services authorization replaces an old denied receipt without dropping search limits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-consent-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  let requests = 0;
  try {
    storage.createProject({ projectId: 'p', operationId: 'create', name: 'Search test', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'fact-check' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', planVersion: 'test' });
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId: 'old-search', type: 'tool.requested', payload: { toolName: 'search_fact_sources', arguments: { query: 'public fact' } } });
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId: 'old-search', type: 'tool.completed', payload: {
      result: { toolName: 'search_fact_sources', ok: true, result: { mode: 'unavailable', authorization: 'denied', failureCode: 'SEARCH_NOT_AUTHORIZED', route: ['tavily'] } },
    } });
    const scope = search.createFactSearchTools({ storage,
      configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, authorizationMode: 'enabled_services', getTavilyKey: async () => 'test-key',
        authorizeQuery: async () => { throw new Error('No per-query dialog allowed'); } }),
      fetch: async () => { requests++; return Response.json({ results: [] }); },
    });
    const context = { projectId: 'p', runId: 'r', operationId: 'new-search', abortSignal: new AbortController().signal, expectedBodyVersionId: null,
      permissionGrant: createToolPermissionGrant({ projectId: 'p', runId: 'r', permissions: ['network:https:read'] }) };
    const invoke = (query: string) => scope.search(query, undefined, 'r', context);
    const result = await invoke('public fact');
    assert.equal(result.mode, 'external');
    assert.equal(result.authorizationMs, 0);
    assert.equal((await invoke('public fact')).cacheHit, true);
    for (let i = 0; i < 7; i++) await invoke(`another fact ${i}`);
    assert.equal(requests, 5, 'historical attempt still counts toward the six-search run limit');
    assert.equal((await invoke('over limit')).failureCode, 'SEARCH_LIMIT_REACHED');
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test('time spent approving a query does not consume the provider search deadline', async () => {
  let requests = 0;
  const scope = search.createFactSearchTools({
    configuration: () => ({ parallelEnabled: false, tavilyEnabled: true,
      getTavilyKey: async () => 'test-key',
      authorizeQuery: async () => { await new Promise(resolve => setTimeout(resolve, 160)); return true; } }),
    overallTimeoutMs: 100,
    fetch: async () => { requests++; return Response.json({ results: [] }); },
  });
  const result = await scope.search('public fact');
  assert.equal(result.provider, 'tavily', 'author approval must not silently prevent Tavily dispatch');
  assert.equal(requests, 1);
});

test('slow Parallel handshake reserves a real opportunity for the enabled Tavily fallback', async () => {
  const calls: string[] = [];
  const scope = search.createFactSearchTools({
    configuration: () => ({ parallelEnabled: true, tavilyEnabled: true, getTavilyKey: async () => 'test-key', authorizeQuery: async () => true }),
    requestTimeoutMs: 200, overallTimeoutMs: 300,
    fetch: async (url, init) => {
      calls.push(String(url));
      if (String(url).includes('tavily')) return Response.json({ results: [] });
      await new Promise(resolve => setTimeout(resolve, 120));
      const body = JSON.parse(String(init?.body));
      if (body.method === 'initialize') return Response.json({ id: 1, result: { protocolVersion: '2024-11-05' } });
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      return await new Promise<Response>(() => undefined);
    },
  });
  const result = await scope.search('public fact');
  assert.equal(result.provider, 'tavily');
  assert.equal(calls.filter(url => url.includes('tavily')).length, 1);
});

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
    authorizeQuery: async ({ signal, ...request }) => { assert.ok(signal instanceof AbortSignal); approvals.push(request); return false; } }),
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

test('an approval UI error is not recorded as provider failure or author refusal', async () => {
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: false, tavilyEnabled: true,
    authorizeQuery: async () => { throw new Error('private host detail'); } }),
    fetch: async () => { throw new Error('must not send'); } });
  const result = await scope.search('public fact');
  assert.equal(result.failureCode, 'SEARCH_APPROVAL_FAILED');
  assert.notEqual(result.authorization, 'denied');
  assert.deepEqual(result.attempts, []);
  assert.doesNotMatch(JSON.stringify(result), /private host detail/);
});

test('cancellation during Parallel transport never dispatches the enabled paid fallback', async () => {
  const controller = new AbortController();
  const urls: string[] = [];
  const scope = search.createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: true,
    getTavilyKey: async () => 'synthetic-key', authorizeQuery: async () => true }), fetch: async url => {
    urls.push(String(url)); controller.abort(); throw controller.signal.reason;
  } });
  await assert.rejects(scope.search('public fact', controller.signal), error => error instanceof DOMException && error.name === 'AbortError');
  assert.deepEqual(urls, ['https://search.parallel.ai/mcp']);
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
  assert.deepEqual(second, { ...first, cacheHit: true });
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
    approvalTimeoutMs: 20,
  });

  const result = await scope.search('public fact');
  assert.equal(result.mode, 'unavailable');
  assert.equal(result.failureCode, 'SEARCH_APPROVAL_TIMEOUT');
  assert.match(result.notice, /尚未调用搜索服务/);
  assert.deepEqual(result.attempts, []);
  assert.equal((await scope.search('public fact')).cacheHit, true, 'do not prompt repeatedly after an approval timeout');
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
  assert.ok(['SEARCH_TIMEOUT', 'SEARCH_REQUEST_TIMEOUT'].includes(result.failureCode!));
  assert.equal(result.attempts?.length, 2);
  assert.ok(elapsedMs < 250, `search took ${elapsedMs}ms`);
});
