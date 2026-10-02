import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../storage/src/index.js';
import { WritingApplicationService } from '../src/index.js';

const proposed = {
  reply: '约1500字，发今日头条，写长假不会休息的无奈，不虚构你的亲历。这个方向可以吗？',
  summary: '1500字的长假吐槽短评', questions: [],
  proposal: { brief: { topic: '长假却不会休息', genre: 'argument_commentary', audience: '上班族', targetCharacters: 1500,
    constraints: ['不编造亲历'], platform: '今日头条', publicationGoal: 'primary' }, assumptions: [] },
};
const chatOnly = { reply: '方案就这么定了，再确认一下我就动笔。', summary: '用户认可1500字的方案', questions: [] };

async function scenario(semantic: string, respond: (n: number) => object, check: (app: WritingApplicationService, result: any, requests: ModelRequest[]) => void, seedProposal = false) {
  const root = mkdtempSync(join(tmpdir(), 'intake-transition-'));
  const storage = openWorkspaceStorage({ workspacePath: root });
  const requests: ModelRequest[] = [];
  let seeding = true; let attempts = 0;
  class Provider extends ModelProviderBase {
    constructor() { super('transition-fixture', '1', { protocol: 'mock', tools: 'supported', streaming: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push(request);
      const intent = request.tools?.[0]?.name === 'interpret_author_reply';
      let args: any = intent ? { intent: semantic, sourceQuote: 'ok', reason: '结合已展示方案和作者本轮回复作判断' }
        : seeding ? seedProposal ? proposed : chatOnly : respond(++attempts);
      const tool = request.tools![0]!.name;
      if (tool === 'submit_writing_proposal' && args.proposal) args = args.proposal;
      yield { type: 'tool_call_delta', index: 0, id: request.requestId, name: tool, argumentsDelta: JSON.stringify(args) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  try {
    const app = new WritingApplicationService({ storage, provider: new Provider() });
    app.createProject({ projectId: 'p', operationId: 'p', name: '独立回归', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    const first = await app.startConversationTurn({ projectId: 'p', model: 'test', parameters: {}, userInstruction: '1500字，其他没问题' }).result;
    assert.equal(first.ok, true);
    seeding = false; requests.length = 0;
    const result = await app.startConversationTurn({ projectId: 'p', sessionId: first.sessionId, model: 'test', parameters: {}, userInstruction: 'ok' }).result;
    check(app, result, requests);
  } finally { storage.close(); rmSync(root, { recursive: true, force: true }); }
}

it('repairs a missing proposal in the same turn instead of accepting another empty confirmation promise', async () => {
  await scenario('propose_direction', n => n === 1 ? chatOnly : proposed, (app, result, requests) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.getConversationIntake('p').phase, 'proposal');
    assert.equal(app.getConversationIntake('p').brief?.lengthTarget.targetCharacters, 1500);
    assert.equal(app.getConversationIntake('p').assistantTurns.length, 2, 'rejected save must not become another chat turn');
    assert.equal(requests[0]?.tools?.[0]?.name, 'interpret_author_reply', 'collecting state still needs semantic routing');
    assert.equal(requests[1]?.tools?.[0]?.name, 'submit_writing_proposal', 'ready state must offer a proposal-only tool');
  });
});

it('applies the semantic approval to the stored proposal even if the reply tool omits confirmation', async () => {
  await scenario('confirm_direction', () => chatOnly, (app, result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.getConversationIntake('p').phase, 'confirmed');
    assert.equal(app.getConversationIntake('p').brief?.authorAuthorization.directionDecision, 'user_confirmed');
    assert.doesNotMatch(result.reply, /再确认/);
  }, true);
});

it('does not manufacture a proposal or approval for a discussion-only semantic decision', async () => {
  await scenario('discuss', () => ({ reply: '可以先比较两个角度，不开始写。', summary: '继续讨论', questions: [] }), (app, result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.getConversationIntake('p').phase, 'collecting');
    assert.equal(app.getConversationIntake('p').brief, null);
  });
});

it('an explicit replacement proposal in an approval turn stays tentative instead of confirming the old proposal', async () => {
  await scenario('confirm_direction', () => ({ ...proposed, proposal: { ...proposed.proposal,
    brief: { ...proposed.proposal.brief, targetCharacters: 9000 } } }), (app, result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(app.getConversationIntake('p').phase, 'proposal');
    assert.equal(app.getConversationIntake('p').brief?.confirmationStatus, 'tentative');
    assert.equal(app.getConversationIntake('p').brief?.lengthTarget.targetCharacters, 9000);
    assert.match(result.reply, /待你确认/u);
  }, true);
});

it('bounds a model that keeps omitting the required proposal, without saving false success', async () => {
  await scenario('propose_direction', () => chatOnly, (app, result, requests) => {
    assert.equal(result.ok, false);
    assert.ok(requests.length <= 5);
    assert.equal(app.getConversationIntake('p').assistantTurns.length, 1);
    assert.equal(app.getConversationIntake('p').phase, 'collecting');
  });
});
