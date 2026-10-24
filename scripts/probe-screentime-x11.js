'use strict'

/**
 * 真的 X11 桌面：開兩個不同程序的視窗，用 xdotool 輪流切到前景，看 observer-linux 回報的名稱有沒有跟著換。
 * 需要 DISPLAY、xprop、xdotool；第二個視窗用本專案的 Electron（暫存 userData），第一個用 xmessage 或任何有 _NET_WM_PID 的視窗。
 *
 * 用法：DISPLAY=:0 node scripts/probe-screentime-x11.js
 */

const { spawn, execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { tempDir } = require('./lib/test-temp')
const { createLinuxObserver } = require('../src/main/screentime/observer-linux')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 用視窗標題找（xmessage 的 WM_NAME 就是 xmessage；Electron 的標題是 tag）
function windowsNamed(name) {
  try { return execFileSync('xdotool', ['search', '--onlyvisible', '--name', `^${name}$`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean) } catch { return [] }
}

async function waitWindow(name, ms = 15000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const ids = windowsNamed(name)
    if (ids.length) return ids[0]
    await wait(300)
  }
  return ''
}

/** 開一個 Electron 視窗（獨立程序、暫存 userData），標題帶 tag */
function launchElectron(tag) {
  const dir = tempDir('st-x11-')
  fs.writeFileSync(path.join(dir, 'main.js'), `const { app, BrowserWindow } = require('electron')
app.setPath('userData', ${JSON.stringify(path.join(dir, 'ud'))})
app.whenReady().then(() => { const w = new BrowserWindow({ width: 360, height: 200, title: ${JSON.stringify(tag)} }); w.loadURL('data:text/html,<title>${tag}</title>${tag}') })`)
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `st-${tag}`, main: 'main.js' }))
  return spawn(require('electron'), [dir, '--no-sandbox'], { stdio: 'ignore', env: { ...process.env, ELECTRON_ENABLE_LOGGING: '' } })
}

async function main() {
  if (process.platform !== 'linux' || !process.env.DISPLAY) { console.log('SKIP 需要 Linux＋DISPLAY'); return }
  const children = []
  let failed = 0
  try {
    const ticks = []
    const observer = createLinuxObserver({ onTick: (t) => ticks.push(t), idleMs: () => 0 })
    const support = await observer.detect()
    console.log(`backend=${support.backend || '-'} supported=${support.supported} ${support.note}`)
    if (!support.supported) throw new Error('這個桌面偵測不到可用來源')

    const msg = spawn('xmessage', ['-geometry', '+40+40', 'axondeck screentime probe'], { stdio: 'ignore' })
    const app = launchElectron('probe-b')
    children.push(msg, app)
    const winMsg = await waitWindow('xmessage')
    const winApp = await waitWindow('probe-b')
    if (!winApp) throw new Error('Electron 視窗沒出現')
    observer.start()
    for (const [label, win] of [['electron', winApp], ['xmessage', winMsg], ['electron', winApp]]) {
      if (!win) { console.log(`SKIP ${label}：視窗沒出現`); continue }
      execFileSync('xdotool', ['windowactivate', '--sync', win])
      ticks.length = 0
      await wait(2500)
      const names = [...new Set(ticks.map((t) => `${t.name || '（空）'}#${t.pid}`))]
      console.log(`前景=${label}（${win}）→ ticks ${ticks.length}：${names.join(', ')}`)
      const last = ticks.at(-1)
      if (label === 'electron') {
        const good = last && last.name === 'electron' && last.path.endsWith('/electron') && last.pid > 0
        if (!good) failed++
        console.log(`${good ? 'PASS' : 'FAIL'} 前景 Electron → name=electron path=${last?.path || ''}`)
      } else {
        // xmessage（Xt）沒有 _NET_WM_PID → pid 0、name 空：服務端會當成「沒在用 App」不記
        const good = last && last.name !== 'electron'
        if (!good) failed++
        console.log(`${good ? 'PASS' : 'FAIL'} 切到 xmessage → 不再算成 Electron（name=${last?.name || '空'} pid=${last?.pid}）`)
      }
    }
    observer.stop()
  } catch (error) {
    failed++
    console.log(`FAIL ${error.message}`)
  } finally {
    for (const child of children) { try { child.kill() } catch {} }
  }
  if (failed) process.exitCode = 1
}

main()
