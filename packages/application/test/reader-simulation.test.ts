import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createReaderTextTasks, parseReaderReaction } from '../src/reader-simulation.js';

it('uses fixed distinct personas, actual platform and full article without source/other-review context', () => {
  const batch = createReaderTextTasks({ article:'# 标题\n\n完整正文', bodyVersionId:'body-v1', platform:'微信公众号', audience:'普通上班族' });
  assert.equal(batch.tasks.length, 3);
  for (const task of batch.tasks) {
    assert.equal(task.messages.length, 2);
    assert.match(task.messages[1]!.content, /完整正文/);
    assert.match(task.messages[0]!.content, /微信公众号/);
    assert.doesNotMatch(task.messages[0]!.content, /读过作者上一篇/);
    assert.match(task.messages[0]!.content, /禁止.*修改建议/);
    assert.match(task.messages[0]!.content, /模拟.*不是.*真实用户调研/);
  }
  assert.equal(new Set(batch.tasks.map(t => t.messages[0]!.content)).size, 3);
  assert.ok(batch.tasks.every(t => t.messages[0]!.content.length < 1000));
});

it('renders only ordinary reactions and explicit missing readers, not votes or edit reports', () => {
  const batch = createReaderTextTasks({ article:'正文', bodyVersionId:'body-v1', platform:'今日头条', audience:'普通读者' });
  const text = JSON.stringify({ whyOpen:'标题让我好奇', leaveAt:'第二块那堆英文看不懂，想退了', verdict:'还行，有收获', shareOrSave:'想转给同事', memorableLine:'有些事不能只看价钱' });
  assert.ok(parseReaderReaction(text));
  const rendered = batch.combine(batch.tasks.map((t, index) => ({ ...t, requestId:`r${index}`, snapshotId:`s${index}`,
    ...(index === 2 ? { ok:false as const, code:'TIMEOUT' } : { ok:true as const, text }) })));
  assert.match(rendered, /模拟读者 A/); assert.match(rendered, /模拟读者 B/); assert.match(rendered, /模拟读者 C.*未返回/s);
  assert.match(rendered, /第二块那堆英文看不懂/);
  assert.doesNotMatch(rendered, /必须修改|可选优化|建议保留|2\/3|百分比|多数读者/);
  assert.equal(parseReaderReaction(JSON.stringify({ whyOpen:'必须修改首屏', leaveAt:'无', verdict:'编辑建议', shareOrSave:'无', memorableLine:'无' })), null);
});
