'use strict'

/**
 * Linux 平台小工具：POSIX 路徑判斷、掛載點列舉、XDG Trash 位置。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** 虛擬檔案系統／無用掛載，不進「本機」磁碟清單 */
const SKIP_FS = new Set([
  'autofs', 'binfmt_misc', 'bpf', 'cgroup', 'cgroup2', 'configfs', 'debugfs',
  'devpts', 'devtmpfs', 'efivarfs', 'fusectl', 'hugetlbfs', 'mqueue', 'proc',
  'pstore', 'rpc_pipefs', 'securityfs', 'sysfs', 'tmpfs', 'tracefs',
  'nsfs', 'ramfs', 'overlay'
])

function fallbackRoot() {
  return '/'
}

function looksAbsolute(raw) {
  return typeof raw === 'string' && raw.startsWith('/')
}

/**
 * XDG 使用者回收筒。
 * @returns {{ files: string, info: string }}
 */
function trashDirs() {
  const data = process.env.XDG_DATA_HOME
    || path.join(os.homedir() || '/tmp', '.local', 'share')
  const root = path.join(data, 'Trash')
  return {
    files: path.join(root, 'files'),
    info: path.join(root, 'info')
  }
}

/**
 * 從 /proc/self/mountinfo 讀掛載點（失敗時退回 / 與家目錄）。
 * @returns {Array<{ path: string, fs: string, source: string }>}
 */
function readMounts() {
  let text = ''
  try {
    text = fs.readFileSync('/proc/self/mountinfo', 'utf8')
  } catch {
    try {
      text = fs.readFileSync('/proc/mounts', 'utf8')
    } catch {
      return [{ path: '/', fs: '', source: '' }]
    }
  }
  /** @type {Map<string, { path: string, fs: string, source: string }>} */
  const byPath = new Map()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    // mountinfo: … - fstype source superopts
    // mounts: source mountpoint fstype …
    let mountPoint = ''
    let fstype = ''
    let source = ''
    if (line.includes(' - ')) {
      const [left, right] = line.split(' - ')
      const leftParts = left.split(' ')
      mountPoint = unescapeMount(leftParts[4] || '')
      const rightParts = right.trim().split(' ')
      fstype = rightParts[0] || ''
      source = rightParts[1] || ''
    } else {
      const parts = line.split(/\s+/)
      source = unescapeMount(parts[0] || '')
      mountPoint = unescapeMount(parts[1] || '')
      fstype = parts[2] || ''
    }
    if (!mountPoint.startsWith('/')) continue
    // 虛擬 FS 略過；但 `/` 即使是 overlay（容器）也要留，否則本機清單會空
    if (SKIP_FS.has(fstype) && mountPoint !== '/') continue
    const keep = mountPoint === '/'
      || mountPoint === '/home'
      || mountPoint.startsWith('/mnt/')
      || mountPoint.startsWith('/media/')
      || mountPoint.startsWith('/run/media/')
      || (source.startsWith('/dev/') && mountPoint !== '/boot' && !mountPoint.startsWith('/boot/'))
    if (!keep) continue
    byPath.set(mountPoint, { path: mountPoint, fs: fstype, source })
  }
  if (!byPath.has('/')) byPath.set('/', { path: '/', fs: '', source: '' })
  const home = os.homedir()
  if (home && home.startsWith('/') && !byPath.has(home)) {
    // 家目錄若不是獨立掛載，仍列成快捷磁碟列會重複；只在 listPlaces 出現即可
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/** mountinfo 把空白寫成 \040 */
function unescapeMount(value) {
  return String(value || '')
    .replace(/\\040/g, ' ')
    .replace(/\\011/g, '\t')
    .replace(/\\012/g, '\n')
    .replace(/\\134/g, '\\')
}

/**
 * 側欄／本機首頁用的短 id（對應 Windows 的 letter，但不帶冒號語意）。
 * @param {string} mountPath
 * @returns {string}
 */
function mountLetter(mountPath) {
  if (mountPath === '/') return 'root'
  const base = path.basename(mountPath) || 'disk'
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'disk'
  return safe.slice(0, 24)
}

module.exports = {
  id: 'linux',
  fallbackRoot,
  looksAbsolute,
  trashDirs,
  readMounts,
  mountLetter,
  SKIP_FS
}
