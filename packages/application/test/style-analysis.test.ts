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

test("deduplicates and sends only system plus bounded sample statistics", async () => {
  await assert.rejects(createStyleAnalysis({ provider: new Provider(response), model: "m", name: "x", samples: [samples[0]!, { ...samples[0]!, id: "copy" }] }), /STYLE_SAMPLE_DUPLICATE/u);
  const provider = new Provider(response); const draft = await createStyleAnalysis({ provider, model: "m", name: "x", samples });
  assert.equal(draft.modelRequests, 1); assert.equal(provider.requests[0]!.messages.length, 2); assert.equal(provider.requests[0]!.tools, undefined); assert.ok(draft.card.length <= 1_800); assert.match(draft.card, /\n1\./u);
  assert.match(provider.requests[0]!.messages[0]!.content, /"dimension"[\s\S]*"instruction"[\s\S]*"sampleId"[\s\S]*"confidence"/u); assert.match(provider.requests[0]!.messages[0]!.content, /必须为中文/u);
});
test("accepts mixed in-memory sources while keeping representative context within budget", async () => {
  const provider = new Provider(response);
  const mixed = samples.map((sample, index) => ({ ...sample, kind: index === 0 ? "document" as const : "web" as const, sourceReference: index === 0 ? "local:selection" : "https://example.test/source", text: `${sample.text}${"甲".repeat(30_000)}` }));
  await createStyleAnalysis({ provider, model: "m", name: "mixed", samples: mixed });
  const payload = JSON.parse(provider.requests[0]!.messages[1]!.content) as { samples: Array<{ text: string }>; statistics: { excerptSourceCharacters: number; excerptEnvelopeCharacters: number; totalCharacters: number; metrics: { averageSentenceCharacters: number } } };
  assert.equal(payload.samples.length, 2); assert.ok(payload.statistics.excerptEnvelopeCharacters <= 24_000); assert.ok(payload.statistics.excerptSourceCharacters <= payload.statistics.totalCharacters); assert.ok(payload.statistics.metrics.averageSentenceCharacters > 0);
  assert.ok(payload.samples.some(sample => sample.text.includes("[…节选…]")));
});
test("rejects fabricated evidence and recurring rules without two samples", async () => {
  const fabricated = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, evidence: [{ sampleId: "a", quote: "不存在" }] })) });
  await assert.rejects(createStyleAnalysis({ provider: new Provider(fabricated), model: "m", name: "x", samples }), /STYLE_EVIDENCE_NOT_IN_EXCERPT/u);
  const recurring = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, confidence: "recurring" })) });
  await assert.rejects(createStyleAnalysis({ provider: new Provider(recurring), model: "m", name: "x", samples }), /STYLE_RECURRING/u);
});
test("rejects an otherwise real quote when it falls outside the sent excerpt", async () => {
  const long = [{ ...samples[0]!, text: `开头${"甲".repeat(8_000)}未发送的引文${"乙".repeat(20_000)}` }, { ...samples[1]!, text: `${samples[1]!.text}${"丙".repeat(30_000)}` }];
  const outside = JSON.stringify({ summary: "中文概述", rules: JSON.parse(response).rules.map((rule: any) => ({ ...rule, evidence: [{ sampleId: "a", quote: "未发送的引文" }] })) });
  await assert.rejects(createStyleAnalysis({ provider: new Provider(outside), model: "m", name: "x", samples: long }), /STYLE_EVIDENCE_NOT_IN_EXCERPT/u);
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
test("does not ask a model to pad rules when it reports insufficient evidence", async () => {
  const provider = new Provider(JSON.stringify({ insufficientEvidence: true, reason: "只有一处可引用线索" }));
  await assert.rejects(createStyleAnalysis({ provider, model: "m", name: "x", samples }), /STYLE_INSUFFICIENT_EVIDENCE/u);
  assert.match(provider.requests[0]!.messages[0]!.content, /绝不为凑数编造/u);
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
  assert.equal(provider.requests[0]!.messages.length, 2); assert.equal(provider.requests[0]!.parameters.maxOutputTokens, 2048); assert.match(provider.requests[0]!.messages[0]!.content, /中文 200-300 字/u);
});
