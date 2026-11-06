import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../../packages/runtime/llm/src/index.js';
import { DEFAULT_MODEL_GROUPS, modelGroupForActor } from '../../../packages/client-bridge/src/model-groups.js';
import { groupProviderConfig, loadDesktopProviderCatalog, markDesktopProviderVerified, saveDesktopProviderProfile, saveModelGroups, selectDesktopProvider, verifiedProviderModels } from '../src/provider-profile.js';
import { DesktopApplicationHost } from '../src/application-host.js';

const input = { profileId: null, kind: 'openai_compatible' as const, providerId: 'test', baseURL: 'https://model.example.test/v1',
  model: 'fast', models: ['fast', 'writer'], tools: 'supported' as const, usage: 'unknown' as const, apiKey: 'synthetic-test', persistence: 'session' as const };

test('model groups inherit by default and only accept verification for the exact saved model/configuration', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-model-groups-'));
  const path = join(root, 'providers.json');
  const credentials = new CredentialBroker({ environment: {} });
  try {
    const { config } = await saveDesktopProviderProfile(path, credentials, input);
    const catalog = loadDesktopProviderCatalog(path), id = catalog.activeProfileId!;
    assert.equal(groupProviderConfig(catalog, config, 'draft'), config);
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
    const saved = loadDesktopProviderCatalog(path);
    assert.deepEqual(saved.modelGroups, groups);
    assert.deepEqual(Object.keys(verifiedProviderModels(saved.profiles[0]!)).sort(), ['fast', 'writer']);
    assert.equal(groupProviderConfig(saved, config, 'draft')?.model, 'writer');
    assert.equal(groupProviderConfig(saved, config, 'director')?.model, 'fast');
    assert.equal(groupProviderConfig(saved, config, 'fact_check')?.model, 'fast');
    await saveDesktopProviderProfile(path, credentials, { ...input, profileId: id, apiKey: '', displayName: '改名', models: ['fast', 'writer', 'new-model'] });
    assert.deepEqual(Object.keys(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!)).sort(), ['fast', 'writer']);
    markDesktopProviderVerified(path, id, { ...config, model: 'writer' }, false);
    assert.throws(() => groupProviderConfig(loadDesktopProviderCatalog(path), config, 'draft'), { code: 'MODEL_GROUP_UNAVAILABLE' });
    assert.ok(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!).fast);
    await saveDesktopProviderProfile(path, credentials, { ...input, profileId: id, apiKey: 'replacement-synthetic' });
    // A late result for the old key must not verify the replacement profile.
    markDesktopProviderVerified(path, id, { ...config, model: 'writer' });
    assert.deepEqual(verifiedProviderModels(loadDesktopProviderCatalog(path).profiles[0]!), {});
    assert.deepEqual(loadDesktopProviderCatalog(path).modelGroups, groups, 'do not silently reset explicit selections');
    assert.equal(readFileSync(path, 'utf8').includes('synthetic'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('group mapping covers creative, orchestration, reader children and lightweight fact phases', () => {
  for (const actor of ['intake', 'director', 'outline', 'topic_generator', 'topic_research', 'position', 'fact_extract']) assert.equal(modelGroupForActor(actor), 'planning');
  for (const actor of ['draft', 'central_revision', 'language_review', 'title', 'opening', 'style_modeler', 'concretizer', 'empathy']) assert.equal(modelGroupForActor(actor), 'writing');
  for (const actor of ['research', 'review_editor', 'review_publish', 'review_reader', 'review_reader_a', 'review_reader_b', 'review_reader_c', 'fact_check', 'illustrator', 'memory', 'retrospective']) assert.equal(modelGroupForActor(actor), 'review');
});

test('desktop verifies a non-default model without switching default, persists groups and routes style generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-model-group-host-'));
  const requests: Array<{ provider: string; model: string }> = [];
  class Provider extends ModelProviderBase {
    constructor(id: string) { super(id, '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push({ provider: this.id, model: request.model });
      if (request.tools?.some(tool => tool.name === 'writing_agent_capability_probe')) {
        yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'writing_agent_capability_probe', argumentsDelta: '{"value":"ok"}' };
        yield { type: 'completed', finishReason: 'tool_calls' };
      } else {
        yield { type: 'text_delta', delta: JSON.stringify({ summary: '平实自然的短句。', rules: [] }) };
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
    assert.equal((await host.testProviderConnection(target)).ok, true);
    assert.equal((await host.providerStatus()).activeProfileId, fast.activeProfileId);
    assert.equal((await host.providerStatus()).model, 'fast');
    assert.ok((await host.providerStatus()).profiles?.find(p => p.profileId === target.profileId)?.verifiedModels?.writer);
    await host.configureModelGroups({ ...DEFAULT_MODEL_GROUPS, writing: target });
    host.close(); host = new DesktopApplicationHost(options);
    assert.deepEqual((await host.providerStatus()).modelGroups?.writing, target);
    await host.styleLibrary({ action: 'analyze', name: '测试风格', samples: [{ id: 'one', title: '样文', kind: 'text', sourceReference: null, text: '窗外很安静。我写下几句话，留下一点空白。' }] });
    assert.deepEqual(requests.at(-1), { provider: 'creative', model: 'writer' });
    await host.configureModelGroups(DEFAULT_MODEL_GROUPS);
    await host.styleLibrary({ action: 'analyze', name: '默认风格', samples: [{ id: 'one', title: '样文', kind: 'text', sourceReference: null, text: '窗外很安静。我写下几句话，留下一点空白。' }] });
    assert.deepEqual(requests.at(-1), { provider: 'test', model: 'fast' });
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});
