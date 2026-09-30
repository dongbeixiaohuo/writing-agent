import assert from 'node:assert/strict';
import test from 'node:test';
import * as presets from '../../client-bridge/src/provider-presets.js';
import { CC_SWITCH_CODEX_PRESETS, CC_SWITCH_CODEX_SOURCE } from '../../client-bridge/src/cc-switch-codex-presets.js';
import type { DesktopProviderSetupInput } from '../../client-bridge/src/desktop-bridge.js';
import { normalizeProviderSetup } from '../src/shell/onboarding.js';

const existing: DesktopProviderSetupInput = {
  kind: 'anthropic_compatible', providerId: 'my-existing-provider',
  baseURL: 'https://private.example.test/v1', model: 'my-model',
  tools: 'supported', usage: 'reported', apiKey: 'test-only-secret', persistence: 'session',
};

test('mainstream provider catalog uses distinct HTTPS endpoints and contains no credentials', () => {
  assert.ok(Array.isArray(presets.PROVIDER_PRESETS));
  const catalog = presets.PROVIDER_PRESETS;
  for (const id of ['deepseek', 'minimax-cn', 'minimax-global', 'qwen-cn', 'qwen-sg',
    'kimi-cn', 'kimi-global', 'zhipu', 'zai', 'volcengine', 'openai', 'anthropic',
    'gemini', 'siliconflow', 'openrouter']) {
    assert.ok(catalog.some(p => p.id === id), id);
  }
  assert.equal(new Set(catalog.map(p => p.id)).size, catalog.length);
  for (const preset of catalog) {
    const url = new URL(preset.baseURL);
    assert.equal(url.protocol, 'https:');
    assert.equal(url.username + url.password + url.search + url.hash, '');
    assert.equal('apiKey' in preset, false);
    assert.ok(preset.note.length > 0);
  }
});

test('applying a preset fills transport but never carries another provider key or model', () => {
  assert.equal(typeof presets.applyProviderPreset, 'function');
  const form = presets.applyProviderPreset(existing, 'minimax-cn');
  assert.equal(form.kind, 'anthropic_compatible');
  assert.equal(form.baseURL, 'https://api.minimax.cn/anthropic/v1');
  assert.equal(form.providerId, 'minimax-cn');
  assert.equal(form.apiKey, '');
  assert.equal(form.model, '');
  assert.equal(form.persistence, 'session');
  assert.equal(existing.apiKey, 'test-only-secret');
  assert.throws(() => normalizeProviderSetup(form), /PROVIDER_MODEL_REQUIRED/);
});

test('preset plus only key and model is a valid desktop setup for every catalog entry', () => {
  assert.equal(typeof presets.applyProviderPreset, 'function');
  for (const preset of presets.PROVIDER_PRESETS) {
    const form = presets.applyProviderPreset(existing, preset.id);
    const input = normalizeProviderSetup({ ...form, apiKey: 'test-only-new-key', model: 'account-model-id' });
    assert.equal(input.baseURL, preset.baseURL);
    assert.equal(input.kind, preset.kind);
    assert.equal(input.tools, 'supported');
  }
});

test('custom mode keeps editable transport and model, but clears the unsaved key', () => {
  assert.equal(typeof presets.applyProviderPreset, 'function');
  assert.deepEqual(presets.applyProviderPreset(existing, 'custom'), { ...existing, apiKey: '' });
  assert.throws(() => presets.applyProviderPreset(existing, 'unknown-preset'), /PROVIDER_PRESET_UNKNOWN/);
});

test('existing config identification never rewrites the endpoint, model or provider name', () => {
  assert.equal(typeof presets.identifyProviderPreset, 'function');
  const old = { ...existing, baseURL: 'https://api.minimaxi.com/anthropic/v1/' };
  const before = JSON.stringify(old);
  assert.equal(presets.identifyProviderPreset(old), 'custom');
  assert.equal(JSON.stringify(old), before);
  assert.equal(presets.identifyProviderPreset({ ...old, baseURL: 'https://api.minimax.cn/anthropic/v1/' }), 'minimax-cn');
  assert.equal(presets.identifyProviderPreset({ ...old, baseURL: 'https://api.minimax.cn/anthropic/v1/other' }), 'custom');
  assert.equal(presets.identifyProviderPreset({ ...old, kind: 'openai_compatible', baseURL: 'https://api.minimax.cn/anthropic/v1' }), 'custom');
  assert.equal(presets.identifyProviderPreset({ ...old, baseURL: 'https://api.minimax.cn.attacker.test/anthropic/v1' }), 'custom');
});

test('all source API Key entries are represented, with actual upstream API format taking precedence', () => {
  assert.equal(CC_SWITCH_CODEX_SOURCE.entries, 93);
  assert.equal(CC_SWITCH_CODEX_PRESETS.length, 90);
  assert.equal(CC_SWITCH_CODEX_SOURCE.excluded.length, 3);
  for (const [, name, apiFormat, baseURL, examples] of CC_SWITCH_CODEX_PRESETS) {
    const expectedKind = apiFormat === 'openai_chat' ? 'openai_compatible' : 'openai_responses';
    const matches = presets.PROVIDER_PRESETS.filter(p => p.kind === expectedKind && p.baseURL === baseURL && p.sourceNames?.includes(name));
    assert.equal(matches.length, 1, name);
    assert.ok(matches[0]!.sourceNames?.includes(name), name);
    for (const model of examples) assert.ok(matches[0]!.modelExamples?.includes(model), name);
  }
  for (const name of ['OpenAI Official', 'xAI (Grok) OAuth', 'Azure OpenAI']) {
    assert.ok(!presets.PROVIDER_PRESETS.some(p => p.sourceNames?.includes(name)));
  }
  // The source TOML is Responses even for these Chat upstreams.
  for (const name of ['Tencent Token Plan', 'AtlasCloud', 'ModelScope', 'Nvidia']) {
    assert.equal(presets.PROVIDER_PRESETS.find(p => p.sourceNames?.includes(name))!.kind, 'openai_compatible');
  }
});

test('Responses variants coexist with old Chat and Anthropic presets without migrating saved configs', () => {
  // DeepSeek is intentionally absent: its cc entry was corrected back to Chat
  // Completions on 2026-09-26 after the official endpoint rejected this app's
  // Responses payload with HTTP 400 on a verified-valid key.
  for (const [oldId, name] of [['minimax-cn', 'MiniMax'], ['kimi-cn', 'Kimi'], ['qwen-cn', '千问AI平台']]) {
    const old = presets.PROVIDER_PRESETS.find(p => p.id === oldId)!;
    const next = presets.PROVIDER_PRESETS.find(p => p.sourceNames?.includes(name!))!;
    assert.notEqual(old.kind, next.kind);
    assert.equal(next.kind, 'openai_responses');
    assert.equal(presets.identifyProviderPreset(old), old.id);
    assert.equal(presets.identifyProviderPreset(next), next.id);
    const before = JSON.stringify(existing);
    const form = presets.applyProviderPreset(existing, next.id);
    assert.equal(form.apiKey, '');
    assert.equal(form.model, '');
    assert.equal(JSON.stringify(existing), before);
  }
});

test('search exposes protocols and Chinese names; third-party and plan entries state their boundaries', () => {
  assert.ok(presets.filterProviderPresets('  腾讯 ').length >= 3);
  assert.ok(presets.filterProviderPresets('minimax-m3').some(p => p.id === 'cc-minimax'));
  assert.ok(presets.filterProviderPresets('Responses').every(p => p.kind === 'openai_responses'));
  assert.equal(presets.filterProviderPresets('no-such-provider-123').length, 0);
  assert.equal(presets.filterProviderPresets('').length, presets.PREFERRED_PROVIDER_PRESETS.length);
  assert.equal(presets.PROVIDER_PRESETS.length, 120);
  for (const p of presets.PROVIDER_PRESETS) {
    if (p.group === '第三方中转') assert.match(p.note, /内容和 API Key 会发送到此平台/);
    if (p.group === '套餐专用接口') assert.match(p.note, /确认套餐允许用于本写作应用/);
  }
});

test('every preset separates offering, account region and protocol without inferring a plan from its name', () => {
  for (const p of presets.PROVIDER_PRESETS) {
    assert.ok(p.offering.provider);
    assert.ok(p.offering.region in presets.PROVIDER_REGIONS);
    assert.ok(p.offering.product in presets.PROVIDER_PRODUCTS);
    assert.ok(p.label.includes(presets.providerRegionLabel(p.offering)));
    assert.ok(p.label.includes(presets.providerProductLabel(p.offering)));
    assert.ok(p.label.includes(presets.PROVIDER_PROTOCOL_LABELS[p.kind]));
  }
  const relay = presets.PROVIDER_PRESETS.find(p => p.id === 'cc-aicoding')!;
  assert.equal(relay.group, '第三方中转');
  assert.equal(relay.offering.region, 'unspecified');
  assert.equal(relay.offering.product, 'platform');
  assert.equal(presets.PROVIDER_PRESETS.find(p => p.id === 'cc-byteplus')!.offering.product, 'coding');
  for (const id of ['minimax-cn', 'minimax-global', 'cc-minimax', 'cc-minimax-en']) {
    const p = presets.PROVIDER_PRESETS.find(p => p.id === id)!;
    assert.equal(p.offering.product, 'shared');
    assert.match(p.note, /连接验证也不验证扣费方式/);
  }
});

test('Zhipu and Z.AI Coding Plan have three distinct protocols, separate from general API', () => {
  for (const provider of ['智谱 GLM', 'Z.AI / GLM']) {
    const plans = presets.PROVIDER_PRESETS.filter(p => p.offering.provider === provider && p.offering.product === 'coding');
    assert.equal(plans.length, 3);
    assert.deepEqual(new Set(plans.map(p => p.kind)), new Set(['openai_compatible', 'openai_responses', 'anthropic_compatible']));
    assert.ok(plans.every(p => p.group === '套餐专用接口'));
    const general = presets.PROVIDER_PRESETS.find(p => p.offering.provider === provider && p.offering.product === 'api')!;
    assert.ok(plans.every(p => p.baseURL !== general.baseURL));
  }
  const qwen = presets.PROVIDER_PRESETS.find(p => p.id === 'qwen-cn-coding-anthropic')!;
  assert.equal(qwen.baseURL, 'https://coding.dashscope.aliyuncs.com/apps/anthropic/v1');
  assert.equal(qwen.authHeader, 'authorization');
  assert.equal(qwen.offering.product, 'coding');
});

test('shared Tencent endpoints retain all six account editions and never combine model directories', () => {
  const tencent = presets.PROVIDER_PRESETS.filter(p => p.offering.provider === '腾讯云');
  assert.equal(tencent.length, 6);
  assert.equal(new Set(tencent.map(p => p.label)).size, 6);
  for (const region of ['cn', 'international']) {
    const editions = tencent.filter(p => p.offering.region === region);
    assert.equal(editions.length, 3);
    assert.deepEqual(editions.find(p => p.offering.edition === '企业轻量版 Lite')!.modelExamples, ['auto']);
  }
  const intl = tencent.find(p => p.id === 'cc-tencent-token-plan-intl')!;
  assert.equal(presets.identifyProviderPreset({ ...intl, providerId: 'legacy' }), 'custom');
  assert.equal(presets.identifyProviderPreset({ ...intl, providerId: intl.id }), intl.id);
  assert.equal(presets.identifyProviderPreset({ ...intl, providerId: 'cc-tencent-token-plan-enterprise-pro-intl' }), 'cc-tencent-token-plan-enterprise-pro-intl');
  assert.equal(presets.identifyProviderPreset({ ...intl, providerId: intl.id, baseURL: 'https://different.example.test/v1' }), 'custom');
});

test('search and region/product filters do not silently change selection or conflate plans', () => {
  // rc.49: Zhipu Coding's Anthropic variant is the only visible Coding choice;
  // its Chat and Responses variants stay registered but hidden from new selections.
  assert.equal(presets.filterProviderPresets('智谱 国内 Coding').length, 1);
  assert.equal(presets.filterProviderPresets('腾讯', { region: 'international', product: 'token' }).length, 3);
  assert.equal(presets.filterProviderPresets('Qwen', { region: 'international', product: 'api' }).length, 1);
  assert.equal(presets.filterProviderPresets('MiniMax', { product: 'shared' }).length, 4);
  assert.equal(presets.filterProviderPresets('MiniMax', { product: 'coding' }).length, 0);
});

test('new choices prefer Responses only within the same region and account offering; legacy Chat stays editable', () => {
  const choices = presets.filterProviderPresets('');
  const ids = new Set(choices.map(p => p.id));
  for (const [chat, responses] of Object.entries(presets.RESPONSES_PREFERRED_OVER_CHAT)) {
    assert.ok(!ids.has(chat), chat);
    assert.ok(ids.has(responses), responses);
    const previous = presets.PROVIDER_PRESETS.find(p => p.id === chat)!;
    const next = presets.PROVIDER_PRESETS.find(p => p.id === responses)!;
    assert.deepEqual(previous.offering, next.offering);
    assert.equal(next.kind, 'openai_responses');
    const oldForm = { ...existing, ...previous, providerId: previous.id };
    const before = JSON.stringify(oldForm);
    assert.equal(presets.identifyProviderPreset(oldForm), previous.id);
    assert.equal(JSON.stringify(oldForm), before);
  }
  // rc.49: for every family with an Anthropic variant, the Anthropic variant
  // is the only visible choice; Chat and Responses variants stay registered
  // but hidden from new selections, never migrated or rewritten.
  for (const [hidden, preferred] of Object.entries(presets.ANTHROPIC_PREFERRED_PRESETS)) {
    assert.ok(!ids.has(hidden), hidden);
    assert.ok(ids.has(preferred), preferred);
    const winner = presets.PROVIDER_PRESETS.find(p => p.id === preferred)!;
    assert.equal(winner.kind, 'anthropic_compatible');
    assert.equal(winner.authHeader, 'authorization');
  }
  // A provider's Anthropic Coding Plan does not replace its paid general API.
  for (const id of ['zhipu-anthropic', 'zai-anthropic', 'cc-tencent-token-plan', 'cc-qwencloud-coding', 'gemini', 'siliconflow-anthropic']) assert.ok(ids.has(id), id);
  assert.equal(choices.length, 99);
});

test('DeepSeek presets carry the reviewed thinking-disabled adaptation after real-account falsification', () => {
  for (const [id, kind] of [['cc-deepseek', 'openai_compatible'], ['deepseek', 'openai_compatible'], ['deepseek-anthropic', 'anthropic_compatible']] as const) {
    const preset = presets.PROVIDER_PRESETS.find(p => p.id === id)!;
    assert.equal(preset.kind, kind);
    assert.deepEqual(preset.extraBody, { thinking: { type: 'disabled' } }, id);
  }
});

test('unified region wording and Chinese provider aliases are searchable', () => {
  assert.equal(presets.PROVIDER_REGIONS.unspecified, '不区分国内 / 国际');
  assert.ok(presets.filterProviderPresets('深度求索').some(p => p.id === 'deepseek-anthropic'));
  assert.ok(presets.filterProviderPresets('通义 国际').some(p => p.id === 'qwen-sg-anthropic'));
  assert.ok(presets.filterProviderPresets('智谱 国际').some(p => p.id === 'zai-anthropic'));
});
