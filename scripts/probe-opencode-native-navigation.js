'use strict'
// 隔離的真 OpenCode、真 ConPTY；匯入測試紀錄，不送 AI 請求。
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
  const dir = require('./lib/test-temp').tempDir('opencode-nav-')
  const exe = path.join(process.env.APPDATA, 'npm/node_modules/opencode-ai/bin/opencode.exe')
  const env = { ...process.env, HOME: dir, USERPROFILE: dir, APPDATA: path.join(dir, 'roaming'), LOCALAPPDATA: path.join(dir, 'local'),
    XDG_CONFIG_HOME: path.join(dir, 'config'), XDG_DATA_HOME: path.join(dir, 'data'), XDG_CACHE_HOME: path.join(dir, 'cache'), XDG_STATE_HOME: path.join(dir, 'state'),
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_TUI_CONFIG: path.join(dir, 'tui.json'),
    AXONDECK_NAV_JUMP: path.join(dir, 'nav-jump.json') }
  for (const key of Object.keys(env)) if (/^(?:OPENCODE_CONFIG|OPENCODE_CONFIG_DIR|OPENCODE_CONFIG_CONTENT)$/.test(key) || /(?:API_KEY|AUTH_TOKEN)$/.test(key)) delete env[key]
  const sessionID = 'ses_0123456789abcdefghijklmnop'
  const messages = Array.from({ length: 40 }, (_, i) => {
    const id = 'msg_' + String(i).padStart(25, '0')
    const common = { id, sessionID, time: { created: 1700000000000 + i }, agent: 'build' }
    const info = i % 2 === 0 ? { ...common, role: 'user', model: { providerID: 'opencode', modelID: 'big-pickle' } } : {
      ...common, role: 'assistant', time: { ...common.time, completed: 1700000000000 + i + 1 }, parentID: 'msg_' + String(i - 1).padStart(25, '0'),
      modelID: 'big-pickle', providerID: 'opencode', mode: 'build', path: { cwd: dir, root: dir }, cost: 0, finish: 'stop',
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    }
    const lines = i === 39 ? 80 : 5
    return { info, parts: [{ id: 'prt_' + String(i).padStart(25, '0'), messageID: id, sessionID, type: 'text', text: `NAV_${i}\n` + ('Saved conversation content.\n'.repeat(lines)) }] }
  })
  const fixture = path.join(dir, 'session.json')
  fs.writeFileSync(fixture, JSON.stringify({ info: { id: sessionID, slug: 'navigation-test', projectID: 'global', directory: dir, title: 'Navigation QA', version: '1.18.35', time: { created: 1700000000000, updated: 1700000000040 } }, messages }))
  const telemetry = path.join(dir, 'telemetry.json')
  const plugin = pathToFileURL(path.resolve(__dirname, '../src/main/terminal/opencode/navigation.mjs')).href
  fs.writeFileSync(path.join(dir, 'probe.mjs'), `import fs from 'node:fs'; import {tui as install} from ${JSON.stringify(plugin)};
export const id='axondeck-probe'; export default {id,tui}; export async function tui(api){
await install(api);
const scan=n=>({id:n.id,x:n.x,y:n.y,w:n.width,h:n.height,visible:n.visible,plainText:n.plainText,content:typeof n.content==='string'?n.content:undefined,scrollTop:n.scrollTop,scrollHeight:n.scrollHeight,bar:n.verticalScrollBar?{x:n.verticalScrollBar.x,y:n.verticalScrollBar.y,w:n.verticalScrollBar.width,h:n.verticalScrollBar.height,visible:n.verticalScrollBar.visible}:undefined,children:n.getChildren().map(scan)});
const timer=setInterval(()=>fs.writeFileSync(${JSON.stringify(telemetry)},JSON.stringify({route:api.route.current,tree:scan(api.renderer.root)})),100);
api.lifecycle.onDispose(()=>{ clearInterval(timer) }); }`)
  fs.writeFileSync(env.OPENCODE_TUI_CONFIG, JSON.stringify({ plugin: [pathToFileURL(path.join(dir, 'probe.mjs')).href] }))
  let terminal
  const wait = ms => new Promise(r => setTimeout(r, ms))
  let output = ''
  const read = () => { try { return JSON.parse(fs.readFileSync(telemetry, 'utf8')) } catch { return null } }
  const find = (node, predicate) => node && (predicate(node) ? node : node.children?.map(item => find(item, predicate)).find(Boolean))
  async function until(predicate, label) {
    const started = Date.now()
    while (Date.now() - started < 30000) { const state = read(); if (state && predicate(state)) return state; await wait(100) }
    const logs = fs.readdirSync(dir, { recursive: true }).filter(file => file.endsWith('.log'))
      .flatMap(file => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter(line => /plugin|error/i.test(line)))
    const scroll = find(read()?.tree, n => n.scrollHeight > (n.h || 0) + 5 && n.bar)
    const head = node => {
      const own = node?.plainText || node?.content || ''
      if (own) return String(own).replace(/\s+/g, ' ').slice(0, 36)
      return (node?.children || []).map(head).find(Boolean) || ''
    }
    const kids = (scroll?.children || []).slice(-8).map(node => `${node.id}@${node.y}/${node.h}:${head(node)}`)
    const outline = JSON.stringify({ top: scroll?.scrollTop, sh: scroll?.scrollHeight, h: scroll?.h, kids })
    throw new Error(`${label}: ${outline}\n${logs.slice(-20).join('\n')}\n${output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split('\n').filter(line => /plugin|config|error/i.test(line)).join('\n').slice(-4000)}`)
  }
  const mouse = (code, x, y, release = false) => terminal.write(`\x1b[<${code};${Math.floor(x) + 1};${Math.floor(y) + 1}${release ? 'm' : 'M'}`)
  ;(async () => {
    execFileSync(exe, ['import', fixture], { cwd: dir, env, windowsHide: true, timeout: 60000, stdio: 'pipe' })
    terminal = require('@lydell/node-pty').spawn(exe, ['--print-logs', '--log-level', 'DEBUG', '--session', sessionID], { cwd: dir, env, cols: 120, rows: 40, name: 'xterm-256color' })
    terminal.onData(data => { output += data; if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R') })
    const state = await until(s => find(s.tree, n => n.id === 'axondeck-scroll' && n.visible && n.h > 10), '外掛載入')
    assert(!find(state.tree, n => n.id === 'axondeck-nav-button'), '終端機裡不再多一顆對話按鈕')
    const barView = find(state.tree, n => n.bar?.visible)
    assert(barView && barView.scrollHeight > barView.h, '原生捲軸具有真實內容範圍')
    terminal.write('AXON_UNSENT_DRAFT')
    await until(s => find(s.tree, n => n.plainText === 'AXON_UNSENT_DRAFT'), '保留未送出草稿')
    await wait(150)
    mouse(35, barView.x + 10, barView.y + 3)
    mouse(65, barView.x + 10, barView.y + 3)
    await wait(50)
    mouse(65, barView.x + 10, barView.y + 3)
    await until(s => find(s.tree, n => n.id === barView.id && n.scrollTop > 0), '滾輪同步原生位置')
    const bar = barView.bar
    mouse(0, bar.x + bar.w - 1, bar.y + 1)
    await wait(100)
    mouse(32, bar.x + bar.w - 1, bar.y + bar.h - 2)
    await wait(100)
    mouse(0, bar.x + bar.w - 1, bar.y + bar.h - 2, true)
    await until(s => find(s.tree, n => n.id === barView.id && n.scrollTop > 100), '捲軸可拖到下方')
    const trackState = await until(s => find(s.tree, n => n.id === 'axondeck-scroll' && n.visible && n.h > 10), '右側拖曳軌')
    const track = find(trackState.tree, n => n.id === 'axondeck-scroll')
    const beforeDrag = find(trackState.tree, n => n.id === barView.id)
    const mid = track.y + Math.floor((track.h - 1) / 2)
    mouse(0, track.x, mid)
    await wait(150)
    mouse(0, track.x, mid, true)
    const dragged = await until(s => {
      const view = find(s.tree, n => n.id === barView.id)
      if (!view) return false
      const span = Math.max(1, (view.h || 1) - 1)
      const ratio = Math.min(1, Math.max(0, (mid - view.y) / span))
      const expected = Math.round(ratio * Math.max(0, view.scrollHeight - view.h))
      return Math.abs(view.scrollTop - expected) <= Math.max(30, expected * 0.2)
    }, '拖曳軌依真實高度定位')
    assert(find(dragged.tree, n => n.id === barView.id).scrollTop !== beforeDrag.scrollTop || beforeDrag.scrollTop < 100, '拖曳軌有改到捲動位置')
    const jumpFile = env.AXONDECK_NAV_JUMP
    fs.writeFileSync(jumpFile, JSON.stringify({ nonce: 'probe-nav-0', text: 'NAV_0', role: 'prompt', index: 0, ok: null }))
    await until(() => {
      try { return JSON.parse(fs.readFileSync(jumpFile, 'utf8')).ok === true } catch { return false }
    }, '側欄跳轉檔被外掛接走')
    const jumped = await until(s => {
      const view = find(s.tree, n => n.id === barView.id)
      const hit = find(s.tree, n => n.id === messages[0].info.id)
      return view && hit && hit.y >= view.y - 1 && hit.y <= view.y + 8
    }, '跳轉檔把內部捲軸移到第一則')
    assert(find(jumped.tree, n => n.plainText === 'AXON_UNSENT_DRAFT'), '跳轉不清除草稿')
    fs.writeFileSync(jumpFile, JSON.stringify({ nonce: 'probe-nav-39', text: 'NAV_39', role: 'answer', index: 0, ok: null }))
    await until(() => {
      try { return JSON.parse(fs.readFileSync(jumpFile, 'utf8')).ok === true } catch { return false }
    }, '最新一則跳轉檔被接走')
    const landed = await until(s => {
      const view = find(s.tree, n => n.id === barView.id)
      const hit = find(s.tree, n => n.plainText?.startsWith('NAV_39\n') || n.id === messages.at(-1).info.id)
      return view && hit && hit.y >= view.y - 1 && hit.y <= view.y + 8
    }, '跳轉檔停在最新一則開頭')
    const landedView = find(landed.tree, n => n.id === barView.id)
    assert(landedView.scrollTop < Math.max(0, landedView.scrollHeight - landedView.h) - 8, '最新一則後面的內容留在下面')
    terminal.write('_MORE')
    await until(s => find(s.tree, n => n.plainText === 'AXON_UNSENT_DRAFT_MORE'), '跳轉後同一 CLI 仍可輸入')
    console.log('PASS OpenCode 真 CLI：保存提示／回答直接跳轉、原生捲軸拖曳／滾輪、草稿保留與續輸入')
  })().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => {
    if (terminal) { try { execFileSync('taskkill', ['/PID', String(terminal.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} terminal.kill() }
  })
}
