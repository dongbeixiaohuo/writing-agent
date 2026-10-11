// Hidden, isolated Electron test. It never opens the production app or user data.
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');

app.setPath('userData', join(process.argv[3], 'user-data'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
let errorCode = 'EXPORT_WRITING_ACTIVE';
const timeout = setTimeout(() => app.exit(2), 15000);
ipcMain.handle('writing-agent:bridge:v7', () => errorCode === null
  ? { ok: true, result: { cancelled: true } }
  : { ok: false, error: { code: errorCode, message: '安全的公开说明' } });

app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: process.argv[2], contextIsolation: true, sandbox: true,
    nodeIntegration: false, webSecurity: true,
  } });
  await window.loadURL('data:text/html,<title>Publication bridge test</title>');
  for (errorCode of ['EXPORT_WRITING_ACTIVE', 'FACT_GATE_NOT_PASSED', 'EXPORT_SELECTION_CHANGED', 'EXPORT_SAVE_FAILED']) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      try {
        await window.writingAgentDesktop.savePublicationAs({projectId:'p',bodyVersionId:'b',format:'html',layoutPreset:'editorial'});
        return {unexpectedSuccess:true};
      } catch (error) { return {message:error.message,code:error.code}; }
    })()`);
    assert.equal(result.message, errorCode);
    assert.equal(result.code, undefined);
  }
  errorCode = 'EXPORT_RECEIPT_NOT_FOUND';
  const reveal = await window.webContents.executeJavaScript(`(async () => {
    try { await window.writingAgentDesktop.revealPublication('missing'); }
    catch (error) { return {message:error.message,code:error.code}; }
  })()`);
  assert.equal(reveal.message, errorCode);
  assert.equal(reveal.code, undefined);
  errorCode = null;
  const cancelled = await window.webContents.executeJavaScript(
    `window.writingAgentDesktop.savePublicationAs({projectId:'p',bodyVersionId:'b',format:'html',layoutPreset:'clean'})`);
  assert.deepEqual(cancelled, { cancelled: true });
  console.log('PUBLICATION_CONTEXT_BRIDGE_PASS');
  clearTimeout(timeout);
  window.destroy();
  app.exit(0);
}).catch(error => {
  console.error(error);
  clearTimeout(timeout);
  app.exit(1);
});
