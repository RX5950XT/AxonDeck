'use strict'
/** 隔離打包版的真切頁／IPC／模型 owner；以可控制的譯文與模型載入代替推論。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir, removeTree } = require('./lib/test-temp')
const PORT = 9297, MAIN_PORT = 9298
const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const clients = []
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data), req = this.pending.get(message.id)
      if (!req) return
      this.pending.delete(message.id); clearTimeout(req.timer)
      if (message.error) req.reject(new Error(message.error.message))
      else req.resolve(message.result)
    }
    clients.push(this)
  }
  async eval(expression) {
    const id = ++this.id
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout')) }, 30000)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result?.value
  }
}
async function wait(read, label) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await sleep(50) }
  throw new Error(`timeout: ${label}`)
}
async function connect(port, matches) {
  const target = await wait(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(matches) } catch { return null }
  }, 'CDP target')
  const client = new Cdp(target.webSocketDebuggerUrl)
  await client.connect(); return client
}

async function main() {
  const dir = tempDir('translate-lifecycle-')
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, uffsAuto: false,
    dictationEnabled: false, agyEnabled: false, translator: 'local', localTranslateModel: 'linguaforge08q4' }))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  const child = spawn(EXE, [`--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${MAIN_PORT}`,
    '--hidden', '--disable-backgrounding-occluded-windows'], { env, detached: true, stdio: 'ignore' })
  try {
    const main = await connect(MAIN_PORT, target => target.type === 'node')
    const host = await connect(PORT, target => target.url.includes('host=1'))
    await wait(() => host.eval(`document.body?.dataset.mainPage === 'chat'`), 'initial page')
    await main.eval(`(() => {
      const e = process.mainModule.require('electron'), root = e.app.getAppPath()
      const llm = process.mainModule.require(root + '/src/main/local-llm.js')
      globalThis.__translateTest = { loaded: false, loads: 0, unloads: 0, calls: [] }
      llm.isLoaded = () => __translateTest.loaded
      llm.warm = async () => { __translateTest.loaded = true; __translateTest.loads++; return { warnings: [] } }
      llm.unload = async () => { __translateTest.loaded = false; __translateTest.unloads++; return { warnings: [] } }
      e.ipcMain._invokeHandlers.set('models:status', async () => ({ models: { linguaforge08q4: { downloaded: true, label: 'Test LLM' } } }))
      e.ipcMain._invokeHandlers.set('translate', (_event, input) => new Promise((resolve, reject) => __translateTest.calls.push({ input, resolve, reject })))
      e.BrowserWindow.getAllWindows().forEach(w => w.showInactive())
    })()`)
    const navigate = page => host.eval(`electronAPI.pages.navigate({page:${JSON.stringify(page)}})`)
    await navigate('translate')
    const page = await connect(PORT, target => target.url.includes('page=translate'))
    await wait(() => page.eval(`!!document.getElementById('translatePageModel')?.options.length && !document.getElementById('translateRunBtn').disabled`), 'translate ready')
    assert.equal(await page.eval('document.hidden'), false)
    const held = () => page.eval(`electronAPI.engine.status().then(s => s.users.translate && s.llmLoaded)`)
    async function start() {
      const offset = await main.eval('__translateTest.calls.length')
      await page.eval(`(() => { const input = document.getElementById('translateInput'); input.value = 'A sentence to translate.\\n'.repeat(220); input.dispatchEvent(new Event('input')); document.getElementById('translateRunBtn').click() })()`)
      await wait(() => main.eval(`__translateTest.calls.length > ${offset}`), 'first segment')
      return offset
    }
    async function complete(offset, firstPart = 1) {
      let count = 0
      for (let i = offset; i < offset + 12; i++) {
        await main.eval(`__translateTest.calls[${i}].resolve('驗收譯文${i - offset + firstPart}')`)
        count++
        await wait(async () => await main.eval(`__translateTest.calls.length > ${i + 1}`)
          || await page.eval(`document.getElementById('translateRunBtn').textContent === '翻譯'`), 'next segment or done')
        if (await page.eval(`document.getElementById('translateRunBtn').textContent === '翻譯'`)) return count
      }
      throw new Error('segments did not finish')
    }
    let offset = await start()
    assert.equal(await held(), true)
    const loads = await main.eval('__translateTest.loads')
    await navigate('settings')
    await wait(() => page.eval('document.hidden'), 'translate hidden')
    assert.equal(await held(), true, '切頁不得卸載工作中的模型')
    await main.eval(`__translateTest.calls[${offset}].resolve('驗收譯文1')`)
    await wait(() => main.eval(`__translateTest.calls.length > ${offset + 1}`), 'background second segment')
    await navigate('translate')
    assert.equal(await held(), true)
    assert.equal(await main.eval('__translateTest.loads'), loads, '切回不可重載')
    const parts = 1 + await complete(offset + 1, 2)
    assert.deepEqual((await page.eval(`document.getElementById('translateOutput').value`)).match(/驗收譯文\d+/g), Array.from({ length: parts }, (_, i) => `驗收譯文${i + 1}`))
    assert.equal(await held(), true, '仍在翻譯頁時維持待機預熱')
    console.log('PASS 真切頁後長文繼續、切回不重載、譯文保留')

    offset = await start()
    await navigate('settings')
    const count = await complete(offset)
    assert(count > 1)
    await wait(async () => !await held(), 'background completion releases model')
    assert((await page.eval(`document.getElementById('translateOutput').value`)).endsWith(`驗收譯文${count}`))
    assert.equal(await page.eval(`document.getElementById('translateOutputState').textContent`), '完成')
    console.log('PASS 背景完成全部分段後才卸載模型')

    await navigate('translate')
    await wait(() => held(), 'rewarm')
    offset = await start()
    await page.eval(`document.getElementById('translateRunBtn').click()`)
    await navigate('settings')
    await complete(offset)
    await wait(async () => !await held(), 'stopped job releases model')
    assert.equal(await main.eval('__translateTest.calls.length'), offset + 1)
    assert((await page.eval(`document.getElementById('translateOutputState').textContent`)).includes('已停止'))
    console.log('PASS 停止按鈕仍中止後續分段，當段結束後釋放')

    await navigate('translate')
    await wait(() => held(), 'rewarm after stop')
    offset = await start()
    await navigate('settings')
    await main.eval(`__translateTest.calls[${offset}].reject(new Error('test translation failed'))`)
    await wait(async () => !await held(), 'failed job releases model')
    assert.equal(await page.eval(`document.getElementById('translateError').classList.contains('hidden')`), false)
    console.log('PASS 背景失敗同樣釋放模型並保留錯誤提示')
    console.log('4 passed, 0 failed')
  } finally {
    for (const client of clients) client.ws.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    child.kill(); await sleep(1000); removeTree(dir)
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
