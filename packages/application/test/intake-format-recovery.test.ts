import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';

it('title selection survives nested summary then malformed JSON without inventing confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'intake-format-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  const title = '牛马的顶级悲哀：真给你13天，你却不知道干啥';
  const args = { reply: `标题就用《${title}》。以下方向请你确认。`, summary: '给上班族看的自嘲随笔，约1500字，尚待确认。', questions: [],
    proposal: { brief: { topic: title, genre: 'narrative_observation', audience: '上班族', targetCharacters: 1500,
      constraints: ['不编造作者亲历'], platform: '今日头条', publicationGoal: 'primary' }, assumptions: [] } };
  const requests: ModelRequest[] = [];
  class Provider extends ModelProviderBase {
    constructor() { super('format-recovery', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      const { summary, ...rest } = args;
      const raw = requests.length === 1 ? JSON.stringify({ ...rest, proposal: { ...args.proposal, summary } })
        : requests.length === 2 ? '{"reply":"标题中的"引号"未转义"}' : JSON.stringify(args);
      yield { type: 'tool_call_delta', index: 0, id: `c${requests.length}`, name: 'respond_writing_intake', argumentsDelta: raw };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const app = new WritingApplicationService({ storage, provider: new Provider() });
    app.createProject({ projectId: 'p', operationId: 'p', name: '隔离格式回归', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    const result = await app.startConversationTurn({ projectId: 'p', model: 'test', parameters: {}, userInstruction: title }).result;
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.modelRequestCount, 3);
    assert.equal(result.toolCallCount, 1);
    const state = app.getConversationIntake('p');
    assert.equal(state.phase, 'proposal', 'choosing a title is not blanket confirmation of a new brief');
    assert.equal(state.brief?.topic, title);
    assert.equal(state.sourceTurns.at(-1)?.quote, title);
    assert.equal(state.assistantTurns.length, 1);
    assert.equal(storage.inspectProject('p')?.latestBodyVersionId, null);
    assert.match(requests[0]?.messages[0]?.content ?? '', /summary.*顶层/u);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
});
