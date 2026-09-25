import assert from 'node:assert/strict'
import test from 'node:test'
import * as follow from '../src/shell/conversation-follow.js'
import * as interaction from '../src/shell/interaction.js'

test('working clock reports the whole execution segment, not just the latest request', () => {
  const activity = { runId: 'r', requestId: 'q2', actor: 'review_editor', phase: 'waiting' as const, startedAt: 61000, segmentStartedAt: 1000, requestOrdinal: 2, lastActivityAt: null };
  assert.equal(interaction.conversationWorkingCopy(activity, 68000).elapsedSeconds, 67);
});

test('private stages explain the work and upcoming author-facing result', () => {
  const activity = { runId: 'r', requestId: 'q', actor: 'research', phase: 'receiving' as const, startedAt: 1, lastActivityAt: 1000 };
  assert.match(interaction.conversationWorkingCopy(activity, 2000).detail, /核对材料.*提纲/);
  assert.match(interaction.conversationWorkingCopy({ ...activity, actor: 'director' }, 2000).detail, /检查.*足够/);
});

test('record tab distinguishes stable task count from live request count', () => {
  assert.equal(interaction.runRecordsTabLabel(7, null), '运行记录');
  const activity = { runId: 'r', requestId: 'q', actor: 'director', phase: 'waiting' as const, startedAt: 1, lastActivityAt: null, requestOrdinal: 3 };
  assert.equal(interaction.runRecordsTabLabel(7, 'r', activity), '运行记录（本轮 3 次请求）');
  assert.equal(interaction.runRecordsTabLabel(7, 'r', { ...activity, requestOrdinal: 4 }), '运行记录（本轮 4 次请求）');
  assert.equal(interaction.runRecordsTabLabel(7, 'other', activity), '运行记录（执行中）');
});

test('waiting copy distinguishes no response, private progress, and a stalled stream without invented progress', () => {
  const progress = { runId: 'r', requestId: 'q', actor: 'director', phase: 'waiting' as const, startedAt: 1000, lastActivityAt: null };
  const waiting = interaction.conversationWorkingCopy(progress, 46000);
  assert.match(waiting.title, /核对/);
  assert.match(waiting.detail, /等待模型回复/);
  assert.equal(waiting.elapsedSeconds, 45);
  const receiving = interaction.conversationWorkingCopy({ ...progress, phase: 'receiving', lastActivityAt: 45000 }, 46000);
  assert.match(receiving.detail, /已收到模型数据/);
  assert.doesNotMatch(receiving.detail, /思考|百分|%/);
  const stalled = interaction.conversationWorkingCopy({ ...progress, phase: 'receiving', lastActivityAt: 10000 }, 46000);
  assert.match(stalled.detail, /36 秒未收到新内容/);
  assert.match(interaction.conversationWorkingCopy({ ...progress, actor: 'outline' }, 2000).title, /提纲/);
});

import {
  CONVERSATION_FOLLOW_THRESHOLD,
  isNearConversationBottom,
} from '../src/shell/conversation-follow.js'

test('conversation follows updates while the reader remains near the latest item', () => {
  assert.equal(isNearConversationBottom({ scrollTop: 540, clientHeight: 400, scrollHeight: 1000 }), true)
  assert.equal(isNearConversationBottom({
    scrollTop: 1000 - 400 - CONVERSATION_FOLLOW_THRESHOLD,
    clientHeight: 400,
    scrollHeight: 1000,
  }), true)
})

test('conversation preserves position after the reader deliberately scrolls upward', () => {
  assert.equal(isNearConversationBottom({ scrollTop: 120, clientHeight: 400, scrollHeight: 1000 }), false)
})

test('latest message, not the export and checkpoint footer, is the conversation follow target', () => {
  assert.equal(typeof follow.conversationFollowTarget, 'function');
  const metrics = { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 };
  assert.equal(follow.conversationFollowTarget(metrics, 900), 900);
  assert.equal(follow.conversationFollowTarget(metrics, 1800), 1500);
  assert.equal(follow.conversationFollowTarget(metrics, null), 1500);
  assert.equal(follow.conversationFollowTarget({ ...metrics, scrollHeight: 300 }, 100), 0);
});

test('a growing live reply follows its new text without scrolling into the controls below it', () => {
  const metrics = { scrollTop: 900, clientHeight: 500, scrollHeight: 2400 };
  assert.equal(follow.conversationFollowTarget(metrics, 900, 1700), 1200);
  assert.equal(follow.conversationFollowTarget(metrics, 900, 1100), 900);
});
