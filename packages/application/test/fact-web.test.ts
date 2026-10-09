import assert from "node:assert/strict";
import { EventEmitter } from 'node:events';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openWorkspaceStorage } from "../../storage/src/index.js";
import { SecureWebFetchError, type SecureWebFetchResult } from "../../runtime/tools/src/index.js";
import { createFactSourceTool, factToolFailureLoopKey, type FactSourceFetcher } from "../src/fact-web.js";

test('source transport failure is classified without leaking URL credentials or provider text', async () => {
  const f = setup(LEDGER_URL);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: {
      fetchText: async () => { throw new Error('socket failed secret-private-provider-diagnostics'); },
    } });
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'r' } as never), (error: any) => {
      assert.equal(error.code, 'FACT_SOURCE_FETCH_UNAVAILABLE');
      assert.match(error.message, /摘录/);
      assert.doesNotMatch(error.message, /secret-private/);
      return true;
    });
  } finally { f.close(); }
});

const actor = { kind: "user", id: "fact-web-test" } as const;
const LEDGER_URL = "https://93.184.216.34/report-2026";

test('source HTTP status survives the tool boundary and repeated rejected reads do not hit the website again', async () => {
  const f = setup(LEDGER_URL);
  try {
    let requests = 0;
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: {
      fetchText: async () => { requests++; throw new SecureWebFetchError('WEB_HTTP_STATUS_REJECTED', 'secret-body', 403); },
    } });
    for (let i = 0; i < 2; i++) await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'r' } as never), (error: any) => {
      assert.equal(error.details.httpStatus, 403);
      assert.match(error.message, /HTTP 403/);
      assert.doesNotMatch(error.message, /secret-body/);
      return true;
    });
    assert.equal(requests, 1);
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'new-run' } as never));
    assert.equal(requests, 2);
  } finally { f.close(); }
});

for (const code of ['WEB_REQUEST_FAILED', 'WEB_REQUEST_TIMEOUT', 'WEB_CONTENT_TYPE_DENIED'] as const) {
test(`failed source reads are cached per run without leaking transport diagnostics: ${code}`, async () => {
  const f = setup(LEDGER_URL);
  try {
    let requests = 0;
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: {
      fetchText: async () => { requests++; throw new SecureWebFetchError(code as never, 'secret-private-diagnostics'); },
    } });
    for (let index = 0; index < 2; index++) await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'r' } as never), (error: any) => {
      assert.equal(error.code, code === 'WEB_REQUEST_TIMEOUT' ? 'FACT_SOURCE_TIMEOUT' : code);
      assert.equal(error.details.cacheHit === true, index === 1);
      assert.doesNotMatch(error.message, /secret-private/);
      assert.match(error.message, /摘录/);
      return true;
    });
    assert.equal(requests, 1, 'a failed page must not be fetched repeatedly in the same run');
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'new-run' } as never));
    assert.equal(requests, 2, 'an explicit new fact-check run can try the source again');
  } finally { f.close(); }
});
}

test('fact reader uses 30s transport and 60s overall bounds and preserves socket timeout classification', async (t) => {
  const f = setup(LEDGER_URL);
  const httpsModule = createRequire(import.meta.url)('node:https') as typeof import('node:https');
  const originalRequest = httpsModule.request;
  const originalTimeout = globalThis.setTimeout;
  const timers: number[] = [];
  let socketTimeout = 0;
  let destroys = 0;
  t.mock.method(globalThis, 'setTimeout', ((callback: any, ms: number, ...args: any[]) => {
    timers.push(ms);
    return originalTimeout(callback, ms, ...args);
  }) as typeof setTimeout);
  httpsModule.request = ((_url: URL, options: any) => {
    socketTimeout = options.timeout;
    const request = new EventEmitter() as any;
    request.destroy = () => { destroys++; return request; };
    request.end = () => queueMicrotask(() => request.emit('timeout'));
    return request;
  }) as unknown as typeof httpsModule.request;
  syncBuiltinESMExports();
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p' });
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'r' } as never), (error: any) => {
      assert.equal(error.code, 'FACT_SOURCE_TIMEOUT');
      assert.equal(error.details.timeoutMs, 30_000);
      assert.equal(error.details.timeoutPhase, 'transport');
      assert.match(error.message, /30 秒.*不是.*模型.*搜索/);
      return true;
    });
    assert.equal(socketTimeout, 30_000, 'the underlying reader must receive the increased bound');
    assert.ok(timers.includes(60_000), 'policy resolution and redirects still have one overall deadline');
    assert.equal(destroys, 1);
  } finally { httpsModule.request = originalRequest; syncBuiltinESMExports(); t.mock.restoreAll(); f.close(); }
});

test('per-source failure grouping never separates repeated security or submission denials', () => {
  const call = (url: string) => ({ id:'call', name:'read_fact_source', arguments:{ url }, rawArguments:JSON.stringify({ url }) });
  const error = (code: string) => ({ code, message:'failure', retryable:false, details:{} });
  assert.notEqual(factToolFailureLoopKey(call(LEDGER_URL), error('WEB_REQUEST_FAILED')),
    factToolFailureLoopKey(call(`${LEDGER_URL}/other`), error('WEB_REQUEST_FAILED')));
  for (const code of ['FACT_SOURCE_NOT_IN_LEDGER', 'TOOL_PERMISSION_DENIED', 'NETWORK_PRIVATE_TARGET_DENIED']) {
    assert.equal(factToolFailureLoopKey(call(LEDGER_URL), error(code)), factToolFailureLoopKey(call(`${LEDGER_URL}/other`), error(code)));
  }
  assert.equal(factToolFailureLoopKey({ ...call(LEDGER_URL), name:'submit_fact_check' }, error('FACT_EXTERNAL_RECORD_REQUIRED')),
    'submit_fact_check:FACT_EXTERNAL_RECORD_REQUIRED');
});

test('cached source failures still recheck search configuration and current source authorization', async () => {
  const f = setup('{"claims":[]}');
  let enabled = true, discovered = true, requests = 0;
  try {
    const tool = createFactSourceTool({ storage:f.storage, projectId:'p', searchEnabled:()=>enabled, isDiscoveredSource:()=>discovered,
      fetcher:{ fetchText:async () => { requests++; throw new SecureWebFetchError('WEB_REQUEST_FAILED', 'failure'); } } });
    await assert.rejects(async () => tool.execute({ url:LEDGER_URL }, { runId:'r' } as never), { code:'WEB_REQUEST_FAILED' });
    enabled = false;
    await assert.rejects(async () => tool.execute({ url:LEDGER_URL }, { runId:'r' } as never), { code:'FACT_SEARCH_DISABLED' });
    enabled = true; discovered = false;
    await assert.rejects(async () => tool.execute({ url:LEDGER_URL }, { runId:'r' } as never), { code:'FACT_SOURCE_NOT_IN_LEDGER' });
    assert.equal(requests, 1);
  } finally { f.close(); }
});

test('known public HTTP sources are read directly, but private networks remain denied', async () => {
  const httpUrl = LEDGER_URL.replace('https:', 'http:');
  const f = setup(httpUrl);
  try {
    const captured: string[] = [];
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p',
      isDiscoveredSource: url => url === 'http://127.0.0.1/internal', fetcher: fetcherWith('原文', captured) });
    const result = await tool.execute({ url: httpUrl }, { runId: 'r' } as never) as { finalUrl: string };
    assert.deepEqual(captured, [httpUrl]);
    assert.equal(result.finalUrl, httpUrl);
    await assert.rejects(async () => tool.execute({ url: 'http://127.0.0.1/internal' }, { runId: 'r' } as never),
      (error: any) => error.code === 'NETWORK_PRIVATE_TARGET_DENIED');
    assert.equal(captured.length, 1);
  } finally { f.close(); }
});

function setup(ledgerContent: string) {
  const directory = mkdtempSync(join(tmpdir(), "wa-fact-web-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  storage.createProject({ projectId: "p", operationId: "p", name: "probe", mode: "quick", actor });
  storage.commitArtifactVersion({
    operationId: "ev", projectId: "p", expectedProjectRevision: storage.inspectProject("p")!.revision,
    kind: "evidence", logicalKey: "main", baseVersionId: null, content: ledgerContent,
    reason: "probe", actor: { kind: "agent", id: "research", runId: "r" },
  });
  return { storage, close() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function fetcherWith(text: string, captured: string[]): FactSourceFetcher {
  return {
    fetchText: async (url: string) => {
      captured.push(url);
      return {
        finalUrl: url,
        redirectCount: 0,
        contentType: "text/html",
        bodyHash: "body-hash",
        content: {
          text,
          trustLabel: "external_untrusted",
          instructionAuthority: "none",
          activeContentRemoved: true,
          truncated: false,
          totalChars: text.length,
        },
      } satisfies SecureWebFetchResult;
    },
  };
}

test("fact source tool re-reads only URLs recorded in the evidence ledger and returns inert text", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"${LEDGER_URL}"}]}`);
  try {
    const captured: string[] = [];
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("来源原文：某地实际增长为 3%。", captured) });
    const result = await tool.execute({ url: LEDGER_URL }, { projectId: "p", runId: "r", operationId: "op" } as never);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], LEDGER_URL);
    const view = result as { text: string; trustLabel: string; instructionAuthority: string; truncated: boolean };
    assert.match(view.text, /增长为 3%/u);
    assert.equal(view.trustLabel, "external_untrusted");
    assert.equal(view.instructionAuthority, "none");
    assert.equal(view.truncated, false);
  } finally { f.close(); }
});

test('fact source tool permits discovered URLs only in the searching run and respects disabled search', async () => {
  const f = setup('{"claims":[]}');
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: fetcherWith('网页原文', []),
      isDiscoveredSource: (url, runId) => url === LEDGER_URL && runId === 'searched' });
    await tool.execute({ url: LEDGER_URL }, { runId: 'searched' } as never);
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'other' } as never));
    const off = createFactSourceTool({ storage: f.storage, projectId: 'p', searchEnabled: () => false,
      isDiscoveredSource: () => true, fetcher: fetcherWith('must not fetch', []) });
    await assert.rejects(async () => off.execute({ url: LEDGER_URL }, { runId: 'searched' } as never), /disabled/);
  } finally { f.close(); }
});

test("fact source tool refuses URLs that are not in the ledger instead of browsing", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"${LEDGER_URL}"}]}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: "https://other.example.test/anything" }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "FACT_SOURCE_NOT_IN_LEDGER");
        assert.match(String((error as Error).message), /NEEDS_USER_SOURCE/u);
        return true;
      },
    );
  } finally { f.close(); }
});

test("fact source tool still enforces the network policy on ledger URLs", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"https://127.0.0.1/internal"}]}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: "https://127.0.0.1/internal" }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in (error as object), "policy errors carry a code");
        return true;
      },
    );
  } finally { f.close(); }
});

test("fact source tool reports an empty ledger without fetching", async () => {
  const f = setup(`{"claims":[],"notes":"纯个人感受"}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: LEDGER_URL }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => (error as { code?: string }).code === "FACT_SOURCE_NOT_IN_LEDGER",
    );
  } finally { f.close(); }
});

test('fact source read has a hard overall timeout when the transport never settles', async () => {
  const f = setup(LEDGER_URL);
  try {
    let requests = 0;
    let transportSignal: AbortSignal | undefined;
    const tool = createFactSourceTool({
      storage: f.storage,
      projectId: 'p',
      timeoutMs: 20,
      fetcher: { fetchText: async (_url, signal) => { requests++; transportSignal = signal; return await new Promise<SecureWebFetchResult>(() => undefined); } },
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    await assert.rejects(
      async () => await tool.execute({ url: LEDGER_URL }, { runId: 'r', abortSignal: controller.signal } as never),
      (error: any) => error.code === 'FACT_SOURCE_TIMEOUT' && error.details.timeoutMs === 20 && error.details.timeoutPhase === 'overall',
    );
    assert.ok(Date.now() - startedAt < 1_000);
    assert.equal(transportSignal?.aborted, true);
    await assert.rejects(async () => tool.execute({ url:LEDGER_URL }, { runId:'r' } as never), (error: any) => error.code === 'FACT_SOURCE_TIMEOUT' && error.details.cacheHit === true);
    assert.equal(requests, 1);
  } finally { f.close(); }
});

test('fact source read propagates cancellation to the transport and reports ABORTED', async () => {
  const f = setup(LEDGER_URL);
  try {
    let transportSignal: AbortSignal | undefined;
    let requests = 0;
    let transportStarted!: () => void;
    const started = new Promise<void>(resolve => { transportStarted = resolve; });
    const tool = createFactSourceTool({
      storage: f.storage,
      projectId: 'p',
      timeoutMs: 1_000,
      fetcher: {
        fetchText: async (_url, signal) => {
          requests++;
          transportSignal = signal;
          transportStarted();
          if (requests > 1) return await fetcherWith('再次读取成功', []).fetchText(LEDGER_URL, signal);
          return await new Promise<SecureWebFetchResult>(() => undefined);
        },
      },
    });
    const controller = new AbortController();
    const pending = tool.execute({ url: LEDGER_URL }, { runId: 'r', abortSignal: controller.signal } as never);
    await started;
    controller.abort();
    await assert.rejects(
      async () => await pending,
      (error: unknown) => (error as { code?: string }).code === 'ABORTED',
    );
    assert.equal(transportSignal?.aborted, true);
    const retry = await tool.execute({ url:LEDGER_URL }, { runId:'r' } as never) as { text:string };
    assert.equal(retry.text, '再次读取成功', 'user cancellation must not become a cached website failure');
    assert.equal(requests, 2);
  } finally { f.close(); }
});
