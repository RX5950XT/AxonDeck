'use strict'
// 隔離的真 OpenCode 2、真 ConPTY；匯入測試紀錄，不送 AI 請求。
// 使用者的背景服務佔著預設埠，這裡在隔離設定裡另指一個埠，結束時收掉。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { spawn, execFileSync } = require('node:child_process')
const { pathToFileURL } = require('node:url')
if (!process.versions.electron) {
  const child = spawn(path.join(__dirname, '../node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  })
  child.on('exit', code => { process.exitCode = code || 0 })
  child.on('error', error => { console.error(error); process.exitCode = 1 })
} else {
  const dir = require('./lib/test-temp').tempDir('opencode2-nav-')
  const exe = path.join(process.env.APPDATA, 'npm/node_modules/@opencode/cli/bin/opencode.exe')
  const PORT = 28995
  const COUNT = 300
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state'),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', AXONDECK_NAV_JUMP: path.join(dir, 'nav-jump.json') }
  for (const key of Object.keys(env)) if (/^OPENCODE_(?:CONFIG|CONFIG_DIR|CONFIG_CONTENT|CLI_CONFIG_CONTENT|TUI_CONFIG)$/.test(key) || /(?:API_KEY|AUTH_TOKEN)$/.test(key)) delete env[key]
  fs.mkdirSync(path.join(dir, 'config/opencode'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'config/opencode/service.json'), JSON.stringify({ port: PORT }))

  // 跟 host-runtime.js 的 stageRuntime 一樣擺：資料夾＋package.json 的 ./tui
  const nav = path.join(dir, 'runtime/opencode')
  fs.mkdirSync(nav, { recursive: true })
  fs.copyFileSync(path.join(__dirname, '../src/main/terminal/opencode/navigation.mjs'), path.join(nav, 'navigation.mjs'))
  fs.writeFileSync(path.join(nav, 'package.json'), JSON.stringify({ name: 'axondeck-navigation', version: '0.0.0', type: 'module', exports: { './tui': './navigation.mjs' } }))
  const telemetry = path.join(dir, 'telemetry.json')
  const probe = path.join(dir, 'probe')
  fs.mkdirSync(probe)
  fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({ name: 'axondeck-probe', version: '0.0.0', type: 'module', exports: { './tui': './tui.mjs' } }))
  fs.writeFileSync(path.join(probe, 'tui.mjs'), `import fs from 'node:fs'
const scan = n => ({ id: n.id, y: n.y, h: n.height, visible: n.visible, scrollTop: n.scrollTop, scrollHeight: n.scrollHeight,
  text: typeof n.plainText === 'string' && n.plainText.startsWith('AXON') ? n.plainText : undefined, children: (n.getChildren?.() || []).map(scan) })
export default { id: 'axondeck.probe', setup(ctx) {
  const timer = setInterval(() => fs.writeFileSync(${JSON.stringify(telemetry)}, JSON.stringify({ route: ctx.ui.router.current(), tree: scan(ctx.renderer.root) })), 100)
  return () => clearInterval(timer)
} }
`)
  // 使用者原本在 cli.json 的外掛：環境變數的清單會整份取代它，所以要接在前面（pty.js／shell.rs 的做法）
  const userPlugin = path.join(dir, 'user-plugin')
  const marker = path.join(dir, 'user-plugin-loaded')
  fs.mkdirSync(userPlugin)
  fs.writeFileSync(path.join(userPlugin, 'package.json'), JSON.stringify({ name: 'user-plugin', version: '0.0.0', type: 'module', exports: { './tui': './tui.mjs' } }))
  fs.writeFileSync(path.join(userPlugin, 'tui.mjs'), `import fs from 'node:fs'\nexport default { id: 'user.marker', setup() { fs.writeFileSync(${JSON.stringify(marker)}, 'ok') } }\n`)
  fs.writeFileSync(path.join(dir, 'config/opencode/cli.json'), JSON.stringify({ plugins: [userPlugin] }))
  env.OPENCODE_CLI_CONFIG_CONTENT = JSON.stringify({ plugins: [userPlugin, nav, pathToFileURL(probe).href] })

  const sessionID = 'ses_0123456789abcdefghijklmnop'
  const idOf = i => 'msg_' + String(i).padStart(26, '0')
  const messages = Array.from({ length: COUNT }, (_, i) => {
    const text = `NAV_${i}\n` + 'Saved conversation content.\n'.repeat(i === COUNT - 1 ? 80 : 5)
    return i % 2 === 0 ? { id: idOf(i), time: { created: 1700000000000 + i }, text, files: [], type: 'user' } : {
      id: idOf(i), time: { created: 1700000000000 + i, completed: 1700000000000 + i + 1 }, type: 'assistant', agent: 'build',
      model: { id: 'big-pickle', providerID: 'opencode' }, content: [{ type: 'text', text }], finish: 'stop', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
  })
  const fixture = path.join(dir, 'session.json')
  fs.writeFileSync(fixture, JSON.stringify({ info: { id: sessionID, projectID: 'global', cost: 0, outcome: 'succeeded', title: 'Navigation QA',
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1700000000000, updated: 1700000000000 + COUNT }, location: { directory: dir } }, messages }))

  // 背景服務會繼承輸出管線，同步呼叫就等不到結束：輸出一律導到檔案
  const run = args => {
    const log = path.join(dir, 'cmd.log'), fd = fs.openSync(log, 'w')
    try { execFileSync(exe, args, { cwd: dir, env, windowsHide: true, timeout: 90000, stdio: ['ignore', fd, fd] }) } finally { fs.closeSync(fd) }
    return fs.readFileSync(log, 'utf8')
  }
  let terminal
  const wait = ms => new Promise(r => setTimeout(r, ms))
  const read = () => { try { return JSON.parse(fs.readFileSync(telemetry, 'utf8')) } catch { return null } }
  const find = (node, predicate) => node && (predicate(node) ? node : node.children?.map(item => find(item, predicate)).find(Boolean))
  const transcript = state => find(state?.tree, n => n.scrollHeight > 0 && n.children?.some(c => String(c.id).startsWith('msg_')))
  async function until(predicate, label, ms = 30000) {
    const started = Date.now()
    while (Date.now() - started < ms) { const state = read(); if (state && predicate(state)) return state; await wait(100) }
    const view = transcript(read())
    const ids = (view?.children || []).map(c => c.id).filter(id => String(id).startsWith('msg_'))
    throw new Error(`${label}: top=${view?.scrollTop}/${view?.scrollHeight} rendered=${ids[0]}..${ids.at(-1)} (${ids.length})`)
  }
  async function jump(nonce, text, role, index) {
    fs.writeFileSync(env.AXONDECK_NAV_JUMP, JSON.stringify({ nonce, text, role, index, ok: null }))
    const started = Date.now()
    while (Date.now() - started < 7000) {
      let answer
      try { answer = JSON.parse(fs.readFileSync(env.AXONDECK_NAV_JUMP, 'utf8')) } catch { answer = null }
      if (answer?.nonce === nonce && answer.ok != null) return answer.ok
      await wait(80)
    }
    return null
  }
  const landedOn = (i) => until(s => {
    const view = transcript(s), hit = find(s.tree, n => n.id === idOf(i))
    return view && hit && hit.y >= view.y - 1 && hit.y <= view.y + 8
  }, `停在第 ${i} 則`, 5000)
  ;(async () => {
    console.log('service', run(['service', 'start']).trim())
    assert.match(run(['session', 'import', fixture]), /Imported session/)
    terminal = require('@lydell/node-pty').spawn(exe, ['--session', sessionID], { cwd: dir, env, cols: 120, rows: 40, name: 'xterm-256color' })
    terminal.onData(data => { if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R') })
    const state = await until(s => find(s.tree, n => n.id === 'axondeck-scroll' && n.visible && n.h > 10), '外掛載入')
    assert(transcript(state), '找得到對話區')
    assert.equal(fs.existsSync(marker), true, '使用者 cli.json 的外掛照樣載入')
    terminal.write('AXON_UNSENT_DRAFT')
    await until(s => find(s.tree, n => n.text === 'AXON_UNSENT_DRAFT'), '輸入草稿')
    for (const [nonce, text, role, index, target] of [
      ['first', 'NAV_0', 'prompt', 0, 0],
      ['middle', 'NAV_151', 'answer', 0, 151],
      ['early', 'NAV_40', 'prompt', 0, 40],
      ['last', `NAV_${COUNT - 1}`, 'answer', 0, COUNT - 1],
    ]) {
      const started = Date.now()
      assert.equal(await jump(nonce, text, role, index), true, `${text} 跳轉檔被外掛接走且回報成功`)
      await landedOn(target)
      const ms = Date.now() - started
      await wait(800)
      await landedOn(target)
      console.log(`PASS 跳到 ${text} 並停住（${ms}ms）`)
    }
    await until(s => find(s.tree, n => n.text === 'AXON_UNSENT_DRAFT'), '跳轉不清除草稿', 3000)
    terminal.write('_MORE')
    await until(s => find(s.tree, n => n.text === 'AXON_UNSENT_DRAFT_MORE'), '跳轉後同一 CLI 仍可輸入', 5000)
    assert.equal(await jump('missing', 'NOT_THERE', 'prompt', 0), false, '不存在的訊息回報失敗')
    const view = transcript(read())
    assert(view.scrollTop < Math.max(0, view.scrollHeight - 31) + 1, '捲動位置有效')
    console.log('PASS OpenCode 2 真 CLI：載入舊訊息後跳轉（第一則／中段／最後一則）、找不到回報失敗、使用者外掛不被蓋掉')
  })().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
    if (terminal) { try { execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} terminal.kill() }
    try { run(['service', 'stop']) } catch {}
  })
}
