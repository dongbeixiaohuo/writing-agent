import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationWithPreview } from '../src/shell/conversation-stream.js';
import type { ChatMessage } from '../../client-bridge/src/protocol.js';

test('each readable review output has a human label during streaming', () => {
  for (const [stage, label] of [['review_editor', '编辑审校'], ['review_publish', '发布审校'], ['review_reader', '读者审校']]) {
    const items = conversationWithPreview([], { runId: 'r', requestId: 'q', id: stage, stage, text: '建议缩短开头' }, 'r');
    assert.match((items[0] as ChatMessage).body, new RegExp(label + '.*生成中'));
    assert.equal((items[0] as ChatMessage).stage, stage, 'role header must be program-bound, not guessed from prose');
  }
});

test('live stage and saved stage occupy one stable timeline position; persisted text wins', () => {
  const reply = { runId: 'r', requestId: 'q', id: 'outline:one', stage: 'outline', text: '# 开始\n第一段', phase: 'generating' as const };
  const live = conversationWithPreview([], reply, 'r');
  assert.equal(live.length, 1);
  assert.equal(live[0]?.id, reply.id);
  assert.match((live[0] as ChatMessage).body, /文章提纲.*生成中/u);
  const saving = conversationWithPreview([], { ...reply, phase: 'saving' }, 'r');
  assert.equal((saving[0] as ChatMessage).streaming, 'saving');
  const saved: ChatMessage = { id: reply.id, kind: 'message', role: 'assistant', body: '实际保存的完整提纲', createdAt: '现在' };
  assert.deepEqual(conversationWithPreview([saved], reply, 'r'), [saved]);
  assert.deepEqual(conversationWithPreview([], reply, null), []);
});
