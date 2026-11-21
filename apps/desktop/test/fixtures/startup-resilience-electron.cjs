// Runs the compiled production main/preload/renderer against a test-mode workspace.
const assert = require('node:assert/strict');
const { app, BrowserWindow, dialog } = require('electron');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const id = process.env.WRITING_AGENT_DESKTOP_TEST;
if (!/^batch1-[A-Za-z0-9]+$/.test(id ?? '')) throw new Error('Isolated test id required');
const root = join(app.getPath('temp'), 'writing-agent-desktop-test-' + id);
const action = process.env.WA_FIXTURE_ACTION;
const result = join(root, 'result.json');
const output = join(root, 'export.json');
const prompts = [];
app.disableHardwareAcceleration();
BrowserWindow.prototype.show = function () {};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  prompts.push(options.buttons);
  const button = { rollback: '回退原工作区', retry: '重试恢复', prepare: '继续原工作区', exit: '退出' }[action];
  const response = options.buttons.indexOf(button);
  assert.ok(response >= 0, JSON.stringify(options.buttons));
  return { response, checkboxChecked: false };
};
dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
let projectBackupSelections = 0;
dialog.showOpenDialog = async () => ({ canceled: false,
  filePaths: [join(root, action === 'apply' ? 'selected.sqlite3' : projectBackupSelections++ === 0 ? 'invalid.sqlite3' : 'project-backup.sqlite3')] });
dialog.showErrorBox = (_title, message) => {
  writeFileSync(result, JSON.stringify({ error: message, prompts }));
  app.exit(1);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
if (action === 'exit') app.once('will-quit', () => {
  assert.equal(prompts.length, 1);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  writeFileSync(result, JSON.stringify({ action, passed: true, prompts }));
});
async function until(f, label) {
  for (let n = 0; n < 150; n++) {
    if (await f()) return;
    await wait(50);
  }
  throw Error('Timed out at ' + label);
}
app.once('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    const run = js => window.webContents.executeJavaScript(js);
    const hasText = text => run('document.body.innerText.includes(' + JSON.stringify(text) + ')');
    const click = async selector => { assert.ok(await run('(()=>{const e=document.querySelector(' + JSON.stringify(selector) + '); if(!e)return false;e.click();return true})()'), selector); };
    try {
      if (action === 'projects') {
        await until(() => hasText('已使用默认主题和字号'), 'visible settings fallback');
        await click('[aria-label="夜跑随想"]');
        await until(() => hasText('导出此项目原始数据'), 'isolated project');
        await run("Array.from(document.querySelectorAll('button')).find(b=>b.innerText==='导出此项目原始数据').click()");
        await until(() => existsSync(output), 'native save result');
        const raw = readFileSync(output, 'utf8');
        assert.equal(JSON.parse(raw).projectId, 'publication-fixture');
        assert.ok(raw.includes('original-damaged-bytes'));
        assert.ok(!raw.includes('健康项目专属内容'));
        await click('[aria-label="另一个项目"]');
        await until(async () => !(await hasText('导出此项目原始数据')), 'switch to healthy project');
        await click('[aria-label="稿件与版本"]');
        await until(() => hasText('健康项目专属内容'), 'healthy manuscript');
        await click('[aria-label="夜跑随想"]');
        await until(() => hasText('从备份修复此项目'), 'single project repair');
        await run("Array.from(document.querySelectorAll('button')).find(b=>b.innerText==='从备份修复此项目').click()");
        await until(() => hasText('备份文件未通过检查'), 'actionable invalid-backup error');
        await run("Array.from(document.querySelectorAll('button')).find(b=>b.innerText==='从备份修复此项目').click()");
        await until(() => hasText('已从同版本备份修复本项目的记录'), 'successful repair result');
        await until(async () => !(await hasText('从备份修复此项目')), 'repaired project reopened');
        assert.equal(prompts.length, 0);
      } else if (action === 'apply') {
        await until(() => hasText('原有文章'), 'original workspace before restore');
        const outcome = await run("(async () => { const api=window.writingAgentDesktop; const p=await api.selectWorkspaceRestoreBackup(); return api.applyWorkspaceRestore(p.confirmationHash,p.confirmationPhrase) })()");
        assert.equal(outcome.restarting, true);
        assert.equal(outcome.restoredProjectCount, 1);
        writeFileSync(result, JSON.stringify({ action, passed: true, safetyBackupFileName: outcome.safetyBackupFileName }));
        app.exit(0);
        return;
      } else {
        const title = action === 'retry' ? '备份中的文章' : '原有文章';
        await until(() => hasText(title), 'chosen workspace');
        assert.equal(prompts.length, 1);
        if (action === 'prepare') assert.deepEqual(prompts[0], ['退出', '继续原工作区']);
        else assert.ok(prompts[0].includes('回退原工作区') && prompts[0].includes('重试恢复'));
      }
      writeFileSync(result, JSON.stringify({ action, passed: true, prompts }));
      app.quit();
    } catch (error) {
      writeFileSync(result, JSON.stringify({ error: error.message, prompts }));
      app.exit(1);
    }
  });
});
require(resolve(__dirname, '../../dist/package/main.cjs'));
