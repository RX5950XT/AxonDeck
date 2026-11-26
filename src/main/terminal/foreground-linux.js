'use strict'

/**
 * Linux 抬窗：終端機 Ctrl+G 開出的編輯器／GUI 要跳到最前面。
 * X11 用 wmctrl／xdotool／xprop；KDE Wayland 用 kdotool 或 KWin D-Bus；
 * GNOME Wayland 盡力走 Window Calls／Shell.Eval；Hyprland／Sway 用各自的 CLI。
 */

const { execFile } = require('child_process')
const path = require('path')

const DEFAULT_TIMEOUT_MS = 4000
const POLL_MS = 150
const EXEC_TIMEOUT_MS = 2000

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ execFileFn?: typeof execFile }} [deps]
 * @returns {Promise<string|null>}
 */
function run(cmd, args, deps = {}) {
  const execFileFn = deps.execFileFn || execFile
  return new Promise((resolve) => {
    try {
      execFileFn(cmd, args, {
        timeout: deps.execTimeoutMs || EXEC_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true
      }, (error, stdout) => resolve(error ? null : String(stdout || '')))
    } catch {
      resolve(null)
    }
  })
}

function hasCommand(name, env = process.env, exists = null) {
  const ok = exists || ((p) => {
    try { return require('fs').existsSync(p) } catch { return false }
  })
  if (path.isAbsolute(name)) return ok(name)
  for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (ok(path.join(dir, name))) return true
  }
  return false
}

/** `0x02a00003  0 1234 hostname Title` */
function parseWmctrlList(stdout) {
  const rows = []
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(0x[0-9a-fA-F]+)\s+\S+\s+(\d+)\s+\S+\s+(.*)$/)
    if (!m) continue
    rows.push({ id: m[1], pid: Number(m[2]) || 0, title: m[3] || '', cls: '' })
  }
  return rows
}

function parseXdotoolSearch(stdout) {
  return String(stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s) || /^0x/i.test(s))
}

function isWayland(env = process.env) {
  return env.XDG_SESSION_TYPE === 'wayland' || (!env.XDG_SESSION_TYPE && Boolean(env.WAYLAND_DISPLAY))
}

function desktopName(env = process.env) {
  return String(env.XDG_CURRENT_DESKTOP || env.DESKTOP_SESSION || '').toLowerCase()
}

/**
 * @param {string} name
 * @param {string[]} reuse
 */
function isReuseProcess(name, reuse) {
  const n = String(name || '').toLowerCase().replace(/\.exe$/i, '')
  return reuse.some((item) => n === item || n.startsWith(item + ' ') || n.endsWith(' ' + item) || n.includes(item))
}

/**
 * 新視窗：id 沒見過；或同一 id 標題變了且程序名在重用清單裡。
 * @param {{ id: string, pid?: number, title?: string, cls?: string }[]} before
 * @param {{ id: string, pid?: number, title?: string, cls?: string }[]} after
 * @param {string[]} reuse
 */
function pickNewWindows(before, after, reuse) {
  const prev = new Map(before.map((w) => [w.id, w]))
  const hits = []
  for (const win of after) {
    const old = prev.get(win.id)
    if (!old) {
      hits.push(win)
      continue
    }
    if (old.title !== win.title && isReuseProcess(win.cls || win.title, reuse)) hits.push(win)
  }
  return hits
}

/**
 * @param {object} [deps]
 * @returns {Promise<{ backend: string, list: () => Promise<object[]>, raise: (win: object) => Promise<boolean> }>}
 */
async function createBackend(deps = {}) {
  const env = deps.env || process.env
  const call = (cmd, args) => (deps.run || run)(cmd, args, deps)
  const exists = deps.exists
  const has = (name) => (deps.hasCommand || hasCommand)(name, env, exists)
  const wmctrl = {
    backend: 'wmctrl',
    async list() { return parseWmctrlList(await call('wmctrl', ['-lp'])) },
    async raise(win) { return (await call('wmctrl', ['-i', '-a', String(win.id)])) !== null }
  }
  const xdotool = {
    backend: 'xdotool',
    async list() {
      const ids = parseXdotoolSearch(await call('xdotool', ['search', '--name', '']))
      const rows = []
      for (const id of ids.slice(0, 64)) {
        const title = ((await call('xdotool', ['getwindowname', id])) || '').trim()
        const pid = Number(((await call('xdotool', ['getwindowpid', id])) || '').trim()) || 0
        rows.push({ id, pid, title, cls: '' })
      }
      return rows
    },
    async raise(win) { return (await call('xdotool', ['windowactivate', String(win.id)])) !== null }
  }
  const kdotool = {
    backend: 'kdotool',
    async list() {
      const raw = await call('kdotool', ['search', ''])
      const ids = String(raw || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      const rows = []
      for (const id of ids.slice(0, 64)) {
        const title = ((await call('kdotool', ['getwindowname', id])) || '').trim()
        const pid = Number(((await call('kdotool', ['getwindowpid', id])) || '').trim()) || 0
        rows.push({ id, pid, title, cls: '' })
      }
      return rows
    },
    async raise(win) { return (await call('kdotool', ['windowactivate', String(win.id)])) !== null }
  }
  const kwin = {
    backend: 'kwin-script',
    async list() {
      const ev = await call('gdbus', [
        'call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting',
        '--method', 'org.kde.kwin.Scripting.interactiveEvaluate',
        'print("AXD_WINS=" + JSON.stringify((workspace.windowList ? workspace.windowList() : (workspace.clientList ? workspace.clientList() : [])).map(function(w){return {id:String(w.internalId||w.windowId||w.frameId||""),pid:w.pid||0,title:String(w.caption||w.resourceName||""),cls:String(w.resourceClass||"")}})))'
      ])
      const m = String(ev || '').match(/AXD_WINS=(\[.*\])/)
      if (!m) return []
      try { return JSON.parse(m[1]) } catch { return [] }
    },
    async raise(win) {
      const script = `var id=${JSON.stringify(String(win.id))};var list=workspace.windowList?workspace.windowList():(workspace.clientList?workspace.clientList():[]);for(var i=0;i<list.length;i++){var w=list[i];if(String(w.internalId||w.windowId||w.frameId||"")===id){if(workspace.activeWindow!==undefined)workspace.activeWindow=w;else if(workspace.activeClient!==undefined)workspace.activeClient=w;if(w.min===true)w.min=false;print("AXD_RAISE=1");break;}}`
      const ev = await call('gdbus', [
        'call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/Scripting',
        '--method', 'org.kde.kwin.Scripting.interactiveEvaluate', script
      ])
      return /AXD_RAISE=1/.test(String(ev || ''))
    }
  }
  const gnome = {
    backend: 'gnome-window-calls',
    async list() {
      const ev = await call('gdbus', [
        'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows',
        '--method', 'org.gnome.Shell.Extensions.Windows.List'
      ])
      let data = []
      try {
        const inner = String(ev || '').match(/'([\s\S]*)'/) || String(ev || '').match(/"([\s\S]*)"/) || String(ev || '').match(/(\[[\s\S]*\])/)
        data = JSON.parse((inner && inner[1]) || '[]')
      } catch { data = [] }
      return (Array.isArray(data) ? data : []).map((w) => ({
        id: String(w.id ?? w.windowId ?? ''),
        pid: Number(w.pid) || 0,
        title: String(w.title || w.wm_class || ''),
        cls: String(w.wm_class || w.wmclass || '')
      })).filter((w) => w.id)
    },
    async raise(win) {
      const ev = await call('gdbus', [
        'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell/Extensions/Windows',
        '--method', 'org.gnome.Shell.Extensions.Windows.Activate', String(win.id)
      ])
      if (ev !== null) return true
      const evalScript = `global.get_window_actors().map(a=>a.meta_window).some(w=>{if(String(w.get_id())===${JSON.stringify(String(win.id))}){w.activate(global.get_current_time());return true}return false})`
      const ev2 = await call('gdbus', [
        'call', '--session', '--dest', 'org.gnome.Shell', '--object-path', '/org/gnome/Shell',
        '--method', 'org.gnome.Shell.Eval', evalScript
      ])
      return ev2 !== null && !/false,?\s*''/.test(String(ev2))
    }
  }
  const hypr = {
    backend: 'hyprland',
    async list() {
      let data
      try { data = JSON.parse((await call('hyprctl', ['clients', '-j'])) || '[]') } catch { return [] }
      return (Array.isArray(data) ? data : []).map((w) => ({
        id: String(w.address || w.workspace?.id || ''),
        pid: Number(w.pid) || 0,
        title: String(w.title || ''),
        cls: String(w.class || '')
      })).filter((w) => w.id)
    },
    async raise(win) {
      return (await call('hyprctl', ['dispatch', 'focuswindow', `address:${win.id}`])) !== null
    }
  }
  const sway = {
    backend: 'sway',
    async list() {
      let tree
      try { tree = JSON.parse((await call('swaymsg', ['-t', 'get_tree', '-r'])) || '{}') } catch { return [] }
      const rows = []
      const walk = (node) => {
        if (!node || typeof node !== 'object') return
        if (node.id && (node.type === 'con' || node.type === 'floating_con') && node.name) {
          rows.push({
            id: String(node.id),
            pid: Number(node.pid) || 0,
            title: String(node.name || ''),
            cls: String(node.app_id || node.window_properties?.class || '')
          })
        }
        for (const child of node.nodes || []) walk(child)
        for (const child of node.floating_nodes || []) walk(child)
      }
      walk(tree)
      return rows
    },
    async raise(win) {
      return (await call('swaymsg', ['[con_id=' + String(win.id) + ']', 'focus'])) !== null
    }
  }

  if (deps.backend) {
    const map = { wmctrl, xdotool, kdotool, 'kwin-script': kwin, 'gnome-window-calls': gnome, hyprland: hypr, sway }
    if (map[deps.backend]) return map[deps.backend]
  }

  if (isWayland(env)) {
    if (env.HYPRLAND_INSTANCE_SIGNATURE && has('hyprctl')) return hypr
    if (env.SWAYSOCK && has('swaymsg')) return sway
    const desk = desktopName(env)
    if (desk.includes('kde') || desk.includes('plasma')) {
      if (has('kdotool')) return kdotool
      if (has('gdbus')) return kwin
    }
    if (desk.includes('gnome') || desk.includes('ubuntu')) {
      if (has('gdbus')) return gnome
    }
    // Wayland 上 wmctrl 通常無效，但有時 XWayland 視窗仍可用
    if (has('wmctrl')) return wmctrl
    if (has('xdotool')) return xdotool
    return { backend: '', list: async () => [], raise: async () => false }
  }

  if (has('wmctrl')) return wmctrl
  if (has('xdotool')) return xdotool
  return { backend: '', list: async () => [], raise: async () => false }
}

/**
 * @param {{ before: object[], after: object[], reuse?: string[] }} input
 */
function detectRaiseTargets(input) {
  return pickNewWindows(input.before || [], input.after || [], input.reuse || [])
}

/**
 * @param {object} [deps]
 * @returns {Promise<boolean>} 有沒有真的開始等
 */
async function startWaiter(deps = {}) {
  const backend = await createBackend(deps)
  if (!backend.backend) return false
  const reuse = deps.reuse || []
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = deps.pollMs ?? POLL_MS
  const before = await backend.list()
  const started = Date.now()
  const tick = async () => {
    if (Date.now() - started > timeoutMs) return false
    const after = await backend.list()
    const hits = pickNewWindows(before, after, reuse)
    if (hits.length) {
      let ok = false
      for (const win of hits) {
        if (await backend.raise(win)) ok = true
      }
      return ok
    }
    await new Promise((r) => setTimeout(r, pollMs))
    return tick()
  }
  const running = tick().catch(() => false)
  if (deps.wait === true) return running
  return true
}

module.exports = {
  run,
  hasCommand,
  parseWmctrlList,
  pickNewWindows,
  isReuseProcess,
  detectRaiseTargets,
  createBackend,
  startWaiter,
  DEFAULT_TIMEOUT_MS,
  POLL_MS
}
