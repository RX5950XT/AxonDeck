'use strict'

/**
 * Grok 對話的分頁標題與即時狀態。
 *
 * OSC 標題全程停在 `grok`，宿主又把整支 CLI 當成一條還沒結束的指令，所以分頁與側欄
 * 會一直顯示「grok／運行中」。這裡只尾讀該對話的 `events.jsonl`（回合、權限、階段）
 * 與 `summary.json`（`generated_title`）。`updates.jsonl` 含 token 與圖片，不讀。
 * 目錄可能在網路磁碟上，只用非同步讀加逾時，不做同步 I/O。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const WORKING = new Set(['turn_started', 'loop_started', 'first_token', 'tool_started', 'tool_completed', 'permission_resolved'])
const PHASE_WORKING = new Set(['waiting_for_model', 'streaming_reasoning', 'streaming_text', 'tool_execution'])
const SESSION_ID = /^[A-Za-z0-9_-]{6,64}$/
const TAIL_BYTES = 16 * 1024
const DEBOUNCE_MS = 40
const READ_MS = 1500
const TITLE_MAX = 80

/**
 * 單一行事件對應的顯示狀態。不認識的型別回 null，交給尾端歸約決定要不要沿用上一筆。
 * @param {object | null | undefined} event
 * @returns {'working' | 'waiting' | 'idle' | null}
 */
function grokEventState(event) {
  if (!event || typeof event.type !== 'string') return null
  if (event.type === 'turn_ended') return 'idle'
  if (event.type === 'permission_requested') return 'waiting'
  if (event.type === 'phase_changed') {
    if (event.phase === 'permission_prompt') return 'waiting'
    if (PHASE_WORKING.has(event.phase)) return 'working'
    return null
  }
  if (WORKING.has(event.type)) return 'working'
  return null
}

/**
 * 尾端文字的最後一個有意義狀態。只有 mcp 這類啟動事件時是 idle（新開的提示字元不是運行中）。
 * 完全沒有 JSON 才是 null，呼叫端不要拿 null 蓋掉已經知道的狀態。
 * @param {string} text
 * @returns {'working' | 'waiting' | 'idle' | null}
 */
function latestGrokState(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  let saw = false
  let state = null
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue
    saw = true
    const next = grokEventState(event)
    if (next) state = next
  }
  if (!saw) return null
  return state || 'idle'
}

/**
 * @param {object | null | undefined} summary
 * @returns {string}
 */
function grokTitle(summary) {
  if (!summary || typeof summary !== 'object') return ''
  const picked = [summary.generated_title, summary.session_summary].find(value => typeof value === 'string' && value.trim())
  if (!picked) return ''
  return picked.replace(/[\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

/**
 * `<home>/sessions/<encodeURIComponent(cwd)>/<id>`。id 與 `..` 都不得離開 sessions。
 * @param {string} home
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {string}
 */
function sessionDir(home, cwd, sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return ''
  if (typeof home !== 'string' || typeof cwd !== 'string') return ''
  if (!home.trim() || /[\u0000-\u001f]/.test(home) || /[\u0000-\u001f]/.test(cwd)) return ''
  if (!/^[A-Za-z]:[\\/]/.test(cwd) || cwd.replace(/\\/g, '/').split('/').includes('..')) return ''
  const root = path.resolve(home, 'sessions')
  const dir = path.resolve(root, encodeURIComponent(path.resolve(cwd)), sessionId)
  const prefix = `${root.toLowerCase()}${path.sep}`
  return dir.toLowerCase().startsWith(prefix) ? dir : ''
}

/**
 * @param {Promise<unknown>} promise
 * @param {number} ms
 * @returns {Promise<unknown>}
 */
function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('TIMEOUT'), { code: 'TIMEOUT' })), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {{ home?: string | (() => string) }} options
 * @returns {string}
 */
function resolveHome(options) {
  const picked = typeof options.home === 'function' ? options.home() : options.home
  if (typeof picked === 'string' && picked.trim()) return picked
  const configured = typeof process.env.GROK_HOME === 'string' ? process.env.GROK_HOME.trim() : ''
  return configured || path.join(os.homedir(), '.grok')
}

/**
 * 只讀檔尾。從中間開始時丟掉第一行半截，避免把半行 JSON 當成狀態。
 * @param {string} file
 * @returns {Promise<string>}
 */
async function readTail(file) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    const length = Math.min(TAIL_BYTES, stat.size)
    if (!length) return ''
    const start = stat.size - length
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, start)
    const text = buf.toString('utf8')
    if (start === 0) return text
    const nl = text.indexOf('\n')
    return nl < 0 ? '' : text.slice(nl + 1)
  } finally {
    await handle.close()
  }
}

/**
 * @param {string} dir
 * @returns {Promise<'working' | 'waiting' | 'idle' | null>}
 */
async function readState(dir) {
  try {
    const text = await withTimeout(readTail(path.join(dir, 'events.jsonl')), READ_MS)
    return latestGrokState(text)
  } catch {
    return null
  }
}

/**
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function readTitle(dir) {
  try {
    const raw = await withTimeout(fs.promises.readFile(path.join(dir, 'summary.json'), 'utf8'), READ_MS)
    return grokTitle(JSON.parse(raw))
  } catch {
    return ''
  }
}

/**
 * 宿主的 idle 要配得上結束代碼才代表那條指令已經結束。
 * 安靜逾時也是 idle，但 exitCode 仍是 null，Grok 可能還在同一個程序裡。
 * @param {{ state?: string, exitCode?: number | null } | null | undefined} state
 * @returns {boolean}
 */
function shellCommandOpen(state) {
  if (!state || state.state === 'exited' || state.state === 'stopped') return false
  return !(state.state === 'idle' && typeof state.exitCode === 'number')
}

/** 目錄監看會看到 updates.jsonl。那個檔不參與狀態。 @param {string} filename */
function watchedName(filename) {
  const base = path.basename(String(filename)).toLowerCase()
  return base === 'events.jsonl' || base === 'summary.json'
}

/** @param {object | null | undefined} watch */
function detachWatch(watch) {
  if (!watch) return
  watch.generation += 1
  clearTimeout(watch.timer)
  watch.timer = null
  const resolve = watch.resolvePending
  watch.pending = null
  watch.resolvePending = null
  resolve?.()
  if (!watch.close) return
  const close = watch.close
  watch.close = null
  close()
}

/** @param {ReturnType<typeof createActivityContext>} ctx @param {string} id @param {boolean} notifyNull */
function closeSession(ctx, id, notifyNull) {
  const watch = ctx.watches.get(id)
  if (!watch) return
  detachWatch(watch)
  ctx.watches.delete(id)
  if (notifyNull) ctx.notify('terminal:agent', { id, state: null })
}

/** @param {ReturnType<typeof createActivityContext>} ctx @param {string} id */
function scheduleRead(ctx, id) {
  const watch = ctx.watches.get(id)
  if (!watch) return Promise.resolve()
  clearTimeout(watch.timer)
  if (!watch.pending) watch.pending = new Promise(resolve => { watch.resolvePending = resolve })
  watch.timer = setTimeout(() => {
    const resolve = watch.resolvePending || (() => {})
    watch.pending = null
    watch.resolvePending = null
    resolve(readSession(ctx, id))
  }, ctx.debounce)
  watch.timer.unref?.()
  return watch.pending
}

/** @param {ReturnType<typeof createActivityContext>} ctx @param {string} id */
async function readSession(ctx, id) {
  const watch = ctx.watches.get(id)
  if (!watch) return
  const generation = ++watch.generation
  const state = await readState(watch.dir)
  const title = await readTitle(watch.dir)
  const current = ctx.watches.get(id)
  if (!current || current !== watch || current.generation !== generation) return
  if (state && state !== current.state) {
    current.state = state
    ctx.notify('terminal:agent', { id, state })
  }
  if (title && title !== current.title) {
    current.title = title
    ctx.notify('terminal:title', { id, title })
  }
}

/** @param {ReturnType<typeof createActivityContext>} ctx @param {string} id @param {string} dir @param {object} watch */
function openWatch(ctx, id, dir, watch) {
  let watcher
  try {
    watcher = fs.watch(dir, (_eventType, filename) => {
      if (filename && !watchedName(filename)) return
      void scheduleRead(ctx, id)
    })
  } catch {
    return false
  }
  watcher.on('error', () => { if (ctx.watches.get(id) === watch) detachWatch(watch) })
  watcher.unref?.()
  watch.close = () => { try { watcher.close() } catch { /* already closed */ } }
  return true
}

/** @param {ReturnType<typeof createActivityContext>} ctx @param {object} meta */
function followSession(ctx, meta) {
  if (!meta?.id) return Promise.resolve()
  const dir = meta.preset === 'grok' ? sessionDir(ctx.home(), meta.cwd, meta.agentSessionId) : ''
  if (!dir) {
    closeSession(ctx, meta.id, true)
    return Promise.resolve()
  }
  const existing = ctx.watches.get(meta.id)
  if (existing?.dir === dir && existing.close) return scheduleRead(ctx, meta.id)
  const watch = {
    dir, close: null, generation: 0, timer: null, pending: null, resolvePending: null,
    state: existing?.dir === dir ? existing.state : null,
    title: existing?.dir === dir ? existing.title : ''
  }
  if (!openWatch(ctx, meta.id, dir, watch)) return Promise.resolve()
  if (existing) detachWatch(existing)
  ctx.watches.set(meta.id, watch)
  return scheduleRead(ctx, meta.id)
}

/** @param {ReturnType<typeof createActivityContext>} ctx */
function stopActivity(ctx) {
  for (const id of [...ctx.watches.keys()]) {
    detachWatch(ctx.watches.get(id))
    ctx.watches.delete(id)
  }
}

/**
 * @param {(event: string, payload: object) => void} emit
 * @param {{ home?: string | (() => string), debounce?: number }} [options]
 */
function createActivityContext(emit, options) {
  return {
    watches: new Map(),
    notify: typeof emit === 'function' ? emit : () => {},
    debounce: Number.isFinite(options.debounce) ? options.debounce : DEBOUNCE_MS,
    home: () => resolveHome(options)
  }
}

/**
 * @param {(event: string, payload: object) => void} emit
 * @param {{ home?: string | (() => string), debounce?: number }} [options]
 */
function createActivity(emit, options = {}) {
  const ctx = createActivityContext(emit, options)
  return {
    follow: meta => followSession(ctx, meta),
    drop: id => closeSession(ctx, id, true),
    stop: () => stopActivity(ctx),
    stateOf: id => ctx.watches.get(id)?.state || null,
    titleOf: async meta => {
      const dir = meta?.preset === 'grok' ? sessionDir(ctx.home(), meta.cwd, meta.agentSessionId) : ''
      return dir ? readTitle(dir) : ''
    }
  }
}

module.exports = {
  grokEventState,
  latestGrokState,
  grokTitle,
  sessionDir,
  shellCommandOpen,
  createActivity
}
