'use strict'

/**
 * 本機正在監聽的 TCP 埠（Main Process）。
 *
 * 這一塊是給「dev server 起來了，一鍵用內建瀏覽器開」用的，所以只列**本機位址**
 * （127.0.0.1／::1／0.0.0.0／::）的監聽埠——列別台機器的沒有意義。
 *
 * 兩件實測：
 * 1. `netstat -ano` 的**狀態字串沒有被在地化**（zh-TW 的 Windows 上照樣印 `LISTENING`），
 *    只有欄位標題會翻譯，所以可以直接比對這個字。
 *    刻意不用 `Get-NetTCPConnection`：那要自動載入 NetTCPIP 模組，
 *    `PSModulePath` 被污染時會整組載不起來（`Get-NetAdapter` 已經踩過一次）。
 * 2. 程序名要另外跑一次 `tasklist`；`netstat` 只給得出 PID。
 *
 * 兩支都是 `spawn(..., { shell: false })` 且**不帶任何使用者輸入**。
 */

const { execFile } = require('child_process')
const path = require('path')
const http = require('http')

/** 單次指令逾時 */
const TIMEOUT_MS = 8000
const SYSTEM32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')
/** 最多列幾個埠 */
const MAX_PORTS = 200
/** HTTP 探測逾時：本機服務該立刻回，等不到就當不是網頁 */
const PROBE_MS = 1200
/** 這些埠是 Windows 自己的服務，列出來只是雜訊 */
const NOISE_PORTS = new Set([135, 139, 445, 5040, 7680])

/**
 * @param {string} exe
 * @param {string[]} args
 * @returns {Promise<string>} stdout；失敗回空字串（這個面板壞掉不該讓整頁失敗）
 */
function run(exe, args) {
  return new Promise((resolve) => {
    execFile(exe, args, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      resolve(error && !stdout ? '' : String(stdout || ''))
    })
  })
}

/**
 * 這個位址算不算「這台機器上打得開的」。
 * @param {string} addr `netstat` 的本機位址欄（`0.0.0.0:5173` / `[::1]:3000`）
 * @returns {{ port: number, local: boolean } | null}
 */
function parseAddress(addr) {
  const at = addr.lastIndexOf(':')
  if (at < 0) return null
  const port = Number(addr.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const host = addr.slice(0, at).replace(/^\[|\]$/g, '')
  const local = host === '0.0.0.0' || host === '::' || host === '127.0.0.1' || host === '::1'
  return { port, local }
}

/**
 * 解析 `netstat -ano -p TCP`。欄位是空白分隔的四／五格：
 * `TCP  <本機>  <外部>  LISTENING  <PID>`
 *
 * @param {string} raw
 * @returns {Map<number, number>} port → pid
 */
function parseNetstat(raw) {
  /** @type {Map<number, number>} */
  const found = new Map()
  for (const line of String(raw || '').split('\n')) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5) continue
    if (cols[0] !== 'TCP') continue
    if (cols[3] !== 'LISTENING') continue
    const addr = parseAddress(cols[1])
    if (!addr || !addr.local) continue
    const pid = Number(cols[4])
    if (!Number.isInteger(pid) || pid < 0) continue
    // 同一個埠 IPv4 與 IPv6 各一列，留先看到的那個就好
    if (!found.has(addr.port)) found.set(addr.port, pid)
  }
  return found
}

/**
 * 解析 `tasklist /FO CSV /NH`：`"名稱","PID","工作階段","階段編號","記憶體"`。
 * @param {string} raw
 * @returns {Map<number, string>} pid → 程序名
 */
function parseTasklist(raw) {
  /** @type {Map<number, string>} */
  const names = new Map()
  for (const line of String(raw || '').split('\n')) {
    const cols = line.trim().match(/"([^"]*)"/g)
    if (!cols || cols.length < 2) continue
    const name = cols[0].slice(1, -1)
    const pid = Number(cols[1].slice(1, -1))
    if (!Number.isInteger(pid)) continue
    names.set(pid, name)
  }
  return names
}

/**
 * 這個埠開起來是不是一個真的網頁：對 127.0.0.1 送一個 GET，2xx 且是 HTML、或 3xx 轉址才算。
 * 4xx／5xx（系統服務、Discord RPC）和 JSON／純文字 API（Ollama）開了只是一片錯誤或一行字，不算。
 * 只收標頭就斷線，不讀內容；非 HTTP 服務會回亂碼或不回，一律當不是網頁。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
function probeHttp(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: PROBE_MS, agent: false }, (res) => {
      res.destroy()
      resolve(isWebPage(res.statusCode, res.headers['content-type']))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

/**
 * @param {number | undefined} status
 * @param {string | undefined} contentType
 * @returns {boolean}
 */
async function windowsListening() {
  const [netstat, tasks] = await Promise.all([
    run(path.join(SYSTEM32, 'netstat.exe'), ['-ano', '-p', 'TCP']),
    run(path.join(SYSTEM32, 'tasklist.exe'), ['/FO', 'CSV', '/NH'])
  ])
  return { ports: parseNetstat(netstat), names: parseTasklist(tasks) }
}

function isWebPage(status, contentType) {
  if (!status) return false
  if (status >= 300 && status < 400) return true
  return status >= 200 && status < 300 && /text\/html/i.test(String(contentType || ''))
}

/** /proc/net/tcp 的本機位址欄（十六進位、IPv4 是 little-endian）是不是本機打得開的 */
function procLocal(hex) {
  const addr = String(hex || '').toUpperCase()
  if (addr.length === 8) return addr === '00000000' || addr === '0100007F'
  // IPv6：:: 或 ::1（四個 32-bit 字各自 little-endian），以及 IPv4-mapped 的 0.0.0.0／127.0.0.1
  return addr === '0'.repeat(32) || addr === '000000000000000000000000' + '01000000'
    || addr === '0000000000000000FFFF000000000000' || addr === '0000000000000000FFFF00000100007F'
}

/**
 * 解析 `/proc/net/tcp`／`tcp6`：`sl local_address rem_address st … uid timeout inode`，
 * 狀態 `0A` 是 LISTEN。
 * @param {string} raw
 * @returns {Map<number, string>} port → socket inode
 */
function parseProcNet(raw) {
  /** @type {Map<number, string>} */
  const found = new Map()
  for (const line of String(raw || '').split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 10 || cols[3] !== '0A') continue
    const [host, portHex] = cols[1].split(':')
    if (!procLocal(host)) continue
    const port = parseInt(portHex, 16)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
    if (!found.has(port)) found.set(port, cols[9])
  }
  return found
}

/**
 * Linux：讀 /proc（不跑 ss／netstat，發行版不一定有裝）。別的使用者的程序讀不到 fd，
 * 那些埠照樣列出來，只是沒有 PID 與程序名。
 * @param {string} [root]
 * @returns {Promise<{ ports: Map<number, number>, names: Map<number, string> }>}
 */
async function linuxListening(root = '/proc') {
  const fsp = require('fs').promises
  const read = (file) => fsp.readFile(path.join(root, file), 'utf8').catch(() => '')
  const [tcp, tcp6] = await Promise.all([read('net/tcp'), read('net/tcp6')])
  const inodes = new Map([...parseProcNet(tcp6), ...parseProcNet(tcp)])
  const wanted = new Map([...inodes].map(([port, inode]) => [inode, port]))
  /** @type {Map<number, number>} */
  const ports = new Map([...inodes.keys()].map((port) => [port, 0]))
  /** @type {Map<number, string>} */
  const names = new Map()
  const pids = (await fsp.readdir(root).catch(() => [])).filter((name) => /^\d+$/.test(name))
  for (const pid of pids) {
    if (!wanted.size) break
    const fds = await fsp.readdir(path.join(root, pid, 'fd')).catch(() => [])
    for (const fd of fds) {
      const link = await fsp.readlink(path.join(root, pid, 'fd', fd)).catch(() => '')
      const inode = /^socket:\[(\d+)\]$/.exec(link)?.[1]
      if (!inode || !wanted.has(inode)) continue
      ports.set(/** @type {number} */ (wanted.get(inode)), Number(pid))
      if (!names.has(Number(pid))) names.set(Number(pid), (await read(`${pid}/comm`)).trim())
      wanted.delete(inode)
    }
  }
  return { ports, names }
}

/**
 * 目前在聽的本機埠，依埠號小到大；`web` 是開得起來的網頁。
 * @returns {Promise<Array<{ port: number, pid: number, process: string, web: boolean }>>}
 */
async function list() {
  const { ports, names } = process.platform === 'win32' ? await windowsListening() : await linuxListening()
  const rows = [...ports.entries()]
    .filter(([port]) => !NOISE_PORTS.has(port))
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_PORTS)
    .map(([port, pid]) => ({ port, pid, process: names.get(pid) || '' }))
  const web = await Promise.all(rows.map((row) => probeHttp(row.port)))
  return rows.map((row, i) => ({ ...row, web: web[i] }))
}

module.exports = {
  NOISE_PORTS,
  parseAddress,
  parseNetstat,
  parseTasklist,
  parseProcNet,
  linuxListening,
  isWebPage,
  list
}
