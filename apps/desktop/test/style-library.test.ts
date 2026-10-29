import assert from 'node:assert/strict';
import test from 'node:test';
import { styleProviderConfig } from '../src/style-provider.js';

test('style-only MiniMax effort defaults are protocol-aware and preserve explicit settings', () => {
  const base = { schemaVersion: 2 as const, providerId: 'minimax', baseURL: 'https://example.test/v1', credentialRef: 'session:test', model: 'MiniMax-M3.1-Flash', tools: 'supported' as const, usage: 'reported' as const };
  for (const kind of ['openai_compatible', 'openai_responses', 'anthropic_compatible'] as const) {
    const config = { ...base, kind };
    const adjusted = styleProviderConfig(config);
    const field = kind === 'openai_compatible' ? 'reasoning_effort' : kind === 'openai_responses' ? 'reasoning' : 'output_config';
    assert.deepEqual(adjusted.extraBody?.[field], kind === 'openai_compatible' ? 'low' : { effort: 'low' });
    assert.equal('extraBody' in config, false);
    const explicit = { ...config, extraBody: { [field]: kind === 'openai_compatible' ? 'high' : { effort: 'high' } } };
    assert.deepEqual(styleProviderConfig(explicit).extraBody, explicit.extraBody);
    const otherModel = { ...config, model: 'another-model' };
    assert.equal(styleProviderConfig(otherModel), otherModel);
  }
});
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, strToU8 } from 'fflate';
import { DesktopApplicationHost } from '../src/application-host.js';
import { decodeStyleDocument } from '../src/style-source.js';
import { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage, migrateWorkspaceStorage } from '../../../packages/storage/src/index.js';
import { styleReferenceForProfile, type StyleDraft } from '../../../packages/writing-core/src/style-profile.js';
import { buildWritingPrompt } from '../../../packages/writing-pack/src/index.js';
import { safeDesktopFailure } from '../src/rpc-host.js';

const sample = { id: 'sample-a', title: '窗边', kind: 'text' as const, sourceReference: null, text: '清晨的窗很亮。人群慢慢散开。样文事实标记，不该进入新文章。' };
const rules = ['语气', '节奏', '开头', '推进', '结尾'].map(dimension => ({ dimension, instruction: '从可观察的细节开始，用短句推进。', evidence: [{ sampleId: sample.id, quote: '清晨的窗很亮。' }], confidence: 'sample' as const }));
const fixture: StyleDraft = { name: '克制观察', card: '用具体细节与长短句推进；不要凭空添加事实或亲历。', summary: '短句、具体细节。', rules, samples: [sample], sampleCount: 1, analyzedCharacters: sample.text.length, totalCharacters: sample.text.length, elapsedMs: 10, modelRequests: 1 };
class Provider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  never = false;
  constructor() { super('style-host-test', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    if (this.never) { await new Promise<void>(() => {}); return; }
    yield { type: 'text_delta', delta: JSON.stringify({ summary: fixture.summary, rules }) };
    yield { type: 'completed', finishReason: 'stop' };
  }
}
function createHost(root: string, provider = new Provider()) {
  return new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {}, systemBackend: { isAvailable: async () => true, read: async () => null, write: async () => {}, delete: async () => {} } }), providerFactory: () => provider,
    authorWebFetcher: { async fetchText(url) { return { finalUrl: url, redirectCount: 0, contentType: 'text/html', bodyHash: 'test',
      content: { text: sample.text, title: '公众号样文', truncated: false, totalChars: sample.text.length, activeContentRemoved: true, trustLabel: 'external_untrusted', instructionAuthority: 'none' } }; } } });
}
async function configure(host: DesktopApplicationHost) {
  await host.configureProvider({ kind: 'openai_compatible', providerId: 'test', baseURL: 'https://example.test/v1', model: 'm', tools: 'supported', usage: 'unknown', apiKey: 'test-only', persistence: 'session' });
}

test('desktop library analyzes once, saves explicitly, versions edits, survives reopen and removes without changing applied cards', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-style-host-')); const provider = new Provider(); let host = createHost(root, provider);
  try {
    await configure(host);
    const analysis = await host.styleLibrary({ action: 'analyze', name: fixture.name, samples: [sample] });
    assert.equal(provider.requests.length, 1); assert.deepEqual((await host.styleLibrary({ action: 'list' })).profiles, []);
    const created = (await host.styleLibrary({ action: 'save', id: null, expectedVersion: null, draft: analysis.draft })).profile!;
    const frozen = styleReferenceForProfile(created);
    assert.equal(created.version, 1);
    const { id: _id, version: _version, updatedAt: _at, ...draft } = created;
    await host.styleLibrary({ action: 'save', id: created.id, expectedVersion: 1, draft: { ...draft, card: '改为自然的长短句交替。' } });
    await assert.rejects(host.styleLibrary({ action: 'save', id: created.id, expectedVersion: 1, draft }), /STYLE_VERSION_CONFLICT/);
    host.close(); host = createHost(root, provider);
    const saved = (await host.styleLibrary({ action: 'get', id: created.id })).profile!;
    assert.equal(saved.version, 2); assert.notEqual(frozen, styleReferenceForProfile(saved));
    const listing = await host.styleLibrary({ action: 'list' });
    assert.equal(listing.profiles.length, 1); assert.equal(JSON.stringify(listing).includes('样文事实标记'), false);
    await host.styleLibrary({ action: 'delete', id: saved.id, expectedVersion: saved.version });
    assert.deepEqual((await host.styleLibrary({ action: 'list' })).profiles, []);
    assert.match(frozen, /v1/);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('imports DOCX and native-selected text; rejects bad documents and arbitrary renderer file paths', async () => {
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p></w:body></w:document>'), 'ignored.bin': new Uint8Array(100) });
  assert.equal(decodeStyleDocument('sample.docx', docx).text, '第一段\n\n第二段');
  assert.throws(() => decodeStyleDocument('sample.pdf', strToU8('hello')), /STYLE_DOCUMENT_TYPE/);
  assert.throws(() => decodeStyleDocument('sample.txt', new Uint8Array([255])), /STYLE_DOCUMENT_ENCODING/);
  assert.throws(() => decodeStyleDocument('sample.docx', new Uint8Array([0])), /STYLE_DOCUMENT_INVALID/);
  const root = mkdtempSync(join(tmpdir(), 'wa-style-files-')); const host = createHost(root);
  try {
    const path = join(root, 'sample.txt'); writeFileSync(path, sample.text);
    const loaded = await host.styleLibrary({ action: 'import' }, async () => path);
    assert.equal(loaded.sample?.text, sample.text); assert.equal(loaded.sample?.sourceReference, 'sample.txt');
    assert.equal((await host.styleLibrary({ action: 'import' }, async () => null)).cancelled, true);
    await assert.rejects(host.styleLibrary({ action: 'import', path }), /STYLE_INPUT_INVALID/);
    const web = await host.styleLibrary({ action: 'source', url: 'https://mp.weixin.qq.com/s/example' });
    assert.equal(web.sample?.kind, 'web'); assert.equal(web.sample?.title, '公众号样文');
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('cancels a model ignoring AbortSignal, blocks concurrent analysis and never saves late output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-style-cancel-')); const provider = new Provider(); provider.never = true; const host = createHost(root, provider);
  try {
    await configure(host);
    const pending = host.styleLibrary({ action: 'analyze', name: fixture.name, samples: [sample] });
    await assert.rejects(host.styleLibrary({ action: 'analyze', name: fixture.name, samples: [sample] }), /STYLE_LIBRARY_BUSY/);
    await host.styleLibrary({ action: 'cancel' });
    await assert.rejects(pending, /STYLE_ANALYSIS_CANCELLED/);
    assert.deepEqual((await host.styleLibrary({ action: 'list' })).profiles, []);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('schema 8 migration installs a persistent library; readonly storage refuses mutations', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-style-schema-'));
  let storage = openWorkspaceStorage({ workspacePath: root }); const path = storage.databasePath; storage.close();
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE style_profiles; DELETE FROM schema_migrations WHERE version=9; PRAGMA user_version=8;'); db.close();
  try {
    const migrated = await migrateWorkspaceStorage({ workspacePath: root });
    assert.equal(migrated.toVersion, 9);
    storage = openWorkspaceStorage({ workspacePath: root });
    const saved = storage.styleProfiles().save(null, null, fixture); storage.close();
    storage = openWorkspaceStorage({ workspacePath: root, readOnly: true });
    assert.equal(storage.styleProfiles().get(saved.id).name, fixture.name);
    assert.throws(() => storage.styleProfiles().remove(saved.id, saved.version), /STORAGE_READ_ONLY/);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});

test('writing gets only chosen compact rules as data, not samples, source identity or analysis evidence', () => {
  const ref = styleReferenceForProfile({ ...fixture, id: 'style-1', version: 1 });
  const prompt = buildWritingPrompt({ mode: 'quick', materials: [], brief: {
    schemaVersion: 1, topic: '城市散步', genre: 'narrative_observation', audience: '上班族', lengthTarget: { targetCharacters: 1200 }, materialIds: [], constraints: [], interactionMode: 'co_creation', confirmationStatus: 'confirmed',
    authorAuthorization: { voice: null, styleReference: ref, styleDecision: 'user_confirmed', directionDecision: 'user_confirmed', firsthandMaterialIds: [] }, platform: 'wechat', publicationGoal: 'not_applicable' } });
  assert.ok(prompt.userMessage.includes(ref.replaceAll('\n', '\\n')));
  assert.equal(prompt.systemPrompt.includes(fixture.card), false);
  assert.equal(JSON.stringify(prompt).includes('样文事实标记'), false);
  assert.match(prompt.systemPrompt, /不复制样文事实/);
});

test('safe public style errors do not expose provider response bodies', () => {
  const failure = safeDesktopFailure(new Error('STYLE_MODEL_NETWORK_ERROR'));
  assert.equal(failure.ok, false);
  if (!failure.ok) assert.equal(failure.error.code, 'STYLE_MODEL_FAILED');
});
