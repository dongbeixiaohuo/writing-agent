import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { editorialPlanFixture } from './collaboration-fixture.js';
import { replayReadingHandoff, type ReadingHandoffFixture } from './reading-handoff-replay.js';
import { parsePrewriting } from '../src/prewriting.js';
import { selectedSourceCoverage } from '../src/research-supplement.js';

const direction = '老板说员工在乎钱，奖金规则却说不清。';
const publicUrl = 'https://report.example.org/pay';
const supplementalUrl = 'https://case.example.net/bonus';
const originalText = '员工问自己的绩效奖金，主管告诫他不要把奖金告诉同事。';
const supplementalText = '离线夹具：公开了工资区间，年终奖的系数仍没有向员工解释。';
const source = (url: string, text: string) => ({
  url, finalUrl: url, text, bodyHash: createHash('sha256').update(text).digest('hex'),
  truncated: false, instructionAuthority: 'none' as const,
});
const query = '公开薪酬区间 年终奖 系数 分配规则 案例';
const fixture: ReadingHandoffFixture = {
  brief: { schemaVersion: 1, topic: direction, genre: 'explanatory_analysis', audience: '职场读者',
    lengthTarget: { targetCharacters: 800 }, materialIds: [], constraints: [], interactionMode: 'co_creation',
    authorAuthorization: { voice: null, styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', firsthandMaterialIds: [] },
    platform: null, publicationGoal: 'not_applicable', confirmationStatus: 'confirmed' },
  authorReplies: [direction], rawAuthorText: [direction],
  firstReading: source(publicUrl, originalText),
  supplement: source(supplementalUrl, supplementalText),
  researchLedger: JSON.stringify({ claims: [{ evidence_id: 'E001', claim_type: 'other', claim_text: originalText, source_quote: originalText,
    source_title: '合成报道', source_publisher: '合成报刊', source_url: publicUrl, accessed_at: '离线测试', reliability: 'medium', use_boundary: '只写材料展示的做法',
    verification_status: 'source_verified' }], notes: '', editorialPlan: editorialPlanFixture(['E001']) }),
  assessment: {
    decision: 'ready', promise: direction, readerPayoff: '知道区间与奖金计算分别能回答什么。', reason: '按原方向选材。',
    readingRoute: { question: direction, moments: [{ sourceUrl: publicUrl, quote: originalText, interest: '公司怎样转移员工关于奖金的问题。' }] },
    transitionBridge: { moment: 1, connection: '从员工问自己的奖金，接到主管要求员工保持沉默。' },
    researchGap: { angle: 'counterexample', query }, premises: [], sections: [], queries: [], questions: [],
  },
};

for (const outcome of ['found', 'missing', 'reprint', 'not_authorized', 'irrelevant'] as const)
  test(`bounds the prewriting supplement and reaches the writer (${outcome})`, async () => {
    const replay = await replayReadingHandoff(fixture, outcome);
    assert.equal(replay.publicQueries.length, outcome === 'not_authorized' ? 0 : 1);
    if (outcome !== 'not_authorized') assert.equal(replay.publicQueries[0], query);
    assert.equal(new Set(replay.publicQueries).size, replay.publicQueries.length);
    assert.equal(replay.outlineRequests, outcome === 'found' || outcome === 'irrelevant' ? 2 : 1);
    assert.equal(replay.sourceReads, outcome === 'missing' || outcome === 'not_authorized' ? 0 : 1);
    const state = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
    assert.deepEqual(state.authorWords, [direction]);
    assert.equal(state.writingRequirements.topic, direction);
    assert.equal(state.writingPlan.readerPayoff, fixture.assessment.readerPayoff);
    assert.deepEqual(state.writingPlan.transitionBridge, fixture.assessment.transitionBridge);
    assert.deepEqual(state.sourceReadings.map((source: {url: string}) => source.url),
      outcome === 'found' ? [publicUrl, supplementalUrl] : [publicUrl]);
    assert.doesNotMatch(replay.draftRequest.messages[1]!.content, /researchGap|公司怎样转移员工关于奖金的问题/u);
  });

test('rebinds optional writing connections after pruning invalid bookmarks and omits unsupported connections', () => {
  const good = fixture.assessment.readingRoute!.moments[0]!;
  const plan = (moment: number) => parsePrewriting({
    ...fixture.assessment, readingRoute: { question: direction, moments: [{ ...good, quote: '未出现的引文。' }, good] },
    transitionBridge: { moment, connection: '从作者起点转到书签。' },
    practicalFriction: { moment, connection: '从书签中的实际交涉写员工问奖金时遇到的阻力。' },
  }, fixture.researchLedger, '', true, { direction, sources: [fixture.firstReading] });
  assert.equal(plan(2).transitionBridge?.moment, 1);
  assert.equal(plan(1).transitionBridge, undefined);
  assert.equal(plan(2).practicalFriction?.moment, 1);
  assert.equal(plan(1).practicalFriction, undefined);
  assert.equal(plan(7).decision, 'ready');
});

test('narrative observation uses an attributed survey or searches a concrete gap and keeps the topic if nothing turns up', async () => {
  const topic = '为什么请年假难开口？';
  const reportUrl = 'https://reports.example.org/leave-study';
  const searchUrl = reportUrl + '?ref=search';
  const report = '一份本地问卷里，有受访者把工作交接困难列为请年假的障碍。';
  const initialQuery = '带薪年假 工作交接 问卷';
  const practicalFriction = { moment: 1, connection: '写清开口请假前还要安排手头工作由谁接。' };
  const gapQuery = '带薪年假 请假审批 工作交接 员工采访';
  const narrative: ReadingHandoffFixture = {
    ...fixture, brief: { ...fixture.brief, topic, genre: 'narrative_observation' }, rawAuthorText: [topic], authorReplies: [],
    researchLedger: JSON.stringify({ claims: [{ evidence_id: 'E001', claim_type: 'other', claim_text: report, source_quote: report,
      source_title: '问卷报道', source_publisher: '离线报道', source_url: reportUrl, accessed_at: '离线测试',
      reliability: 'medium', use_boundary: '只说受访者遇到的交接困难', verification_status: 'source_verified' }],
      editorialPlan: editorialPlanFixture(['E001']) }),
    recordedResearch: { queries: new Map([[initialQuery, [{ url: searchUrl, title: '问卷报道', content: report }]]]),
      followupQueries: [], readings: [], failedReadUrls: [reportUrl] },
    assessment: { ...fixture.assessment, researchGap: undefined, transitionBridge: undefined, practicalFriction,
      readingRoute: { question: topic, moments: [{ sourceUrl: searchUrl, quote: report, interest: '请假前先解决交接。' }] } },
  };
  const replay = await replayReadingHandoff(narrative, 'missing');
  assert.deepEqual(replay.publicQueries, [initialQuery]);
  const state = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.equal(state.writingPlan.readingRoute.question, topic);
  assert.deepEqual(state.writingPlan.practicalFriction, practicalFriction);
  assert.deepEqual(state.writingPlan.readingRoute.moments, [{ sourceUrl: searchUrl, quote: report }]);
  assert.equal(state.sourceReadings[0]?.sourceType, 'search_excerpt');
  assert.match(state.materialGuidance, /媒体评论提出的判断可供理解背景/u);

  const missing = await replayReadingHandoff({
    ...narrative, recordedResearch: { ...narrative.recordedResearch!, queries: new Map() },
    assessment: { ...narrative.assessment, practicalFriction: undefined, readingRoute: { question: topic, moments: [] },
      researchGaps: [{ angle: 'event', query: gapQuery }] },
  }, 'missing');
  assert.deepEqual(missing.publicQueries, [gapQuery]);
  const missingInput = JSON.parse(missing.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.equal(missingInput.writingPlan.readingRoute.question, topic);
  assert.equal(missingInput.writingPlan.practicalFriction, undefined);
  assert.equal(missing.finalBody, undefined);
});

test('a guide preserves an actionable excerpt within the source budget and hands each bookmark to one step', async () => {
  const topic = '遇到强制扫码点餐，当场怎么做、事后从哪里投诉？';
  const startQuery = '扫码点餐 投诉须知 入口';
  const missingQuery = '页面拒绝授权后 提供人工点餐的实际案例';
  const instructions = '到消费争议平台的投诉入口提交商家名称、地址、诉求和争议材料。';
  const portalUrl = 'https://guide.example.org/notice';
  const readings = ['规则只说明何时可以拒绝扫码授权。', '规则补充依法收集数据的基本原则。', '指导说明介绍了有关部门的各项职责。', '店员可以使用纸质菜单帮顾客点餐。']
    .map((text, index) => source(`https://source.example.org/reading-${index}`, text));
  const caseReading = readings[3]!;
  const report = { url: portalUrl, title: '消费争议投诉须知', content: instructions };
  const makeClaim = (entry: { url: string; text: string }, index: number) => ({
    evidence_id: `E00${index + 1}`, claim_type: entry.url === portalUrl ? 'action_step' : entry.url === caseReading.url ? 'case_report' : 'other',
    claim_text: entry.text,
    source_quote: entry.text, source_title: '离线素材', source_publisher: '离线来源', source_url: entry.url,
    accessed_at: '离线记录', reliability: 'medium', use_boundary: '保留来源的适用范围', verification_status: 'source_verified',
  });
  const claims = [...readings, { url: portalUrl, text: instructions }].map(makeClaim);
  const guide: ReadingHandoffFixture = {
    ...fixture, brief: { ...fixture.brief, topic, genre: 'practical_experience' }, rawAuthorText: [topic], authorReplies: [],
    firstReading: readings[0]!,
    researchLedger: JSON.stringify({ claims, editorialPlan: editorialPlanFixture(claims.map(claim => claim.evidence_id)) }),
    recordedResearch: { queries: new Map([[startQuery, [report]]]), followupQueries: [], readings, failedReadUrls: [portalUrl] },
    assessment: { ...fixture.assessment, researchGap: undefined, transitionBridge: undefined,
      readingRoute: { question: topic, moments: [
        { sourceUrl: caseReading.url, quote: caseReading.text, interest: '当场可以先问人工点餐。' },
        { sourceUrl: portalUrl, quote: instructions, interest: '投诉入口和所需材料。' },
        { sourceUrl: portalUrl, quote: instructions, interest: '重复引用同一原话。' },
      ] },
      guideSteps: [
        { heading: '问能否人工点餐', action: '向店员询问是否有纸质菜单。', moments: [1] },
        { heading: '事后从哪里提交', action: '从投诉入口提交门店和诉求。', moments: [2] },
        { heading: '再讲一遍', action: '把投诉材料再列一遍。', moments: [3] },
      ],
    },
  };
  const saved = '# 扫码点餐遇到卡点\n\n记好店名。有关部门在各自职责范围内负责监督管理。';
  const replay = await replayReadingHandoff(guide, 'missing', { body: saved, answer(request, stage) {
    const state = JSON.parse(request.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
    if (stage === 'review_editor') return { findings: [] };
    if (stage === 'central_revision') return { reviewEdits: { baseBodyVersionId: state.baseBodyVersionId, edits: [] } };
    assert.match(request.messages[0]!.content, /没有读者动作的句子/u);
    assert.ok(state.sources.some((item: { id: string; sourceType?: string }) => item.id === portalUrl && item.sourceType === 'search_excerpt'));
    return { lintEdits: { baseBodyVersionId: state.baseBodyVersionId, edits: [{ kind: 'material',
      quote: '有关部门在各自职责范围内负责监督管理。', replacement: instructions,
      source: { id: portalUrl, quote: instructions }, reason: '给出具体入口和材料。' }] } };
  } });
  assert.deepEqual(replay.publicQueries, [startQuery]);
  const handoff = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.equal(handoff.writingPlan.readingRoute.question, topic);
  assert.deepEqual(handoff.writingPlan.guideSteps, guide.assessment.guideSteps?.slice(0, 2));
  assert.equal(handoff.sourceReadings.length, 4);
  assert.ok(handoff.sourceReadings.some((entry: { url: string }) => entry.url === portalUrl));
  assert.equal(replay.finalBody, saved.replace('有关部门在各自职责范围内负责监督管理。', instructions));

  const missing = await replayReadingHandoff({ ...guide,
    recordedResearch: { ...guide.recordedResearch!, queries: new Map([[startQuery, []]]) },
    assessment: { ...guide.assessment, researchGaps: [{ angle: 'event', query: missingQuery }] },
  }, 'missing');
  assert.deepEqual(missing.publicQueries, [startQuery, missingQuery]);
  const withoutSource = JSON.parse(missing.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.equal(withoutSource.writingPlan.readingRoute.question, topic);
  assert.deepEqual(withoutSource.writingPlan.guideSteps, guide.assessment.guideSteps?.slice(0, 1));
  assert.equal(missing.finalBody, undefined);
});

test('only checks implementation when a gap points to a retained source and sends only selected passages to the writer', async () => {
  const rule = '公司承诺向员工公布工资区间和奖金计算规则。公告写明从下个月开始可以查阅。';
  const reading = source(publicUrl, rule);
  const implementationQuery = '公司 公开奖金规则 实行后 员工 查询 访谈';
  const assessment = { ...fixture.assessment, readingRoute: { question: direction,
    moments: [{ sourceUrl: publicUrl, quote: '没有读到的政策。', interest: '无原文。' },
      { sourceUrl: publicUrl, quote: rule, interest: '制度只说什么时间可以查询。' }] } };
  const gap = (effectOfMoment: number) => ({ angle: 'counterexample' as const, query: implementationQuery, effectOfMoment });
  for (const [researchGap, outcome, expectedReads, expectedQueries] of [
    [undefined, 'missing', 0, []],
    [gap(1), 'missing', 0, []],
    [gap(2), 'missing', 0, [implementationQuery]],
    [gap(2), 'found', 1, [implementationQuery]],
  ] as const) {
    const replay = await replayReadingHandoff({ ...fixture, firstReading: reading, assessment: { ...assessment, researchGap } }, outcome);
    assert.deepEqual(replay.publicQueries, expectedQueries);
    assert.equal(replay.sourceReads, expectedReads);
    const state = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
    assert.equal(state.writingPlan.readingRoute.question, direction);
    assert.deepEqual(state.writingPlan.readingRoute.moments.map((entry: { quote: string }) => entry.quote),
      outcome === 'found' ? [rule, supplementalText] : [rule]);
    assert.match(state.materialGuidance, /分清制度怎么规定和实行后发生了什么/u);
    assert.doesNotMatch(JSON.stringify(state.writingPlan), /effectOfMoment|没有读到的政策/u);
    if (expectedQueries.length) {
      const request = replay.runEvents.find(event => event.type === 'tool.requested' && event.payload.implementationReference === publicUrl);
      assert.ok(request);
      assert.deepEqual(request.payload.arguments, { query: implementationQuery });
    }
  }
});

test('initial research and supplement dispatch only the queries requested', async () => {
  const firstSearchQuery = '职场同事工资和奖金保密 案例';
  const replay = await replayReadingHandoff({ ...fixture, firstSearchQuery }, 'missing');
  assert.equal(replay.publicQueries.length, 2);
  assert.deepEqual(replay.publicQueries.slice(0, 2), [firstSearchQuery, query]);
  assert.equal(replay.outlineRequests, 1);
});

test('the pay article keeps the boss-employee question with one useful source and skips unnecessary supplement', async () => {
  const topic = '职场谈钱：谈钱伤感情为什么只对员工生效';
  const quote = '技术员万杰在与主管沟通年度绩效和奖金时，被告知不要把奖金告诉同事。';
  const tangent = '同事互相打听工资，然后公司公布职级和工资区间。';
  const rawAuthorText = ['老板总说我在乎钱，但是发奖金的时候又很小气', '5'];
  const { researchGap: _gap, ...assessment } = fixture.assessment;
  const replay = await replayReadingHandoff({ ...fixture, brief: { ...fixture.brief, topic }, rawAuthorText,
    firstReading: source(publicUrl, quote + tangent),
    assessment: { ...assessment, promise: topic,
      readerPayoff: '弄清公司要不要公开薪酬区间。',
      readingRoute: { question: topic, moments: [
        { sourceUrl: publicUrl, quote: tangent, interest: '工资区间办法。' },
        { sourceUrl: publicUrl, quote, interest: '主管如何回答员工。' },
      ] } },
  }, 'missing');
  assert.deepEqual(replay.publicQueries, []);
  assert.equal(replay.outlineRequests, 1);
  assert.equal(replay.sourceReads, 0);
  const state = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.equal(state.writingRequirements.topic, topic);
  assert.deepEqual(state.authorWords, rawAuthorText);
  assert.match(state.confirmedFocus.boundary, /老板和员工之间/u);
  assert.match(state.writingPlan.readerPayoff, /两套标准/u);
  assert.deepEqual(state.writingPlan.readingRoute.moments.map((moment: { quote: string }) => moment.quote), [quote]);
  assert.equal(state.writingPlan.transitionBridge.moment, 1);
  assert.equal(state.sourceReadings.length, 1);
});

test('an unreadable first result is skipped within the same search and the next source reaches the writer', async () => {
  const result = await replayReadingHandoff(fixture, 'blocked_first');
  assert.equal(result.publicQueries.length, 1);
  assert.equal(result.publicQueries[0], query);
  assert.equal(result.sourceReads, 2);
  assert.ok(result.runEvents.some(e => e.type === 'tool.failed' && JSON.stringify(e.payload.result).includes('WEB_CONTENT_TYPE_DENIED')));
  const state = JSON.parse(result.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.ok(state.sourceReadings.some((source: { url: string }) => source.url === supplementalUrl));
});

test('an eleventh concrete supplement query is sent and empty results still reach the writer', async () => {
  const { researchGap: _gap, ...assessment } = fixture.assessment;
  const researchGaps = Array.from({ length: 11 }, (_, i) => ({ angle: 'counterexample' as const, query: `奖金分配规则 公开案例 ${i + 1}` }));
  const replay = await replayReadingHandoff({ ...fixture, assessment: { ...assessment, researchGaps } }, 'missing');
  assert.deepEqual(replay.publicQueries, researchGaps.map(gap => gap.query));
  assert.equal(replay.sourceReads, 0);
  assert.equal(replay.outlineRequests, 1);
});

test('ranks useful originals in one query then returns to outline before searching again', async () => {
  const topic = '职场谈钱：谈钱伤感情为什么只对员工生效';
  const ruleUrl = 'https://www.szse.cn/synthetic/bonus-rule';
  const exampleUrl = 'https://tutorial.example.org/bonus';
  const publicityUrl = 'https://news.example.org/bonus-total';
  const ruleQuote = '个人奖金以部门奖金包为基数，按个人绩效系数分配。';
  const exampleQuote = '假设部门奖金包为两万元，个人奖金按个人绩效系数分配。';
  const rule = source(ruleUrl, `离线合成公司：薪酬办法经董事会审议通过。${ruleQuote}`);
  const example = source(exampleUrl, `计算教学算例。${exampleQuote}`);
  const baseQueries = ['员工问主管奖金为何变少 公司怎么回应', '老板和员工协商奖金分配 主管如何回复'];
  const { researchGap: _gap, ...assessment } = fixture.assessment;
  const replay = await replayReadingHandoff({
    ...fixture, brief: { ...fixture.brief, topic }, rawAuthorText: ['老板总说我在乎钱，但是发奖金的时候又很小气'],
    assessment: { ...assessment, promise: topic, readingRoute: { ...assessment.readingRoute!, question: topic },
      researchGaps: [{ angle: 'rule', query: '奖金自动计算表模板' }, ...baseQueries.map(query => ({ angle: 'event' as const, query }))] },
    recordedSupplement: {
      queries: new Map([
        [baseQueries[0]!, [{ title: '算例', url: exampleUrl, content: exampleQuote },
          { title: '发了多少', url: publicityUrl, content: '老板说拿出三千万元发奖金。' },
          { title: '公告', url: ruleUrl, content: ruleQuote }]],
      ]),
      readings: new Map([[ruleUrl, rule], [exampleUrl, example]]),
      select(readings) {
        return readings.filter(item => item.supplementEvidence).map(item => ({
          sourceUrl: item.url, quote: item.url === ruleUrl ? ruleQuote : exampleQuote, interest: '解释员工为什么需要计算口径。',
        }));
      },
    },
  }, 'missing');
  const reads = replay.runEvents.filter(e => e.type === 'tool.requested' && e.payload.toolName === 'read_fact_source' &&
    e.payload.origin === 'outline_research_supplement').map(e => (e.payload.arguments as { url: string }).url);
  assert.deepEqual(replay.publicQueries, [baseQueries[0]]);
  assert.deepEqual(reads, [ruleUrl, exampleUrl]);
  const state = JSON.parse(replay.draftRequest.messages[1]!.content.split('\nCOLLABORATION_STATE=').at(-1)!);
  assert.deepEqual(state.sourceReadings.filter((item: { supplementEvidence?: unknown }) => item.supplementEvidence)
    .map((item: { supplementEvidence: { kind: string } }) => item.supplementEvidence.kind), ['documented_rule', 'calculation_example']);
  assert.deepEqual(state.writingPlan.readingRoute.moments.slice(-2).map((item: { quote: string }) => item.quote), [ruleQuote, exampleQuote]);
  assert.equal(state.writingRequirements.topic, topic);
});

test('counts selected excerpts, grouping copies of the same article across hostnames', () => {
  const first = source(publicUrl, '一二三');
  const independent = source(supplementalUrl, '四五');
  const reprint = { ...first, url: 'https://copy.example.com/pay', finalUrl: 'https://copy.example.com/pay' };
  const plan = { ...fixture.assessment, readingRoute: { question: direction, moments: [
    ...['一', '二', '三'].map(quote => ({ sourceUrl: first.url, quote, interest: '同篇报道。' })),
    { sourceUrl: reprint.url, quote: '一', interest: '转载。' },
    ...['四', '五'].map(quote => ({ sourceUrl: independent.url, quote, interest: '独立材料。' })),
  ] } };
  assert.deepEqual(selectedSourceCoverage(plan, [first, reprint, independent]),
    { independentSources: 2, selected: 5, largestShare: 0.6 });
  assert.deepEqual(selectedSourceCoverage(plan, [first, reprint]),
    { independentSources: 1, selected: 3, largestShare: 1 });
});
