'use strict'

/**
 * Linux 前景視窗觀測（取代 Windows 的 axondeck-probe／observer.ps1）。每秒輪詢一次「前景視窗的 PID」，
 * 再從 /proc/<pid>/exe 取執行檔路徑與名稱，餵給 index.js 同一個 onTick（{ name, path, pid, idleMs }）。
 *
 * 前景 PID 的來源依工作階段自動挑（啟動時偵測一次）：
 * - X11：`xprop -root _NET_ACTIVE_WINDOW` → `xprop -id <wid> _NET_WM_PID`（視窗 → PID 有快取，平常每秒一支 xprop）
 * - Wayland／Hyprland：`hyprctl activewindow -j`
 * - Wayland／Sway：`swaymsg -t get_tree -r` 找 focused 節點
 * - Wayland／KDE Plasma：`kdotool getactivewindow getwindowpid`（要另裝 kdotool）
 * - Wayland／GNOME：Window Calls 擴充套件的 D-Bus `org.gnome.Shell.Extensions.Windows.List`；
 *   退而求其次 `org.gnome.Shell.Eval`（GNOME 41 起預設關閉，只有 unsafe mode 才行）
 * 都不行就回 supported:false 與原因，UI 照實顯示，不假裝在記。
 *
 * 閒置時間用 Electron `powerMonitor.getSystemIdleTime()`（X11 準；部分 Wayland 合成器一律回 0）。
 * 全部外部指令 `execFile`（不經 shell）、固定參數、1.5 秒逾時；上一輪還沒回來就跳過這一輪。
 */

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const INTERVAL_MS = 1000
const EXEC_TIMEOUT_MS = 1500
// 桌面／面板本身不算「在用某個 App」（等同 Windows 的 explorer 桌面）
const SHELL_NAMES = new Set(['gnome-shell', 'plasmashell', 'kwin_x11', 'kwin_wayland', 'xfdesktop', 'xfce4-panel',
  'xfwm4', 'plank', 'Xorg', 'Xwayland', 'mutter', 'cinnamon', 'budgie-panel', 'mate-panel', 'lxpanel', 'pcmanfm-desktop'])
const GNOME_DEST = ['--session', '--dest', 'org.gnome.Shell']
const WINDOW_CALLS = [...GNOME_DEST, '--object-path', '/org/gnome/Shell/Extensions/Windows', '--method', 'org.gnome.Shell.Extensions.Windows.List']
const GNOME_EVAL = [...GNOME_DEST, '--object-path', '/org/gnome/Shell', '--method', 'org.gnome.Shell.Eval',
  'global.display.focus_window ? String(global.display.focus_window.get_pid()) : "0"']

/** @param {string} name @param {Record<string,string|undefined>} env @param {typeof fs} fsImpl */
function hasCommand(name, env, fsImpl = fs) {
  return String(env.PATH || '').split(':').filter(Boolean).some((dir) => {
    try { fsImpl.accessSync(path.join(dir, name), fs.constants.X_OK); return true } catch { return false }
  })
}

/** `_NET_ACTIVE_WINDOW: window id # 0x2a00007` → '0x2a00007'；0x0／沒有 → '' */
function parseActiveWindow(out) {
  const match = /window id # (0x[0-9a-f]+)/i.exec(String(out))
  return match && !/^0x0+$/i.test(match[1]) ? match[1] : ''
}

/** `_NET_WM_PID = 1234` → 1234 */
function parseWmPid(out) {
  const match = /_NET_WM_PID(?:\(CARDINAL\))?\s*=\s*(\d+)/.exec(String(out))
  return match ? Number(match[1]) : 0
}

/** GVariant 文字格式 `('…',)`／`(true, '…')` 取出字串內容 */
function gvariantString(out) {
  const match = /'((?:[^'\\]|\\.)*)'/s.exec(String(out))
  return match ? match[1].replace(/\\(.)/gs, '$1') : null
}

function parseWindowCalls(out) {
  const text = gvariantString(out)
  if (text === null) return null
  try {
    const list = JSON.parse(text)
    if (!Array.isArray(list)) return null
    const focused = list.find((w) => w && (w.focus === true || w.has_focus === true))
    return focused ? Number(focused.pid) || 0 : 0
  } catch { return null }
}

/** `(true, '1234')` → 1234；`(false, '')`（GNOME 41+ 預設）→ null */
function parseGnomeEval(out) {
  if (!/^\s*\(true,/.test(String(out))) return null
  const text = gvariantString(out)
  return text !== null && /^\d+$/.test(text) ? Number(text) : null
}

function findSwayFocused(node) {
  if (!node || typeof node !== 'object') return 0
  if (node.focused && Number(node.pid) > 0) return Number(node.pid)
  for (const child of [...(node.nodes || []), ...(node.floating_nodes || [])]) {
    const pid = findSwayFocused(child)
    if (pid) return pid
  }
  return 0
}

/**
 * PID → { name, path }。路徑讀 /proc/<pid>/exe；別的使用者的程序讀不到就用 argv[0]（絕對路徑才收）。
 * @param {number} pid
 */
async function processInfo(pid, fsp = fs.promises) {
  if (!(pid > 0)) return { name: '', path: '' }
  let exe = ''
  try { exe = (await fsp.readlink(`/proc/${pid}/exe`)).replace(/ \(deleted\)$/, '') } catch {}
  if (!exe) {
    try {
      const argv0 = (await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0')[0]
      if (argv0.startsWith('/')) exe = argv0
    } catch {}
  }
  let name = exe ? path.basename(exe) : ''
  if (!name) {
    try { name = (await fsp.readFile(`/proc/${pid}/comm`, 'utf8')).trim() } catch {}
  }
  return { name: SHELL_NAMES.has(name) ? '' : name, path: exe }
}

function defaultIdleMs() {
  try {
    const { powerMonitor } = require('electron')
    return Math.max(0, Number(powerMonitor.getSystemIdleTime()) || 0) * 1000
  } catch { return 0 }
}

/**
 * @param {{
 *   onTick?: (info: { name: string, path: string, pid: number, idleMs: number }) => void,
 *   env?: Record<string, string|undefined>, execFileFn?: typeof execFile, fsImpl?: typeof fs,
 *   idleMs?: () => number, intervalMs?: number, readInfo?: (pid: number) => Promise<{ name: string, path: string }>
 * }} deps
 */
function createLinuxObserver(deps = {}) {
  const env = deps.env || process.env
  const execFileFn = deps.execFileFn || execFile
  const fsImpl = deps.fsImpl || fs
  const onTick = deps.onTick || (() => {})
  const idleMs = deps.idleMs || defaultIdleMs
  const readInfo = deps.readInfo || ((pid) => processInfo(pid))
  const intervalMs = deps.intervalMs || INTERVAL_MS
  /** @type {{ supported: boolean|null, backend: string, note: string }} */
  let support = { supported: null, backend: '', note: '' }
  let detecting = null
  let timer = null
  let busy = false
  let wanted = false
  const pidByWindow = new Map()

  const run = (cmd, args) => new Promise((resolve) => {
    try {
      execFileFn(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true },
        (error, stdout) => resolve(error ? null : String(stdout)))
    } catch { resolve(null) }
  })

  async function x11Pid() {
    const wid = parseActiveWindow(await run('xprop', ['-root', '-notype', '_NET_ACTIVE_WINDOW']))
    if (!wid) return 0
    if (pidByWindow.has(wid)) return pidByWindow.get(wid)
    const pid = parseWmPid(await run('xprop', ['-id', wid, '-notype', '_NET_WM_PID']))
    if (pidByWindow.size > 256) pidByWindow.clear()
    if (pid) pidByWindow.set(wid, pid)
    return pid
  }

  const BACKENDS = {
    x11: x11Pid,
    hyprland: async () => {
      try { return Number(JSON.parse(await run('hyprctl', ['activewindow', '-j']) || '{}').pid) || 0 } catch { return 0 }
    },
    sway: async () => {
      try { return findSwayFocused(JSON.parse(await run('swaymsg', ['-t', 'get_tree', '-r']) || '{}')) } catch { return 0 }
    },
    kdotool: async () => Number(String(await run('kdotool', ['getactivewindow', 'getwindowpid']) || '').trim()) || 0,
    'gnome-window-calls': async () => parseWindowCalls(await run('gdbus', ['call', ...WINDOW_CALLS])) || 0,
    'gnome-eval': async () => parseGnomeEval(await run('gdbus', ['call', ...GNOME_EVAL])) || 0
  }

  async function detectNow() {
    const has = (name) => hasCommand(name, env, fsImpl)
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!env.XDG_SESSION_TYPE && Boolean(env.WAYLAND_DISPLAY))
    const desktop = String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase()
    const ok = (backend) => ({ supported: true, backend, note: '' })
    const no = (note) => ({ supported: false, backend: '', note })
    if (!wayland) {
      if (!env.DISPLAY) return no('沒有圖形工作階段（DISPLAY／WAYLAND_DISPLAY 都沒有），無法觀測前景視窗。')
      if (!has('xprop')) return no('X11 需要 xprop 才能觀測前景視窗：請安裝 x11-utils（Debian／Ubuntu）或 xorg-xprop（Arch）／xprop（Fedora）。')
      return ok('x11')
    }
    if (env.HYPRLAND_INSTANCE_SIGNATURE && has('hyprctl')) return ok('hyprland')
    if (env.SWAYSOCK && has('swaymsg')) return ok('sway')
    if (desktop.includes('kde') || desktop.includes('plasma')) {
      if (has('kdotool')) return ok('kdotool')
      return no('KDE Plasma（Wayland）需要安裝 kdotool 才能觀測前景視窗；或改用 X11 工作階段。')
    }
    if (desktop.includes('gnome') || desktop.includes('ubuntu')) {
      if (!has('gdbus')) return no('GNOME（Wayland）需要 gdbus（libglib2.0-bin）才能觀測前景視窗。')
      if (parseWindowCalls(await run('gdbus', ['call', ...WINDOW_CALLS])) !== null) return ok('gnome-window-calls')
      if (parseGnomeEval(await run('gdbus', ['call', ...GNOME_EVAL])) !== null) return ok('gnome-eval')
      return no('GNOME（Wayland）不開放查詢前景視窗：請安裝「Window Calls」擴充套件（extensions.gnome.org），或改用 X11 工作階段。')
    }
    return no(`這個 Wayland 桌面（${desktop || '未知'}）沒有可用的前景視窗查詢方式；目前支援 X11、GNOME（Window Calls）、KDE（kdotool）、Hyprland、Sway。`)
  }

  function detect() {
    if (!detecting) detecting = detectNow().then((result) => { support = result; return result })
    return detecting
  }

  async function tick() {
    if (busy || !timer) return
    busy = true
    try {
      const pid = await BACKENDS[support.backend]()
      const info = await readInfo(pid)
      if (timer) onTick({ name: info.name, path: info.path, pid, idleMs: idleMs() })
    } catch { /* 這一輪丟掉 */ } finally { busy = false }
  }

  function start() {
    wanted = true
    detect().then((result) => {
      if (!wanted || timer || !result.supported) return
      timer = setInterval(tick, intervalMs)
    })
  }

  function stop() {
    wanted = false
    if (timer) clearInterval(timer)
    timer = null
    pidByWindow.clear()
  }

  return {
    start,
    stop,
    detect,
    get running() { return Boolean(timer) },
    get support() { return { ...support } }
  }
}

module.exports = {
  createLinuxObserver,
  processInfo,
  hasCommand,
  parseActiveWindow,
  parseWmPid,
  parseWindowCalls,
  parseGnomeEval,
  findSwayFocused,
  SHELL_NAMES
}
