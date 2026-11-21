const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const id = process.env.WRITING_AGENT_DESKTOP_TEST;
if (!/^batch2-[a-f0-9]+$/.test(id ?? '')) throw Error('Isolated batch2 id required');
const resultFile = join(app.getPath('temp'), 'writing-agent-desktop-test-' + id, 'result.json');
const scenario = process.env.WA_DRAFT_SCENARIO;
const records = [];
let current;
let protocolVersion;
let forceRunning = false;
let releaseAcknowledgement;
function patchSnapshot(snapshot) {
  if (snapshot && snapshot.workspaceId && snapshot.settings) {
    snapshot.settings.credentialReference = 'test-fixture-no-network';
    if (forceRunning) { snapshot.activeRunId = 'fixture-other-project-run'; snapshot.connection = 'running'; }
    current = snapshot;
  }
  return snapshot;
}
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => handle(channel, async (event, request) => {
  protocolVersion = request?.protocolVersion ?? protocolVersion;
  if ((request?.method === 'sendMessage' || request?.method === 'startConversation') && request.args?.[1]?.operationId !== 'test-stale-owner') {
    records.push({ method: request.method, args: request.args, actualTarget: { projectId: current.selectedProjectId, sessionId: current.selectedSessionId } });
    if (scenario === 'navigation' && request.args[0] === '等待回执的旧指令') {
      return new Promise(resolve => { releaseAcknowledgement = () => resolve({ ok: true, result: { runId: 'fixture-ack' } }); });
    }
    return { ok: false, error: { code: 'TEST_SEND_CAPTURED', message: '测试已记录发送，未调用模型' } };
  }
  const response = await listener(event, request);
  if (response?.snapshot) patchSnapshot(response.snapshot);
  if (response?.result?.settings) patchSnapshot(response.result);
  return response;
});
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function () {};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let n = 0; n < 150; n++) { if (await fn()) return; await wait(40); }
  throw Error('Timed out: ' + label);
}
app.once('browser-window-created', (_event, win) => {
  const send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, ...args) => send(channel, ...args.map(patchSnapshot));
  win.webContents.once('did-finish-load', async () => {
    const js = code => win.webContents.executeJavaScript(code);
    const click = selector => js(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}); if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);
    const textClick = text => js(`(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.innerText.startsWith(${JSON.stringify(text)}));if(!e)throw Error('Missing '+${JSON.stringify(text)});e.click()})()`);
    const type = text => js(`(()=>{const e=document.querySelector('[aria-label="写作指令"]');e.focus();e.textContent=${JSON.stringify(text)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}))})()`);
    const value = () => js(`document.querySelector('[aria-label="写作指令"]')?.textContent`);
    const openNew = async () => {
      await textClick('新建项目');
      await until(() => js(`document.querySelector('h1')?.textContent === '今天，写点什么？'`), 'new composer');
    };
    const project = async label => { await click(`[aria-label="${label}"]`); await until(() => js(`document.querySelector('[aria-label=${JSON.stringify(label)}]')?.getAttribute('aria-current')==='true'`), label); await wait(80); };
    const observed = {};
    try {
      await until(() => js(`!!document.querySelector('[aria-label="夜跑随想"]')`), 'projects');
      await project('夜跑随想');
      await until(() => js(`document.querySelector('[aria-label="写作指令"]')?.isContentEditable`), 'editable composer');
      if (scenario === 'project') {
        await type('甲项目专属采访草稿');
        await project('另一个项目');
        observed.bInitial = await value();
        observed.bSendDisabled = await js(`document.querySelector('[aria-label="发送"]').disabled`);
        await type('乙项目独立草稿');
        await click('[aria-label="发送"]');
        await until(() => records.length > 0, 'B captured send');
        observed.bAfterRejected = await value();
        await project('夜跑随想');
        observed.aRestored = await value();
        await click('[aria-label="发送"]');
        await until(() => records.length > 1, 'A captured send');
        observed.staleOwner = await js(`window.writingAgentDesktop.invoke(${JSON.stringify({ protocolVersion, method: 'sendMessage', args: ['stale draft', { operationId: 'test-stale-owner', owner: { workspaceId: current.workspaceId, projectId: 'other-project', sessionId: 'other-session' } }] })})`);
        assert.equal(observed.bInitial, '');
        assert.equal(observed.bSendDisabled, true);
        assert.equal(observed.bAfterRejected, '乙项目独立草稿');
        assert.equal(records[0].args[0], '乙项目独立草稿');
        assert.equal(records[0].actualTarget.projectId, 'other-project');
        assert.equal(records[0].actualTarget.sessionId, 'other-session');
        assert.equal(records[0].args[1].owner.projectId, 'other-project');
        assert.equal(observed.staleOwner.ok, false);
        assert.equal(observed.staleOwner.error.code, 'DRAFT_OWNER_CHANGED');
        assert.equal(observed.aRestored, '甲项目专属采访草稿');
        assert.equal(records[1].args[0], '甲项目专属采访草稿');
        assert.equal(records[1].args[1].owner.projectId, 'publication-fixture');
        assert.equal(records[1].args[1].owner.sessionId, 'export-session');
        assert.equal(records[1].actualTarget.projectId, 'publication-fixture');
      } else if (scenario === 'navigation') {
        await type('运行记录与刷新都保留这段未发送文字');
        await textClick('运行记录');
        await textClick('对话');
        observed.afterTab = await value();
        // Type again so refresh is independently exercised even on RC102.
        await type('运行记录与刷新都保留这段未发送文字');
        win.webContents.reload();
        await until(() => js(`!!document.querySelector('[aria-label="夜跑随想"]')`), 'reload');
        await project('夜跑随想');
        observed.afterReload = await value();
        assert.equal(observed.afterTab, '运行记录与刷新都保留这段未发送文字');
        assert.equal(observed.afterReload, '运行记录与刷新都保留这段未发送文字');
        await type('等待回执的旧指令');
        await click('[aria-label="发送"]');
        await until(() => releaseAcknowledgement !== undefined, 'old send pending');
        await textClick('运行记录');
        await textClick('对话');
        await type('重开编辑器后写的新草稿');
        releaseAcknowledgement();
        await wait(120);
        await textClick('运行记录');
        await textClick('对话');
        observed.afterLateAck = await value();
        assert.equal(observed.afterLateAck, '重开编辑器后写的新草稿');
      } else if (scenario === 'isolation') {
        await type('已有项目专属未发草稿');
        await openNew();
        observed.newInitial = await value();
        assert.equal(observed.newInitial, '');
        await type('新建面板独立未发草稿');
        await project('另一个项目');
        assert.equal(await value(), '');
        await project('夜跑随想');
        assert.equal(await value(), '已有项目专属未发草稿');
        await openNew();
        observed.newRestored = await value();
        assert.equal(observed.newRestored, '新建面板独立未发草稿');
        await project('夜跑随想');
        await js(`void (window.originalSetItem = Storage.prototype.setItem, Storage.prototype.setItem = function(){ throw new DOMException('test quota', 'QuotaExceededError') })`);
        await type('保存失败时仍在输入框的原文');
        observed.failureVisible = await js(`document.body.innerText.includes('草稿保存失败')`);
        assert.equal(observed.failureVisible, true);
        assert.equal(await value(), '保存失败时仍在输入框的原文');
        await project('另一个项目');
        await project('夜跑随想');
        observed.failedDraftReopened = await value();
        assert.equal(observed.failedDraftReopened, '保存失败时仍在输入框的原文');
        assert.equal(await js(`document.body.innerText.includes('草稿保存失败')`), true);
        await click('[aria-label="稿件与版本"]');
        await until(() => js(`!!document.querySelector('[aria-label="关闭稿件面板"]')`), 'failed storage panel');
        await textClick('稿件与差异');
        await textClick('局部修改');
        await js(`(()=>{const e=document.querySelector('textarea[aria-label^="编辑块"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'存储故障时的局部改稿');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        await wait(60);
        await click('[aria-label="关闭稿件面板"]');
        await click('[aria-label="稿件与版本"]');
        await until(() => js(`!!document.querySelector('textarea[aria-label^="编辑块"]')`), 'failed local edit restored');
        observed.failedEditReopened = await js(`document.querySelector('textarea[aria-label^="编辑块"]').value`);
        assert.equal(observed.failedEditReopened, '存储故障时的局部改稿');
        assert.equal(await js(`document.body.innerText.includes('草稿保存失败')`), true);
        await js(`void (Storage.prototype.setItem = window.originalSetItem)`);
        await js(`(()=>{const e=document.querySelector('textarea[aria-label^="编辑块"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'存储恢复后的局部改稿');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        await type('存储恢复后正常保存');
        await wait(60);
        assert.equal(await js(`document.body.innerText.includes('草稿保存失败')`), false);
        forceRunning = true;
        win.webContents.send('writing-agent:snapshot:v7', patchSnapshot({ ...current, revision: current.revision + 100 }));
        await until(() => js(`!!document.querySelector('[aria-label="停止生成"]')`), 'existing project running');
        await openNew();
        await type('旧项目运行时的新项目请求');
        observed.newWhileOtherRunning = await js(`document.querySelector('[aria-label="发送"]')?.disabled === false`);
        assert.equal(observed.newWhileOtherRunning, true);
        await click('[aria-label="发送"]');
        await until(() => records.some(record => record.method === 'startConversation'), 'new command while existing run active');
        assert.equal(records.at(-1).args[0], '旧项目运行时的新项目请求');
      } else if (scenario === 'paragraph') {
        await click('[aria-label="稿件与版本"]');
        await until(() => js(`!!document.querySelector('[aria-label="关闭稿件面板"]')`), 'panel loaded');
        await textClick('稿件与差异');
        await textClick('局部修改');
        await until(() => js(`!!document.querySelector('textarea[aria-label^="编辑块"]')`), 'paragraph edit');
        observed.label = await js(`document.querySelector('textarea[aria-label^="编辑块"]').getAttribute('aria-label')`);
        await js(`(()=>{const e=document.querySelector('textarea[aria-label^="编辑块"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'尚未生成预览的手写段落');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        await wait(100);
        await js(`[...document.querySelectorAll('button')].filter(e=>e.innerText==='局部修改').at(-1).click()`);
        await js(`(()=>{const e=document.querySelector('textarea[aria-label^="编辑块"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'第二段独立修改');e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
        await wait(60);
        await textClick('局部修改');
        observed.afterOtherBlock = await js(`document.querySelector('textarea[aria-label^="编辑块"]')?.value`);
        await click('[aria-label="关闭稿件面板"]');
        await click('[aria-label="稿件与版本"]');
        await until(() => js(`!!document.querySelector('[aria-label="关闭稿件面板"]')`), 'panel loaded');
        await textClick('稿件与差异');
        if (!(await js(`!!document.querySelector('textarea[aria-label^="编辑块"]')`))) await textClick('局部修改');
        observed.afterReopen = await js(`document.querySelector('textarea[aria-label^="编辑块"]')?.value`);
        assert.equal(observed.afterOtherBlock, '尚未生成预览的手写段落');
        assert.equal(observed.afterReopen, '尚未生成预览的手写段落');
        await js(`[...document.querySelectorAll('button')].filter(e=>e.innerText==='局部修改').at(-1).click()`);
        observed.secondBlockRestored = await js(`document.querySelector('textarea[aria-label^="编辑块"]')?.value`);
        assert.equal(observed.secondBlockRestored, '第二段独立修改');
        await textClick('生成差异预览');
        await until(() => js(`document.body.innerText.includes('接受并创建新版本')`), 'preview persisted');
        assert.equal(await js(`!!document.querySelector('textarea[aria-label^="编辑块"]')`), false);
        await textClick('接受并创建新版本');
        await until(() => js(`document.body.innerText.includes('正文 v2')`), 'accepted body version');
        await textClick('局部修改');
        observed.newVersionFirstBlock = await js(`document.querySelector('textarea[aria-label^="编辑块"]')?.value`);
        assert.equal(observed.newVersionFirstBlock, '我喜欢在夜色中慢慢跑步。');
      }
      writeFileSync(resultFile, JSON.stringify({ scenario, passed: true, observed, records }, null, 2));
      app.exit(0);
    } catch (error) {
      writeFileSync(resultFile, JSON.stringify({ scenario, passed: false, error: error.message, ui: await js('document.body.innerText'), observed, records }, null, 2));
      app.exit(1);
    }
  });
});
require(resolve(process.env.WA_COMPILED_ROOT, 'apps/desktop/dist/package/main.cjs'));
