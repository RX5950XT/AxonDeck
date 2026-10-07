'use strict'

/**
 * Linux 系統監控 probe：讀 /proc、/sys（可選 nvidia-smi 靜態 GPU），
 * 輸出與 probe.ps1／axondeck-probe 相同的 #READY／tick／static／detail 協定，
 * 讓既有 sampler + metrics 路徑不用分叉。
 *
 * 風扇／超頻／PawnIO 不在這裡——那些仍走 sensors stub。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const { execFileSync } = require('child_process')

const CLK_TCK = (() => {
  try {
    const n = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim())
    return Number.isFinite(n) && n > 0 ? n : 100
  } catch {
    return 100
  }
})()

/** 把 Linux clock ticks 轉成 Windows 那套 100ns 累計單位，供 metrics.diffSamples 使用 */
const TICKS_TO_100NS = 1e7 / CLK_TCK

function esc(value) {
  return String(value ?? '').replace(/[|\r\n]/g, ' ')
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8') } catch { return '' }
}

function numFromMeminfo(text, key) {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m ? Number(m[1]) * 1024 : 0
}

function bootTimeMs() {
  const up = Number((readText('/proc/uptime').split(/\s+/)[0]) || 0)
  return Date.now() - up * 1000
}

/**
 * @param {string} text /proc/<pid>/stat
 */
function parseProcStat(text) {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const name = text.slice(open + 1, close)
  const rest = text.slice(close + 2).trim().split(/\s+/)
  // man proc: after comm — state ppid ... utime stime ... num_threads ... starttime
  return {
    pid,
    name,
    ppid: Number(rest[1]) || 0,
    utime: Number(rest[11]) || 0,
    stime: Number(rest[12]) || 0,
    threads: Number(rest[17]) || 0,
    starttime: Number(rest[19]) || 0
  }
}

function rssBytes(pid) {
  const status = readText(`/proc/${pid}/status`)
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)
  if (m) return Number(m[1]) * 1024
  const statm = readText(`/proc/${pid}/statm`).trim().split(/\s+/)
  const pages = Number(statm[1]) || 0
  return pages * 4096
}

function privateBytes(pid) {
  const status = readText(`/proc/${pid}/status`)
  const m = /^VmData:\s+(\d+)\s+kB/m.exec(status)
  return m ? Number(m[1]) * 1024 : 0
}

function ioBytes(pid) {
  const text = readText(`/proc/${pid}/io`)
  if (!text) return { read: 0, write: 0 }
  const r = /^read_bytes:\s+(\d+)/m.exec(text)
  const w = /^write_bytes:\s+(\d+)/m.exec(text)
  return { read: r ? Number(r[1]) : 0, write: w ? Number(w[1]) : 0 }
}

function exePathOf(pid) {
  try { return fs.readlinkSync(`/proc/${pid}/exe`) } catch { return '' }
}

function collectTickRows() {
  const rows = []
  const nowMs = Date.now()
  const ts100 = Math.floor(nowMs * 10000)
  rows.push(`T|${nowMs}`)

  const mem = readText('/proc/meminfo')
  const available = numFromMeminfo(mem, 'MemAvailable') || numFromMeminfo(mem, 'MemFree')
  const cached = numFromMeminfo(mem, 'Cached') + numFromMeminfo(mem, 'Buffers')
  const total = numFromMeminfo(mem, 'MemTotal')
  const committed = Math.max(0, total - available)
  const commitLimit = total + numFromMeminfo(mem, 'SwapTotal')
  rows.push(`M|${available}|${cached}|${committed}|${commitLimit}|${cached}`)

  // 磁碟：累計 sectors → bytes；idle 留空（metrics 會讓 busy 為 null）
  const diskText = readText('/proc/diskstats')
  for (const line of diskText.split('\n')) {
    if (!line.trim()) continue
    const p = line.trim().split(/\s+/)
    if (p.length < 14) continue
    const name = p[2]
    if (!/^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/.test(name)) continue
    const read = (Number(p[5]) || 0) * 512
    const write = (Number(p[9]) || 0) * 512
    rows.push(`D|${esc(name)}|${read}|${write}||${ts100}`)
  }

  const netText = readText('/proc/net/dev')
  for (const line of netText.split('\n').slice(2)) {
    if (!line.includes(':')) continue
    const [ifaceRaw, rest] = line.split(':')
    const iface = ifaceRaw.trim()
    if (!iface || iface === 'lo') continue
    const cols = rest.trim().split(/\s+/)
    const rx = Number(cols[0]) || 0
    const tx = Number(cols[8]) || 0
    let linkSpeed = 0
    const speed = readText(`/sys/class/net/${iface}/speed`).trim()
    if (speed && speed !== '-1') linkSpeed = (Number(speed) || 0) * 1_000_000
    rows.push(`N|${esc(iface)}|${rx}|${tx}|${linkSpeed}`)
  }

  const boot = bootTimeMs()
  let dirs = []
  try { dirs = fs.readdirSync('/proc') } catch { dirs = [] }
  for (const ent of dirs) {
    if (!/^\d+$/.test(ent)) continue
    const pid = Number(ent)
    if (pid <= 0) continue
    const statText = readText(`/proc/${pid}/stat`)
    if (!statText) continue
    const st = parseProcStat(statText)
    if (!st) continue
    // 核心執行緒（名稱 [kworker/…]）略過，減少噪音
    if (st.name.startsWith('[') && st.name.endsWith(']')) continue
    const cpuTime = Math.floor((st.utime + st.stime) * TICKS_TO_100NS)
    const io = ioBytes(pid)
    const startedAt = Math.floor(boot + (st.starttime / CLK_TCK) * 1000)
    const exe = esc(exePathOf(pid))
    rows.push(
      `P|${pid}|${esc(st.name)}|${cpuTime}|${ts100}|${rssBytes(pid)}|${privateBytes(pid)}|${st.threads}|${io.read}|${io.write}|0|${st.ppid}|${exe}|${startedAt}`
    )
  }
  return rows
}

function osRelease() {
  const text = readText('/etc/os-release')
  /** @type {Record<string, string>} */
  const map = {}
  for (const line of text.split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line)
    if (!m) continue
    map[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
  return map
}

function cpuStaticRows() {
  const info = readText('/proc/cpuinfo')
  const models = [...info.matchAll(/^model name\s*:\s*(.+)$/gm)].map((m) => m[1].trim())
  const name = models[0] || os.cpus()[0]?.model || 'CPU'
  const threads = os.cpus().length || 1
  let cores = 0
  const coreIds = new Set()
  for (const m of info.matchAll(/^core id\s*:\s*(\d+)/gm)) coreIds.add(m[1])
  cores = coreIds.size || Math.max(1, Math.floor(threads / 2))
  const mhz = Number((/^cpu MHz\s*:\s*([\d.]+)/m.exec(info) || [])[1]) || 0
  const vendor = (/^vendor_id\s*:\s*(.+)$/m.exec(info) || [])[1] || ''
  return [`CPU|${esc(name)}|${cores}|${threads}|${Math.round(mhz)}|0|0||${esc(vendor)}`]
}

function volumeRows() {
  const rows = []
  const mounts = readText('/proc/mounts').split('\n')
  const seen = new Set()
  for (const line of mounts) {
    const p = line.split(/\s+/)
    if (p.length < 3) continue
    const mountPoint = p[1]
    const fstype = p[2]
    if (!mountPoint.startsWith('/')) continue
    if (['proc', 'sysfs', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2', 'overlay', 'squashfs'].includes(fstype)) {
      if (mountPoint !== '/') continue
    }
    if (seen.has(mountPoint)) continue
    seen.add(mountPoint)
    try {
      const st = fs.statfsSync(mountPoint)
      const size = Number(st.blocks) * Number(st.bsize)
      const free = Number(st.bavail) * Number(st.bsize)
      if (!(size > 0)) continue
      rows.push(`VOL|${esc(mountPoint)}||${size}|${free}|${esc(fstype)}|`)
    } catch { /* 無權限或虛擬掛載 */ }
  }
  return rows
}

function nicStaticRows() {
  const rows = []
  let ifaces = []
  try { ifaces = fs.readdirSync('/sys/class/net') } catch { ifaces = [] }
  for (const name of ifaces) {
    if (name === 'lo') continue
    const oper = readText(`/sys/class/net/${name}/operstate`).trim()
    const mac = readText(`/sys/class/net/${name}/address`).trim()
    const speed = readText(`/sys/class/net/${name}/speed`).trim()
    const status = oper === 'up' ? 2 : 0
    rows.push(`NIC|${esc(name)}|${esc(mac)}|${status}|${speed && speed !== '-1' ? Number(speed) * 1_000_000 : 0}||||`)
  }
  return rows
}

function nvidiaStaticRows() {
  try {
    const out = execFileSync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true })
    const rows = []
    for (const line of out.split('\n')) {
      if (!line.trim()) continue
      const [name, memMiB, driver] = line.split(',').map((s) => s.trim())
      const vram = (Number(memMiB) || 0) * 1024 * 1024
      rows.push(`GPU|${esc(name)}|${vram}|${esc(driver)}|||||||${vram}`)
    }
    return rows
  } catch {
    return []
  }
}

function collectStaticRows() {
  const rows = []
  const rel = osRelease()
  const hostname = os.hostname()
  const totalMemory = os.totalmem()
  rows.push(`SYS|||${esc(os.arch())}|${totalMemory}|${esc(hostname)}|||||||`)
  rows.push(...cpuStaticRows())
  rows.push(
    `OS|${esc(rel.PRETTY_NAME || rel.NAME || 'Linux')}|${esc(rel.VERSION_ID || '')}|${esc(os.release())}|${Math.floor(bootTimeMs())}|${esc(os.arch())}|||||||`
  )
  rows.push(...volumeRows())
  rows.push(...nicStaticRows())
  rows.push(...nvidiaStaticRows())
  return rows
}

function collectDetailRows(pid) {
  if (!(pid > 0)) return []
  const statText = readText(`/proc/${pid}/stat`)
  const st = parseProcStat(statText)
  if (!st) return []
  const exe = exePathOf(pid)
  const startedAt = Math.floor(bootTimeMs() + (st.starttime / CLK_TCK) * 1000)
  const rows = [
    `X|${pid}|${esc(st.name)}|${esc(exe)}||${startedAt}|${st.ppid}`
  ]
  return rows
}

function frame(kind, seq, rows) {
  const body = rows.length ? `${rows.join('\n')}\n` : ''
  return `#B ${kind} ${seq}\n${body}#E ${kind} ${seq}\n`
}

/**
 * 處理一行 stdin 指令，回傳要寫到 stdout 的字串（可能多行）。
 * @param {string} line
 * @returns {string}
 */
function handleCommand(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed) return ''
  const parts = trimmed.split(/\s+/)
  const cmd = parts[0]
  const seq = parts[1] || '0'
  const arg = parts[2] || ''
  try {
    if (cmd === 'tick') return frame('tick', seq, collectTickRows())
    if (cmd === 'static') return frame('static', seq, collectStaticRows())
    if (cmd === 'detail') return frame('detail', seq, collectDetailRows(Number(arg) || 0))
    if (cmd === 'bye') return ''
    return frame(cmd, seq, [])
  } catch (err) {
    const msg = esc(err && err.message ? err.message : 'error')
    return `#B ${cmd} ${seq}\n#ERR|${msg}\n#E ${cmd} ${seq}\n`
  }
}

/**
 * 給 sampler 用的假 child_process：stdin／stdout 管線 + EventEmitter。
 * @returns {import('child_process').ChildProcess}
 */
function createLinuxProbeChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const proc = new EventEmitter()
  let alive = true
  let buf = ''

  Object.assign(proc, {
    stdin,
    stdout,
    stderr,
    pid: process.pid,
    kill() {
      if (!alive) return
      alive = false
      try { stdin.end() } catch { /* */ }
      try { stdout.end() } catch { /* */ }
      queueMicrotask(() => proc.emit('close', 0))
    }
  })

  stdin.setEncoding('utf8')
  stdin.on('data', (chunk) => {
    if (!alive) return
    buf += chunk
    let idx
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      const out = handleCommand(line)
      if (out && alive) stdout.write(out)
      if (line.trim().startsWith('bye')) {
        proc.kill()
        return
      }
    }
  })
  stdin.on('end', () => { if (alive) proc.kill() })

  queueMicrotask(() => {
    if (alive) stdout.write('#READY\n')
  })

  return /** @type {any} */ (proc)
}

module.exports = {
  CLK_TCK,
  esc,
  parseProcStat,
  collectTickRows,
  collectStaticRows,
  collectDetailRows,
  handleCommand,
  createLinuxProbeChild,
  frame
}
