import assert from 'node:assert/strict';
import test from 'node:test';
import * as presets from '../../client-bridge/src/provider-presets.js';
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
