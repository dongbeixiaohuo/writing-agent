import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js'
import { openWorkspaceStorage } from '../../storage/src/index.js'
import { MODEL_ONLY_FACT_NOTICE } from '../src/fact-search.js'
import { WritingApplicationService } from '../src/index.js'

const actor = { kind: 'user', id: 'fact-search-integration' } as const

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
    assert.ok(first.tools?.some(tool => tool.name === 'search_fact_sources'))
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
    assert.equal(fixture.provider.requests.length, 1, 'save ends the check without rereading or another prose-only model request');
    assert.equal(fixture.provider.requests.flatMap(request => request.messages)
      .some(message => message.role === 'tool' && message.name === 'search_fact_sources'), false)
  } finally {
    fixture.storage.close()
    rmSync(fixture.workspacePath, { recursive: true, force: true })
  }
})
