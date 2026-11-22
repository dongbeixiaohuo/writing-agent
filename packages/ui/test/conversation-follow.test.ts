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
  assert.match(interaction.conversationWorkingCopy(activity, 2000).detail, /哪些人、哪些事.*写得更具体/);
  assert.match(interaction.conversationWorkingCopy({ ...activity, actor: 'director' }, 2000).detail, /到哪一步了我来盯.*轮到你拍板/);
});

test('record tab indicates ongoing work without exposing request counters', () => {
  assert.equal(interaction.runRecordsTabLabel(7, null), '运行记录');
  const activity = { runId: 'r', requestId: 'q', actor: 'director', phase: 'waiting' as const, startedAt: 1, lastActivityAt: null, requestOrdinal: 3 };
  assert.equal(interaction.runRecordsTabLabel(7, 'r', activity), '运行记录（进行中）');
  assert.equal(interaction.runRecordsTabLabel(7, 'r', { ...activity, requestOrdinal: 4 }), '运行记录（进行中）');
  assert.equal(interaction.runRecordsTabLabel(7, 'other', activity), '运行记录（进行中）');
});

test('waiting copy distinguishes no response, private progress, and a stalled stream without invented progress', () => {
  const progress = { runId: 'r', requestId: 'q', actor: 'director', phase: 'waiting' as const, startedAt: 1000, lastActivityAt: null };
  const waiting = interaction.conversationWorkingCopy(progress, 46000);
  assert.match(waiting.title, /写作导演托尼老师/);
  assert.match(waiting.detail, /还在等回复.*再等一会儿.*停止/);
  assert.equal(waiting.elapsedSeconds, 45);
  const receiving = interaction.conversationWorkingCopy({ ...progress, phase: 'receiving', lastActivityAt: 45000 }, 46000);
  assert.match(receiving.detail, /轮到你拍板/);
  assert.doesNotMatch(receiving.detail, /思考|百分|%/);
  const stalled = interaction.conversationWorkingCopy({ ...progress, phase: 'receiving', lastActivityAt: 10000 }, 46000);
  assert.match(stalled.detail, /还在等回复/);
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
  assert.match(reasoning.detail, /手头的原文先对一遍/);
  const search = interaction.conversationWorkingCopy({ ...base, activeTool:{name:'search_fact_sources', startedAt:60000} }, 66000);
  assert.match(search.title, /查有据在查一句话的来历/);
  assert.match(search.detail, /找到出处/);
  assert.doesNotMatch(search.detail, /正在等待模型回复/);
});

test('reasoning activity reports a wait without exposing or inventing private reasoning', () => {
  const activity = { runId:'r', requestId:'q', actor:'draft', phase:'receiving' as const, startedAt:1000, lastActivityAt:65000, receivedEvents:3, lastEventKind:'reasoning' as const };
  const copy = interaction.conversationWorkingCopy(activity, 66000);
  assert.match(copy.detail, /按你选的路子落笔/);
  assert.doesNotMatch(copy.detail, /私有推理|数据活动|工具参数|流式|请求/);
  assert.match(copy.detail, /写到哪儿，你就能看到哪儿/);
  assert.doesNotMatch(copy.detail, /看到.*素材/);
});

test('all writing roles keep the same task description across transport events', () => {
  for (const actor of ['intake', 'author', 'director', 'research', 'outline', 'draft', 'review_editor', 'review_publish', 'review_reader', 'central_revision', 'language_review', 'title', 'fact_check', 'fact_extract', 'unknown']) {
    const base = { runId: 'r', requestId: 'q', actor, phase: 'waiting' as const, startedAt: 1000, lastActivityAt: null };
    const waiting = interaction.conversationWorkingCopy(base, 2000);
    assert.match(waiting.title, /在/);
    assert.doesNotMatch(waiting.title, /Agent/u);
    for (const lastEventKind of ['reasoning', 'tool_arguments', 'content'] as const) {
      const receiving = interaction.conversationWorkingCopy({ ...base, phase: 'receiving', lastActivityAt: 1500, lastEventKind, receivedEvents: 999 }, 2000);
      assert.deepEqual(receiving, waiting, 'transport metadata must not invent a new task or appear as progress');
      assert.doesNotMatch(JSON.stringify(receiving), /推理|流式|数据活动|999|工具参数|百分|%/);
    }
  }
});
