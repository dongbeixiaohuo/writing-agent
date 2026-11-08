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
  assert.match(rendered, /模拟读者 A/); assert.match(rendered, /模拟读者 B/); assert.match(rendered, /模拟读者 C.*反馈未完成/s);
  assert.match(rendered, /第二块那堆英文看不懂/);
  assert.doesNotMatch(rendered, /必须修改|可选优化|建议保留|2\/3|百分比|多数读者/);
  assert.doesNotMatch(rendered, /未自动重试|没有编造|模型响应/);
});

it('accepts the complete reader C reaction that was rejected for quoting article percentages', () => {
  const reaction = { whyOpen:'标题问得挺扎心，想看看有没有新说法。', leaveAt:'第二块那个《The Leadership Quarterly》和68%、24%的实验，读着有点绕，差点划走，好在后面解释清楚了。', verdict:'有收获，没白读。', shareOrSave:'会收藏，转给同事。', memorableLine:'这段关系，是能打听来的，还是托付出来的？' };
  const text = JSON.stringify(reaction);
  assert.deepEqual(parseReaderReaction(text), reaction);
  const batch = createReaderTextTasks({ article:'实验比例为68%和24%。', bodyVersionId:'body', platform:'公众号', audience:'上班族' });
  assert.equal(batch.validate(text), true);
  const result = batch.combine(batch.tasks.map(t => ({id:t.id, actor:t.actor, requestId:t.id, snapshotId:t.id, ok:true as const, text})));
  assert.match(result, /模拟读者 C[\s\S]*68%、24%/);
  assert.doesNotMatch(result, /未返回|反馈未完成/);
  assert.ok(parseReaderReaction(JSON.stringify({...reaction, leaveAt:'看到文中“必须修改”和“建议保留”这几个词，就像在看编辑工作记录，我想划走。'})));
});

it('rejects incomplete or malformed reader responses without rejecting vocabulary', () => {
  const reaction = {whyOpen:'好奇', leaveAt:'没有', verdict:'还行', shareOrSave:'不转发', memorableLine:'没有'};
  for (const bad of ['不是JSON', JSON.stringify([reaction]), JSON.stringify({...reaction, verdict:''}), JSON.stringify({...reaction, leaveAt:12}), JSON.stringify({...reaction, shareOrSave:'字'.repeat(301)}), JSON.stringify({...reaction, extra:'多出的字段'}), JSON.stringify({whyOpen:'缺少其他项'})]) {
    assert.equal(parseReaderReaction(bad), null);
  }
  assert.deepEqual(parseReaderReaction('```json\n'+JSON.stringify(reaction)+'\n```'), reaction);
});

it('distinguishes unusable feedback from an absent response without displaying internal codes', () => {
  const batch = createReaderTextTasks({article:'正文', bodyVersionId:'body', platform:'公众号', audience:'读者'});
  const text = batch.combine([{id:'c', actor:'review_reader_c', requestId:'c', snapshotId:'c', ok:false, code:'PARALLEL_TEXT_INVALID'}]);
  assert.match(text, /模拟读者 C · 懂行读者 · 反馈未完成[\s\S]*反馈暂时无法使用/);
  assert.doesNotMatch(text, /PARALLEL_TEXT_INVALID|未返回|未自动重试|没有编造/);
});
