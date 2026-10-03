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

test('working materials are a collapsed manual preview, not rotating progress', () => {
  const root=mkdtempSync(join(tmpdir(),'wa-material-preview-'));const file=join(root,'render.cjs');
  try {
    buildSync({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {ConversationWorking} from './packages/ui/src/shell/ConversationWorking.tsx';
      const longText='A'.repeat(900)+'TAIL_MUST_NOT_RENDER';
      const snapshot={activeRunId:'run-1',liveReply:'',liveActivity:{runId:'run-1',requestId:'request-1',actor:'research',phase:'receiving',startedAt:1000,lastActivityAt:2000,materials:[{id:'m1',label:'访谈纪要',text:longText},{id:'m2',label:'产品资料',text:'第二份节选'}]}};
      export const html=renderToStaticMarkup(React.createElement(ConversationWorking,{snapshot,bridge:{cancelRun:async()=>{}}}));`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:file,jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
    const {html}=createRequire(import.meta.url)(file);
    assert.match(html, /写作要求与参考素材（2 项）/);
    assert.match(html, /不是实际进度/);
    assert.match(html, /<select[^>]*aria-label="选择参考材料"/);
    assert.match(html, /<option[^>]*value="0"[^>]*selected=""[^>]*>访谈纪要<\/option>/);
    assert.match(html, /<option[^>]*value="1"[^>]*>产品资料<\/option>/);
    assert.match(html, /<details[^>]*data-material-details="true"(?![^>]*open)/);
    assert.doesNotMatch(html, /TAIL_MUST_NOT_RENDER/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
