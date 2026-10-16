'use strict'
/** 隔離打包版：量新增終端機與專案切換，不送 AI 提問、不碰正式設定。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir, removeTree } = require('./lib/test-temp')

const EXE = process.env.AXONDECK_EXE || path.join(__dirname, '../dist/win-unpacked/AxonDeck.exe')
const PORT = 9269, MAIN_PORT = 9270
const paint = process.argv.includes('--paint')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
class Cdp {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map() }
  async connect() {
    this.ws = new WebSocket(this.url)
    await new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject })
    this.ws.onmessage = event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    }
  }
  async eval(expression) {
    const id = ++this.seq
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout')) }, 90000)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }))
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
    return response.result?.value
  }
  close() { this.ws?.close() }
}
async function connect(port, matches) {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json())
      const target = list.find(matches)
      if (target) { const client = new Cdp(target.webSocketDebuggerUrl); await client.connect(); return client }
    } catch { /* 啟動中 */ }
    await sleep(100)
  }
  throw new Error(`No CDP target on ${port}`)
}
async function main() {
  const dir = tempDir('workspace-latency-'), ids = [], clients = []
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ sysmonSensors: false, uffsAuto: false, agyEnabled: false, dictationEnabled: false }))
  // 同一份真實 AI 紀錄作唯讀掃描；只有隔離的終端機與分頁狀態會寫入。
  fs.mkdirSync(path.join(dir, 'project-b'))
  const projects = ['a', 'b'].map(id => ({ id: `w_latency_${id}`, name: `Latency ${id}`, path: id === 'a' ? path.resolve(__dirname, '..') : path.join(dir, 'project-b'), createdAt: Date.now() }))
  fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ projects }))
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key]
  const child = spawn(EXE, [`--user-data-dir=${dir}`, `--remote-debugging-port=${PORT}`, `--inspect=127.0.0.1:${MAIN_PORT}`, '--hidden', '--disable-backgrounding-occluded-windows'], { env, detached: true, stdio: 'ignore' })
  let cdp
  try {
    const main = await connect(MAIN_PORT, target => target.type === 'node'); clients.push(main)
    cdp = await connect(PORT, target => /index\.html.*[?&]page=chat/.test(target.url)); clients.push(cdp)
    if (paint) await main.eval(`process.mainModule.require('electron').BrowserWindow.getAllWindows().forEach(w => w.showInactive())`)
    await cdp.eval(`(async () => {
      while (!document.querySelector('#projList [data-id="w_latency_a"] .chat-list-open')) await new Promise(resolve => setTimeout(resolve, 50))
      globalThis.__latencyTabs = await import('./scripts/ws-tabs.js')
      globalThis.__latencyTerminal = await import('./scripts/terminal-page.js')
      const { Terminal } = await import('../../node_modules/@xterm/xterm/lib/xterm.mjs')
      const { WebglAddon } = await import('../../node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs')
      globalThis.__latencyGraphics = []
      globalThis.__latencyRenderers = new Set()
      for (const name of ['activate', 'dispose']) {
        const original = WebglAddon.prototype[name]
        WebglAddon.prototype[name] = function(...args) {
          const start = performance.now()
          try { return original.apply(this, args) } finally {
            if (name === 'activate') __latencyRenderers.add(this)
            else __latencyRenderers.delete(this)
            __latencyGraphics.push({ name, ms: Math.round(performance.now() - start) })
          }
        }
      }
      const open = Terminal.prototype.open
      globalThis.__latencyTerms = new Map()
      Terminal.prototype.open = function(el) { __latencyTerms.set(el.dataset.id, this); return open.call(this, el) }
    })()`)
    await main.eval(`(() => {
      const root = process.mainModule.require('electron').app.getAppPath()
      globalThis.__latency = []
      for (const [file, methods] of [['terminal/service', ['listSessions', 'openSession', 'createSession', 'conversation']], ['workspace/agents', ['sessions', 'resume']], ['terminal/agent-processes', ['identifySessions']]]) {
        const mod = process.mainModule.require(root + '/src/main/' + file + '.js')
        for (const name of methods) { const original = mod[name]; mod[name] = async function(...args) {
          const start = performance.now()
          try { return await original.apply(this, args) } finally { __latency.push({ name, ms: Math.round(performance.now() - start) }) }
        } }
      }
    })()`)
    const samples = []
    async function measure(label, expression) {
      const result = await cdp.eval(`(async () => { const start = performance.now(); ${expression}; ${paint ? 'await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));' : ''} return Math.round(performance.now() - start) })()`)
      samples.push({ label, ms: result }); console.log(JSON.stringify(samples.at(-1)))
    }
    await measure('select-empty', `await __latencyTabs.setActiveProject(${JSON.stringify(projects[0])})`)
    for (const preset of paint ? ['shell'] : ['shell', 'codex']) {
      const created = await cdp.eval(`window.electronAPI.terminal.create({preset:${JSON.stringify(preset)}, cwd:${JSON.stringify(projects[0].path)}, projectId:'w_latency_a'})`)
      assert.equal(created.ok, true); ids.push(created.data.id)
      await measure(`new-${preset}`, `await __latencyTerminal.openTerminalSession(${JSON.stringify(created.data.id)})`)
      if (preset === 'shell') await cdp.eval(`(async () => {
        await electronAPI.terminal.write(${JSON.stringify(created.data.id)}, 'echo AXON_LATENCY_READY\\r')
        const term = __latencyTerms.get(${JSON.stringify(created.data.id)}), deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          if (Array.from({length:term.buffer.active.length}, (_, i) => term.buffer.active.getLine(i)?.translateToString(true)).some(line => line.trim() === 'AXON_LATENCY_READY')) return
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        throw new Error('PTY output missing')
      })()`)
    }
    const other = await cdp.eval(`window.electronAPI.terminal.create({preset:'shell', cwd:${JSON.stringify(projects[1].path)}, projectId:'w_latency_b'})`)
    assert.equal(other.ok, true); ids.push(other.data.id)
    const saved = await cdp.eval(`window.electronAPI.workspace.saveTabsState('w_latency_b', {activeId:${JSON.stringify(other.data.id)}, tabs:[{id:${JSON.stringify(other.data.id)}, kind:'terminal', title:'other'}]})`)
    assert.equal(saved.ok, true)
    for (let i = 0; i < 3; i++) {
      await measure(`switch-b-${i}`, `await __latencyTabs.setActiveProject(${JSON.stringify(projects[1])})`)
      assert.equal(await cdp.eval(`document.querySelector('#wsTabStrip .ws-tab.is-active')?.dataset.id`), other.data.id)
      await measure(`switch-a-${i}`, `await __latencyTabs.setActiveProject(${JSON.stringify(projects[0])})`)
      const active = await cdp.eval(`__latencyTabs.currentProjectId()`)
      assert.equal(active, 'w_latency_a')
    }
    if (paint) {
      assert.equal(await cdp.eval('document.hidden'), false, '必須在真正顯示的視窗量測')
      await cdp.eval(`new Promise(resolve => __latencyTerms.get(${JSON.stringify(ids[0])}).write(('歷史輸出'.repeat(20) + '\\r\\n').repeat(2000) + 'LATENCY_HISTORY_END\\r\\n', resolve))`)
      await cdp.eval('__latencyGraphics.length = 0')
      for (let i = 0; i < 4; i++) {
        await measure(`visible-switch-b-${i}`, `document.querySelector('#projList [data-id="w_latency_b"] .chat-list-open').click(); while (__latencyTabs.currentProjectId() !== 'w_latency_b' || !document.querySelector('.term-pane[data-id="${other.data.id}"].is-active')) await new Promise(r => setTimeout(r, 10))`)
        await measure(`visible-switch-a-${i}`, `document.querySelector('#projList [data-id="w_latency_a"] .chat-list-open').click(); while (__latencyTabs.currentProjectId() !== 'w_latency_a' || !document.querySelector('.term-pane[data-id="${ids[0]}"].is-active')) await new Promise(r => setTimeout(r, 10))`)
      }
      for (let i = 0; i < 8; i++) {
        await measure(`visible-new-shell-${i}`, `await __latencyTabs.newShellTerminal()`)
        const result = await cdp.eval('electronAPI.terminal.list()')
        ids.push(...result.data.map(item => item.id).filter(id => !ids.includes(id)))
        assert(await cdp.eval('__latencyRenderers.size <= 8'), '實際 WebGL 畫布不得超過 8 個')
      }
      await cdp.eval(`(async () => { for (const id of ${JSON.stringify([ids[0]])}) await __latencyTerminal.toggleTerminalSplit(id) })()`)
      await cdp.eval(`__latencyTerminal.toggleTerminalSplit(${JSON.stringify(ids[2])})`)
      assert.equal(await cdp.eval(`document.querySelectorAll('.term-pane.is-active').length`), 3, '真實三格並排')
      assert(await cdp.eval('__latencyRenderers.size <= 8'), '並排後實際 WebGL 仍有上限')
      assert(await cdp.eval(`__latencyTerms.get(${JSON.stringify(ids[0])}).buffer.active.length > 2000`), '歷史畫面仍在')
      console.log('GRAPHICS visible', JSON.stringify(await cdp.eval('__latencyGraphics')))
      fs.writeFileSync(path.resolve(__dirname, '../dist/workspace-paint-bench.json'), JSON.stringify(samples, null, 2))
    }
    console.log('MAIN', JSON.stringify(await main.eval('__latency')))
    console.log('PASS: new terminals and repeated project isolation')
  } finally {
    if (cdp) for (const id of ids) await cdp.eval(`window.electronAPI.terminal.delete(${JSON.stringify(id)})`).catch(() => {})
    for (const client of clients) client.close()
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* 已結束 */ }
    child.kill()
    removeTree(dir, { retries: 5 })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
