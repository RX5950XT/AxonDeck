/**
 * Grok 網頁版的 Cloudflare 通行證。
 *
 * Grok 的 Cloudflare 認得出 Electron：App 內怎麼換瀏覽器識別都過不了，勾選框點了也一直重來（2026-10-05 實測）。
 * 同一台電腦的 Edge 卻會自動通過。所以碰到驗證頁就開一個 Edge（沒有就 Chrome）小視窗去過驗證，
 * 把它拿到的 cf_clearance 連同它的瀏覽器識別帶回 persist:ai-grok——通行證綁瀏覽器識別，兩個要一起換；
 * 有效期約一年，之後很久才會再跳一次。
 *
 * 地雷：除錯埠要給固定號碼。用 0 讓瀏覽器自己挑時，Cloudflare 一律不放行（實測 7 次全敗，原因不明）。
 */
const fs = require('fs')
const net = require('net')
const path = require('path')
const { spawn } = require('child_process')
const { removeTreeSync } = require('./safe-rm')

const HOME = 'https://grok.com/'
const STATE_FILE = 'grok-clearance.json'
const TIMEOUT_MS = 3 * 60_000
const COOLDOWN_MS = 2 * 60_000

function findBrowser(env = process.env) {
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean)
  const rels = ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe']
  for (const rel of rels) {
    for (const root of roots) {
      const exe = path.join(root, rel)
      if (fs.existsSync(exe)) return exe
    }
  }
  return ''
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 驗證頁的標題是「請稍候…」／「Just a moment…」，載入中是網址；過了才會是「Grok」 */
function passedTitle(title) {
  return /grok/i.test(title) && !/grok\.com|請稍候|稍候|moment/i.test(title)
}

async function getJson(port, route) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(3000) })
  return res.json()
}

/** 只連瀏覽器本體（不附著到網頁），拿 grok.com 的 cookie 後關掉瀏覽器 */
function readCookiesAndClose(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP_TIMEOUT')) }, 10_000)
    ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP_ERROR')) }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.send(JSON.stringify({ id: 2, method: 'Browser.close' }))
      resolve(Array.isArray(msg.result?.cookies) ? msg.result.cookies : [])
    }
  })
}

/** 等瀏覽器那邊過驗證；使用者自己關掉視窗就提早結束 */
async function waitForPass(port, child) {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('BROWSER_CLOSED')
    await sleep(1500)
    try {
      const pages = await getJson(port, '/json/list')
      if (pages.some((p) => p.type === 'page' && p.url.startsWith(HOME) && passedTitle(p.title))) return
    } catch { /* 瀏覽器還在開，下一輪再問 */ }
  }
  throw new Error('TIMEOUT')
}

/**
 * 開瀏覽器過一次驗證
 * @param {string} profileDir 專用的暫存使用者資料夾（用完刪掉）
 * @returns {Promise<{ userAgent: string, cookies: any[] }>}
 */
async function fetchClearance(profileDir) {
  const exe = findBrowser()
  if (!exe) throw new Error('NO_BROWSER')
  const port = await freePort()
  removeTreeSync(profileDir)
  const child = spawn(exe, [
    `--user-data-dir=${profileDir}`, `--remote-debugging-port=${port}`, '--no-first-run',
    '--no-default-browser-check', '--disable-sync', '--window-size=520,680', `--app=${HOME}`
  ], { stdio: 'ignore' })
  const exited = new Promise((resolve) => { child.once('exit', resolve); child.once('error', resolve) })
  try {
    await waitForPass(port, child)
    const { 'User-Agent': userAgent, webSocketDebuggerUrl } = await getJson(port, '/json/version')
    const cookies = (await readCookiesAndClose(webSocketDebuggerUrl)).filter((c) => /(^|\.)grok\.com$/.test(c.domain))
    if (!userAgent || !cookies.some((c) => c.name === 'cf_clearance')) throw new Error('NO_CLEARANCE')
    return { userAgent, cookies }
  } finally {
    if (child.exitCode === null) child.kill()
    await Promise.race([exited, sleep(5000)])
    await sleep(1000) // 子程序放掉檔案鎖
    try { removeTreeSync(profileDir) } catch { /* 刪不掉下次開之前會再刪 */ }
  }
}

function toElectronCookie(c) {
  return {
    url: `https://${c.domain.replace(/^\./, '')}${c.path || '/'}`,
    name: c.name,
    value: c.value,
    domain: c.domain.startsWith('.') ? c.domain : undefined,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expires > 0 ? c.expires : undefined,
    sameSite: ({ Strict: 'strict', Lax: 'lax', None: 'no_restriction' })[c.sameSite] || 'unspecified'
  }
}

/**
 * 掛到 persist:ai-grok：套用上次存下的瀏覽器識別；整頁被 Cloudflare 擋時自動去拿通行證、換好後重新載入。
 * @param {import('electron').Session} ses
 * @param {{ userDataDir: string, getGuests: () => import('electron').WebContents[] }} opts
 */
function install(ses, { userDataDir, getGuests }) {
  const stateFile = path.join(userDataDir, STATE_FILE)
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    if (typeof saved?.userAgent === 'string' && /^Mozilla\/5\.0 /.test(saved.userAgent)) ses.setUserAgent(saved.userAgent)
  } catch { /* 還沒拿過通行證 */ }

  let running = null
  let lastTry = 0
  const refresh = () => {
    if (running || Date.now() - lastTry < COOLDOWN_MS) return
    lastTry = Date.now()
    running = fetchClearance(path.join(userDataDir, 'grok-verify'))
      .then(async ({ userAgent, cookies }) => {
        for (const c of cookies) await ses.cookies.set(toElectronCookie(c)).catch(() => {})
        ses.setUserAgent(userAgent)
        fs.writeFileSync(stateFile, JSON.stringify({ userAgent }))
        for (const guest of getGuests()) {
          guest.setUserAgent(userAgent)
          guest.reload()
        }
      })
      .catch((error) => console.warn('[grok-clearance]', /^[A-Z_]+$/.test(error?.message) ? error.message : 'FAILED'))
      .finally(() => { running = null; lastTry = Date.now() })
  }

  ses.webRequest.onHeadersReceived({ urls: ['https://grok.com/*'] }, (details, callback) => {
    const mitigated = details.responseHeaders?.['cf-mitigated'] || details.responseHeaders?.['Cf-Mitigated']
    if (details.resourceType === 'mainFrame' && String(mitigated || '').includes('challenge')) refresh()
    callback({})
  })
}

module.exports = { install, fetchClearance, passedTitle, findBrowser, toElectronCookie }
