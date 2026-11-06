import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_MODEL_GROUPS } from '../../client-bridge/src/model-groups.ts';

test('three simple group selectors show advice and only verified choices, retaining invalid selections visibly', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-model-groups-ui-'));
  try {
    const output = join(root, 'render.cjs');
    buildSync({ stdin: { resolveDir: resolve('.'), sourcefile: 'model-groups-render.tsx', contents: `
      import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import { ModelGroupSettings } from './packages/ui/src/shell/ModelGroupSettings.tsx';
      export const render = status => renderToStaticMarkup(React.createElement(ModelGroupSettings, { status, busy:false, onChange:()=>{} }));
      export const choose = (status, value) => {
        let changed;
        const tree = ModelGroupSettings({status,busy:false,onChange:groups=>{changed=groups}});
        const visit = node => {
          if (!node || typeof node!=='object') return;
          if (node.type==='select' && node.props['aria-label']==='写作与表达模型') node.props.onChange({target:{value}});
          React.Children.forEach(node.props?.children, visit);
        };
        visit(tree); return changed;
      };
    ` }, outfile: output, bundle:true, platform:'node', format:'cjs', jsx:'automatic', loader:{'.css':'text'} });
    const api = createRequire(import.meta.url)(output);
    const status = { model:'default-model', modelGroups: DEFAULT_MODEL_GROUPS, profiles:[
      { profileId:'p', displayName:'测试供应商', model:'tested-model', models:['tested-model','untested-model'], tools:'supported', credentialChecked:false,
        verifiedModels:{'tested-model':'2026-11-06T00:00:00Z'} },
    ] };
    const html = api.render(status);
    assert.equal((html.match(/<select/g) ?? []).length, 3);
    for (const text of ['策划与统筹','写作与表达','审校与辅助','不确定时','理解意图','中文写作','响应稳定','默认','测试供应商 / tested-model']) assert.ok(html.includes(text), text);
    assert.ok(!html.includes('untested-model'));
    assert.deepEqual(api.choose(status, JSON.stringify(['p','tested-model'])), { ...DEFAULT_MODEL_GROUPS, writing:{profileId:'p',model:'tested-model'} });
    const invalid = api.render({...status, modelGroups:{...DEFAULT_MODEL_GROUPS, writing:{profileId:'p', model:'untested-model'}}});
    assert.match(invalid, /untested-model · 不可用，请重新验证或选择/);
    const missingKey = api.render({...status, profiles:status.profiles.map(p=>({...p,credentialChecked:true,configured:false}))});
    assert.ok(!missingKey.includes('测试供应商 / tested-model'));
  } finally { rmSync(root, {recursive:true,force:true}); }
});
