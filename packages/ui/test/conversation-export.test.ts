import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('main conversation links to the current manuscript while export settings live in the workbench', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wa-conversation-export-'));
  try {
    const output = join(directory, 'render.cjs');
    buildSync({ stdin: { contents: `
      import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
      import { WritingAgentShell } from './packages/ui/src/shell/WritingAgentShell.tsx';
      import { ConversationExportCard } from './packages/ui/src/shell/ConversationExportCard.tsx';
      import { WritingWorkbenchPanel } from './packages/writing-ui/src/WritingWorkbenchPanel.tsx';
      import { createDeterministicMockBridge } from './packages/client-bridge/src/mock-bridge.ts';
      export function render(status, connection='ready', stopReason=null, view=null, interruption=null, plainCheckpoint=false) {
        const mock=createDeterministicMockBridge(); const original=mock.getSnapshot();
        const snapshot={...original,mode:'application',connection,activeRunId:null,recoverableRuns:[],runRecords:[],
          previewDocument:{...original.previewDocument,status:'ready',body:'# 一篇文章'},
          factCheckWorkspace:{...original.factCheckWorkspace,status},
          deliveryWorkspace:{...original.deliveryWorkspace,bodyVersionId:'body1',gateStatus:status,formalExportEnabled:status==='passed'}};
        if(stopReason) snapshot.recoverableRuns=[{runId:'waiting',sessionId:snapshot.selectedSessionId,status:'waiting_user',stopReason,
          checkpointStage:'outline',nextStage:'draft',inputRequest:{kind:'publication_selection',reason:'选一个标题，确认后继续核查',questions:[],
          candidates:[{title:'功劳不是特权',rationale:'克制的观察',distributionCopy:null}]}}];
        if(stopReason==='UNKNOWN_EXTERNAL_OUTCOME') delete snapshot.recoverableRuns[0].inputRequest;
        if(plainCheckpoint) delete snapshot.recoverableRuns[0].inputRequest;
        if(interruption) snapshot.recoverableRuns[0].interruption=interruption;
        const bridge={...mock,getSnapshot:()=>snapshot};
        if(connection==='running') { snapshot.activeRunId='live'; snapshot.liveReply=view==='waiting' ? null : {runId:'live',requestId:'request',text:'这是一段正在到达的回复'}; }
        const extensions={extensionIds:[],listLaunchers:()=>[],getPanel:()=>undefined};
        snapshot.timelineBySession={...snapshot.timelineBySession,[snapshot.selectedSessionId]:[
          {id:'read',kind:'tool',label:'读取参考材料',detail:'已完成',state:'success'},
          {id:'guard',kind:'tool',label:'内部检查',detail:'系统已阻止直接写作',state:'failure'},
          {id:'fail',kind:'tool',label:'运行失败',detail:'网络中断，请重试',state:'failure',audience:'conversation'},
          {id:'reply',kind:'message',role:'assistant',body:plainCheckpoint?'唯一的提纲正文\\n\\n**这个方向可以吗？确认后我继续写初稿，也可以直接告诉我怎么改。**':'请确认这份提纲',createdAt:'12:00'}]};
        if(plainCheckpoint) snapshot.materialProcessWorkspace={...snapshot.materialProcessWorkspace,outline:{content:'唯一的提纲正文'}};
        const exportControls=React.createElement(ConversationExportCard,{bridge,snapshot,onInspect:()=>{},onContentChange:()=>{},hostConfiguration:{savePublicationAs:async()=>({cancelled:true})}});
        const html=renderToStaticMarkup(view && view!=='waiting' ? React.createElement(WritingWorkbenchPanel,{bridge,snapshot,initialView:view,closePanel:()=>{},exportControls}) : React.createElement(WritingAgentShell,{bridge,extensions,
          hostConfiguration:{savePublicationAs:async()=>({cancelled:true})}})); mock.dispose(); return html;
      }
    `, resolveDir: resolve('.'), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', outfile: output,
      jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, loader: { '.css': 'empty' }, logLevel: 'silent' });
    const { render } = createRequire(import.meta.url)(output);
    const passed = render('passed');
    assert.match(passed, />查看当前稿件</u);
    assert.match(passed, /已通过核查/u);
    assert.doesNotMatch(passed, /aria-label="文章导出"|导出文件格式|读取参考材料|系统已阻止直接写作/u);
    assert.match(passed, /网络中断，请重试/u);
    assert.match(passed, /请确认这份提纲/u);
    const streaming = render('not_checked', 'running');
    assert.match(streaming, /这是一段正在到达的回复/u);
    assert.match(streaming, /正在生成.*尚未保存/u);
    assert.match(render('not_checked', 'running', null, 'waiting'), /aria-label="正在处理你的消息"/u);
    assert.match(render('not_checked', 'running', null, 'waiting'), /data-conversation-message="status"/u);
    assert.match(render('passed', 'ready', null, 'delivery'), /aria-label="文章导出"/u);
    assert.match(render('passed', 'ready', null, 'read'), /<h1>一篇文章<\/h1>/u);
    for (const status of ['blocked', 'stale', 'error', 'not_checked', 'checking']) {
      const html = render(status);
      assert.doesNotMatch(html, /已通过核查/u);
      assert.match(html, />查看当前稿件</u);
      assert.match(render(status, 'ready', null, 'delivery'), /<button[^>]*disabled=""[^>]*>导出文章<\/button>/u);
    }
    assert.match(render('passed', 'offline', null, 'delivery'), /<button[^>]*disabled=""[^>]*>导出文章<\/button>/u);
    for (const reason of ['WRITING_INPUT_REQUIRED', 'CO_CREATION_CHECKPOINT']) {
      const html = render('not_checked', 'ready', reason);
      assert.match(html, /功劳不是特权/u);
      assert.doesNotMatch(html, /<textarea|>发送意见<|>补充并继续</u);
      assert.equal((html.match(/aria-label="写作指令"/gu) ?? []).length, 1);
      assert.match(html, /下方.*主对话/u);
    }
    assert.match(render('not_checked', 'ready', 'UNKNOWN_EXTERNAL_OUTCOME'), /确认重试并继续/u);
    const checkpoint = render('not_checked', 'ready', 'CO_CREATION_CHECKPOINT', null, null, true);
    assert.equal((checkpoint.match(/唯一的提纲正文/gu) ?? []).length, 1);
    assert.match(checkpoint, /这个方向可以吗？确认后我继续写初稿/);
    assert.doesNotMatch(checkpoint, /aria-label="共创决策"|本阶段成果|已自动展开|打开稿件与过程/);
    assert.equal((checkpoint.match(/aria-label="写作指令"/gu) ?? []).length, 1);
    assert.match(checkpoint, />结束本轮</);
    const timeout = render('not_checked', 'ready', 'UNKNOWN_EXTERNAL_OUTCOME', null, {source:'model',cause:'timeout',replyAccepted:true});
    assert.match(timeout, /已收到你的回复/u);
    assert.match(timeout, /模型响应超时/u);
    assert.match(timeout, />重试这一步</u);
    assert.match(timeout, /data-conversation-recovery="true"/u);
    assert.doesNotMatch(timeout, /避免重复写入|aria-label="本阶段成果"|外部请求的结果未知/u);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
