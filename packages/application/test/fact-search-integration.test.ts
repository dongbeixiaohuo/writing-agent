import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js'
import { openWorkspaceStorage } from '../../storage/src/index.js'
import { MODEL_ONLY_FACT_NOTICE } from '../src/fact-search.js'
import { WritingApplicationService } from '../src/index.js'
import { factPreparationFixtureEvents } from './collaboration-fixture.js'

const actor = { kind: 'user', id: 'fact-search-integration' } as const

for (const status of ['SUPPORTED', 'CONTRADICTED'] as const) test(`non-standard fact category does not trigger a whole-report model rewrite or change ${status}`, async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-category-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const seeded = seedFactInputs(storage);
  const body = storage.commitArtifactVersion({ operationId: 'category-body', projectId: 'project-1', expectedProjectRevision: seeded.projectRevision,
    kind: 'body', logicalKey: 'main', baseVersionId: seeded.bodyVersionId, content: '# 示例事件\n\n示例项目在2025年发布。', reason: 'fixture', actor });
  assert.equal(body.ok, true); if (!body.ok) throw new Error('body fixture');
  const requests: ModelRequest[] = [];
  class CategoryProvider extends ModelProviderBase {
    constructor() { super('category', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      const extracting = JSON.parse(request.messages[1]!.content).factPhase === 'extract';
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: extracting ? 'prepare_fact_check' : 'submit_fact_check', argumentsDelta: JSON.stringify(extracting ? {
        claims: [{ claimText: '示例项目在2025年发布', articleQuote: '示例项目在2025年发布', location: 'body', matchedEvidenceIds: [], checkReason: 'key_fact' }], noFactualClaimsReason: '',
      } : { claims: [{ claimId: 'C001', claimText: '示例项目在2025年发布', claimType: 'quotation_or_interpretation', location: 'body', status,
        risk: status === 'SUPPORTED' ? 'green' : 'yellow', supportScope: status === 'SUPPORTED' ? 'full' : 'none', matchedEvidenceId: null,
        sourceReference: 'model-knowledge:unverified', evidenceSummary: status === 'SUPPORTED' ? '模型复核年份一致，未独立联网。' : '模型发现该年份与已知事件有冲突，需要确认。',
        recommendedAction: status === 'SUPPORTED' ? '无需修改' : '核对年份后重新检查', verificationMethod: 'model_review', verificationRecordIds: [] }], noFactualClaimsReason: '' }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const app = new WritingApplicationService({ storage, provider: new CategoryProvider() });
    const result = await app.runFactCheck({ projectId: 'project-1', expectedProjectRevision: body.projectRevision, model: 'mock', parameters: {},
      budget: { maxModelRequests: 2, maxToolCalls: 2, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, true, 'display-only category must not spend another long model round');
    const saved = storage.getFactCheckStatus('project-1').assessment!;
    assert.equal(saved.payload.claims[0]!.claimType, 'other');
    assert.equal(saved.payload.claims[0]!.status, status);
    assert.equal(saved.status, status === 'SUPPORTED' ? 'passed' : 'blocked');
    assert.equal(requests.length, 2);
    assert.equal(storage.listRunEvents(result.runId).some(e => e.type === 'request.failed'), false);
    const raw = storage.listRunEvents(result.runId).findLast(e => e.type === 'tool.requested')!;
    assert.match(JSON.stringify(raw.payload), /quotation_or_interpretation/, 'raw model category remains available for diagnostics');
  } finally { storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

class FactSearchInspectionProvider extends ModelProviderBase {
  readonly requests: ModelRequest[] = []

  constructor(
    private readonly bodyVersionId: string,
    private readonly evidenceVersionId: string,
    private readonly useSearch: boolean,
  ) {
    super('fact-search-integration-mock', '1.0.0', {
      protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'reported',
    })
  }

  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(structuredClone(request))
    const extraction = factPreparationFixtureEvents(request);
    if (extraction) { yield* extraction; return; }
    const toolMessages = request.messages.filter(message => message.role === 'tool')
    if (this.useSearch && !toolMessages.some(message => message.name === 'search_fact_sources')) {
      yield {
        type: 'tool_call_delta', index: 0, id: 'search-public-fact', name: 'search_fact_sources',
        argumentsDelta: JSON.stringify({ query: '查证一个公开事实' }),
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }
    const artifactReads = toolMessages.filter(message => message.name === 'read_artifact_version')
    const supplied = JSON.parse(request.messages.find(m => m.role === 'user')!.content).artifacts;
    if (!supplied && artifactReads.length < 2) {
      yield {
        type: 'tool_call_delta', index: 0, id: `read-fact-input-${artifactReads.length}`, name: 'read_artifact_version',
        argumentsDelta: JSON.stringify({ versionId: artifactReads.length === 0 ? this.bodyVersionId : this.evidenceVersionId }),
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }
    if (!toolMessages.some(message => message.name === 'submit_fact_check')) {
      yield {
        type: 'tool_call_delta', index: 0, id: 'submit-fact-result', name: 'submit_fact_check',
        argumentsDelta: JSON.stringify({ claims: [], noFactualClaimsReason: '正文只有作者感受，没有需要外部核实的客观事实。' }),
      }
      yield { type: 'completed', finishReason: 'tool_calls' }
      return
    }
    yield { type: 'text_delta', delta: '事实核查已保存。' }
    yield { type: 'completed', finishReason: 'stop' }
  }
}

function seedFactInputs(storage: ReturnType<typeof openWorkspaceStorage>) {
  const bootstrap = new WritingApplicationService({ storage })
  assert.equal(bootstrap.createProject({
    operationId: 'create-fact-search-project', projectId: 'project-1', name: '搜索集成测试', mode: 'quick', actor,
  }).ok, true)
  const body = storage.commitArtifactVersion({
    operationId: 'seed-fact-body', projectId: 'project-1', expectedProjectRevision: 0,
    kind: 'body', logicalKey: 'main', baseVersionId: null,
    content: '# 散步\n\n这是作者对下班散步的感受。', reason: 'fixture', actor,
  })
  assert.equal(body.ok, true)
  if (!body.ok) throw new Error('body fixture failed')
  const evidence = storage.commitArtifactVersion({
    operationId: 'seed-fact-evidence', projectId: 'project-1', expectedProjectRevision: body.projectRevision,
    kind: 'evidence', logicalKey: 'main', baseVersionId: null,
    content: JSON.stringify({ claims: [], notes: '无外部事实' }), reason: 'fixture', actor,
  })
  assert.equal(evidence.ok, true)
  if (!evidence.ok) throw new Error('evidence fixture failed')
  return { bodyVersionId: body.result.versionId, evidenceVersionId: evidence.result.versionId, projectRevision: evidence.projectRevision }
}

async function runFactSearchCase(enabled: boolean) {
  const workspacePath = mkdtempSync(join(tmpdir(), `wa-fact-search-${enabled ? 'enabled' : 'disabled'}-`))
  const storage = openWorkspaceStorage({ workspacePath })
  const seeded = seedFactInputs(storage)
  const provider = new FactSearchInspectionProvider(seeded.bodyVersionId, seeded.evidenceVersionId, enabled)
  const service = new WritingApplicationService({
    storage, provider,
    factSearchConfiguration: () => ({ parallelEnabled: enabled, tavilyEnabled: false, authorizeQuery: async () => true }),
  })
  try {
    const result = await service.runFactCheck({
      projectId: 'project-1', expectedProjectRevision: seeded.projectRevision,
      model: 'mock-fact-model', parameters: { temperature: 0, toolChoice: 'auto' },
      budget: { maxModelRequests: 6, maxToolCalls: 5, maxRetriesPerRequest: 0, maxMajorRevisions: 0 },
    })
    return { result, provider, storage, workspacePath }
  } catch (error) {
    storage.close()
    rmSync(workspacePath, { recursive: true, force: true })
    throw error
  }
}

test('claim-first check verifies only article facts without resending the article or unused evidence', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-claim-first-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const seeded = seedFactInputs(storage);
  const body = storage.commitArtifactVersion({ operationId: 'real-fact-body', projectId: 'project-1', expectedProjectRevision: storage.inspectProject('project-1')!.revision,
    kind: 'body', logicalKey: 'main', baseVersionId: seeded.bodyVersionId, content: '# 一个事实\n\n示例公司在2025年成立。\n\n' + '这是明确的作者感受。'.repeat(600), reason: 'fixture', actor });
  assert.equal(body.ok, true); if (!body.ok) throw new Error('body fixture');
  const evidence = storage.commitArtifactVersion({ operationId: 'real-fact-evidence', projectId: 'project-1', expectedProjectRevision: body.projectRevision,
    kind: 'evidence', logicalKey: 'main', baseVersionId: seeded.evidenceVersionId, content: JSON.stringify({ claims: [
      { evidence_id: 'E001', claim_type: 'date', claim_text: '示例公司在2025年成立', source_quote: '示例公司在2025年成立。', source_title: '登记资料', source_publisher: '示例登记机构', source_url: 'https://example.test/date', accessed_at: '2026-10-05', reliability: 'high', use_boundary: '仅证明成立年份', verification_status: '待核实' },
      { evidence_id: 'E002', claim_type: 'other', claim_text: '没有写进文章的资料', source_quote: '未入正文的长原文'.repeat(4000), source_title: '另一资料', source_publisher: '机构', accessed_at: '2026-10-05', reliability: 'medium', use_boundary: '不可作证明', verification_status: '待核实' },
    ] }), reason: 'fixture', actor });
  assert.equal(evidence.ok, true); if (!evidence.ok) throw new Error('evidence fixture');
  const requests: ModelRequest[] = [];
  class ClaimsProvider extends ModelProviderBase {
    constructor() { super('claim-first-mock', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      const state = JSON.parse(request.messages.find(m => m.role === 'user')!.content);
      let name: string, args: any;
      if (state.factPhase === 'extract') {
        assert.deepEqual(request.tools?.map(t => t.name), ['prepare_fact_check']);
        assert.match(state.artifacts.find((a: any) => a.kind === 'body').content, /示例公司在2025年成立/);
        assert.equal(JSON.stringify(state).includes('未入正文的长原文'), false);
        name = 'prepare_fact_check'; args = { claims: [{ claimText: '示例公司在2025年成立', articleQuote: '示例公司在2025年成立', location: 'body', matchedEvidenceIds: ['E001'], checkReason: 'key_fact' }], noFactualClaimsReason: '' };
      } else {
        assert.equal(JSON.stringify(state).includes('这是明确的作者感受。'), false);
        assert.equal(JSON.stringify(state).includes('未入正文的长原文'), false);
        assert.equal(state.preparedClaims.length, 1);
        assert.equal(request.messages.some(m => m.role === 'tool' && m.name === 'prepare_fact_check'), false, 'phase boundary retires extraction history');
        assert.match(JSON.stringify(state.artifacts), /仅证明成立年份/);
        const searched = request.messages.find(m => m.role === 'tool' && m.name === 'search_fact_sources');
        if (!searched) { name = 'search_fact_sources'; args = { query: '示例公司 成立 2025 登记资料' }; }
        else {
          assert.ok(searched.content.length < 3000);
          assert.equal(JSON.parse(searched.content).result.sources[0].url, 'https://example.test/date');
          name = 'submit_fact_check'; args = { claims: [{ claimId: 'C001', claimText: '示例公司在2025年成立', claimType: 'date', location: 'body', status: 'SUPPORTED', risk: 'green', supportScope: 'full', matchedEvidenceId: 'E001', sourceReference: 'https://example.test/date', evidenceSummary: '登记年份与当前成稿一致，仅证明成立年份。', recommendedAction: '无需修改', verificationMethod: 'external_source', verificationRecordIds: [searched.role === 'tool' ? searched.toolCallId : ''] }], noFactualClaimsReason: '' };
        }
      }
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const originalFetch = globalThis.fetch;
  let searches = 0;
  globalThis.fetch = async () => { searches++; return Response.json({ results: [{ title: '示例登记资料', url: 'https://example.test/date', content: '示例公司在2025年成立。'.repeat(2500) }] }); };
  try {
    const app = new WritingApplicationService({ storage, provider: new ClaimsProvider(), factSearchConfiguration: () => ({ parallelEnabled: false, tavilyEnabled: true, authorizationMode: 'enabled_services', getTavilyKey: async () => 'test-not-a-real-key' }) });
    const result = await app.runFactCheck({ projectId: 'project-1', expectedProjectRevision: evidence.projectRevision, model: 'mock', parameters: {}, budget: { maxModelRequests: 6, maxToolCalls: 6, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.publicationReady, true);
    assert.equal(searches, 1);
    assert.equal(requests.length, 3, 'extract, search, verify/save; no redundant completion request');
    const savedClaim = storage.getFactCheckStatus('project-1').assessment!.payload.claims[0]!;
    assert.equal(savedClaim.checkReason, 'key_fact');
    assert.equal(savedClaim.verificationMethod, 'external_source');
    assert.equal(savedClaim.verificationRecordIds?.length, 1, 'provenance must survive SQLite assessment readback');
    assert.ok(storage.listRunEvents(result.runId).some(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'prepare_fact_check'));
  } finally { globalThis.fetch = originalFetch; storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('targeted verification of a suspect year exposes the material error without auditing ordinary background', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-source-error-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const seeded = seedFactInputs(storage);
  const body = storage.commitArtifactVersion({ operationId: 'event-body', projectId: 'project-1', expectedProjectRevision: seeded.projectRevision,
    kind: 'body', logicalKey: 'main', baseVersionId: seeded.bodyVersionId,
    content: '# 发布事件\n\n示例项目在2025年发布。Brett是一名编程20多年的程序员。', reason: 'fixture', actor });
  assert.equal(body.ok, true); if (!body.ok) throw new Error('body fixture');
  const evidence = storage.commitArtifactVersion({ operationId: 'event-evidence', projectId: 'project-1', expectedProjectRevision: body.projectRevision,
    kind: 'evidence', logicalKey: 'main', baseVersionId: seeded.evidenceVersionId,
    content: JSON.stringify({ claims: [], notes: '用户二手整理材料：示例项目在2025年发布，Brett编程超过20年，未经独立核实。' }), reason: 'fixture', actor });
  assert.equal(evidence.ok, true); if (!evidence.ok) throw new Error('evidence fixture');
  let searches = 0;
  class SourceErrorProvider extends ModelProviderBase {
    constructor() { super('source-error-mock', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const state = JSON.parse(request.messages.find(m => m.role === 'user')!.content);
      const messages = request.messages.filter(m => m.role === 'tool');
      let name: string, args: unknown;
      if (state.factPhase === 'extract') {
        assert.match(request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), /关键事实.*可疑/u);
        name = 'prepare_fact_check';
        args = { claims: [{ claimText: '示例项目在2025年发布', articleQuote: '示例项目在2025年发布',
          location: 'body', matchedEvidenceIds: [], checkReason: 'key_fact' }], noFactualClaimsReason: '' };
      } else {
        assert.equal(state.preparedClaims.length, 1, 'a background paraphrase should not create a second verification task');
        const searched = messages.find(m => m.name === 'search_fact_sources');
        if (!searched) {
          name = 'search_fact_sources'; args = { query: '示例项目 原始发布公告 年份' };
        } else {
          name = 'submit_fact_check';
          args = { claims: [{ claimId: 'C001', claimText: '示例项目在2025年发布', claimType: 'date', location: 'body',
            status: 'CONTRADICTED', risk: 'yellow', supportScope: 'none', matchedEvidenceId: null,
            sourceReference: 'https://example.test/announcement', evidenceSummary: '原始公告记载发布于2024年，二手素材的年份有误。',
            recommendedAction: '将2025年纠正为2024年。', verificationMethod: 'external_source', verificationRecordIds: [searched.toolCallId] }], noFactualClaimsReason: '' };
        }
      }
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { searches++; return Response.json({ results: [{ title: '原始发布公告', url: 'https://example.test/announcement', content: '示例项目于2024年正式发布。' }] }); };
  try {
    const app = new WritingApplicationService({ storage, provider: new SourceErrorProvider(), factSearchConfiguration: () => ({ parallelEnabled: false,
      tavilyEnabled: true, authorizationMode: 'enabled_services', getTavilyKey: async () => 'fixture-key' }) });
    const result = await app.runFactCheck({ projectId: 'project-1', expectedProjectRevision: evidence.projectRevision, model: 'mock', parameters: {},
      budget: { maxModelRequests: 6, maxToolCalls: 6, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.publicationReady, false);
    assert.equal(searches, 1, 'source reuse and focused selection must not cause repeated searches');
    const assessment = storage.getFactCheckStatus('project-1').assessment!;
    assert.equal(assessment.status, 'blocked');
    assert.equal(assessment.payload.claims[0]!.status, 'CONTRADICTED');
    assert.equal(assessment.payload.claims[0]!.verificationMethod, 'external_source');
    assert.equal(assessment.payload.claims.length, 1);
  } finally { globalThis.fetch = originalFetch; storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('enabled Tavily does not force public proof of author firsthand facts, and repeated checks reuse the derived title', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-firsthand-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const seeded = seedFactInputs(storage);
  const body = storage.commitArtifactVersion({ operationId: 'author-body', projectId: 'project-1', expectedProjectRevision: seeded.projectRevision,
    kind: 'body', logicalKey: 'main', baseVersionId: seeded.bodyVersionId,
    content: '# 客户会议\n\n昨天我参加了客户会议。', reason: 'fixture', actor });
  assert.equal(body.ok, true); if (!body.ok) throw new Error('body fixture');
  let requests = 0, searches = 0;
  class FirsthandProvider extends ModelProviderBase {
    constructor() { super('firsthand-mock', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests++;
      assert.match(request.messages.filter(m => m.role === 'system').map(m => m.content).join('\n'), /不是论文审稿/u);
      const state = JSON.parse(request.messages.find(m => m.role === 'user')!.content);
      const extract = state.factPhase === 'extract';
      const name = extract ? 'prepare_fact_check' : 'submit_fact_check';
      const args = extract ? { claims: [{ claimText: '昨天我参加了客户会议', articleQuote: '昨天我参加了客户会议',
        location: 'body', matchedEvidenceIds: [], checkReason: 'key_fact' }], noFactualClaimsReason: '' }
        : { claims: [{ claimId: 'C001', claimText: '昨天我参加了客户会议', claimType: 'event', location: 'body',
          status: 'SUPPORTED', risk: 'green', supportScope: 'full', matchedEvidenceId: null,
          sourceReference: '作者提供的会议经历', evidenceSummary: '对照作者本人自述，没有新增他人事件或数字。',
          recommendedAction: '保留，不要求作者提供公开证明。', verificationMethod: 'material_comparison' }], noFactualClaimsReason: '' };
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { searches++; throw new Error('no external requests expected'); };
  try {
    const app = new WritingApplicationService({ storage, provider: new FirsthandProvider(), factSearchConfiguration: () => ({ parallelEnabled: false,
      tavilyEnabled: true, authorizationMode: 'enabled_services', getTavilyKey: async () => 'fixture-key' }) });
    const input = () => ({ projectId: 'project-1', expectedProjectRevision: storage.inspectProject('project-1')!.revision, model: 'mock', parameters: {},
      budget: { maxModelRequests: 4, maxToolCalls: 4, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    const first = await app.runFactCheck(input());
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.publicationReady, true);
    const titleVersionId = storage.inspectProject('project-1')!.currentTitleVersionId;
    const second = await app.runFactCheck(input());
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.publicationReady, true);
    assert.equal(storage.inspectProject('project-1')!.currentTitleVersionId, titleVersionId, 'same derived title must not create a new version');
    assert.equal(storage.listArtifactVersions('project-1', 'title', 'main').length, 1);
    assert.equal(requests, 4, 'two checks each extract and save, no rejection/correction loop');
    assert.equal(searches, 0);
    const claim = storage.getFactCheckStatus('project-1').assessment!.payload.claims[0]!;
    assert.equal(claim.verificationMethod, 'material_comparison');
    assert.deepEqual(claim.verificationRecordIds, []);
  } finally { globalThis.fetch = originalFetch; storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});

test('runFactCheck exposes and authorizes external fact search only when enabled', async () => {
  const originalFetch = globalThis.fetch
  let networkRequests = 0
  let fixture: Awaited<ReturnType<typeof runFactSearchCase>> | null = null
  globalThis.fetch = async (_url, init) => {
    networkRequests += 1
    const body = JSON.parse(String(init?.body)) as { id?: number; method?: string }
    if (body.method === 'initialize') {
      return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } })
    }
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 })
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '测试事实来源 https://example.test/fact' }] } })}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    fixture = await runFactSearchCase(true)
    assert.equal(fixture.result.ok, true, JSON.stringify(fixture.result))
    assert.equal(networkRequests, 3)
    const first = fixture.provider.requests[0]
    assert.ok(first)
    assert.deepEqual(first.tools?.map(tool => tool.name), ['prepare_fact_check'])
    assert.ok(fixture.provider.requests[1]?.tools?.some(tool => tool.name === 'search_fact_sources'))
    const systemPrompt = first.messages.find(message => message.role === 'system')?.content ?? ''
    assert.match(systemPrompt, /外部事实搜索已启用/)
    assert.match(systemPrompt, /search_fact_sources/)
    const searchResult = fixture.provider.requests.flatMap(request => request.messages)
      .find(message => message.role === 'tool' && message.name === 'search_fact_sources')
    assert.ok(searchResult)
    if (searchResult?.role === 'tool') {
      const envelope = JSON.parse(searchResult.content) as { ok?: boolean; result?: { mode?: string } }
      assert.equal(envelope.ok, true)
      assert.equal(envelope.result?.mode, 'external')
    }
  } finally {
    globalThis.fetch = originalFetch
    fixture?.storage.close()
    if (fixture !== null) rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('runFactCheck omits external tools and warns about model-only review when search is disabled', async () => {
  const fixture = await runFactSearchCase(false)
  try {
    assert.equal(fixture.result.ok, true)
    const first = fixture.provider.requests[0]
    assert.ok(first)
    assert.equal(first.tools?.some(tool => tool.name === 'search_fact_sources') ?? false, false)
    const systemPrompt = first.messages.find(message => message.role === 'system')?.content ?? ''
    assert.match(systemPrompt, new RegExp(MODEL_ONLY_FACT_NOTICE))
    assert.match(systemPrompt, /不调用任何外部网络工具/)
    const state = JSON.parse(first.messages.find(m => m.role === 'user')!.content);
    assert.match(state.artifacts.find((a: any) => a.kind === 'body').content, /下班散步/);
    assert.equal(typeof state.artifacts.find((a: any) => a.kind === 'evidence').content, 'object');
    assert.ok(Array.isArray(state.materialCatalog));
    assert.equal(fixture.provider.requests.length, 2, 'one extraction and one verification, no post-save prose-only model request');
    assert.equal(fixture.provider.requests.flatMap(request => request.messages)
      .some(message => message.role === 'tool' && message.name === 'search_fact_sources'), false)
  } finally {
    fixture.storage.close()
    rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})

test('fact retry reuses extraction and all saved searches in the same run after rebuilding the service', async () => {
  const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-retry-'));
  const storage = openWorkspaceStorage({ workspacePath });
  const seeded = seedFactInputs(storage);
  const originalFetch = globalThis.fetch;
  let searches = 0;
  const configuration = () => ({ parallelEnabled: false, tavilyEnabled: true, authorizationMode: 'enabled_services' as const,
    getTavilyKey: async () => 'synthetic-test-key' });
  globalThis.fetch = async () => { searches++; return Response.json({ results: [{ title: '已有公开资料', url: `https://example.test/fact/${searches}`, content: '保存下来的完整摘录，不需要再次联网。' }] }); };
  const requests: ModelRequest[] = [];
  class InterruptedProvider extends ModelProviderBase {
    constructor(private readonly resuming: boolean) { super('fact-retry-mock', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(structuredClone(request));
      const state = JSON.parse(request.messages.find(m => m.role === 'user')!.content);
      const extraction = factPreparationFixtureEvents(request);
      if (!this.resuming && extraction) { yield* extraction; return; }
      let name: string, args: unknown;
      if (!this.resuming) {
        name = 'search_fact_sources'; args = { query: `公开事实${searches + 1}` };
      } else {
        assert.equal(state.factPhase, 'verify', 'no second full-article extraction after an unchanged-input retry');
        assert.equal(state.searchBudget.used, 6);
        assert.equal(state.searchBudget.remaining, 0);
        assert.equal(request.tools?.some(t => t.name === 'search_fact_sources'), false);
        assert.equal(state.savedSourceRecords.length, 6, 'same-preparation sources must be discoverable without the old conversation');
        const read = request.messages.find(m => m.role === 'tool' && m.name === 'read_fact_record');
        if (!read) { name = 'read_fact_record'; args = { callId: state.savedSourceRecords[0].callId, resultIndex: 0 }; }
        else {
          assert.match(JSON.parse(read.content).result.text, /保存下来的完整摘录/);
          name = 'submit_fact_check'; args = { claims: [], noFactualClaimsReason: '全文仅为感受，无外部事实主张。' };
        }
      }
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const first = new WritingApplicationService({ storage, provider: new InterruptedProvider(false), factSearchConfiguration: configuration });
    const stopped = await first.runFactCheck({ projectId: 'project-1', expectedProjectRevision: seeded.projectRevision,
      model: 'mock', parameters: {}, budget: { maxModelRequests: 7, maxToolCalls: 7, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
    assert.equal(stopped.ok, false);
    assert.equal(storage.getRun(stopped.runId)?.status, 'budget_exhausted');
    assert.equal(searches, 6);
    const resumedApp = new WritingApplicationService({ storage, provider: new InterruptedProvider(true), factSearchConfiguration: configuration });
    const resumeInput = { projectId: 'project-1', runId: stopped.runId, operationId: 'explicit-fact-retry', decision: 'resume' as const,
      expectedProjectRevision: storage.inspectProject('project-1')!.revision, model: 'mock', parameters: {} };
    assert.throws(() => resumedApp.resumeFactCheck({ ...resumeInput, sessionId: 'another-session' }), { code: 'RUN_SCOPE_INVALID' });
    assert.equal(storage.getRun(stopped.runId)?.status, 'budget_exhausted', 'invalid recovery cannot mutate the paused run');
    assert.equal(storage.listRunEvents(stopped.runId).some(e => e.type === 'run.resumed'), false);
    const handle = resumedApp.resumeFactCheck(resumeInput);
    const result = await handle.result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.runId, stopped.runId);
    assert.equal(searches, 6, 'retry cannot issue any extra network search');
    assert.equal(storage.listRuns('project-1').length, 1);
    assert.equal(requests.filter(r => JSON.parse(r.messages.find(m => m.role === 'user')!.content).factPhase === 'extract').length, 1);
    assert.equal(storage.listRunEvents(stopped.runId).filter(e => e.type === 'tool.completed' && (e.payload.result as any)?.toolName === 'prepare_fact_check').length, 1);
    assert.throws(() => resumedApp.resumeFactCheck({ ...resumeInput, operationId: 'completed-retry' }), { code: 'RUN_NOT_RESUMABLE' });
  } finally { globalThis.fetch = originalFetch; storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
});
