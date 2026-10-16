'use strict'

/**
 * Miroxen 服務（圖片／影音生成）：App 自己開一顆 `miroxen.exe serve`，生成頁用 iframe 內嵌它的工作台。
 *
 * - 預設只聽 127.0.0.1 的隨機埠；開了「區網」改聽 0.0.0.0 的固定埠 8188，讓別台用同一組網址。
 * - API key 第一次產生後存在 store（區網裝置要填同一組）；工作台從網址 hash 拿，進不了 history。
 * - 模型在 `models/miroxen/`（`--models`），輸出在 `userData/miroxen/out`。
 * - 引擎只在啟動時盤點模型：下載了新模型、而且沒有工作在跑，就重開一次。
 * - PATH 前面接 runtime 資料夾：cuBLAS DLL 與 ffmpeg／ffprobe 都放在 exe 旁邊。
 */

const { app } = require('electron')
const { spawn, execFile } = require('child_process')
const { randomBytes } = require('crypto')
const fsp = require('fs/promises')
const net = require('net')
const os = require('os')
const path = require('path')
const models = require('../models')
const runtime = require('./runtime')
const { nvidiaDriver } = require('../hfmodels/hardware')

const START_TIMEOUT_MS = 60_000
const RUNTIME_KEY = 'miroxenruntime'
const LAN_PORT = 8188

/** @type {{ child: import('child_process').ChildProcess, host: string, port: number, key: string, signature: string } | null} */
let server = null
/** @type {Promise<any> | null} */
let starting = null
let stderrTail = ''
/** @type {any} */
let store = null

function setStore(value) { store = value }
const lanEnabled = () => store?.get?.('miroxenLan') === true

function apiKey() {
  let key = String(store?.get?.('miroxenApiKey') || '')
  if (!/^[A-Za-z0-9_-]{32}$/.test(key)) {
    key = randomBytes(24).toString('base64url')
    store?.set?.('miroxenApiKey', key)
  }
  return key
}

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  error.userMessage = message
  return error
}

const runtimeDir = () => models.modelDir(RUNTIME_KEY)
const modelsDir = () => models.modelDir(models.MIROXEN_MODEL_KEYS[0])
const outDir = () => path.join(app.getPath('userData'), 'miroxen', 'out')
const installedModels = () => models.MIROXEN_MODEL_KEYS.filter((key) => models.isDownloaded(key))

/** @param {number} port 0 = 隨機 @param {string} host */
function freePort(port, host) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(port, host, () => {
      const { port } = probe.address()
      probe.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

/** @param {{ checkUpdate?: boolean }} [options] */
async function status({ checkUpdate = false } = {}) {
  const version = runtime.installedVersion(runtimeDir())
  let latest = ''
  if (checkUpdate) {
    try { latest = (await runtime.latestRelease()).tag } catch { /* 離線就不顯示更新 */ }
  }
  const nvidia = await nvidiaDriver()
  return {
    gpuReady: nvidia.cudaReady,
    hasNvidia: nvidia.hasNvidia,
    installed: !!version,
    version,
    latest,
    update: !!version && runtime.isNewer(latest, version),
    models: models.MIROXEN_MODEL_KEYS.map((key) => ({ key, label: models.MODELS[key].label, downloaded: models.isDownloaded(key) })),
    running: !!server && !starting,
    starting: !!starting,
    url: server && !starting ? url() : ''
  }
}

/** 這台的區網 IPv4（給別台連的網址） */
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((item) => item && item.family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.'))
    .map((item) => item.address)
}

/** Local SI 的 API 面板：網址、金鑰、區網開關 */
function api() {
  const running = !!server && !starting
  const port = running ? server.port : lanEnabled() ? LAN_PORT : 0
  return {
    installed: !!runtime.installedVersion(runtimeDir()), running, lan: lanEnabled(), port, key: apiKey(),
    local: port ? `http://127.0.0.1:${port}` : '',
    lanUrls: running && server.host === '0.0.0.0' ? lanAddresses().map((ip) => `http://${ip}:${port}`) : []
  }
}

/** 切區網：服務在跑就照新設定重開（佇列有工作時拒絕，免得中斷生成） */
async function setLan(enabled) {
  store?.set?.('miroxenLan', enabled === true)
  if (server && !starting) {
    if (await busy()) throw fail('BUSY', '還有工作在生成，等它完成再切換區網')
    await stop()
    await start()
  }
  return api()
}

function url() {
  return `http://127.0.0.1:${server.port}/?embed=1#key=${server.key}`
}

async function request(endpoint, timeoutMs = 2000) {
  const response = await fetch(`http://127.0.0.1:${server.port}${endpoint}`, {
    headers: { authorization: `Bearer ${server.key}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`) }
  return response.json()
}

/** 有沒有工作在排隊或在跑（讀不到就當忙，不冒險重開） */
async function busy() {
  try { return Number((await request('/v1/system')).queue_length) > 0 } catch { return true }
}

/** 確保服務在跑；回傳工作台網址（不含 theme 參數，renderer 自己接） */
async function start() {
  if (starting) await starting.catch(() => {})
  if (server) {
    if (server.signature === installedModels().join(',') || await busy()) return { url: url() }
    await stop()
  }
  starting = launch().finally(() => { starting = null })
  await starting
  return { url: url() }
}

async function launch() {
  if (!runtime.isReady(runtimeDir())) throw fail('NOT_INSTALLED', '請先到 Local SI 的執行環境安裝 Miroxen 引擎')
  const signature = installedModels()
  if (!signature.length) throw fail('NO_MODEL', '請先到 Local SI 的推薦下載圖片或影音模型')
  const dir = runtimeDir()
  const home = modelsDir()
  await fsp.mkdir(outDir(), { recursive: true })
  await fsp.mkdir(path.join(home, 'loras', 'image'), { recursive: true })
  await fsp.mkdir(path.join(home, 'loras', 'video'), { recursive: true })
  const host = lanEnabled() ? '0.0.0.0' : '127.0.0.1'
  // 區網要固定埠別台才記得住；被占了就退回隨機埠（面板會顯示實際埠）
  const port = host === '0.0.0.0' ? await freePort(LAN_PORT, host).catch(() => freePort(0, host)) : await freePort(0, host)
  const key = apiKey()
  const h3 = path.join(home, 'video', 'minimax-h3', 'hf')
  const env = { ...process.env, PATH: `${dir};${process.env.PATH || ''}`,
    MX_H3_VIDEO_VAE_CONFIG: path.join(h3, 'vae', 'config.json'),
    MX_H3_AUDIO_VAE_CONFIG: path.join(h3, 'audio_vae', 'config.json') }
  const args = ['serve', '--host', host, '--port', String(port), '--api-key', key,
    '--models', home, '--loras', path.join(home, 'loras'), '--out', outDir(), '--web', path.join(dir, 'web')]
  const child = spawn(path.join(dir, 'miroxen.exe'), args, { cwd: home, env, windowsHide: true, shell: false,
    stdio: ['ignore', 'ignore', 'pipe'] })
  stderrTail = ''
  child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000) })
  const owned = { child, host, port, key, signature: signature.join(',') }
  server = owned
  let exited = false
  child.once('error', () => { exited = true })
  child.once('exit', () => {
    exited = true
    if (server === owned) server = null
  })
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline && !exited) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { redirect: 'error', signal: AbortSignal.timeout(1000) })
      await response.body?.cancel()
      if (response.ok) return
    } catch { /* 還沒起來 */ }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  await stop()
  // 本機引擎自己的錯誤訊息（例如找不到顯示卡），不含網路上游內容
  const reason = stderrTail.trim().split(/\r?\n/).pop()
  throw fail('START_FAILED', `Miroxen 引擎啟動失敗${reason ? `：${reason.slice(0, 200)}` : '或逾時'}`)
}

function stop() {
  const owned = server
  server = null
  if (!owned?.child.pid || owned.child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe')
    execFile(taskkill, ['/PID', String(owned.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => resolve())
  })
}

async function openOutput() {
  await fsp.mkdir(outDir(), { recursive: true })
  return outDir()
}

module.exports = { setStore, status, start, stop, shutdown: stop, openOutput, api, setLan }
