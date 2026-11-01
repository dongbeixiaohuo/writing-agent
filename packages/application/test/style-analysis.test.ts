import assert from "node:assert/strict";
import test from "node:test";
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from "../../runtime/llm/src/index.js";
import { StyleLibraryCommandSchema, styleReferenceForProfile } from "../../writing-core/src/style-profile.js";
import { createStyleAnalysis, previewStyle } from "../src/style-analysis.js";

type ProviderMode = "stop" | "max_tokens" | "error" | "never";
class Provider extends ModelProviderBase {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly response: string | null, private readonly mode: ProviderMode = "stop") { super("style-test", "1", { protocol: "mock", streaming: "supported", tools: "unsupported", usage: "unknown" }); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.requests.push(request);
    if (this.mode === "never") { await new Promise<void>(() => {}); return; }
    if (this.mode === "error") { yield { type: "error", error: { code: "NETWORK_ERROR", message: "network", retryable: false } }; return; }
    yield { type: "text_delta", delta: this.response ?? "" };
    yield { type: "completed", finishReason: this.mode === "max_tokens" ? "max_tokens" : "stop" };
  }
}
const samples = [{ id: "a", title: "甲", kind: "text" as const, sourceReference: null, text: "清晨的窗很亮。人群慢慢散开。" }, { id: "b", title: "乙", kind: "text" as const, sourceReference: null, text: "傍晚的窗很亮。街道慢慢安静。" }];
const response = JSON.stringify({ summary: "短句推进，意象克制。", rules: ["语气", "节奏", "结构", "用词", "句式"].map((dimension, index) => ({ dimension, instruction: "用具体意象和短句推进。", evidence: [{ sampleId: index === 0 ? "a" : "a", quote: index === 0 ? "清晨的窗很亮。" : "人群慢慢散开。" }], confidence: "sample" })) });

test('ten samples share one bounded analysis request; eleven are rejected before requesting a model', async () => {
  const ten = Array.from({ length: 10 }, (_, index) => ({ ...samples[0]!, id: index === 0 ? 'a' : `sample-${index}`, text: `${samples[0]!.text.repeat(1000)}第${index}篇。` }));
  const provider = new Provider(response);
  const draft = await createStyleAnalysis({ provider, model: 'm', name: '十篇联合', samples: ten });
  assert.equal(draft.sampleCount, 10);
  assert.equal(provider.requests.length, 1);
  const context = JSON.parse(provider.requests[0]!.messages[1]!.content as string);
  assert.equal(context.samples.length, 10);
  assert.ok(context.statistics.excerptEnvelopeCharacters <= 24_000);
  const untouched = new Provider(response);
  await assert.rejects(createStyleAnalysis({ provider: untouched, model: 'm', name: '超量', samples: [...ten, { ...samples[0]!, id: 'eleven' }] }), /STYLE_SAMPLE_LIMIT_EXCEEDED/);
  assert.equal(untouched.requests.length, 0);
});

test("deduplicates and sends only system plus bounded sample statistics", async () => {
  await assert.rejects(createStyleAnalysis({ provider: new Provider(response), model: "m", name: "x", samples: [samples[0]!, { ...samples[0]!, id: "copy" }] }), /STYLE_SAMPLE_DUPLICATE/u);
  const provider = new Provider(response); const draft = await createStyleAnalysis({ provider, model: "m", name: "x", samples });
  assert.equal(draft.modelRequests, 1); assert.equal(provider.requests[0]!.messages.length, 2); assert.equal(provider.requests[0]!.tools, undefined); assert.ok(draft.card.length <= 1_800); assert.match(draft.card, /\n1\./u);
  assert.match(provider.requests[0]!.messages[0]!.content, /"dimension"[\s\S]*"instruction"/u);
  assert.match(provider.requests[0]!.messages[0]!.content, /中文/u);
  assert.match(provider.requests[0]!.messages[0]!.content, /不凑条数/);
  assert.match(provider.requests[0]!.messages[0]!.content, /引文.*可选/);
  assert.doesNotMatch(JSON.stringify(provider.requests[0]!.messages), /不替代引文证据|insufficientEvidence|5-8 条/);
});
test("accepts mixed in-memory sources while keeping representative context within budget", async () => {
  const provider = new Provider(response);
  const mixed = samples.map((sample, index) => ({ ...sample, kind: index === 0 ? "document" as const : "web" as const, sourceReference: index === 0 ? "local:selection" : "https://example.test/source", text: `${sample.text}${"甲".repeat(30_000)}` }));
  await createStyleAnalysis({ provider, model: "m", name: "mixed", samples: mixed });
  const payload = JSON.parse(provider.requests[0]!.messages[1]!.content) as { samples: Array<{ paragraphs: Array<{ id: string; text: string }> }>; statistics: { excerptSourceCharacters: number; excerptEnvelopeCharacters: number; totalCharacters: number; metrics: { averageSentenceCharacters: number } } };
  assert.equal(payload.samples.length, 2); assert.ok(payload.statistics.excerptEnvelopeCharacters <= 24_000); assert.ok(payload.statistics.excerptSourceCharacters <= payload.statistics.totalCharacters); assert.ok(payload.statistics.metrics.averageSentenceCharacters > 0);
  assert.ok(payload.samples.every(sample => sample.paragraphs.length > 1));
  assert.ok(payload.statistics.excerptSourceCharacters < payload.statistics.totalCharacters);
});

test('keeps all five unequal samples intact when their combined 19,400 characters fit the budget', async () => {
  const input = [2964, 2988, 6186, 3974, 3288].map((length, index) => ({
    ...samples[0]!, id: index === 0 ? 'a' : `sample-${index}`,
    text: `${samples[0]!.text}第${index}篇。${'原文'.repeat(length)}`.slice(0, length),
  }));
  const provider = new Provider(response);
  const draft = await createStyleAnalysis({ provider, model: 'm', name: '五篇样文', samples: input });
  const sent = JSON.parse(provider.requests[0]!.messages[1]!.content);
  assert.ok(sent.samples.every((sample: { paragraphs: Array<{text: string}> }, index: number) => sample.paragraphs.map(p => p.text).join('') === input[index]!.text), 'all five sample texts must remain intact');
  assert.equal(draft.analyzedCharacters, 19_400);
  assert.equal(draft.totalCharacters, 19_400);
  assert.equal(provider.requests.length, 1);
});

test('redistributes unused excerpt capacity independently of sample order', async () => {
  const input = [30_000, 2000, 500].map((length, index) => ({
    ...samples[0]!, id: index === 0 ? 'a' : `sample-${index}`,
    text: `${samples[0]!.text}第${index}篇。${'原文'.repeat(length)}`.slice(0, length),
  }));
  const lengths = [];
  for (const ordered of [input, [...input].reverse()]) {
    const provider = new Provider(response);
    await createStyleAnalysis({ provider, model: 'm', name: '长短混合', samples: ordered });
    const sent = JSON.parse(provider.requests[0]!.messages[1]!.content);
    assert.equal(sent.statistics.excerptEnvelopeCharacters, 24_000);
    assert.deepEqual(sent.samples.map((sample: { id: string }) => sample.id), ordered.map(sample => sample.id));
    lengths.push(Object.fromEntries(sent.samples.map((sample: { id: string; paragraphs: Array<{text: string}> }) => [sample.id, sample.paragraphs.reduce((n,p) => n+p.text.length, 0)])));
  }
  assert.deepEqual(lengths[0], lengths[1]);
});

function withEvidence(quote: string, sampleId = 'a'): string {
  const model = JSON.parse(response);
  model.rules[0].evidence = [{ sampleId, quote }];
  return JSON.stringify(model);
}

test('restores typography-only quote differences to exact original sample text', async () => {
  const original = '他说“先观察，再表达”。\n\n不要急着解释。';
  const input = [{ ...samples[0]!, text: `${original}清晨的窗很亮。人群慢慢散开。` }];
  for (const quote of ['他说"先观察，再表达"。\n不要急着解释。', '他说“先观察，再表达”。不要急着解释。']) {
    const provider = new Provider(withEvidence(quote));
    const draft = await createStyleAnalysis({ provider, model: 'm', name: '排版兼容', samples: input });
    assert.equal(draft.rules[0]!.evidence[0]!.quote, original);
    assert.equal(draft.samples[0]!.text, input[0]!.text);
    assert.equal(provider.requests.length, 1);
  }
});

test('normalizes whitespace runs without joining English words or changing quotation content', async () => {
  const original = "他说：‘not\n  ready’。";
  const input = [{ ...samples[0]!, text: `${original}人群慢慢散开。` }];
  const draft = await createStyleAnalysis({ provider: new Provider(withEvidence("他说：'not ready'。")), model: 'm', name: '英文引文', samples: input });
  assert.equal(draft.rules[0]!.evidence[0]!.quote, original);
  for (const quote of ["他说：'notready'。", "他说：'ready'。", '他说：已经准备好。']) {
    const result = await createStyleAnalysis({ provider: new Provider(withEvidence(quote)), model: 'm', name: '隐藏不匹配例子', samples: input });
    assert.deepEqual(result.rules[0]!.evidence, []);
  }
});

test('never accepts changed numbers, removed negation or omitted intervening sentences', async () => {
  const input = [{ ...samples[0]!, text: '价格是120元。不能直接接受。先观察。仍需验证。再表达。人群慢慢散开。' }];
  for (const quote of ['价格是12元。', '价格是120元。能直接接受。', '先观察。再表达。']) {
    const result = await createStyleAnalysis({ provider: new Provider(withEvidence(quote)), model: 'm', name: '不得改义', samples: input });
    assert.deepEqual(result.rules[0]!.evidence, []);
  }
});

test('does not treat generated excerpt markers or stitched excerpts as original quotations', async () => {
  const input = [{ ...samples[0]!, text: `${'甲'.repeat(20_000)}${'乙'.repeat(20_000)}${'丙'.repeat(20_000)}人群慢慢散开。` }];
  for (const quote of ['甲\n[…节选…]\n乙', '[…节选…]', '甲乙']) {
    const result = await createStyleAnalysis({ provider: new Provider(withEvidence(quote)), model: 'm', name: '节选边界', samples: input });
    assert.deepEqual(result.rules[0]!.evidence, []);
  }
});

test('unmatched optional examples and unknown sample IDs do not discard the style description', async () => {
  for (const output of [withEvidence('没有的原句'), withEvidence('清晨的窗很亮。', 'unknown')]) {
    const provider = new Provider(output);
    const draft = await createStyleAnalysis({ provider, model: 'm', name: '保留描述', samples });
    assert.equal(draft.summary, JSON.parse(response).summary);
    assert.equal(draft.rules.length, 5);
    assert.deepEqual(draft.rules[0]!.evidence, []);
    assert.equal(draft.rules[1]!.evidence.length, 1);
    assert.equal(provider.requests.length, 1);
  }
});
test("omits fabricated examples and downgrades unsupported recurring labels without blocking analysis", async () => {
  const fabricated = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, evidence: [{ sampleId: "a", quote: "不存在" }] })) });
  const draft = await createStyleAnalysis({ provider: new Provider(fabricated), model: "m", name: "x", samples });
  assert.ok(draft.rules.every(rule => rule.evidence.length === 0));
  const recurring = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, confidence: "recurring" })) });
  const result = await createStyleAnalysis({ provider: new Provider(recurring), model: "m", name: "x", samples });
  assert.ok(result.rules.every(rule => rule.confidence === 'sample'));
});
test("hides an otherwise real quote when it falls outside the sent excerpt", async () => {
  const long = [{ ...samples[0]!, text: `开头${"甲".repeat(8_000)}未发送的引文${"乙".repeat(20_000)}` }, { ...samples[1]!, text: `${samples[1]!.text}${"丙".repeat(30_000)}` }];
  const outside = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, evidence: [{ sampleId: "a", quote: "未发送的引文" }] })) });
  const draft = await createStyleAnalysis({ provider: new Provider(outside), model: "m", name: "x", samples: long });
  assert.ok(draft.rules.every(rule => rule.evidence.length === 0));
});
test("accepts recurring rules only when two exact sample quotes support each rule", async () => {
  const recurring = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, confidence: "recurring", evidence: [{ sampleId: "a", quote: "清晨的窗很亮。" }, { sampleId: "b", quote: "傍晚的窗很亮。" }] })) });
  const draft = await createStyleAnalysis({ provider: new Provider(recurring), model: "m", name: "x", samples });
  assert.equal(draft.rules.every(rule => rule.confidence === "recurring"), true);
});
test("cancellation and timeout settle even when a provider ignores abort", async () => {
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await assert.rejects(createStyleAnalysis({ provider: new Provider(response), model: "m", name: "x", samples, signal: controller.signal }), /cancelled/u);
  await assert.rejects(createStyleAnalysis({ provider: new Provider(null, "never"), model: "m", name: "x", samples, timeoutMs: 10 }), /STYLE_ANALYSIS_TIMEOUT/u);
});
test("rejects terminal failures, incomplete output, and output above the hard cap", async () => {
  await assert.rejects(createStyleAnalysis({ provider: new Provider(response, "error"), model: "m", name: "x", samples }), /STYLE_MODEL_NETWORK_ERROR/u);
  await assert.rejects(createStyleAnalysis({ provider: new Provider(response, "max_tokens"), model: "m", name: "x", samples }), /STYLE_MODEL_OUTPUT_TRUNCATED/u);
  await assert.rejects(createStyleAnalysis({ provider: new Provider("x".repeat(12_001)), model: "m", name: "x", samples }), /STYLE_MODEL_OUTPUT_TOO_LARGE/u);
});
test("short or mixed samples return editable initial observations instead of failing an evidence quota", async () => {
  const provider = new Provider(JSON.stringify({ summary: '偏口语化，以直接判断起句。', rules: [{ dimension: '语气', instruction: '直接说观点，不先堆概念。' }], notes: ['样文的语气不同，先保留共同的口语化倾向。'] }));
  const draft = await createStyleAnalysis({ provider, model: 'm', name: '初步风格', samples });
  assert.equal(draft.rules.length, 1);
  assert.deepEqual(draft.rules[0]!.evidence, []);
  assert.ok(draft.notes?.some(note => note.includes('样文的语气不同')));
  assert.ok(draft.notes?.some(note => note.includes('较短')));
  assert.ok(draft.card.includes('直接说观点'));
  assert.equal(provider.requests.length, 1);
});

test('summary-only and plain-language results are usable without inventing rules', async () => {
  const summary = '短句为主，语气克制。用具体观察推动叙述，不急于总结道理。';
  for (const output of [JSON.stringify({ summary }), summary, '```json\n' + JSON.stringify({ summary, rules: [] }) + '\n```']) {
    const draft = await createStyleAnalysis({ provider: new Provider(output), model: 'm', name: '描述即可', samples });
    assert.equal(draft.summary, summary);
    assert.deepEqual(draft.rules, []);
    assert.ok(draft.card.includes(summary));
  }
});

test('optional metadata and invalid examples cannot reject useful model rules', async () => {
  const output = JSON.stringify({ summary: '克制的表达。', rules: [{ dimension: '语气', instruction: '用平实语句描述。', evidence: [{ quote: null }, { sampleId: 'a', quote: '清晨的窗很亮。' }], confidence: 'high', extra: true }, { malformed: true }], notes: [null, '可通过试写调整。'], extra: 'irrelevant' });
  const draft = await createStyleAnalysis({ provider: new Provider(output), model: 'm', name: '容错', samples });
  assert.equal(draft.rules.length, 1);
  assert.equal(draft.rules[0]!.evidence.length, 1);
  assert.ok(draft.notes?.includes('可通过试写调整。'));
});

test('usable writing instructions remain available when the model omits its summary field', async () => {
  const provider = new Provider(JSON.stringify({ rules: [{ dimension: '节奏', instruction: '长短句交替，不把每一句都断成一段。' }] }));
  const draft = await createStyleAnalysis({ provider, model: 'm', name: '写法即可', samples });
  assert.equal(draft.rules.length, 1);
  assert.match(draft.card, /长短句交替/);
  assert.equal(provider.requests.length, 1);
});

test('more than eight observations fit a bounded style card without imposing a target count', async () => {
  const output = JSON.stringify({ summary: '具体、平实的表达。', rules: Array.from({ length: 12 }, (_, i) => ({ dimension: `特点${i}`, instruction: '从观察说起，不重复相同判断。'.repeat(20) })) });
  const draft = await createStyleAnalysis({ provider: new Provider(output), model: 'm', name: '较多特点', samples });
  assert.equal(draft.rules.length, 12);
  assert.ok(draft.card.length <= 1800);
});

test('empty or structurally broken responses still report a technical failure without fabricating a style', async () => {
  for (const output of ['', '{}', '{"summary":', JSON.stringify({ insufficientEvidence: true, reason: '没有返回风格描述' })]) {
    await assert.rejects(createStyleAnalysis({ provider: new Provider(output), model: 'm', name: '空响应', samples }), /STYLE_MODEL_RESPONSE_INVALID/);
  }
});
test("keeps native import parameterless and creates a bounded stable brief reference", () => {
  assert.equal(StyleLibraryCommandSchema.parse({ action: "import" }).action, "import");
  assert.throws(() => StyleLibraryCommandSchema.parse({ action: "import", profiles: [] }));
  const reference = styleReferenceForProfile({ id: "p1", version: 2, name: "个人表达", card: "短句，克制。" });
  assert.equal(reference, "个人风格卡 · 个人表达 · p1 · v2\n短句，克制。"); assert.ok(reference.length <= 2_100);
});
test("preview has a short bounded request and response", async () => {
  const preview = `风格试写，非事实稿：${"窗边的光落在桌面上，句子停得很轻。人群从远处经过，没有人急着解释什么。她把杯子向里挪了挪，听见风吹动纸页。这个下午没有结论，只有几次缓慢的停顿，让目光回到一扇半开的窗。".repeat(3).slice(0, 220)}`;
  const provider = new Provider(JSON.stringify({ preview }));
  assert.equal(await previewStyle({ provider, model: "m", card: "短句，克制。", topic: "窗边" }), preview);
  assert.equal(provider.requests[0]!.messages.length, 2); assert.equal(provider.requests[0]!.parameters.maxOutputTokens, 3000); assert.match(provider.requests[0]!.messages[0]!.content, /800–1200字/u);
});

test('snippet IDs resolve to actual provided paragraphs; invalid optional references never block the card', async () => {
  const input = [{ ...samples[0]!, text: '重复句。\n重复句。\n结尾不要仓促总结。' }];
  const provider = new Provider(JSON.stringify({ summary: '重复起句，克制收尾。', patterns: [{ kind: 'ending', instruction: '收尾留在具体观察上。' }],
    snippets: [{ sampleId: 'a', paragraphId: 'p2:0.1', kind: 'opening', quote: '模型自编的文字' }, { sampleId: 'a', paragraphId: 'p999', kind: 'ending' }], statistics: { invented: 99 } }));
  const result = await createStyleAnalysis({ provider, model: 'm', name: '段落片段', samples: input });
  assert.equal(result.package!.snippets.length, 1);
  assert.equal(result.package!.snippets[0]!.quote, '重复句。');
  assert.equal(result.package!.statistics.articles[0]!.metrics.paragraphs, 3);
  assert.equal(result.package!.patterns[0]!.kind, 'ending');
  assert.equal(provider.requests.length, 1);
});

test('many tiny paragraphs cannot expand the analysis envelope without bound', async () => {
  const provider = new Provider(JSON.stringify({ summary: '一行一个短句。' }));
  const input = [{ ...samples[0]!, text: '短句。\n'.repeat(6000) }];
  const result = await createStyleAnalysis({ provider, model: 'm', name: '短段', samples: input });
  const payload = provider.requests[0]!.messages[1]!.content;
  assert.ok(payload.length < 50_000);
  assert.equal(JSON.parse(payload).samples[0].paragraphs.length, 480);
  assert.equal(result.package!.statistics.articles[0]!.metrics.paragraphs, 6000);
  assert.ok(result.notes!.some(note => note.includes('短段较多')));
  assert.equal(result.analyzedCharacters, 480 * 3);
});
