import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { createToolPermissionGrant } from '../../runtime/tools/src/index.js';
import { createFactSearchTools } from '../src/fact-search.js';
import { validateFactSearchDecision, factSearchLimitations, FACT_SEARCH_DECISION_REQUIRED } from '../src/fact-search-recovery.js';

test('search decisions survive rebuild, retry a cached failure once and only append author-approved quota', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-search-decisions-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  storage.createProject({ projectId: 'p', operationId: 'create', name: 'Search decisions', mode: 'quick', actor: { kind: 'user', id: 'test' } });
  storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'fact-check' });
  storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', planVersion: 'test' });
  let requests = 0, fails = true, operation = 0;
  const scope = () => createFactSearchTools({ storage,
    configuration: () => ({ parallelEnabled: false, tavilyEnabled: true, searchLimit: 1,
      authorizationMode: 'enabled_services', getTavilyKey: async () => 'test-key' }),
    fetch: async () => { requests++; if (fails) throw new Error('SEARCH_REQUEST_TIMEOUT');
      return Response.json({ results: [{ url: 'https://example.test/fact', content: '日期记录' }] }); },
  });
  const invoke = async (query: string) => {
    const operationId = `search-${++operation}`;
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId, type: 'tool.requested', payload: { toolName: 'search_fact_sources', arguments: { query } } });
    const result = await scope().search(query, undefined, 'r', { projectId: 'p', runId: 'r', operationId,
      abortSignal: new AbortController().signal, expectedBodyVersionId: null,
      permissionGrant: createToolPermissionGrant({ projectId: 'p', runId: 'r', permissions: ['network:https:read'] }) });
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId, type: 'tool.completed', payload: { result: { ok: true, toolName: 'search_fact_sources', result } } });
    return result;
  };
  const resume = (action: 'retry' | 'extend' | 'continue') => {
    const waiting = scope().pause('r')!;
    assert.ok(waiting);
    // Simulates reopening after tool settlement but before pause was persisted.
    storage.pauseRun({ projectId: 'p', runId: 'r', operationId: `pause-${operation}`, reason: waiting.reason, payload: waiting.payload });
    const requestId = waiting.payload.searchRecovery.requestId;
    assert.throws(() => validateFactSearchDecision(storage, 'r', undefined), { code: FACT_SEARCH_DECISION_REQUIRED });
    assert.throws(() => validateFactSearchDecision(storage, 'r', { requestId: 'stale', action }), { code: FACT_SEARCH_DECISION_REQUIRED });
    const factSearchDecision = validateFactSearchDecision(storage, 'r', { requestId, action })!;
    storage.resumeRun({ projectId: 'p', runId: 'r', operationId: `resume-${operation}`, decision: 'resume', factSearchDecision });
    assert.equal(scope().pause('r'), null);
    assert.throws(() => validateFactSearchDecision(storage, 'r', { requestId, action }), { code: FACT_SEARCH_DECISION_REQUIRED });
  };
  try {
    const failed = await invoke('公开日期');
    assert.equal(failed.recoveryRequired?.kind, 'timeout');
    assert.equal(failed.quotaCharged, false);
    assert.equal(scope().budget('r').used, 0);
    assert.equal((await invoke('公开日期')).cacheHit, true);
    assert.equal(requests, 1, 'reopening must preserve failed-query cache');
    resume('retry');
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId: 'rejected-query', type: 'tool.requested',
      payload: { toolName: 'search_fact_sources', arguments: { query: '模型误改的查询' } } });
    storage.recordRunEvent({ projectId: 'p', runId: 'r', operationId: 'rejected-query', type: 'tool.completed',
      payload: { result: { ok: false, toolName: 'search_fact_sources', error: { code: 'SEARCH_RETRY_QUERY_REQUIRED' } } } });
    assert.equal(scope().budget('r').used, 0, 'validation failures without a network attempt never spend query quota');
    assert.equal(scope().budget('r').retryQuery, '公开日期');
    fails = false;
    const success = await invoke('公开日期');
    assert.equal(success.mode, 'external');
    assert.equal(requests, 2);
    assert.equal(scope().budget('r').retryQuery, null);
    assert.equal(success.recoveryRequired?.kind, 'limit');
    resume('extend');
    assert.equal(scope().budget('r').limit, 4);
    assert.equal(scope().budget('r').used, 1, 'extension must not reset previous usage');
    assert.equal((await invoke('公开日期')).cacheHit, true, 'approved retry is one-shot');
    assert.equal(requests, 2);
    fails = true;
    await invoke('另一个公开事实');
    resume('continue');
    assert.equal(scope().budget('r').stopped, true);
    assert.equal((await invoke('第三个公开事实')).failureCode, 'SEARCH_USER_DECLINED');
    assert.equal(requests, 3, 'declining must prevent further network attempts');
    assert.equal((await invoke('公开日期')).mode, 'external', 'already saved successful sources remain usable');
    assert.deepEqual(factSearchLimitations(storage.listRunEvents('r')).map(r => r.query), ['另一个公开事实']);
    assert.equal(storage.listRunEvents('r').filter(e => e.type === 'search.attempt_started').length, 3);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test('mixed provider failures charge once; a timeout followed by successful fallback also charges once', async () => {
  for (const success of [false, true]) {
    const scope = createFactSearchTools({ configuration: () => ({ parallelEnabled: true, tavilyEnabled: true,
      authorizationMode: 'enabled_services', getTavilyKey: async () => 'test-key' }),
      fetch: async url => {
        if (String(url).includes('parallel')) throw new Error('SEARCH_REQUEST_TIMEOUT');
        return success ? Response.json({ results: [] }) : new Response(null, { status: 401 });
      } });
    const result = await scope.search('公开信息');
    assert.equal(result.quotaCharged, true);
    assert.equal(scope.budget('direct').used, 1);
    assert.equal(result.mode, success ? 'external' : 'unavailable');
    assert.equal(result.failureCode, success ? undefined : 'SEARCH_UNAVAILABLE');
    assert.deepEqual(result.attempts?.map(a => a.errorCode), ['SEARCH_REQUEST_TIMEOUT', success ? undefined : 'SEARCH_HTTP_401']);
  }
});
