import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkpointCopy, conversationWorkingCopy, stageRoleCopy } from '../src/shell/interaction.js';

test('reader simulation and final review responsibilities are explicit', () => {
  assert.match(stageRoleCopy('review_reader').action, /分别阅读文章/);
  assert.match(stageRoleCopy('language_review').role, /终审/);
  assert.match(stageRoleCopy('language_review').action, /复核修订结果/);
  assert.match(stageRoleCopy('language_review').action, /清理工作备注和机械表达，保留作者声音/);
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

test('saved conversation messages resolve legacy authors to the current avatars and names', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-history-personas-'));
  const file = join(root, 'render.cjs');
  try {
    buildSync({
      stdin: { contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
        import {WritingAgentShell} from './packages/ui/src/shell/WritingAgentShell.tsx';
        import {createDeterministicMockBridge} from './packages/client-bridge/src/mock-bridge.ts';
        const mock=createDeterministicMockBridge(); const old=mock.getSnapshot();
        const message=(id, body, extra={})=>({id, body, kind:'message', role:'assistant', createdAt:'22:29', ...extra});
        const history=[message('old-assistant','已选定标题。',{actorLabel:'写作助手'}),
          message('old-fact','这版文章已完成事实核查，可以导出。',{stage:'fact_check',activeDurationMs:61000}),
          message('old-final','保存后的修订稿',{actorLabel:'终审与文字打磨专家'}),
          message('no-actor','早期没有角色编号的消息。'),
          message('user','这是用户原话。',{role:'user'})];
        const snapshot={...old,timelineBySession:{[old.selectedSessionId]:history}};
        export const html=renderToStaticMarkup(React.createElement(WritingAgentShell,
          {bridge:{...mock,getSnapshot:()=>snapshot},extensions:{extensionIds:[],listLaunchers:()=>[],getPanel:()=>undefined}}));
        mock.dispose();`, resolveDir: resolve('.'), loader: 'tsx' },
      bundle: true, platform: 'node', format: 'cjs', outfile: file, jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'silent',
    });
    const { html } = createRequire(import.meta.url)(file);
    const row = (id: string) => html.split('data-message-id="' + id + '"')[1]?.split('</article>')[0] ?? '';
    for (const [id, avatar, name] of [
      ['old-assistant', 'assistant', '写作助手汤大姆'],
      ['old-fact', 'fact-check', '核查员查有据'],
      ['old-final', 'final-review', '终审林顺句'],
      ['no-actor', 'assistant', '写作助手汤大姆'],
    ]) {
      assert.ok(row(id!).includes('/agent-avatars/' + avatar + '.png'), id);
      assert.ok(row(id!).includes('<strong>' + name + '</strong>'), id);
      assert.ok(row(id!).includes(name + ' · 22:29'), id);
    }
    assert.match(row('old-fact'), /这版文章已完成事实核查，可以导出。/u);
    assert.match(row('old-fact'), /处理用时 61 秒/u);
    assert.match(row('user'), /这是用户原话。/u);
    assert.doesNotMatch(row('user'), /agent-avatars/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the writing status only shows who is working, elapsed time and the stop button', () => {
  const root=mkdtempSync(join(tmpdir(),'wa-material-preview-'));const file=join(root,'render.cjs');
  try {
    buildSync({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
      import {ConversationWorking} from './packages/ui/src/shell/ConversationWorking.tsx';
      const longText='A'.repeat(900)+'TAIL_MUST_NOT_RENDER';
      const snapshot={activeRunId:'run-1',liveReply:'',liveActivity:{runId:'run-1',requestId:'request-1',actor:'research',phase:'receiving',startedAt:1000,lastActivityAt:2000,lastEventKind:'tool_arguments',receivedEvents:999,workPreview:{label:'尚未执行',text:'INTERNAL_TOOL_ARGUMENTS'},materials:[{id:'m1',label:'访谈纪要',text:longText},{id:'m2',label:'产品资料',text:'第二份节选'}]}};
      export const html=renderToStaticMarkup(React.createElement(ConversationWorking,{snapshot,bridge:{cancelRun:async()=>{}}}));`,resolveDir:resolve('.'),loader:'tsx'},bundle:true,platform:'node',format:'cjs',outfile:file,jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
    const {html}=createRequire(import.meta.url)(file);
    assert.doesNotMatch(html, /写作要求与参考素材|选择参考材料|data-material-preview|访谈纪要|产品资料|TAIL_MUST_NOT_RENDER|INTERNAL_TOOL_ARGUMENTS/);
    assert.match(html, /资料员包打听在翻手头的材料/);
    assert.match(html, /src="\/agent-avatars\/research\.png" width="36" height="36"/u);
    assert.match(html, /本轮已用时/);
    assert.match(html, /<button[^>]*>停止<\/button>/u);
  } finally {rmSync(root,{recursive:true,force:true});}
});

test('waiting and interruption use the same persona for a workflow stage', () => {
  const activity = { runId: 'run', requestId: 'request', actor: 'language_review', phase: 'waiting' as const,
    startedAt: 1000, lastActivityAt: null };
  const running = conversationWorkingCopy(activity, 31000);
  assert.equal(running.title, '终审林顺句在读修订稿');
  assert.match(running.detail, /你可以再等一会儿，也可以点「停止」/);
  const paused = checkpointCopy({ runId: 'run', sessionId: 'session', status: 'interrupted',
    stopReason: 'UNKNOWN_EXTERNAL_OUTCOME', checkpointStage: null, nextStage: null,
    interruption: { source: 'model', cause: 'timeout', actorLabel: '语言终审', replyAccepted: false } }, undefined);
  assert.equal(paused.persona, running.persona);
  assert.match(paused.title, /终审林顺句/);
  const reading = { ...activity, actor: 'research', activeTool: { name: 'read_fact_source', startedAt: 2000 } };
  assert.equal(conversationWorkingCopy(reading, 2500).persona, 'research');
  assert.equal(conversationWorkingCopy({ ...reading, actor: 'fact_check' }, 2500).persona, 'fact-check');
  assert.equal(conversationWorkingCopy({ ...activity, actor: 'review_reader_a' }, 2500).persona, 'readers');
});
