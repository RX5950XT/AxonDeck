'use strict'

/**
 * Linux 手機（MTP）／相機（PTP）的底層傳輸。兩種：
 *
 *   gio  ：GNOME 的 gvfs（gvfs-backends 的 gvfsd-mtp）。列舉 `gio mount -li`、掛載 `gio mount`、
 *          `gio list`／`gio copy`／`gio mkdir`／`gio remove`。不用 root、桌面環境通常已裝。
 *   fuse ：沒有 gvfs 時退回 jmtpfs／simple-mtpfs，掛到 $XDG_RUNTIME_DIR/axondeck-mtp/<n>，之後用一般 fs。
 *
 * 系統工具一律指名絕對路徑（不靠 PATH）、參數陣列、shell: false；檔名只進 URI（百分比編碼）或參數，不進 shell。
 * 這裡只做單一檔案／單一資料夾的動作；遞迴複製／刪除在 mtp-linux.js。
 */

const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const rawFs = require('../raw-fs')

const GIO = ['/usr/bin/gio', '/bin/gio']
/** gvfs 的 MTP 後端；只有 gio 沒有它＝裝了 glib 但沒裝 gvfs-backends（Debian／Ubuntu）或 gvfs-mtp（Fedora／Arch） */
const GVFSD_MTP = [
  '/usr/libexec/gvfsd-mtp', '/usr/lib/gvfs/gvfsd-mtp', '/usr/lib/x86_64-linux-gnu/gvfs/gvfsd-mtp',
  '/usr/lib64/gvfs/gvfsd-mtp', '/usr/libexec/gvfs/gvfsd-mtp'
]
const SIMPLE_MTPFS = ['/usr/bin/simple-mtpfs']
const JMTPFS = ['/usr/bin/jmtpfs']
const FUSERMOUNT = ['/usr/bin/fusermount3', '/usr/bin/fusermount', '/bin/fusermount']

const LIST_TIMEOUT_MS = 2 * 60 * 1000
const COPY_TIMEOUT_MS = 6 * 60 * 60 * 1000
const SHORT_TIMEOUT_MS = 60 * 1000
const MAX_STDOUT = 32 * 1024 * 1024

function firstExisting(list, exists) {
  return list.find((p) => exists(p)) || ''
}

/**
 * 跑一支外部程式，收 stdout；stderr 只留前 2KB 判斷錯誤種類，不往上丟原文。
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
function run(spawnFn, file, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawnFn(file, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } })
    } catch {
      resolve({ code: -1, stdout: '', stderr: 'spawn', timedOut: false })
      return
    }
    const out = []
    let size = 0
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { child.kill() } catch { /* 已結束 */ } }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      size += chunk.length
      if (size <= MAX_STDOUT) out.push(chunk)
    })
    child.stderr?.on('data', (chunk) => { if (err.length < 2048) err += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: 'spawn', timedOut }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: Number(code ?? -1), stdout: Buffer.concat(out).toString('utf8'), stderr: err, timedOut })
    })
  })
}

/**
 * 解析 `gio mount -li`：挑出 MTP／PTP（mtp://、gphoto2://）的磁碟區與已掛載點。
 * @param {string} text
 * @returns {Array<{ name: string, uri: string, mounted: boolean }>}
 */
function parseMountList(text) {
  const byUri = new Map()
  let pending = null
  const isPhone = (uri) => /^(mtp|gphoto2):\/\//i.test(uri)
  const add = (name, uri, mounted) => {
    if (!uri || !isPhone(uri)) return
    const key = uri.replace(/\/+$/, '/')
    const prev = byUri.get(key)
    byUri.set(key, { name: (prev?.name || name || '').trim() || '手機', uri: key, mounted: Boolean(prev?.mounted || mounted) })
  }
  for (const line of String(text || '').split('\n')) {
    const vol = /^\s*Volume\(\d+\):\s*(.*)$/.exec(line)
    if (vol) { pending = { name: vol[1] }; continue }
    const mount = /^\s*Mount\(\d+\):\s*(.*?)\s+->\s+(\S+)\s*$/.exec(line)
    if (mount) { add(mount[1], mount[2], true); pending = null; continue }
    if (/^\s*(Drive)\(\d+\):/.test(line)) { pending = null; continue }
    const root = /^\s*activation_root=(\S+)/.exec(line)
    if (root && pending) { add(pending.name, root[1], false); pending = null }
  }
  return [...byUri.values()]
}

/**
 * 解析 `gio list -l -h -u -a time::modified <uri>`：每行 `URI\t大小\t(型別)\ttime::modified=秒`。
 * 用 -u（印 URI）是因為 URI 已經百分比編碼，檔名裡有 tab／換行也不會切錯。
 * @returns {Array<{ name: string, dir: boolean, size: number, mtimeMs: number }>}
 */
function parseGioList(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue
    const cols = line.split('\t')
    if (cols.length < 3) continue
    const uri = cols[0].replace(/\/+$/, '')
    const raw = uri.slice(uri.lastIndexOf('/') + 1)
    let name
    try { name = decodeURIComponent(raw) } catch { continue }
    if (!name || name === '.' || name === '..' || /[\\/\u0000-\u001f]/.test(name)) continue
    const type = /^\((\w+)\)$/.exec(cols[2])?.[1] || ''
    const dir = type === 'directory' || type === 'mountable'
    const mtime = /(?:^|\s)time::modified=(\d+)/.exec(cols.slice(3).join('\t'))
    out.push({ name, dir, size: dir ? 0 : Math.max(0, Number(cols[1]) || 0), mtimeMs: mtime ? Number(mtime[1]) * 1000 : 0 })
  }
  return out
}

/** URI 子路徑：每段百分比編碼 */
function childUri(base, segs) {
  const root = base.endsWith('/') ? base : `${base}/`
  return root + segs.map((s) => encodeURIComponent(s)).join('/')
}

/** 錯誤分類：只回我們自己的字串（stderr 可能含裝置序號，不往外丟） */
function classify(res) {
  if (res.timedOut) return 'TIMEOUT'
  const e = String(res.stderr || '')
  if (/exists/i.test(e)) return 'EXISTS'
  if (/not found|No such file|does not exist/i.test(e)) return 'NOT_FOUND'
  if (/not empty/i.test(e)) return 'NOT_EMPTY'
  if (/permission|denied|locked/i.test(e)) return 'DENIED'
  if (/already mounted/i.test(e)) return 'ALREADY'
  return 'FAILED'
}

function createGioTransport(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const exists = deps.exists || ((p) => { try { return rawFs.existsSync(p) } catch { return false } })
  const gio = deps.gioPath || firstExisting(GIO, exists)

  async function must(args, timeoutMs) {
    const res = await run(spawnFn, gio, args, timeoutMs)
    if (res.code !== 0) {
      const err = new Error(classify(res))
      err.kind = classify(res)
      throw err
    }
    return res.stdout
  }

  return {
    kind: 'gio',
    async enumerate() {
      const res = await run(spawnFn, gio, ['mount', '-li'], SHORT_TIMEOUT_MS)
      if (res.code !== 0) return []
      return parseMountList(res.stdout).map((d) => ({ name: d.name, root: d.uri, mounted: d.mounted, type: /^gphoto2:/i.test(d.uri) ? '相機（PTP）' : '手機（MTP）' }))
    },
    async mount(dev) {
      if (dev.mounted) return
      const res = await run(spawnFn, gio, ['mount', '--', dev.root], SHORT_TIMEOUT_MS)
      if (res.code !== 0 && classify(res) !== 'ALREADY') {
        const err = new Error('MOUNT')
        err.kind = classify(res) === 'TIMEOUT' ? 'TIMEOUT' : 'MOUNT'
        throw err
      }
      dev.mounted = true
    },
    loc: (dev, segs) => (segs.length ? childUri(dev.root, segs) : dev.root),
    async list(loc) {
      return parseGioList(await must(['list', '-l', '-h', '-u', '-a', 'time::modified', '--', loc], LIST_TIMEOUT_MS))
    },
    async copyOut(loc, localFile) { await must(['copy', '--', loc, localFile], COPY_TIMEOUT_MS) },
    async copyIn(localFile, loc) { await must(['copy', '--', localFile, loc], COPY_TIMEOUT_MS) },
    async mkdir(loc) { await must(['mkdir', '--', loc], SHORT_TIMEOUT_MS) },
    async remove(loc) { await must(['remove', '--', loc], SHORT_TIMEOUT_MS) },
    async unmountAll() { /* gvfs 的掛載歸系統管，不替使用者卸載 */ }
  }
}

/** `simple-mtpfs --list-devices`：`1: Google Pixel 6a` */
function parseSimpleMtpfsList(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+):\s*(.+?)\s*$/.exec(line)
    if (m) out.push({ name: m[2], arg: ['--device', m[1]] })
  }
  return out
}

/** `jmtpfs -l`：`1, 5, 0x4ee1, 0x18d1, Pixel 6a, Google` */
function parseJmtpfsList(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const m = /^\s*(\d+),\s*(\d+),\s*0x[0-9a-f]+,\s*0x[0-9a-f]+,\s*(.*?),\s*(.*?)\s*$/i.exec(line)
    if (m) out.push({ name: `${m[4]} ${m[3]}`.trim(), arg: [`-device=${m[1]},${m[2]}`] })
  }
  return out
}

function createFuseTransport(deps = {}) {
  const spawnFn = deps.spawnFn || spawn
  const exists = deps.exists || ((p) => { try { return rawFs.existsSync(p) } catch { return false } })
  const fsp = deps.fsp || rawFs.promises
  const simple = firstExisting(SIMPLE_MTPFS, exists)
  const jmtpfs = simple ? '' : firstExisting(JMTPFS, exists)
  const tool = simple || jmtpfs
  const fusermount = firstExisting(FUSERMOUNT, exists)
  const base = deps.mountBase || path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), '.cache'), 'axondeck-mtp')
  const mounted = new Set()

  async function isMountPoint(dir) {
    try {
      const [a, b] = await Promise.all([fsp.stat(dir), fsp.stat(path.dirname(dir))])
      return a.dev !== b.dev
    } catch {
      return false
    }
  }

  return {
    kind: 'fuse',
    tool: simple ? 'simple-mtpfs' : (jmtpfs ? 'jmtpfs' : ''),
    async enumerate() {
      if (!tool) return []
      const res = await run(spawnFn, tool, simple ? ['--list-devices'] : ['-l'], SHORT_TIMEOUT_MS)
      const list = simple ? parseSimpleMtpfsList(res.stdout) : parseJmtpfsList(res.stdout)
      return list.map((d, i) => {
        const root = path.join(base, String(i + 1))
        return { name: d.name, root, mounted: mounted.has(root), type: '手機（MTP，FUSE）', arg: d.arg }
      })
    },
    async mount(dev) {
      if (dev.mounted || await isMountPoint(dev.root)) { dev.mounted = true; mounted.add(dev.root); return }
      await fsp.mkdir(dev.root, { recursive: true })
      const res = await run(spawnFn, tool, [...dev.arg, dev.root], SHORT_TIMEOUT_MS)
      if (res.code !== 0) {
        const err = new Error('MOUNT')
        err.kind = res.timedOut ? 'TIMEOUT' : 'MOUNT'
        throw err
      }
      dev.mounted = true
      mounted.add(dev.root)
    },
    loc: (dev, segs) => path.join(dev.root, ...segs),
    async list(loc) {
      const names = await fsp.readdir(loc)
      const out = []
      for (const name of names) {
        try {
          const st = await fsp.stat(path.join(loc, name))
          const dir = st.isDirectory()
          out.push({ name, dir, size: dir ? 0 : Number(st.size) || 0, mtimeMs: Number(st.mtimeMs) || 0 })
        } catch { /* 手機那邊剛好刪掉 */ }
      }
      return out
    },
    async copyOut(loc, localFile) { await fsp.copyFile(loc, localFile, rawFs.constants.COPYFILE_EXCL) },
    async copyIn(localFile, loc) { await fsp.copyFile(localFile, loc, rawFs.constants.COPYFILE_EXCL) },
    async mkdir(loc) { await fsp.mkdir(loc) },
    async remove(loc) {
      const st = await fsp.lstat(loc)
      if (st.isDirectory()) await fsp.rmdir(loc)
      else await fsp.unlink(loc)
    },
    /** 我們自己掛的才卸（App 結束時），別人掛的不碰 */
    async unmountAll() {
      if (!fusermount) return
      for (const dir of mounted) await run(spawnFn, fusermount, ['-u', '--', dir], SHORT_TIMEOUT_MS)
      mounted.clear()
    }
  }
}

/**
 * 看這台機器有什麼可用：gio＋gvfsd-mtp ＞ jmtpfs／simple-mtpfs ＞ 都沒有（附安裝說明）。
 * @returns {{ kind: 'gio'|'fuse'|'none', gio: boolean, gvfsMtp: boolean, fuseTool: string }}
 */
function detect(deps = {}) {
  const exists = deps.exists || ((p) => { try { return rawFs.existsSync(p) } catch { return false } })
  const gio = Boolean(firstExisting(GIO, exists))
  const gvfsMtp = Boolean(firstExisting(GVFSD_MTP, exists))
  const fuseTool = firstExisting(SIMPLE_MTPFS, exists) ? 'simple-mtpfs' : (firstExisting(JMTPFS, exists) ? 'jmtpfs' : '')
  const kind = gio && gvfsMtp ? 'gio' : (fuseTool ? 'fuse' : 'none')
  return { kind, gio, gvfsMtp, fuseTool }
}

module.exports = {
  GIO, GVFSD_MTP, SIMPLE_MTPFS, JMTPFS,
  run, parseMountList, parseGioList, parseSimpleMtpfsList, parseJmtpfsList, childUri, classify,
  createGioTransport, createFuseTransport, detect
}
