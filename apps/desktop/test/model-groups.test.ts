import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../../packages/runtime/llm/src/index.js';
import { DEFAULT_MODEL_GROUPS, modelGroupForActor } from '../../../packages/client-bridge/src/model-groups.js';
import { groupProviderConfig, loadDesktopProviderCatalog, markDesktopProviderVerified, saveDesktopProviderProfile, saveModelGroups, selectDesktopProvider, verifiedProviderModels } from '../src/provider-profile.js';
import { DesktopApplicationHost } from '../src/application-host.js';
import { styleAnalysisResponse } from '../../../packages/application/test/style-analysis-fixture.js';

const input = { profileId: null, kind: 'openai_compatible' as const, providerId: 'test', baseURL: 'https://model.example.test/v1',
  model: 'fast', models: ['fast', 'writer'], tools: 'supported' as const, usage: 'unknown' as const, apiKey: 'synthetic-test', persistence: 'session' as const };

test('model groups require explicit verified selections and preserve legacy assignments on upgrade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-model-groups-'));
  const path = join(root, 'providers.json');
  const credentials = new CredentialBroker({ environment: {} });
  try {
    const { config } = await saveDesktopProviderProfile(path, credentials, input);
    const catalog = loadDesktopProviderCatalog(path), id = catalog.activeProfileId!;
    assert.throws(() => groupProviderConfig(catalog, 'draft'), { code: 'MODEL_GROUP_UNAVAILABLE' });
    const groups = { ...DEFAULT_MODEL_GROUPS, writing: { profileId: id, model: 'writer' } };
    const original = readFileSync(path, 'utf8');
    assert.throws(() => saveModelGroups(path, groups), { code: 'MODEL_GROUP_UNAVAILABLE' });
    assert.equal(readFileSync(path, 'utf8'), original);
    markDesktopProviderVerified(path, id, config);
    assert.throws(() => saveModelGroups(path, groups), { code: 'MODEL_GROUP_UNAVAILABLE' });
    markDesktopProviderVerified(path, id, { ...config, model: 'writer' });
    saveModelGroups(path, groups);
    selectDesktopProvider(path, id, 'writer');
    selectDesktopProvider(path, id, 'fast');
    assert.throws(() => groupProviderConfig(loadDesktopProviderCatalog(path), 'outline'), { code: 'MODEL_GROUP_UNAVAILABLE' });
    const { modelRouting: _explicit, ...legacy } = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify(legacy));
    const light = { profileId: id, model: 'fast' };
    const migrated = { ...groups, planning: light, review: light };
    assert.deepEqual(loadDesktopProviderCatalog(path).modelGroups, migrated);
    selectDesktopProvider(path, id, 'writer');
    const saved = loadDesktopProviderCatalog(path);
    assert.deepEqual(saved.modelGroups, migrated);
    assert.deepEqual(Object.keys(verifiedProviderModels(saved.profiles[0]!)).sort(), ['fast', 'writer']);
    assert.equal(groupProviderConfig(saved, 'draft').model, 'writer');
    assert.equal(groupProviderConfig(saved, 'director').model, 'writer');
    assert.equal(groupProviderConfig(saved, 'fact_check').model, 'fast');
    assert.equal(groupProviderConfig(saved, 'fact_extract').model, 'fast');
    assert.equal(groupProviderConfig(saved, 'central_revision').model, 'writer');
    assert.equal(groupProviderConfig(saved, 'outline').model, 'fast');
    assert.equal(groupProviderConfig(saved, 'language_review').model, 'fast');
    await saveDesktopProviderProfile(path, credentials, { ...input, profileId: id, apiKey: '', displayName: '改名', models: ['fast', 'writer', 'new-model'] });
    assert.deepEqual(Object.keys(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!)).sort(), ['fast', 'writer']);
    markDesktopProviderVerified(path, id, { ...config, model: 'writer' }, false);
    assert.throws(() => groupProviderConfig(loadDesktopProviderCatalog(path), 'draft'), { code: 'MODEL_GROUP_UNAVAILABLE' });
    assert.ok(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!).fast);
    await saveDesktopProviderProfile(path, credentials, { ...input, profileId: id, apiKey: 'replacement-synthetic' });
    // A late result for the old key must not verify the replacement profile.
    markDesktopProviderVerified(path, id, { ...config, model: 'writer' });
    assert.deepEqual(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!), {});
    assert.deepEqual(loadDesktopProviderCatalog(path).modelGroups, migrated, 'do not silently reset explicit selections');
    assert.equal(readFileSync(path, 'utf8').includes('synthetic'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('group mapping covers creative, orchestration, reader children and lightweight fact phases', () => {
  for (const actor of ['outline', 'review_editor', 'review_publish', 'language_review', 'review_reader', 'review_reader_a', 'review_reader_b', 'review_reader_c', 'retrospective']) assert.equal(modelGroupForActor(actor), 'planning');
  for (const actor of ['intake', 'author', 'director', 'topic_generator', 'topic_research', 'position', 'draft', 'central_revision', 'title', 'opening', 'style_modeler', 'concretizer', 'empathy']) assert.equal(modelGroupForActor(actor), 'writing');
  for (const actor of ['research', 'fact_extract', 'fact_check', 'illustrator', 'memory']) assert.equal(modelGroupForActor(actor), 'review');
});

test('desktop requests use configured groups, and an incomplete configuration sends no writing request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-model-group-host-'));
  const requests: Array<{ provider: string; model: string }> = [];
  class Provider extends ModelProviderBase {
    constructor(id: string) { super(id, '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push({ provider: this.id, model: request.model });
      if (request.tools?.some(tool => tool.name === 'writing_agent_capability_probe')) {
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'writing_agent_capability_probe', argumentsDelta: '{"value":"ok"}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else if (request.tools?.some(tool => tool.name === 'respond_writing_intake')) {
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'respond_writing_intake',
          argumentsDelta: JSON.stringify({ reply: '我们先聊聊具体想法。', summary: '城市观察', questions: [] }) };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: JSON.stringify(styleAnalysisResponse('one')) };
        yield { type: 'completed', finishReason: 'stop' };
      }
    }
  }
  const options = { workspacePath: join(root, 'workspace'), providerProfilePath: join(root, 'providers.json'),
    credentials: new CredentialBroker({ environment: {} }), providerFactory: (config: { providerId: string }) => new Provider(config.providerId) };
  let host = new DesktopApplicationHost(options);
  try {
    const fast = await host.configureProvider(input);
    const writer = await host.configureProvider({ ...input, providerId: 'creative', baseURL: 'https://creative.example.test/v1' });
    await host.selectProvider(fast.activeProfileId!, 'fast');
    const target = { profileId: writer.activeProfileId!, model: 'writer' };
    const quick = { profileId: fast.activeProfileId!, model: 'fast' };
    assert.equal((await host.testProviderConnection(target)).ok, true);
    assert.equal((await host.testProviderConnection(quick)).ok, true);
    assert.ok((await host.providerStatus()).profiles?.find(p => p.profileId === target.profileId)?.verifiedModels?.writer);
    await host.configureModelGroups({ ...DEFAULT_MODEL_GROUPS, writing: target });
    const probeCount = requests.length;
    await assert.rejects(host.bridge.startConversation('城市观察'), /MODEL_CONFIGURATION_REQUIRED/);
    assert.equal(requests.length, probeCount);
    assert.equal(host.bridge.getSnapshot().projects.length, 0);
    await host.configureModelGroups({ writing: target, planning: quick, review: quick });
    host.close(); host = new DesktopApplicationHost(options);
    assert.deepEqual((await host.providerStatus()).modelGroups?.writing, target);
    await host.bridge.startConversation('城市观察');
    const deadline = Date.now() + 5000;
    while (host.bridge.getSnapshot().connection !== 'ready' && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
      await host.bridge.refresh();
    }
    assert.equal(host.bridge.getSnapshot().connection, 'ready');
    assert.deepEqual(requests.at(-1), { provider: 'creative', model: 'writer' });
    await host.styleLibrary({ action: 'analyze', name: '测试风格', samples: [{ id: 'one', title: '样文', kind: 'text', sourceReference: null, text: '窗外很安静。我写下几句话，留下一点空白。' }] });
    assert.deepEqual(requests.at(-1), { provider: 'creative', model: 'writer' });
    await host.configureModelGroups(DEFAULT_MODEL_GROUPS);
    await assert.rejects(host.styleLibrary({ action: 'analyze', name: '测试风格', samples: [{ id: 'one', title: '样文', kind: 'text', sourceReference: null, text: '窗外很安静。我写下几句话，留下一点空白。' }] }),
      { code: 'MODEL_GROUP_UNAVAILABLE' });
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});
