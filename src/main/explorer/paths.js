'use strict'

/**
 * 整機檔案總管的唯一路徑入口（Main Process）。
 *
 * Windows：磁碟機字母 + 嚴格 UNC（`\\伺服器\分享\…`）；不收 `\\.\`／`\\?\`／pipe／ADS。
 * Linux：POSIX 絕對路徑（`/` 開頭）；不收相對路徑與 `~`。
 *
 * `realpath` 只當「目標仍在允許範圍」的檢查，回傳值是使用者給的路徑，不把 symlink 換成目標。
 */

const fs = require('../raw-fs')
const fsp = require('../raw-fs').promises
const path = require('path')
const os = require('os')
const platform = require('../platform')

const DRIVE_ABS = /^[A-Za-z]:\\/
const POSIX_ABS = /^\//
const MAX_PATH = 32767
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/
const IPV4 = /^(\d{1,3})(\.(\d{1,3})){3}$/

/** Linux 根與常見系統目錄本身不准刪／改名／搬（子項交給 OS 權限）。 */
const LINUX_LOCKED = new Set(['/', '/boot', '/dev', '/etc', '/proc', '/run', '/sys', '/usr', '/var'])

/**
 * @param {string} code
 * @param {string} message
 * @returns {Error}
 */
function fail(code, message) {
  const error = new Error(code)
  error.code = code
  error.userMessage = message
  return error
}

/**
 * 新增／改名用的單層名字。
 * @param {unknown} raw
 * @returns {string}
 */
function checkName(raw) {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!name || name.length > 255) throw fail('BAD_NAME', '名稱不合法')
  if (name === '.' || name === '..') throw fail('BAD_NAME', '名稱不合法')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) throw fail('BAD_NAME', '名稱不合法')
  if (platform.isWindows) {
    // eslint-disable-next-line no-control-regex
    if (/[\\/:*?"<>|]/.test(name)) {
      throw fail('BAD_NAME', '名稱不能含 \\ / : * ? " < > | 這些字元')
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) {
      throw fail('BAD_NAME', '這是 Windows 的保留名稱')
    }
    if (/[. ]$/.test(name)) throw fail('BAD_NAME', '名稱不能以句點或空白結尾')
  } else if (/[\/]/.test(name)) {
    throw fail('BAD_NAME', '名稱不能含 /')
  }
  return name
}

/**
 * @param {string} target
 * @returns {string}
 */
function realOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return ''
  }
}

/**
 * @param {string} s
 * @returns {boolean}
 */
function isDevicePath(s) {
  const lower = String(s || '').toLowerCase()
  if (lower.startsWith('\\\\.\\') || lower.startsWith('\\\\?\\')) return true
  return /^\\\\[^\\]+\\(pipe|mailslot)(\\|$)/i.test(s)
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isServerName(name) {
  if (IPV4.test(name)) {
    return name.split('.').every((n) => {
      const v = Number(n)
      return v >= 0 && v <= 255
    })
  }
  return SERVER_NAME.test(name)
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function isUnc(raw) {
  return typeof raw === 'string' && raw.startsWith('\\\\') && !isDevicePath(raw)
}

/**
 * @param {string} s 已把 / 換成 \
 * @returns {string}
 */
function resolveUnc(s) {
  if (isDevicePath(s)) throw fail('BAD_PATH', '路徑不合法')
  if (s.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
  const parts = s.replace(/^\\\\/, '').split('\\').filter(Boolean)
  if (parts.length < 2) throw fail('BAD_PATH', '路徑不合法')
  const server = parts[0]
  const share = parts[1]
  if (!isServerName(server)) throw fail('BAD_PATH', '路徑不合法')
  if (/^(pipe|mailslot)$/i.test(share)) throw fail('BAD_PATH', '路徑不合法')
  const rest = []
  for (const part of parts.slice(2)) {
    if (part === '.') continue
    if (part === '..') {
      if (!rest.length) throw fail('BAD_PATH', '路徑不合法')
      rest.pop()
      continue
    }
    // eslint-disable-next-line no-control-regex
    if (/[<>:"/|?*\u0000-\u001f]/.test(part) || /[<>:"/|?*\u0000-\u001f]/.test(share)) {
      throw fail('BAD_PATH', '路徑不合法')
    }
    rest.push(part)
  }
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/|?*\u0000-\u001f]/.test(share)) throw fail('BAD_PATH', '路徑不合法')
  const full = `\\\\${server}\\${share}${rest.length ? '\\' + rest.join('\\') : ''}`
  if (full.length > MAX_PATH) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * 上一層。磁碟根／UNC 分享根／POSIX `/` 回空字串。
 * @param {string} full
 * @returns {string}
 */
function parentOf(full) {
  const value = String(full || '')
  if (platform.isWindows || value.startsWith('\\\\') || DRIVE_ABS.test(value.replace(/\//g, '\\'))) {
    if (value.startsWith('\\\\')) {
      const parts = value.replace(/\\+$/, '').replace(/^\\\\/, '').split('\\').filter(Boolean)
      if (parts.length <= 2) return ''
      return `\\\\${parts.slice(0, -1).join('\\')}`
    }
    const trimmed = value.replace(/\\+$/, '')
    const parent = trimmed.replace(/\\[^\\]+$/, '')
    if (/^[A-Za-z]:$/.test(parent)) return `${parent}\\`
    return parent
  }
  if (value === '/') return ''
  const trimmed = value.replace(/\/+$/, '') || '/'
  if (trimmed === '/') return ''
  const parent = path.posix.dirname(trimmed)
  return parent === trimmed ? '' : parent
}

/**
 * @param {string} full
 * @returns {boolean}
 */
function isAllowedAbs(full) {
  if (typeof full !== 'string' || !full) return false
  if (platform.isWindows || full.startsWith('\\\\')) {
    if (full.startsWith('\\\\')) {
      try {
        return resolveUnc(full) === full || resolveUnc(full).toLowerCase() === full.toLowerCase()
      } catch {
        return false
      }
    }
    return DRIVE_ABS.test(full) && full.indexOf(':', 2) === -1
  }
  if (!POSIX_ABS.test(full)) return false
  if (full.includes('\0')) return false
  // 正規化後仍須是絕對路徑，且不含 `..` 逃出
  try {
    const resolved = path.posix.resolve(full)
    return resolved.startsWith('/') && !resolved.split('/').includes('..')
  } catch {
    return false
  }
}

/**
 * 正規化成平台絕對路徑。不碰磁碟。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveAbs(raw) {
  if (typeof raw !== 'string' || !raw) throw fail('BAD_PATH', '路徑不合法')
  if (raw.includes('\0')) throw fail('BAD_PATH', '路徑不合法')
  if (raw.length > MAX_PATH) throw fail('BAD_PATH', '路徑不合法')

  if (platform.isWindows) {
    const s = raw.replace(/\//g, '\\')
    if (s.startsWith('\\\\')) return resolveUnc(s)
    if (!DRIVE_ABS.test(s)) throw fail('BAD_PATH', '路徑不合法')
    if (s.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
    let full
    try {
      full = path.win32.resolve(s)
    } catch {
      throw fail('BAD_PATH', '路徑不合法')
    }
    if (!DRIVE_ABS.test(full)) throw fail('BAD_PATH', '路徑不合法')
    if (full.indexOf(':', 2) !== -1) throw fail('BAD_PATH', '路徑不合法')
    if (full.startsWith('\\\\')) throw fail('BAD_PATH', '路徑不合法')
    return full
  }

  // Linux／其他 POSIX：只收絕對路徑
  if (!raw.startsWith('/')) throw fail('BAD_PATH', '路徑不合法')
  let full
  try {
    full = path.posix.resolve(raw)
  } catch {
    throw fail('BAD_PATH', '路徑不合法')
  }
  if (!full.startsWith('/')) throw fail('BAD_PATH', '路徑不合法')
  if (full.length > MAX_PATH) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * 目標必須存在。回傳使用者路徑（不跟 symlink）。
 * @param {unknown} raw
 * @returns {string}
 */
function resolveExisting(raw) {
  const full = resolveAbs(raw)
  let st
  try {
    st = fs.lstatSync(full)
  } catch {
    throw fail('NOT_FOUND', '找不到這個檔案')
  }
  if (!st) throw fail('NOT_FOUND', '找不到這個檔案')
  const real = realOf(full)
  if (real && !isAllowedAbs(real)) throw fail('BAD_PATH', '路徑不合法')
  return full
}

/**
 * @param {string} full
 * @returns {boolean}
 */
function isSystemLocked(full) {
  if (platform.isWindows) {
    const resolved = path.win32.resolve(full).replace(/[\\/]+$/, '')
    const lower = resolved.toLowerCase()
    if (/^[a-z]:$/i.test(lower)) return true
    const windir = String(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
    return lower === windir
  }
  const resolved = path.posix.resolve(full).replace(/\/+$/, '') || '/'
  return LINUX_LOCKED.has(resolved)
}

/**
 * @param {string} full
 */
function assertCreatable(full) {
  if (isSystemLocked(full)) throw fail('PROTECTED', '這個位置不能改')
}

/**
 * @param {string} full
 */
async function removeLinkOrTree(full) {
  let st
  try {
    st = await fsp.lstat(full)
  } catch {
    throw fail('NOT_FOUND', '找不到這個檔案')
  }
  if (st.isSymbolicLink()) {
    try {
      await fsp.unlink(full)
    } catch {
      await fsp.rmdir(full)
    }
    return
  }
  if (!st.isDirectory()) {
    await fsp.unlink(full)
    return
  }
  const kids = await fsp.readdir(full, { withFileTypes: true })
  for (const kid of kids) {
    await removeLinkOrTree(path.join(full, kid.name))
  }
  await fsp.rmdir(full)
}

/**
 * 刪／改名／搬移不准動的位置。
 * @param {string} full
 * @returns {boolean}
 */
function isProtected(full) {
  let home = ''
  try {
    home = path.resolve(os.homedir())
  } catch {
    home = ''
  }
  if (platform.isWindows) {
    const resolved = path.win32.resolve(full).replace(/[\\/]+$/, '')
    const lower = resolved.toLowerCase()
    if (/^[a-z]:$/i.test(lower)) return true
    if (home && lower === home.toLowerCase()) return true
    const windir = String(process.env.SystemRoot || 'C:\\Windows').replace(/[\\/]+$/, '').toLowerCase()
    return lower === windir
  }
  const resolved = path.posix.resolve(full).replace(/\/+$/, '') || '/'
  if (LINUX_LOCKED.has(resolved)) return true
  if (home && resolved === path.posix.resolve(home)) return true
  return false
}

/**
 * @param {string} full
 */
function assertMutable(full) {
  if (isProtected(full)) throw fail('PROTECTED', '這個位置不能改')
}

module.exports = {
  DRIVE_ABS,
  POSIX_ABS,
  MAX_PATH,
  fail,
  checkName,
  realOf,
  isUnc,
  isDevicePath,
  parentOf,
  isAllowedAbs,
  resolveAbs,
  resolveExisting,
  isProtected,
  isSystemLocked,
  assertMutable,
  assertCreatable,
  removeLinkOrTree
}
