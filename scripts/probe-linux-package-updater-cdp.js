'use strict'

/**
 * 實機探針：把打好的 .deb 用 `dpkg-deb -x` 解到測試暫存（不安裝、不需要 root），
 * 跑裡面的 /opt/AxonDeck/axondeck，用 CDP 問 `electronAPI.update.status()`：
 * packageKind 要是 deb、更新設定要讀得到（app-update.yml），有沒有 pkexec 決定 manual。
 * 會在目前的 DISPLAY 開一個視窗再自己關掉；不檢查更新、不連網。
 *
 *   npm run electron:build:linux
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/probe-linux-package-updater-cdp.js [dist/xxx.deb]
 */

const { spawn, execFileSync } = require('child_process')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { tempDir } = require('./lib/test-temp')
const lib = require('./lib/linux-artifacts')

const PORT = 9295
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const DEB = process.argv[2] || path.join(__dirname, '..', 'dist', lib.packageNames(require('../package.json').version, arch).deb)
const WORK = tempDir('axondeck-probe-deb-')
const ROOTFS = path.join(WORK, 'root')
const USER_DATA_DIR = path.join(WORK, 'user-data')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let failed = false

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failed = true
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.setTimeout(2000, () => req.destroy(new Error('逾時')))
    req.on('error', reject)
  })
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null)
    if (v) return v
    await sleep(250)
  }
  throw new Error(`逾時：${label}`)
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })))
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id !== 1) return
      ws.close()
      if (msg.error || msg.result?.exceptionDetails) reject(new Error(JSON.stringify(msg.error || msg.result.exceptionDetails)))
      else resolve(msg.result.result.value)
    })
    ws.addEventListener('error', () => reject(new Error('CDP 連線失敗')))
  })
}

async function main() {
  if (!fs.existsSync(DEB)) throw new Error(`找不到 ${DEB}；先 npm run electron:build:linux`)
  fs.mkdirSync(ROOTFS, { recursive: true })
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })
  fs.writeFileSync(path.join(USER_DATA_DIR, 'config.json'), JSON.stringify({ sysmonSensors: false, autoUpdate: false }))
  execFileSync('dpkg-deb', ['-x', DEB, ROOTFS])
  const exe = path.join(ROOTFS, 'opt', 'AxonDeck', 'axondeck')
  const res = path.join(ROOTFS, 'opt', 'AxonDeck', 'resources')
  check('deb 解出主程式', fs.existsSync(exe))
  check('resources/package-type 是 deb', fs.readFileSync(path.join(res, 'package-type'), 'utf8').trim() === 'deb')
  check('resources/app-update.yml 指向 GitHub', ((t) => /provider: github/.test(t) && /repo: AxonDeck/.test(t))(fs.readFileSync(path.join(res, 'app-update.yml'), 'utf8')))
  const desktop = fs.readFileSync(path.join(ROOTFS, 'usr', 'share', 'applications', 'axondeck.desktop'), 'utf8')
  check('desktop entry：Exec／Icon／StartupWMClass', /^Exec=\/opt\/AxonDeck\/axondeck %U$/m.test(desktop) && /^Icon=axondeck$/m.test(desktop) && /^StartupWMClass=axondeck$/m.test(desktop))
  check('圖示 256x256', fs.existsSync(path.join(ROOTFS, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'axondeck.png')))

  // 解出來的 chrome-sandbox 沒有 setuid，跟 dpkg 在沒有 userns 的機器上一樣要 --no-sandbox
  const env = { ...process.env }
  delete env.APPIMAGE
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(exe, [`--user-data-dir=${USER_DATA_DIR}`, `--remote-debugging-port=${PORT}`, '--no-sandbox'], { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(WORK, 'stderr.log'), 'w')] })
  try {
    let seen = []
    const target = await waitFor(async () => {
      const list = await getJson(`http://127.0.0.1:${PORT}/json/list`)
      seen = list.map((t) => `${t.type} ${t.url}`)
      return list.find((t) => t.type === 'page' && /index\.html|app:\/\//.test(t.url) && t.webSocketDebuggerUrl)
    }, 60000, '主視窗').catch((error) => {
      throw new Error(`${error.message}（exit=${child.exitCode}；targets：${seen.join('、') || '無'}）`)
    })
    const st = await waitFor(() => evaluate(target.webSocketDebuggerUrl, 'window.electronAPI?.update?.status()'), 20000, 'update.status')
    console.log(`      status：${JSON.stringify({ packageKind: st.packageKind, manual: st.manual, state: st.state, note: st.note, currentVersion: st.currentVersion })}`)
    check('執行中的 deb 版回報 packageKind=deb', st.packageKind === 'deb')
    const pkexec = String(process.env.PATH || '').split(':').some((d) => d && fs.existsSync(path.join(d, 'pkexec')))
    check(`有沒有 pkexec（${pkexec ? '有' : '沒有'}）決定 manual`, st.manual === !pkexec)
    check('沒有「缺更新資訊」', st.state !== 'unsupported')
  } catch (error) {
    try { console.error(fs.readFileSync(path.join(WORK, 'stderr.log'), 'utf8').split('\n').slice(-15).join('\n')) } catch {}
    throw error
  } finally {
    child.kill('SIGTERM')
    await sleep(1500)
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  if (failed) process.exit(1)
  console.log('探針全部通過')
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
