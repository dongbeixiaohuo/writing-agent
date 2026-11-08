import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';
import { createApplicationBridge } from '../../client-bridge/src/application-bridge.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { styleContext, styleStatistics } from '../../writing-core/src/style-package.js';
import { intentFixtureEvents } from './intent-fixture.js';

class Provider extends ModelProviderBase {
  requests: ModelRequest[] = [];
  constructor() { super('style-selection-test', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    const intent = intentFixtureEvents(request); if (intent) { yield* intent; return; }
    yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: 'respond_writing_intake', argumentsDelta: JSON.stringify({ reply: '准备写给谁看？', summary: '已收到主题', questions: ['写给谁看？'] }) };
    yield { type: 'completed', finishReason: 'tool_calls' };
  }
}
const samples = [{ id: 'a', title: '窗口', kind: 'text' as const, sourceReference: null, text: '片段原文。\n不应全篇外发的样文余下内容。' }];

test('each bundled style selects independently and reaches writing roles without biasing research or reader review', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-builtin-selection-'));
  let storage = openWorkspaceStorage({ workspacePath: root });
  try {
    const service = new WritingApplicationService({ storage });
    const profiles = storage.styleProfiles().list().filter(p => p.builtin);
    for (const [i, metadata] of profiles.entries()) {
      const projectId = `trial-${i}`;
      service.createProject({ projectId, operationId: `create-${i}`, name: projectId, mode: 'quick', actor: { kind: 'user', id: 'test' } });
      assert.equal(service.getProjectStyleSelection(projectId), undefined, 'neither candidate is chosen by default');
      assert.throws(() => service.selectProjectStyle(projectId, { id: metadata.id, version: metadata.version + 1 }, `stale-${i}`), /STYLE_VERSION_CONFLICT/);
      service.selectProjectStyle(projectId, { id: metadata.id, version: metadata.version }, `select-${i}`);
      const selection = service.getProjectStyleSelection(projectId)!;
      const profile = storage.styleProfiles().get(metadata.id);
      assert.equal(selection.card, profile.card);
      for (const role of ['outline', 'writer', 'title', 'review_editor']) {
        const context = styleContext(selection, role);
        assert.ok(context.includes(profile.card));
        assert.ok(context.length <= 4000);
        assert.ok(context.includes('句式片段'), `${role} retains examples`);
        assert.ok(!context.includes(profiles.find(p => p.id !== profile.id)!.name));
      }
      for (const role of ['research', 'fact_check', 'review_reader']) assert.equal(styleContext(selection, role), '');
      assert.ok(!styleContext(selection, 'intake').includes(profile.card));
    }
    storage.close(); storage = openWorkspaceStorage({ workspacePath: root });
    const reopened = new WritingApplicationService({ storage });
    for (const [i, p] of profiles.entries()) assert.equal(reopened.getProjectStyleSelection(`trial-${i}`)!.name, p.name);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wa-style-selection-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  const provider = new Provider();
  const service = new WritingApplicationService({ storage, provider });
  const profile = storage.styleProfiles().save(null, null, { name: '克制观察', card: '核心卡独特标记：用短句呈现场景。', summary: '短句观察', rules: [], samples, sampleCount: 1, analyzedCharacters: samples[0]!.text.length, totalCharacters: samples[0]!.text.length, elapsedMs: 1, modelRequests: 1,
    package: { version: 2, statistics: styleStatistics(samples), patterns: [{ kind: 'structure', instruction: '先观察，再追问。' }], snippets: [{ sampleId: 'a', paragraphId: 'p1:0', kind: 'opening', quote: '片段原文。' }, { sampleId: 'a', paragraphId: 'p1', kind: 'ending', quote: '不存在的例句' }] } });
  return { root, storage, provider, service, profile, close() { storage.close(); rmSync(root, { recursive: true, force: true }); } };
}

test('project selection persists a bounded snapshot, survives library edits/deletion, isolates projects and clears explicitly', () => {
  const f = fixture();
  try {
    for (const projectId of ['a', 'b']) f.service.createProject({ projectId, operationId: `create-${projectId}`, name: projectId, mode: 'quick', actor: { kind: 'user', id: 'test' } });
    assert.equal(f.profile.package!.snippets.length, 1, 'invalid optional snippet omitted at save');
    f.service.selectProjectStyle('a', { id: f.profile.id, version: 1 }, 'select');
    const selected = f.service.getProjectStyleSelection('a')!;
    assert.equal(selected.card, f.profile.card);
    assert.ok(!JSON.stringify(selected).includes('不应全篇外发'));
    assert.equal(f.service.getProjectStyleSelection('b'), undefined);
    const revision = f.storage.inspectProject('a')!.revision;
    f.service.selectProjectStyle('a', { id: f.profile.id, version: 1 }, 'same');
    assert.equal(f.storage.inspectProject('a')!.revision, revision, 'unchanged selection is a no-op');
    const { id: _id, version: _version, updatedAt: _time, ...draft } = f.profile;
    f.storage.styleProfiles().save(f.profile.id, 1, { ...draft, name: '库里修改', card: '新的卡' });
    assert.throws(() => f.service.selectProjectStyle('b', { id: f.profile.id, version: 1 }, 'stale'), /STYLE_VERSION_CONFLICT/);
    f.storage.styleProfiles().remove(f.profile.id, 2);
    const reopened = new WritingApplicationService({ storage: f.storage });
    assert.deepEqual(reopened.getProjectStyleSelection('a'), selected);
    reopened.selectProjectStyle('a', null, 'clear');
    assert.equal(reopened.getProjectStyleSelection('a'), null);
    assert.throws(() => reopened.selectProjectStyle('b', { id: 'missing', version: 1 }, 'missing'), /STYLE_PROFILE_NOT_FOUND/);
  } finally { f.close(); }
});

test('new conversation resolves ID at backend while retaining only user text in source turns', async () => {
  const f = fixture();
  const bridge = createApplicationBridge({ service: f.service, workspaceId: 'test', model: { model: 'mock', parameters: {}, providerLabel: 'mock', credentialReference: 'test' } });
  try {
    await assert.rejects(bridge.startConversation('主题', { operationId: 'invalid', styleSelection: { id: 'missing', version: 1 } }), /STYLE_PROFILE_NOT_FOUND/);
    assert.equal(f.service.listProjects().length, 0, 'invalid selection must not create an empty project');
    await bridge.startConversation('我想写夜跑', { operationId: 'new', styleSelection: { id: f.profile.id, version: 1 } });
    const projectId = bridge.getSnapshot().selectedProjectId;
    const deadline = Date.now() + 5000;
    while (f.storage.listRuns(projectId).some(r => r.status === 'running')) { assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10)); }
    assert.equal(f.service.getProjectStyleSelection(projectId)!.name, '克制观察');
    const state = f.service.getConversationIntake(projectId);
    assert.equal(state.sourceTurns[0]!.quote, '我想写夜跑');
    const intake = f.provider.requests.filter(r => r.tools?.some(t => t.name === 'respond_writing_intake'));
    assert.ok(intake.length > 0);
    assert.ok(intake.some(r => JSON.stringify(r.messages).includes('克制观察')));
    assert.ok(intake.every(r => !JSON.stringify(r.messages).includes(f.profile.card)), 'intake sees name, not full card or examples');
  } finally { bridge.dispose(); f.close(); }
});
