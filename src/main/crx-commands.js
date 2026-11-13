'use strict'
/**
 * 擴充功能的鍵盤快速鍵（chrome.commands）：manifest 的 `commands` 加上使用者在管理頁改的（存在 extension-state.json 的 `commands`）。
 * 瀏覽器分頁裡按下去：`_execute_action` 開工具列 popup，其他送 `commands.onCommand`；範圍選「全域」的改用 globalShortcut。
 * 快捷鍵規則照 Chrome：要有 Ctrl 或 Alt（不能兩個一起），可加 Shift；媒體鍵單按。
 */
const { globalShortcut, BrowserWindow } = require('electron')

const ACTIONS = { 3: '_execute_action', 2: '_execute_browser_action' }
const MEDIA = ['MediaNextTrack', 'MediaPlayPause', 'MediaPrevTrack', 'MediaStop']
const NAMED = ['Comma', 'Period', 'Home', 'End', 'PageUp', 'PageDown', 'Space', 'Insert', 'Delete', 'Up', 'Down', 'Left', 'Right', ...MEDIA]
/** KeyboardEvent.code → Chrome 的鍵名（用 code 才不受輸入法、Shift 影響） */
const CODE_KEYS = { Comma: 'Comma', Period: 'Period', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Space: 'Space',
  Insert: 'Insert', Delete: 'Delete', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  MediaTrackNext: 'MediaNextTrack', MediaPlayPause: 'MediaPlayPause', MediaTrackPrevious: 'MediaPrevTrack', MediaStop: 'MediaStop' }
const ACCELERATOR_KEYS = { Comma: ',', Period: '.', MediaPrevTrack: 'MediaPreviousTrack' }

/** Chrome 的快捷鍵字串 → 固定寫法（Ctrl+Alt+Shift+鍵）；不合規則回 '' */
function normalizeShortcut(value) {
  const mods = new Set()
  let key = ''
  for (const part of String(value || '').split('+').map((s) => s.trim()).filter(Boolean)) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') mods.add('Ctrl')
    else if (lower === 'alt') mods.add('Alt')
    else if (lower === 'shift') mods.add('Shift')
    else if (key) return ''
    else key = /^[a-z0-9]$/i.test(part) ? part.toUpperCase() : (NAMED.find((n) => n.toLowerCase() === lower) || '')
  }
  if (!key) return ''
  if (MEDIA.includes(key) ? mods.size : (mods.has('Ctrl') === mods.has('Alt'))) return ''
  return [...['Ctrl', 'Alt', 'Shift'].filter((m) => mods.has(m)), key].join('+')
}

/** 按鍵事件（before-input-event 的 input，或頁面送來的 { code, control, alt, shift }）→ 快捷鍵；不是合法組合回 '' */
function shortcutFromInput(input) {
  if (!input || input.meta) return ''
  const code = String(input.code || '')
  const key = CODE_KEYS[code] || /^Key([A-Z])$/.exec(code)?.[1] || /^Digit(\d)$/.exec(code)?.[1] || ''
  if (!key) return ''
  return normalizeShortcut([input.control && 'Ctrl', input.alt && 'Alt', input.shift && 'Shift', key].filter(Boolean).join('+'))
}

const toAccelerator = (shortcut) => shortcut.split('+').map((k) => ACCELERATOR_KEYS[k] || k).join('+')
const isAction = (name) => Object.values(ACTIONS).includes(name) || name === '_execute_page_action'

/**
 * manifest → [{ name, description, suggested }]；開 popup 那條排第一，其他 `_execute_*` 不支援就不列。
 * 有工具列圖示的擴充功能就算沒寫 commands 也有「啟用擴充功能」可設（跟 Chrome、Edge 一樣）。
 */
function manifestCommands(manifest) {
  const declared = manifest?.commands && typeof manifest.commands === 'object' && !Array.isArray(manifest.commands) ? manifest.commands : {}
  const action = manifest?.manifest_version === 3 ? ACTIONS[3] : (manifest?.browser_action ? ACTIONS[2] : '_execute_page_action')
  const hasAction = !!(manifest?.manifest_version === 3 ? manifest.action : (manifest?.browser_action || manifest?.page_action))
  const commands = hasAction && !declared[action] ? { [action]: {}, ...declared } : declared
  return Object.entries(commands)
    .filter(([name, details]) => details && typeof details === 'object' && (name === action || (!name.startsWith('_execute_') && details.description)))
    .map(([name, details]) => {
      const suggested = details.suggested_key
      return { name, description: String(details.description || '').slice(0, 200),
        suggested: normalizeShortcut(typeof suggested === 'string' ? suggested : (suggested?.windows ?? suggested?.default)) }
    })
    .sort((a, b) => Number(isAction(b.name)) - Number(isAction(a.name)))
}

/**
 * 每個擴充功能每條指令現在的快捷鍵。使用者設過的優先；沒設過的拿 manifest 建議鍵，被別人占走就空著（跟 Chrome 一樣）。
 * @param {{ id: string, commands?: ReturnType<typeof manifestCommands> }[]} rows
 * @param {(id: string) => Record<string, { key: string, global?: boolean }> | undefined} savedOf
 */
function assignShortcuts(rows, savedOf) {
  const taken = new Set()
  for (const row of rows) for (const c of row.commands || []) { const key = savedOf(row.id)?.[c.name]?.key; if (key) taken.add(key) }
  const out = new Map()
  for (const row of rows) {
    out.set(row.id, (row.commands || []).map((c) => {
      const own = savedOf(row.id)?.[c.name]
      let key = own ? own.key : ''
      if (!own && c.suggested && !taken.has(c.suggested)) { key = c.suggested; taken.add(key) }
      return { name: c.name, description: c.description || (isAction(c.name) ? '啟用擴充功能' : c.name), key, global: !!(key && own?.global) }
    }))
  }
  return out
}

/**
 * @param {{ crx: any, session: Electron.Session, rows: () => any[], savedOf: (id: string) => any,
 *   openPopup: (extensionId: string, tab: Electron.WebContents) => void, skip: (url: string) => boolean }} opts
 */
function createCommands({ crx, session, rows, savedOf, openPopup, skip }) {
  let table = new Map()
  const registered = new Set()
  const tracked = new WeakSet()
  let lastTab = null

  function run({ id, name, global }, tab) {
    if (!session.extensions.getExtension(id)) return
    const alive = tab && !tab.isDestroyed() ? tab : null
    if (isAction(name)) {
      if (!alive) return
      if (global) {
        const win = BrowserWindow.fromWebContents(alive.hostWebContents || alive)
        if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
      }
      openPopup(id, alive)
      return
    }
    let details
    try { details = alive ? crx.api.tabs.getTabDetails(alive) : undefined } catch { details = undefined }
    crx.ctx.router.sendEvent(id, 'commands.onCommand', name, details)
  }

  /** 重算快捷鍵表、同步 chrome.commands.getAll、重新登記全域快捷鍵；回傳每個擴充功能的指令清單 */
  function refresh() {
    const assigned = assignShortcuts(rows(), savedOf)
    const next = new Map()
    for (const [id, commands] of assigned) {
      if (!session.extensions.getExtension(id)) continue
      crx.api.commands.commandMap.set(id, commands.map((c) => ({ name: c.name, description: c.description, shortcut: c.key })))
      for (const c of commands) if (c.key) next.set(c.key, { id, name: c.name, global: c.global })
    }
    table = next
    for (const accelerator of registered) globalShortcut.unregister(accelerator)
    registered.clear()
    for (const [key, command] of table) {
      if (!command.global) continue
      const accelerator = toAccelerator(key)
      try { if (globalShortcut.register(accelerator, () => run(command, lastTab))) registered.add(accelerator) } catch { /* 不合法就當沒登記到 */ }
    }
    return assigned
  }

  const isRegistered = (key) => registered.has(toAccelerator(key))

  /** 瀏覽器分頁：記住最後用的分頁（全域快捷鍵要用），按鍵命中就執行並吃掉 */
  function track(contents) {
    if (tracked.has(contents)) return
    tracked.add(contents)
    lastTab = contents
    contents.on('focus', () => { lastTab = contents })
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || skip(contents.getURL())) return
      const command = table.get(shortcutFromInput(input))
      if (!command || command.global) return
      event.preventDefault()
      run(command, contents)
    })
  }

  session.extensions.on('extension-loaded', () => refresh())
  session.extensions.on('extension-unloaded', () => refresh())
  return { refresh, track, isRegistered }
}

module.exports = { createCommands, normalizeShortcut, shortcutFromInput, manifestCommands, assignShortcuts }
