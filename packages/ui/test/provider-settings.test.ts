import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Exercise the real component's event handlers and state across renders. No
// browser or network is needed; this tiny dispatcher implements its three hooks.
test('re-verification clears stale success and scopes failure to the tested profile/model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-settings-ui-'));
  try {
    const output = join(root, 'render.cjs');
    buildSync({ stdin: { resolveDir: resolve('.'), sourcefile: 'provider-settings-render.tsx', contents: `
      import React from 'react';
      import { ProviderSettings } from './packages/ui/src/shell/ProviderSettings.tsx';
      export function mount(host) {
        const slots = [], effects = []; let cursor = 0, tree;
        const hooks = {
          useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
            return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
          useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
          useEffect(effect, deps) { const i = cursor++; if (!slots[i] || deps.some((v,j) => v !== slots[i][j])) effects.push(effect); slots[i] = deps; }
        };
        const render = () => {
          cursor = 0; const dispatcher = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
          const previous = dispatcher.current; dispatcher.current = hooks;
          try { tree = ProviderSettings({host}); } finally { dispatcher.current = previous; }
          while(effects.length) effects.shift()();
        };
        const nodes = (node = tree) => {
          if (!node || typeof node !== 'object') return [];
          return [node, ...React.Children.toArray(node.props?.children).flatMap(child => nodes(child))];
        };
        const text = (node = tree) => typeof node === 'string' || typeof node === 'number' ? String(node)
          : React.Children.toArray(node?.props?.children).map(child => text(child)).join(' ');
        render();
        return { render, text, nodes, async flush() { await new Promise(resolve => setImmediate(resolve)); render(); } };
      }
    ` }, outfile: output, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'text' } });
    const api = createRequire(import.meta.url)(output);
    const profile = { profileId: 'p', displayName: 'Magpie', providerId: 'magpie', kind: 'openai_compatible',
      baseURL: 'http://127.0.0.1:3425/v1', model: 'deepseek/deepseek-flash', models: ['deepseek/deepseek-flash', 'bailian-token-plan/deepseek-v4.1-flash-1017'],
      tools: 'supported', usage: 'unknown', credentialChecked: false, configured: false, verifiedModels: {} as Record<string, string> };
    const status = { activeProfileId: 'p', model: profile.model, profiles: [profile], connectionTest: null };
    let next: 'success' | 'failure' | 'throw' = 'success';
    const tested: string[] = [];
    const host = { providerStatus: async () => status, testProviderConnection: async (target: { profileId: string; model: string }) => {
      tested.push(target.model);
      if (next === 'throw') throw new Error('probe rejected');
      const common = { provider: 'magpie', model: target.model, adapterVersion: 'test' };
      if (next === 'success') { profile.verifiedModels[target.model] = '2026-11-06T00:00:00Z'; return { ...common, ok: true, tools: 'supported', streaming: 'supported', usage: 'not_reported' }; }
      delete profile.verifiedModels[target.model];
      return { ...common, ok: false, stage: 'stream', errorCode: 'MODEL_OUTPUT_TRUNCATED', retryable: false };
    } };
    const ui = api.mount(host);
    await ui.flush();
    const verify = () => ui.nodes().find((n: any) => n.type === 'button' && ui.text(n) === '验证连接').props.onClick();
    verify(); await ui.flush();
    assert.match(ui.text(), /已验证通过，可在分组中选择/);
    next = 'failure';
    verify(); ui.render();
    assert.doesNotMatch(ui.text(), /已验证通过，可在分组中选择/, 'old success is cleared as soon as re-verification starts');
    await ui.flush();
    assert.doesNotMatch(ui.text(), /已验证通过|尚未验证/);
    assert.match(ui.text(), /回复达到单次输出长度上限/);
    assert.ok(ui.nodes().some((n: any) => n.props?.['aria-label'] === '连接验证未通过'));

    next = 'success'; verify(); await ui.flush();
    assert.doesNotMatch(ui.text(), /回复达到单次输出长度上限/);
    const choose = (value: string) => { ui.nodes().find((n: any) => n.type === 'select' && n.props['aria-label'] === 'Magpie 的模型').props.onChange({ target: { value } }); ui.render(); };
    choose(profile.models[1]!);
    next = 'failure'; verify(); await ui.flush();
    assert.match(ui.text(), /bailian-token-plan\/deepseek-v4.1-flash-1017 · 模型回复达到单次输出长度上限/);
    assert.doesNotMatch(ui.text(), /已验证通过/);
    choose(profile.models[0]!);
    assert.match(ui.text(), /deepseek\/deepseek-flash · 已验证通过/, 'failure on a non-default model does not revoke another model');
    next = 'success'; verify(); await ui.flush();
    next = 'throw'; verify(); await ui.flush();
    assert.doesNotMatch(ui.text(), /已验证通过，可在分组中选择/);
    assert.equal(tested.length, 6);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
