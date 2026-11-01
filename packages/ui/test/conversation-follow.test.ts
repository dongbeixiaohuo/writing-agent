import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as follow from '../src/shell/conversation-follow.js'
import * as interaction from '../src/shell/interaction.js'

test('conversation navigation fits a centered, bounded set of equally spaced ticks', () => {
  assert.equal(typeof follow.conversationNavigationCapacity, 'function')
  assert.equal(follow.conversationNavigationCapacity(900), 16)
  assert.equal(follow.conversationNavigationCapacity(172), 10)
  assert.equal(follow.conversationNavigationCapacity(40), 0)
})

test('long conversations retain first, last and active messages without crowding the rail', () => {
  assert.equal(typeof follow.conversationNavigationMarkers, 'function')
  const markers = follow.conversationNavigationMarkers(200, 73, 16)
  assert.equal(markers.length, 16)
  assert.equal(new Set(markers).size, 16)
  assert.equal(markers[0], 0)
  assert.equal(markers.at(-1), 199)
  assert.ok(markers.includes(73))
  assert.deepEqual(markers, [...markers].sort((a, b) => a - b))
  assert.deepEqual(follow.conversationNavigationMarkers(4, 2, 16), [0, 1, 2, 3])
  assert.deepEqual(follow.conversationNavigationMarkers(200, 73, 3), [0, 73, 199])
  assert.deepEqual(follow.conversationNavigationMarkers(200, 73, 1), [73])
  assert.deepEqual(follow.conversationNavigationMarkers(0, -1, 16), [])
  assert.deepEqual(follow.conversationNavigationMarkers(5, 2, 0), [])
})

test('navigation selection follows the reading position and reaches the latest message at the bottom', () => {
  assert.equal(typeof follow.conversationNavigationIndex, 'function')
  const offsets = [40, 400, 900]
  const metrics = { scrollTop: 0, clientHeight: 300, scrollHeight: 1600 }
  assert.equal(follow.conversationNavigationIndex(metrics, offsets), 0)
  assert.equal(follow.conversationNavigationIndex({ ...metrics, scrollTop: 400 }, offsets), 1)
  assert.equal(follow.conversationNavigationIndex({ ...metrics, scrollTop: 1300 }, offsets), 2)
  assert.equal(follow.conversationNavigationIndex(metrics, []), -1)
  assert.equal(follow.conversationNavigationIndex({ ...metrics, scrollHeight: 200 }, offsets), -1)
})

test('navigation jumps to message anchors, not a proportional scroll fraction', () => {
  assert.equal(typeof follow.conversationNavigationTarget, 'function')
  const metrics = { scrollTop: 0, clientHeight: 400, scrollHeight: 2000 }
  assert.equal(follow.conversationNavigationTarget(metrics, 300), 276)
  assert.equal(follow.conversationNavigationTarget(metrics, 0), 0)
  assert.equal(follow.conversationNavigationTarget(metrics, 1900), 1600)
  assert.equal(follow.conversationNavigationTarget({ ...metrics, scrollHeight: 200 }, 300), 0)
})

test('conversation rail replaces the full-height minimap without changing the native scroll surface', () => {
  const source = readFileSync(new URL('../src/shell/WritingAgentShell.tsx', import.meta.url), 'utf8')
  const css = readFileSync(new URL('../src/shell/WritingAgentShell.module.css', import.meta.url), 'utf8')
  assert.match(source, /<ConversationNavigator/u)
  assert.doesNotMatch(source, /ConversationMinimap/u)
  assert.match(css, /\.conversationNavigator\s*\{[^}]*top:\s*50%/u)
  assert.match(css, /\.conversationNavigator\s*\{[^}]*right:\s*18px/u)
  assert.doesNotMatch(css, /\.minimapViewport/u)
  assert.match(css, /\.scrollBody\s*\{[^}]*overflow-y:\s*auto/u)
})

test('navigation gutter is stable before the rail mounts and survives narrow-layout padding', () => {
  const css = readFileSync(new URL('../src/shell/WritingAgentShell.module.css', import.meta.url), 'utf8')
  assert.equal(/\.conversationWrap\s+\.timeline\s*\{[^}]*padding-inline-end:\s*64px/u.test(css), true)
  assert.doesNotMatch(css, /\.conversationWrap:has\(\.conversationNavigator\)/u)
})

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
test('process copy distinguishes provider processing from an actual external search', () => {
  const base = { runId:'r', requestId:'q', actor:'fact_check', phase:'receiving' as const, startedAt:1000, lastActivityAt:65000, receivedEvents:20 };
  const reasoning = interaction.conversationWorkingCopy({ ...base, lastEventKind:'reasoning' }, 66000);
  assert.match(reasoning.detail, /模型服务.*处理.*尚未.*可展示/);
  const search = interaction.conversationWorkingCopy({ ...base, activeTool:{name:'search_fact_sources', startedAt:60000} }, 66000);
  assert.match(search.title, /搜索/);
  assert.match(search.detail, /6 秒/);
  assert.doesNotMatch(search.detail, /正在等待模型回复/);
});

test('reasoning activity reports a wait without exposing or inventing private reasoning', () => {
  const activity = { runId:'r', requestId:'q', actor:'draft', phase:'receiving' as const, startedAt:1000, lastActivityAt:65000, receivedEvents:3, lastEventKind:'reasoning' as const };
  const copy = interaction.conversationWorkingCopy(activity, 66000);
  assert.match(copy.detail, /模型服务.*处理/);
  assert.match(copy.detail, /不会展示或推测私有推理/);
  assert.match(copy.detail, /可展示答复.*流式显示/);
  assert.doesNotMatch(copy.detail, /逐步显示.*素材/);
});
