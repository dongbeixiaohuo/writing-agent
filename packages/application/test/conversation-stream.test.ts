import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationStreamPreview, topLevelString, requestMaterialPreviews } from '../src/conversation-stream.js';

test('input previews distinguish source articles, confirmed requirements and unclassified conversation additions', () => {
  const previews = requestMaterialPreviews([{ role: 'user', content: JSON.stringify({
    writingRequirements: { audience: '普通患者和家属', platform: '今日头条' },
    materials: [
      { materialId: 'web', contentVersionId: 'v1', displayName: '共识解读', sourceKind: 'web_snapshot', content: '文章原文。' },
      { materialId: 'intake-user-a', contentVersionId: 'v2', displayName: '需求对话 a', content: '普通患者和家属' },
      { materialId: 'intake-user-p', contentVersionId: 'v3', displayName: '需求对话 p', content: '今日头条' },
      { materialId: 'intake-user-extra', contentVersionId: 'v4', displayName: '需求对话 extra', content: '语气温和一点' },
    ],
  }) }]);
  assert.deepEqual(previews.map(p => p.label), ['目标读者', '发布平台', '网页素材 · 共识解读', '需求补充 · 语气温和一点']);
  assert.deepEqual(previews.map(p => p.text), ['普通患者和家属', '今日头条', '文章原文。', '语气温和一点']);
});

test('compact research streams only public notes, including partial escaped text, never raw fields', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', actor: 'research' };
  view.observe({ ...base, event: { type: 'tool_call_delta', sequence: 1, index: 0, name: 'submit_writing_stage', id: 't',
    argumentsDelta: '{"stage":"research","content":{"sources":[],"claims":[{"notes":"NOT PUBLIC"}],"notes":"保留原文\\n尚需' } });
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '保留原文\n尚需');
  view.observe({ ...base, event: { type: 'tool_call_delta', sequence: 2, index: 0, id: 't', argumentsDelta: '核实。"}}' } });
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '保留原文\n尚需核实。');
  assert.equal(view.get('p','s','r'), null);
});

test('material previews omit bare links and duplicate excerpts without discarding real article text', () => {
  const previews = requestMaterialPreviews([{role:'user',content:JSON.stringify({materials:[
    {contentVersionId:'link1',content:'https://example.com/article'},
    {contentVersionId:'link2',content:'https://example.com/article'},
    {contentVersionId:'article',content:'完整文章。'},
    {contentVersionId:'copy',content:'完整文章。'},
  ]})}]);
  assert.deepEqual(previews.map(p=>p.text), ['完整文章。']);
});

test('pending dispatch preview expires when the expert request actually starts', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId:'p',sessionId:'s',runId:'r',requestId:'director',actor:'director' };
  view.observe({...base,event:{type:'tool_call_delta',sequence:1,index:0,id:'d',name:'director_decide',argumentsDelta:'{"reason":"整理提纲"}'}});
  assert.match(view.getActivity('p','s','r')!.workPreview!.label, /尚未执行/);
  view.observe({...base,lifecycle:'finished',event:null});
  view.observe({...base,requestId:'outline',actor:'outline',lifecycle:'started',event:null});
  assert.equal(view.getActivity('p','s','r')!.workPreview, undefined);
  assert.equal(view.getActivity('p','s','r')!.requestOrdinal, 2);
});

test('waiting previews use only actual public materials injected into the request, never prompts or reasoning', () => {
  const previews = requestMaterialPreviews([{ role: 'system', content: 'PRIVATE SYSTEM' }, { role:'user', content: 'task\nCOLLABORATION_STATE=' + JSON.stringify({
    artifacts: [{ id:'b',kind:'body',content:'# 当前稿\n\n正文。' }, {id:'e',kind:'evidence',content:JSON.stringify({claims:[{secret:'PRIVATE LEDGER'}],notes:'只写个人感受。'})}],
    materials:[{materialId:'m',contentVersionId:'v',content:'原始材料。'}], reasoning:'PRIVATE REASONING',
  }) }]);
  assert.equal(previews.length, 3);
  assert.deepEqual(previews.map(p=>p.text), ['# 当前稿\n\n正文。', '只写个人感受。', '原始材料。']);
  assert.doesNotMatch(JSON.stringify(previews), /PRIVATE/);
  assert.deepEqual(requestMaterialPreviews([{role:'assistant',content:'PRIVATE'},{role:'user',content:'invalid JSON'}]), []);
});

test('public task summaries and search queries stream as temporary process previews, not final answers', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', actor: 'director' };
  view.observe({ ...base, event: { type: 'tool_call_delta', sequence: 1, index: 0, id: 't', name: 'director_decide', argumentsDelta: '{"reason":"核对文中的假期' } });
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '核对文中的假期');
  view.observe({ ...base, event: { type: 'tool_call_delta', sequence: 2, index: 0, id: 't', argumentsDelta: '日期，正文保持不变"}' } });
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '核对文中的假期日期，正文保持不变');
  assert.equal(view.get('p','s','r'), null);
  view.observe({ ...base, actor: 'fact_check', requestId: 'q2', event: { type: 'tool_call_delta', sequence: 3, index: 0, id: 's', name: 'search_fact_sources', argumentsDelta: '{"query":"2026年放假通知"}' } });
  assert.match(view.getActivity('p','s','r')?.workPreview?.text ?? '', /2026年放假通知/);
  assert.match(view.getActivity('p','s','r')?.workPreview?.label ?? '', /待执行/);
  view.observe({ ...base, requestId: '', event: null });
  assert.equal(view.getActivity('p','s','r'), null);
});

test('reasoning activity is counted truthfully without turning hidden processing into public text', () => {
  const view = new ConversationStreamPreview();
  view.observe({ projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', actor: 'director',
    event: { type: 'response_activity', sequence: 1, phase: 'reasoning' } });
  assert.equal(view.getActivity('p','s','r')?.lastEventKind, 'reasoning');
  assert.equal(view.getActivity('p','s','r')?.receivedEvents, 1);
  assert.equal(view.get('p','s','r'), null);
  assert.equal(view.getActivity('p','s','r')?.workPreview, undefined);
});

test('safe research excerpts remain a temporary preview through request handoffs, never final chat or private reasoning', () => {
  const view=new ConversationStreamPreview();
  const base={projectId:'p',sessionId:'s',runId:'r',requestId:'q',actor:'research'};
  view.observe({...base,event:{type:'text_delta',sequence:1,delta:'private planning must not appear'}});
  assert.equal(view.get('p','s','r'),null);
  view.observe({...base,event:{type:'tool_call_delta',sequence:2,index:0,id:'t1',name:'submit_writing_stage',argumentsDelta:'{"stage":"research","content":"# 参考素材\\n已提供个人感受。'}});
  assert.match(view.getActivity('p','s','r')?.workPreview?.text ?? '',/已提供个人感受/);
  view.observe({...base,lifecycle:'finished',event:null});
  view.observe({...base,actor:'director',requestId:'next',lifecycle:'started',event:null});
  assert.match(view.getActivity('p','s','r')?.workPreview?.text ?? '',/已提供个人感受/);
  assert.equal(view.get('p','s','r'),null);
  view.observe({...base,requestId:'',event:null});
  assert.equal(view.getActivity('p','s','r'),null);
});

test('fact checker prose pretending to save a final result never flashes in the author chat', () => {
  const view=new ConversationStreamPreview();
  view.observe({projectId:'p',sessionId:'s',runId:'r',requestId:'q',actor:'fact_check',event:{type:'tool_call_delta',sequence:1,index:0,id:'t1',name:'respond_author',argumentsDelta:'{"reply":"已通过，可以交付"}'}});
  assert.equal(view.get('p','s','r'),null);
});

test('temporary research hides ledger JSON and fact preview shows claims, never uncommitted verdicts', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId:'p', sessionId:'s', runId:'r', requestId:'q', actor:'research' };
  view.observe({...base, event:{type:'tool_call_delta',sequence:1,index:0,id:'t',name:'submit_writing_stage',argumentsDelta:JSON.stringify({stage:'research',content:JSON.stringify({claims:[],notes:'作者只提供了自己的感受。'})})}});
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '作者只提供了自己的感受。');
  view.observe({...base,actor:'fact_check',requestId:'q2',event:{type:'tool_call_delta',sequence:1,index:0,id:'f',name:'submit_fact_check',argumentsDelta:'{"claims":[{"claimText":"我没有吃月饼","factStatus":"SUPPORTED"'}});
  assert.equal(view.get('p','s','r'),null);
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text, '正在核对原文：我没有吃月饼');
});

test('research content streams before the stage JSON property arrives', () => {
  const view = new ConversationStreamPreview();
  view.observe({projectId:'p',sessionId:'s',runId:'r',requestId:'q',actor:'research',event:{type:'tool_call_delta',sequence:1,index:0,id:'t',name:'submit_writing_stage',argumentsDelta:'{"content":"已收到的可读研究素材'}});
  assert.equal(view.getActivity('p','s','r')?.workPreview?.text,'已收到的可读研究素材');
  assert.equal(view.get('p','s','r'),null);
});

test('intake keeps its visible reply through the save-only request but drops it on failure', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q1', actor: 'intake', textAudience: 'conversation' as const };
  view.observe({ ...base, event: { type: 'text_delta', sequence: 1, delta: '你更想写给谁看？' } });
  const id = view.get('p', 's', 'r')?.id;
  view.observe({ ...base, lifecycle: 'finished', event: null });
  assert.equal(view.get('p', 's', 'r')?.text, '你更想写给谁看？');
  view.observe({ ...base, requestId: 'q2', lifecycle: 'started', event: null });
  assert.equal(view.get('p', 's', 'r')?.text, '你更想写给谁看？');
  assert.equal(view.get('p', 's', 'r')?.id, id);
  view.observe({ ...base, requestId: 'q2', event: { type: 'tool_call_delta', sequence: 1, index: 0, id: 'save', name: 'respond_writing_intake', argumentsDelta: '{"reply":"你更' } });
  assert.equal(view.get('p', 's', 'r')?.text, '你更想写给谁看？');
  view.observe({ ...base, requestId: 'q2', event: null });
  assert.equal(view.get('p', 's', 'r'), null);
});

test('segment clock survives request handoffs and errors but resets after pause', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'one', actor: 'director' };
  view.observe({ ...base, lifecycle: 'started', event: null });
  t.mock.timers.tick(7000);
  view.observe({ ...base, lifecycle: 'finished', event: null });
  view.observe({ ...base, requestId: 'two', lifecycle: 'started', event: null });
  assert.equal(view.getActivity('p', 's', 'r')?.segmentStartedAt, 1000);
  assert.equal(view.getActivity('p', 's', 'r')?.startedAt, 8000);
  assert.equal(view.getActivity('p', 's', 'r')?.requestOrdinal, 2);
  view.observe({ ...base, requestId: 'two', event: null });
  t.mock.timers.tick(7000);
  view.observe({ ...base, requestId: 'three', lifecycle: 'started', event: null });
  assert.equal(view.getActivity('p', 's', 'r')?.segmentStartedAt, 1000);
  assert.equal(view.getActivity('p', 's', 'r')?.requestOrdinal, 3);
  view.observe({ ...base, requestId: '', event: null });
  assert.equal(view.getActivity('p', 's', 'r'), null);
  view.observe({ ...base, requestId: 'resumed', lifecycle: 'started', event: null });
  assert.equal(view.getActivity('p', 's', 'r')?.segmentStartedAt, 15000);
  assert.equal(view.getActivity('p', 's', 'r')?.requestOrdinal, 1);
});

test('assigned output streams content-first arguments and keeps one preview through the save request', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', outputPreview: { id: 'outline:assignment', stage: 'outline' as const } };
  view.observe({ ...base, event: { type: 'text_delta', sequence: 1, delta: '# 大纲\n\n第一段' } });
  assert.equal(view.get('p', 's', 'r')?.text, '# 大纲\n\n第一段');
  view.observe({ ...base, lifecycle: 'finished', event: null });
  assert.equal(view.get('p', 's', 'r')?.phase, 'saving');
  view.observe({ ...base, requestId: 'save', lifecycle: 'started', event: null });
  assert.equal(view.get('p', 's', 'r')?.text, '# 大纲\n\n第一段', 'must not blink away between text and persistence');
  view.observe({ ...base, requestId: 'save', event: { type: 'tool_call_delta', sequence: 1, index: 0, id: 't', name: 'submit_writing_stage', argumentsDelta: '{"content":"# 大纲\\n\\n' } });
  assert.equal(view.get('p', 's', 'r')?.text, '# 大纲\n\n第一段', 'same-content save must not rewind');
  view.observe({ ...base, requestId: 'save', event: { type: 'tool_call_delta', sequence: 2, index: 0, id: 't', argumentsDelta: '第一段，还有第二段' } });
  assert.equal(view.get('p', 's', 'r')?.text, '# 大纲\n\n第一段，还有第二段', 'stage need not arrive before content');
  view.observe({ ...base, requestId: 'save', event: { type: 'tool_call_delta', sequence: 3, index: 0, id: 't', argumentsDelta: '","stage":"research"}' } });
  assert.equal(view.get('p', 's', 'r'), null, 'a conflicting stage must retract the uncommitted preview');
});

test('failed preview is removed, and a fresh assignment never inherits the old text', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', outputPreview: { id: 'outline:one', stage: 'outline' as const } };
  view.observe({ ...base, event: { type: 'text_delta', sequence: 1, delta: '未保存的提纲' } });
  view.observe({ ...base, event: null });
  assert.equal(view.get('p', 's', 'r'), null);
  view.observe({ ...base, requestId: 'retry', lifecycle: 'started', event: null });
  assert.equal(view.get('p', 's', 'r'), null);
  view.observe({ ...base, requestId: 'retry', event: { type: 'text_delta', sequence: 1, delta: '重试' } });
  view.observe({ ...base, requestId: 'new', outputPreview: { id: 'outline:two', stage: 'outline' }, lifecycle: 'started', event: null });
  assert.equal(view.get('p', 's', 'r'), null);
});

test('a corrected text generation replaces rejected text in the same stage preview', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'first', outputPreview: { id: 'outline:one', stage: 'outline' as const } };
  view.observe({ ...base, event: { type: 'text_delta', sequence: 1, delta: '正在整理' } });
  view.observe({ ...base, lifecycle: 'finished', event: null });
  view.observe({ ...base, requestId: 'corrected', lifecycle: 'started', event: null });
  view.observe({ ...base, requestId: 'corrected', event: { type: 'text_delta', sequence: 1, delta: '# 真正的提纲' } });
  assert.equal(view.get('p', 's', 'r')?.text, '# 真正的提纲');
  assert.equal(view.get('p', 's', 'r')?.phase, 'generating');
});

test('request activity is visible before text and private output updates activity without leaking content', () => {
  const view = new ConversationStreamPreview();
  const input = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', actor: 'director' };
  view.observe({ ...input, lifecycle: 'started', event: null });
  assert.equal(view.getActivity('p', 's', 'r')?.phase, 'waiting');
  assert.equal(view.getActivity('p', 's', 'r')?.actor, 'director');
  assert.equal(view.getActivity('other', 's', 'r'), null);
  view.observe({ ...input, event: { type: 'response_activity', phase: 'headers', sequence: 1 } });
  assert.equal(view.getActivity('p', 's', 'r')?.phase, 'connected');
  view.observe({ ...input, event: { type: 'text_delta', delta: 'PRIVATE_REASONING', sequence: 2 } });
  const activity = view.getActivity('p', 's', 'r');
  assert.equal(activity?.phase, 'receiving');
  assert.ok(activity?.lastActivityAt);
  assert.equal(view.get('p', 's', 'r'), null);
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE_REASONING/);
  view.observe({ ...input, requestId: 'retry', lifecycle: 'started', event: null });
  assert.equal(view.getActivity('p', 's', 'r')?.phase, 'waiting');
  assert.equal(view.getActivity('p', 's', 'r')?.lastActivityAt, null);
  view.observe({ ...input, requestId: 'retry', event: null });
  assert.equal(view.getActivity('p', 's', 'r'), null);
});

test('private reasoning updates liveness without creating a public reply or preview', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const view = new ConversationStreamPreview();
  const input = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q', actor: 'director' };
  view.observe({ ...input, lifecycle: 'started', event: null });
  view.observe({ ...input, event: { type: 'response_activity', phase: 'headers', sequence: 1 } });
  t.mock.timers.tick(250);
  view.observe({ ...input, event: { type: 'response_activity', phase: 'reasoning', sequence: 2 } });

  const activity = view.getActivity('p', 's', 'r');
  assert.equal(activity?.phase, 'receiving');
  assert.equal(activity?.lastActivityAt, 1250);
  assert.equal(activity?.workPreview, undefined);
  assert.equal(view.get('p', 's', 'r'), null);
  assert.equal(activity?.lastEventKind, 'reasoning', 'activity kind is public; private reasoning content is not');
  assert.doesNotMatch(JSON.stringify(activity), /PRIVATE/u);
});

test('incremental JSON decodes only a top-level user-visible string, including split escapes', () => {
  assert.equal(topLevelString('{"reply":"第一行\\n第二行\\u4f', 'reply'), '第一行\n第二行');
  assert.equal(topLevelString('{"reply":"第一行\\n第二行\\u4f60', 'reply'), '第一行\n第二行你');
  assert.equal(topLevelString('{"meta":{"reply":"内部指令"},"reply":"给你的答复', 'reply'), '给你的答复');
  assert.equal(topLevelString('{"meta":{"reply":"内部指令"}', 'reply'), null);
  assert.equal(topLevelString('{"reply":"你好\\ud83d', 'reply'), '你好');
  assert.equal(topLevelString('{"reply":"你好\\ud83d\\ude00', 'reply'), '你好😀');
});

test('explicit conversational text streams before tool persistence, but internal actor text stays private', () => {
  const view = new ConversationStreamPreview();
  const base = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q' };
  view.observe({ ...base, event: { type: 'text_delta', sequence: 1, delta: '内部任务分析' } });
  assert.equal(view.get('p', 's', 'r'), null);
  view.observe({ ...base, textAudience: 'conversation', event: { type: 'text_delta', sequence: 2, delta: '先聊聊你的' } });
  assert.equal(view.get('p', 's', 'r')?.text, '先聊聊你的');
  view.observe({ ...base, textAudience: 'conversation', event: { type: 'text_delta', sequence: 3, delta: '想法。' } });
  assert.equal(view.get('p', 's', 'r')?.text, '先聊聊你的想法。');
  view.observe({ ...base, textAudience: 'conversation', event: { type: 'tool_call_delta', sequence: 4, index: 0, id: 'save', name: 'respond_writing_intake', argumentsDelta: '{"reply":"先聊聊' } });
  assert.equal(view.get('p', 's', 'r')?.text, '先聊聊你的想法。', 'saving the same reply must not rewind visible text');
  view.observe({ ...base, requestId: 'new-request', event: { type: 'text_delta', sequence: 1, delta: '新的内部分析' } });
  assert.equal(view.get('p', 's', 'r'), null, 'new private request must not retain old public text');
});

test('only approved visible fields stream; research JSON, director reasoning and metadata stay private', () => {
  const view = new ConversationStreamPreview();
  const context = { projectId: 'p', sessionId: 's', runId: 'r', requestId: 'q' };
  const delta = (name: string, argumentsDelta: string, index = 0) => view.observe({ ...context, event: { type: 'tool_call_delta', sequence: 1, index, id: `t${index}`, name, argumentsDelta } });
  delta('director_decide', '{"reason":"内部安排"}');
  assert.equal(view.get('p', 's', 'r'), null);
  delta('respond_writing_intake', '{"summary":"后台摘要","reply":"先聊聊你的', 1);
  assert.equal(view.get('p', 's', 'r')?.text, '先聊聊你的');
  delta('respond_writing_intake', '想法","questions":[]}', 1);
  assert.equal(view.get('p', 's', 'r')?.text, '先聊聊你的想法');
  assert.equal(view.get('other', 's', 'r'), null);
  view.observe({ ...context, event: null });
  assert.equal(view.get('p', 's', 'r'), null);
  delta('submit_writing_stage', '{"stage":"research","content":"{\\"claims\\":[]}"}');
  assert.equal(view.get('p', 's', 'r'), null);
});

test('a new request never concatenates a retry to a partial draft and the stream is bounded', () => {
  const view = new ConversationStreamPreview();
  const context = { projectId: 'p', sessionId: 's', runId: 'r' };
  view.observe({ ...context, requestId: 'q1', event: { type: 'tool_call_delta', sequence: 1, index: 0, id: 'one', name: 'submit_writing_stage', argumentsDelta: '{"stage":"draft","content":"# 草稿' } });
  assert.equal(view.get('p', 's', 'r')?.text, '# 草稿');
  view.observe({ ...context, requestId: 'q2', event: { type: 'tool_call_delta', sequence: 1, index: 0, id: 'two', name: 'respond_author', argumentsDelta: '{"reply":"重新回答' } });
  assert.equal(view.get('p', 's', 'r')?.text, '重新回答');
  view.observe({ ...context, requestId: 'q2', event: { type: 'tool_call_delta', sequence: 2, index: 0, id: 'two', argumentsDelta: '长'.repeat(1_100_000) } });
  assert.ok((view.get('p', 's', 'r')?.text.length ?? 0) <= 100_000);
});
