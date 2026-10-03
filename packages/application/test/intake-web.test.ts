import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';
import { intentFixtureEvents } from './intent-fixture.js';
import { SecureWebFetchError } from '../../runtime/tools/src/index.js';

const url = 'https://93.184.216.34/article';
const article = '公众号测试正文。这里只是第三方观察，不是作者亲历。';

for (const forbidden of [false, true]) it(`intake handles a restricted article without inventing material (network forbidden: ${forbidden})`, async () => {
  let fetches = 0;
  const provider = new class extends ModelProviderBase {
    constructor() { super('blocked-web', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const result = request.messages.find(message => message.role === 'tool');
      if (forbidden) assert.equal(request.tools?.some(tool => tool.name === 'read_author_web') ?? false, false);
      else if (result) assert.match(result.content, /WEB_ARTICLE_ACCESS_RESTRICTED/);
      yield { type: 'tool_call_delta', index: 0, id: request.requestId,
        name: forbidden || result ? 'respond_writing_intake' : 'read_author_web',
        argumentsDelta: JSON.stringify(forbidden || result
          ? { reply: forbidden ? '不会联网读取。' : '微信要求验证，未读到正文；可以粘贴正文供参考。', summary: '未读取网页', questions: [] }
          : { url }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }();
  const directory = mkdtempSync(join(tmpdir(), 'blocked-intake-web-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    storage.createProject({ projectId: 'project', operationId: 'create', name: '测试', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    const service = new WritingApplicationService({ storage, provider, authorWebFetcher: { async fetchText() {
      fetches++; throw new SecureWebFetchError('WEB_ARTICLE_ACCESS_RESTRICTED', 'WeChat verification required');
    } } });
    const result = await service.startConversationTurn({ projectId: 'project', sessionId: 'session', model: 'mock', parameters: {},
      userInstruction: `${forbidden ? '不要联网读取，仅保存这个链接' : '读这篇公众号文章'} ${url}` }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fetches, forbidden ? 0 : 1);
    assert.equal(storage.listMaterials('project').filter(material => material.sourceKind === 'web_snapshot').length, 0);
    assert.equal(storage.inspectProject('project')!.currentBriefVersionId, null);
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});

for (const propose of [false, true]) it(`first-turn URL persists and can be reused before confirmation (proposal route: ${propose})`, async () => {
  let fetches = 0;
  const provider = new class extends ModelProviderBase {
    requests: ModelRequest[] = [];
    step = 0;
    constructor() { super('intake-web', '1', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'reported' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const intent = intentFixtureEvents(request, [propose ? 'propose_direction' : 'discuss', null]);
      if (intent) { yield* intent; return; }
      this.requests.push(request);
      const step = this.step++;
      let name: string, args: unknown;
      if (step === 0) {
        assert.ok(request.tools?.some(tool => tool.name === 'read_author_web'), 'intake must expose the URL reader');
        name = 'read_author_web'; args = { url };
      } else if (step === 1) {
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(article)), 'model must receive actual text, not only material IDs');
        name = 'respond_writing_intake'; args = { reply: '读到了这篇文章，接下来讨论你的观察。', summary: '已读取公众号材料', questions: [] };
      } else if (step === 2) {
        assert.match(request.messages.find(message => message.role === 'system')!.content, /read_material/,
          'proposal routing must explain that saved references can be read before submitting');
        const user = request.messages.find(message => message.role === 'user')!.content;
        const material = storage.listMaterials('project').find(item => item.sourceKind === 'web_snapshot')!;
        assert.ok(user.includes(material.id), 'later intake must see persisted source catalogue');
        name = 'read_material'; args = { materialId: material.id, contentVersionId: material.contentVersionId, offset: 0, maxChars: 4000 };
      } else {
        assert.ok(request.messages.some(message => message.role === 'tool' && message.content.includes(article)));
        const proposal = {
          brief: { topic: '围绕参考文章的观察', genre: 'narrative_observation', audience: '普通读者', targetCharacters: 1000, constraints: [], publicationGoal: 'not_applicable' }, assumptions: ['篇幅暂定'] };
        name = propose ? 'submit_writing_proposal' : 'respond_writing_intake';
        args = propose ? proposal : { reply: '可以，材料仍在，不必重新发链接。', summary: '继续围绕文章交流', questions: [], proposal };
      }
      yield { type: 'tool_call_delta', index: 0, id: `call-${step}`, name, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }();
  const directory = mkdtempSync(join(tmpdir(), 'intake-web-'));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  try {
    storage.createProject({ projectId: 'project', operationId: 'create', name: '测试', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    const service = new WritingApplicationService({ storage, provider, authorWebFetcher: { async fetchText() {
      fetches++;
      return { finalUrl: url, redirectCount: 0, contentType: 'text/html', bodyHash: 'test', content: {
        text: article, totalChars: article.length, truncated: false, activeContentRemoved: true, trustLabel: 'external_untrusted', instructionAuthority: 'none' } };
    } } });
    const input = { projectId: 'project', sessionId: 'session', model: 'mock', parameters: {} };
    const first = await service.startConversationTurn({ ...input, userInstruction: `读一下这篇 ${url}` }).result;
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(fetches, 1);
    assert.equal(storage.inspectProject('project')!.currentBriefVersionId, null);
    const second = await service.startConversationTurn({ ...input, userInstruction: '以这篇文章作为参考素材，先整理方向' }).result;
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(fetches, 1, 'reading existing material should not call the website again');
    const material = storage.listMaterials('project').find(item => item.sourceKind === 'web_snapshot')!;
    const brief = service.getConversationIntake('project').brief!;
    assert.ok(brief.materialIds.includes(material.id));
    assert.deepEqual(brief.authorAuthorization.firsthandMaterialIds, []);
    assert.equal(brief.confirmationStatus, 'tentative');
  } finally { storage.close(); rmSync(directory, { recursive: true, force: true }); }
});
