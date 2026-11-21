const assert = require('node:assert/strict')
const { BrowserWindow, app, ipcMain, dialog } = require('electron')
const { writeFileSync, readFileSync } = require('node:fs')
const { join } = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const phase = process.env.WA_REQUEST_PHASE
const id = process.env.WRITING_AGENT_DESKTOP_TEST
if (!/^requests-[\da-f-]{36}$/.test(id) || !['lost', 'reopened', 'partial-lost', 'partial-reopened', 'cancel'].includes(phase)) throw Error('Isolated test profile required')
const loseWindow = phase === 'lost' || phase === 'partial-lost'
const root = join(app.getPath('temp'), 'writing-agent-desktop-test-' + id)
const resultPath = join(root, phase + '.json')
const seen = { commands: [], modelRequests: 0 }
function gate() { let release; const wait = new Promise(r => { release = r }); return { wait, release } }
const oldProvider = gate(), nextProvider = gate()
const first = '合成测试的第一条输入', second = '同一项目里的第二条输入'
const zombie = '绝不可出现的旧请求尾巴'
const caps = { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }
globalThis.fixtureProvider = { id: 'local-fake', adapterVersion: '1', capabilities: caps, capabilitiesFor: () => caps,
  snapshotRequest(request) { return { normalizedPayload: { model: request.model, messages: request.messages }, serializationVersion: 'fixture-v1', redactions: [], unreconstructableFields: [] } },
  async *stream(request) {
    const n = ++seen.modelRequests
    if (phase !== 'cancel') { await oldProvider.wait; return }
    if (n === 1) {
      await oldProvider.wait // Intentionally ignore AbortSignal, then yield late text and fail.
      seen.oldProviderReleased = true
      yield { type: 'text_delta', sequence: 1, delta: zombie }
      throw Error('synthetic late failure')
    }
    await nextProvider.wait
    const tool = request.tools?.some(t => t.name === 'interpret_author_reply') ? 'interpret_author_reply' : 'respond_writing_intake'
    const args = tool === 'interpret_author_reply' ? { intent: 'discuss', selectionIndex: null, reason: 'synthetic' }
      : { reply: '新任务独立完成', summary: '新任务主题', questions: [] }
    yield { type: 'tool_call_complete', sequence: 1, index: 0,
      call: { id: request.requestId, name: tool, rawArguments: JSON.stringify(args), arguments: args } }
    yield { type: 'completed', sequence: 2, provider: 'local-fake', model: request.model, adapterVersion: '1', finishReason: 'tool_calls' }
  } }
app.disableHardwareAcceleration()
BrowserWindow.prototype.show = function () {}
dialog.showErrorBox = (_title, error) => { writeFileSync(resultPath, JSON.stringify({ ...seen, error })); app.exit(1) }
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => handle(channel, async (event, request) => {
  const answer = await listener(event, request)
  if (['startConversation', 'sendMessage', 'cancelRun'].includes(request?.method)) {
    seen.commands.push({ method: request.method, ok: answer.ok, run: answer.result?.runId, error: answer.error?.code,
      operation: request.args[1]?.operationId })
    if (loseWindow && request.method === 'startConversation') return new Promise(() => {}) // Lose the reply after commit.
  }
  return answer
})
const pause = ms => new Promise(r => setTimeout(r, ms))
async function until(check, label) {
  for (let i = 0; i < 180; i++) { if (await check()) return; await pause(25) }
  throw Error('Timed out at ' + label)
}
app.once('browser-window-created', (_e, window) => window.webContents.once('did-finish-load', async () => {
  let db
  const run = js => window.webContents.executeJavaScript(js)
  const click = label => run(`document.querySelector('[aria-label="'+${JSON.stringify(label)}+'"]').click()`)
  const editor = 'document.querySelector(\'[aria-label="写作指令"]\')'
  const type = value => run(`(()=>{const e=${editor};e.focus();e.textContent=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText'}));})()`)
  const submit = async value => { await until(() => run(editor+'?.isContentEditable'), 'editable'); await type(value)
    await until(() => run('document.querySelector(\'[aria-label="发送"]\')?.disabled === false'), 'send enabled'); await click('发送') }
  try {
    await until(() => run('document.body.innerText.includes("本地保存已就绪")'), 'handshake')
    db = new DatabaseSync(join(root, 'workspace/.writing-agent/workspace.sqlite3'), { readOnly: !phase.startsWith('partial-') })
    const projects = () => db.prepare('SELECT id FROM projects ORDER BY id').all().map(row => row.id)
    const runs = () => db.prepare('SELECT id, status, project_id FROM runs ORDER BY rowid').all()
    if (phase === 'lost') {
      await submit(first)
      await until(() => seen.commands.some(c => c.method === 'startConversation' && c.ok) && seen.modelRequests === 1, 'committed but unacknowledged')
      seen.projects = projects(); seen.runCount = runs().length
      assert.equal(seen.projects.length, 1)
    } else if (phase === 'partial-lost') {
      db.exec("CREATE TRIGGER fixture_before_run BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'fixture: before first run'); END")
      await submit(first)
      await until(() => seen.commands.some(c => c.method === 'startConversation'), 'project saved before failed run')
      seen.projects = projects(); seen.runCount = runs().length
      assert.equal(seen.projects.length, 1)
      assert.equal(seen.runCount, 0)
      assert.equal(seen.modelRequests, 0)
    } else if (phase === 'partial-reopened') {
      db.exec('DROP TRIGGER fixture_before_run')
      const original = JSON.parse(readFileSync(join(root, 'partial-lost.json')))
      assert.deepEqual(projects(), original.projects)
      await click('新建项目')
      await until(() => run('document.body.innerText.includes("已找回上次保存的项目")'), 'partial receipt')
      await until(() => run(editor + '?.textContent === ' + JSON.stringify(first)), 'draft moved into recovered project')
      seen.recoveredDraft = await run(editor + '.textContent')
      assert.deepEqual(runs(), [])
      assert.equal(seen.modelRequests, 0)
      await click('发送')
      await until(() => seen.modelRequests === 1, 'author continues recovered project')
      seen.projects = projects(); seen.runCount = runs().length
      assert.deepEqual(seen.projects, original.projects)
      assert.equal(seen.runCount, 1)
    } else if (phase === 'reopened') {
      const original = JSON.parse(readFileSync(join(root, 'lost.json')))
      assert.deepEqual(projects(), original.projects)
      await click('新建项目')
      // On RC102 this reopens a fresh editor; on the fix it reconciles the original creation.
      await until(() => run(`!!document.querySelector('[aria-label="新建回执"]') || document.body.innerText.includes('今天，写点什么')`), 'reconcile or new composer')
      if (!await run('document.body.innerText.includes("重复提交已拦截")')) {
        await type(first)
        await until(() => run(`document.body.innerText.includes('重复提交已拦截') || document.querySelector('[aria-label="发送"]')?.disabled === false`), 'receipt or send')
        if (!await run('document.body.innerText.includes("重复提交已拦截")')) await click('发送')
        await until(async () => projects().length > 1 || await run('document.body.innerText.includes("重复提交已拦截")'), 'observed reconciliation or duplicate')
      }
      seen.reconciled = await run('document.body.innerText.includes("重复提交已拦截")')
      seen.projects = projects(); seen.totalRuns = runs().length; seen.totalModelRequests = original.modelRequests + seen.modelRequests
      assert.deepEqual(seen.projects, original.projects, 'reopening and clicking New must reuse the persisted project')
      assert.equal(seen.totalModelRequests, 1)
      assert.equal(seen.reconciled, true)
      // A separate explicit intention, even with identical text, should be allowed.
      await run("[...document.querySelectorAll('button')].find(b=>b.innerText==='另起一篇').click()")
      await until(() => run("document.body.innerText.includes('今天，写点什么') && !document.querySelector('[aria-label=\"新建回执\"]')"), 'explicit new composer')
      await submit(first)
      await until(() => projects().length === 2 && seen.modelRequests === 1, 'intentional new project')
      seen.afterDeliberateNew = projects().length
    } else {
      await submit(first)
      await until(() => seen.modelRequests === 1 && seen.commands.some(c => c.run), 'old request ignoring abort')
      await click('停止生成')
      await until(() => seen.commands.some(c => c.method === 'cancelRun' && c.ok), 'local cancellation')
      await submit(second)
      await until(() => seen.commands.some(c => c.method === 'sendMessage'), 'next send returned')
      const sent = seen.commands.find(c => c.method === 'sendMessage')
      seen.beforeOldReleased = runs()
      assert.equal(sent.ok, true, 'same-project send must succeed while old provider remains suspended')
      await until(() => seen.modelRequests >= 2, 'new request started before old provider allowed to return')
      oldProvider.release()
      await until(() => seen.oldProviderReleased, 'late old stream')
      nextProvider.release()
      await until(() => runs().find(r => r.id === sent.run)?.status === 'completed', 'new task completed')
      seen.afterLateResult = runs()
      assert.equal(seen.afterLateResult[0].status, 'cancelled')
      assert.equal(seen.afterLateResult.length, 2)
      assert.equal(seen.afterLateResult[0].project_id, seen.afterLateResult[1].project_id)
      const records = db.prepare('SELECT payload_json FROM events').all()
      assert.ok(!JSON.stringify(records).includes(zombie))
      assert.equal(await run('document.body.innerText.includes('+JSON.stringify(zombie)+')'), false)
    }
    writeFileSync(resultPath, JSON.stringify(seen))
    db.close()
    if (loseWindow) process.kill(process.pid, 'SIGKILL')
    app.quit()
  } catch (error) {
    seen.error = error.message; seen.display = await run('document.body.innerText.slice(-700)').catch(() => '')
    writeFileSync(resultPath, JSON.stringify(seen)); db?.close(); app.exit(1)
  }
}))
require(process.env.WA_NATIVE_MAIN)
