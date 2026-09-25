import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stageRoleCopy } from '../src/shell/interaction.js';

test('reader simulation and humanizer responsibilities are explicit', () => {
  assert.match(stageRoleCopy('review_reader').action, /模拟.*读者/);
  assert.match(stageRoleCopy('language_review').role, /去 AI 味/);
});

test('program generated confirmation summaries render Markdown in the actual user bubble', () => {
  const root=mkdtempSync(join(tmpdir(),'wa-readable-'));const file=join(root,'render.cjs');
  try {
    buildSync({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {WritingAgentShell} from './packages/ui/src/shell/WritingAgentShell.tsx';
      import {createDeterministicMockBridge} from './packages/client-bridge/src/mock-bridge.ts';
      const mock=createDeterministicMockBridge(); const old=mock.getSnapshot();
      const snapshot={...old, timelineBySession:{[old.selectedSessionId]:[{id:'summary',kind:'message',role:'user',createdAt:'现在',body:'按刚才确认的方向继续：### 写作方向\\n\\n- **主题**：中秋节'}]}};
      export const html=renderToStaticMarkup(React.createElement(WritingAgentShell,{bridge:{...mock,getSnapshot:()=>snapshot},extensions:{extensionIds:[],listLaunchers:()=>[],getPanel:()=>undefined}}));mock.dispose();`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:file,jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
    const {html}=createRequire(import.meta.url)(file);
    assert.match(html, /<h3>写作方向<\/h3>/);
    assert.match(html, /<strong>主题<\/strong>/);
    assert.doesNotMatch(html, /### 写作方向/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
