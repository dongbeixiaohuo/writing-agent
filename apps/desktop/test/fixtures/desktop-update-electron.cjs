const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const id = process.env.WRITING_AGENT_DESKTOP_TEST;
if (!/^update-[a-f0-9]{32}$/.test(id ?? '')) throw new Error('Isolated desktop update ID required');
const directory = join(app.getPath('temp'), `writing-agent-desktop-test-${id}`);
const { DesktopUpdate, UPDATE_INTERVAL_MS } = require(join(directory, 'update.cjs'));
const launch = process.env.WA_UPDATE_TEST_LAUNCH;
const draft = '更新之前还没发出的新主题';
const stateChannel = 'writing-agent:desktop-update-state';
let now = 0;
let published = false;
let busy = true;
let allowedWillQuit = false;
let installRequests = 0;
let downloads = 0;
let checks = 0;
let window;
const version = '1.0.0-rc.9999';
const asset = name => ({ name, state: 'uploaded', size: 16 });
const fakeRelease = { tag_name: `desktop-v${version}`, draft: false, published_at: '2026-11-26', assets: [
  asset(`Writing-Agent-Setup-${version}-x64.exe`), asset('SHA256SUMS.txt'), asset('latest.yml'),
] };

const update = new DesktopUpdate({
  version: '1.0.0-rc.116', canInstallInApp: true, now: () => now,
  async listReleases() { checks++; return published ? [fakeRelease] : []; },
  async download(_release, progress) { downloads++; progress(37); await wait(300); return 'verified-fixture'; },
  safeToRestart: () => !busy,
  async install(path) {
    assert.equal(path, 'verified-fixture');
    allowedWillQuit = true;
    window.webContents.session.flushStorageData();
    writeFileSync(join(directory, 'installed.json'), JSON.stringify({ downloads, checks, installRequests }));
    app.quit();
  },
  openRelease: async () => assert.fail('should handle fixture update in app'),
  publish: state => window.webContents.send(stateChannel, state),
  logFailure: (_operation, error) => assert.fail(String(error)),
});

const original = ipcMain.handle.bind(ipcMain);
function patchSnapshot(value) {
  if (value?.workspaceId && value.settings) value.settings.credentialReference = 'test-no-network';
  return value;
}
ipcMain.handle = (channel, handler) => original(channel, async (event, action) => {
  if (channel === 'writing-agent:desktop-update' && launch === 'upgrade') {
    if (action === 'install') installRequests++;
    return update.request(action);
  }
  const response = await handler(event, action);
  patchSnapshot(response?.snapshot);
  patchSnapshot(response?.result);
  return response;
});
app.disableHardwareAcceleration();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await wait(50); }
  throw Error(`Timed out waiting for ${label}`);
}

app.once('browser-window-created', (_event, browserWindow) => {
  window = browserWindow;
  const send = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, ...args) => send(channel, ...args.map(patchSnapshot));
  window.webContents.once('did-finish-load', async () => {
    const js = code => window.webContents.executeJavaScript(code);
    const bodyIncludes = text => js(`document.body.innerText.includes(${JSON.stringify(text)})`);
    const click = text => js(`(() => {
      const button = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)});
      if (!button) throw new Error('Button missing'); button.click();
    })()`);
    const composer = '[aria-label="写作指令"]';
    const type = text => js(`(() => {
      const input = document.querySelector(${JSON.stringify(composer)});
      input.focus(); input.textContent = ${JSON.stringify(text)};
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
    })()`);
    try {
      // Select the same real, pre-seeded conversation on both launches.
      await until(() => js(`!!document.querySelector('[aria-label="夜跑随想"]')`), 'saved project');
      await js(`document.querySelector('[aria-label="夜跑随想"]').click()`);
      await until(() => js(`document.querySelector(${JSON.stringify(composer)})?.isContentEditable`), 'composer');
      if (launch === 'reopen') {
        assert.equal(await js(`document.querySelector(${JSON.stringify(composer)}).textContent`), draft);
        writeFileSync(join(directory, 'reopened.json'), JSON.stringify({ project: '夜跑随想', draftRestored: true }));
        app.quit();
        return;
      }

      await update.check();
      assert.equal(await bodyIncludes('发现新版本'), false);
      published = true;
      now += UPDATE_INTERVAL_MS;
      await update.check();
      await until(() => bodyIncludes(`发现新版本 ${version}`), 'proactive update on already open window');
      await click('稍后');
      await until(async () => !await bodyIncludes('发现新版本'), 'dismissed banner');
      now += UPDATE_INTERVAL_MS;
      await update.check();
      assert.equal(await bodyIncludes('发现新版本'), false);
      await click('设置');
      await click('关于');
      await until(() => bodyIncludes(`发现新版本 ${version}`), 'same update still available in About');
      await js(`(() => {
        window.savedSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = () => { throw new Error('fixture quota failure'); };
      })()`);
      // Type on the real UI before launching the download, with simulated localStorage failure.
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));`);
      await until(async () => !await bodyIncludes('发现新版本'), 'closed About');
      await type(draft + '（暂存失败）');
      await until(() => bodyIncludes('草稿保存失败'), 'draft remains in failed local save state');
      await click('设置');
      await click('关于');
      await click('立即更新');
      await until(() => js(`document.querySelector('progress[aria-label="更新下载进度"]')?.value === 37`), 'download progress');
      await until(() => bodyIncludes('已下载'), 'verified update waits to install');
      await wait(250);
      assert.equal(installRequests, 0, 'an in-memory draft blocks even the install request');
      await js(`Storage.prototype.setItem = window.savedSetItem; document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));`);
      await type(draft);
      await until(() => installRequests > 0, 'retry after draft persisted');
      assert.equal(allowedWillQuit, false, 'busy writer blocks installer after draft is saved');
      busy = false;
      // The next readiness check will grant installation without a second button click.
    } catch (error) {
      const visibleText = await js('document.body.innerText.slice(-1400)').catch(() => 'renderer text unavailable');
      writeFileSync(join(directory, 'failure.txt'), `${error.stack ?? error}\n${visibleText}`);
      app.exit(1);
    }
  });
});
require(join(process.env.WA_UPDATE_TEST_STAGE, 'main.cjs'));
