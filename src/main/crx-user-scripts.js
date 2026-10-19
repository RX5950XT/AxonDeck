'use strict'

// Electron 缺少 userScripts：以原生 scripting 的檔案注入保留 document_start、frame 與 host permission 守衛。
const fs = require('fs').promises
const path = require('path')
const crypto = require('crypto')
const { ipcMain, webContents } = require('electron')
const { extensionIdOf } = require('./crx-identity')
const PREFIX = 'axondeck-user-'
const CHANNEL = 'crx-user-scripts'
const METHODS = new Set(['get', 'prepare', 'commit', 'remove', 'world', 'worlds', 'reset', 'native', 'target'])

function globPattern(value) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid script glob.')
  return '^' + value.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
}

/** 注入在真正的 extension content-script world，保留 Chrome 的訊息與權限，不把 IPC 暴露給網頁。 */
function userWorld(chrome) {
  const tag = '__axondeckUserScript'
  const port = (p) => {
    const listeners = new Map()
    return { name: p.name, sender: p.sender, disconnect: () => p.disconnect(), onDisconnect: p.onDisconnect,
    postMessage: (message) => p.postMessage({ [tag]: message }),
    onMessage: {
      addListener(fn) { if (!listeners.has(fn)) { const listener = (row) => fn(row?.[tag] ?? row); listeners.set(fn, listener); p.onMessage.addListener(listener) } },
      removeListener(fn) { const listener = listeners.get(fn); if (listener) p.onMessage.removeListener(listener); listeners.delete(fn) },
      hasListener: (fn) => listeners.has(fn), hasListeners: () => listeners.size > 0
    } }
  }
  return { runtime: { id: chrome.runtime.id,
    sendMessage: (message, ...args) => chrome.runtime.sendMessage({ [tag]: message }, ...args),
    connect: (info = {}) => port(chrome.runtime.connect({ ...info, name: `axondeck-user:${info.name || ''}` }))
  } }
}

function validateScript(script) {
  if (!script || typeof script.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(script.id)) throw new Error('Invalid script ID.')
  for (const key of ['matches', 'excludeMatches', 'includeGlobs', 'excludeGlobs']) {
    if (script[key] !== undefined && (!Array.isArray(script[key]) || script[key].length > 1000
      || script[key].some((s) => typeof s !== 'string' || s.length > 4096))) throw new Error('Invalid script match.')
  }
  if (!script.matches?.length || !Array.isArray(script.js) || !script.js.length || script.js.length > 100) throw new Error('Invalid user script.')
  if (script.world !== undefined && !['MAIN', 'USER_SCRIPT'].includes(script.world)) throw new Error('Invalid script world.')
  if (script.runAt !== undefined && !['document_start', 'document_end', 'document_idle'].includes(script.runAt)) throw new Error('Invalid runAt.')
  if (script.allFrames !== undefined && typeof script.allFrames !== 'boolean') throw new Error('Invalid allFrames.')
  if (script.worldId) throw new Error('Named user script worlds are not supported by this Electron version.')
  for (const source of script.js) {
    if (!source || (typeof source.code === 'string') === (typeof source.file === 'string')
      || (source.code?.length || source.file?.length || 0) > 8 * 1024 * 1024) throw new Error('Invalid script source.')
  }
  for (const glob of [...(script.includeGlobs || []), ...(script.excludeGlobs || [])]) globPattern(glob)
  return { ...script }
}

function createUserScripts({ session, dir, allowed }) {
  const file = path.join(dir, 'user-scripts.json')
  let rows = {}
  let chain = Promise.resolve()
  const ready = fs.readFile(file, 'utf8').then((text) => {
    const data = JSON.parse(text)
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Invalid user scripts store.')
    for (const [id, own] of Object.entries(data)) {
      if (!/^[a-p]{32}$/.test(id) || !Array.isArray(own?.scripts) || !Array.isArray(own?.worlds)) throw new Error('Invalid user scripts store.')
      own.scripts.forEach(validateScript)
    }
    rows = data
  }).catch((error) => {
    if (error.code !== 'ENOENT') throw new Error('User scripts store could not be read.')
  })
  async function save(next) {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(`${file}.tmp`, JSON.stringify(next))
    await fs.rename(`${file}.tmp`, file)
    rows = next
  }
  async function compile(id, scripts) {
    const ext = session.extensions.getExtension(id)
    const root = await fs.realpath(ext.path)
    const managed = await fs.realpath(dir)
    if (!root.startsWith(managed + path.sep)) throw new Error('User scripts require an App-managed extension copy.')
    const generated = path.join(root, 'axondeck-user-scripts')
    await fs.mkdir(generated, { recursive: true })
    if (!(await fs.realpath(generated)).startsWith(root + path.sep)) throw new Error('Invalid script directory.')
    return Promise.all(scripts.map(async (script) => {
      const code = []
      for (const source of script.js) {
        if (source.code !== undefined) code.push(source.code)
        else {
          const sourcePath = await fs.realpath(path.resolve(root, source.file.replace(/^\//, '')))
          if (!sourcePath.startsWith(root + path.sep)) throw new Error('Invalid script file.')
          code.push(await fs.readFile(sourcePath, 'utf8'))
        }
      }
      const include = (script.includeGlobs || []).map(globPattern), exclude = (script.excludeGlobs || []).map(globPattern)
      const filter = `(!${JSON.stringify(include)}.length || ${JSON.stringify(include)}.some(p=>new RegExp(p).test(location.href))) && !${JSON.stringify(exclude)}.some(p=>new RegExp(p).test(location.href))`
      const source = code.join('\n;\n')
      // 原生 script 是全域執行：不可包進函式，否則 ScriptCat 的 MAIN bootstrap 全域名稱會消失。
      const messaging = rows[id]?.worlds.some((w) => !w.worldId && w.messaging) || false
      // content scripts 與使用者腳本共用原生 ISOLATED；Electron 未提供舊版 extension 命名空間。
      const scoped = script.world === 'MAIN' ? source : `globalThis.chrome.extension ||= {inIncognitoContext:false,getURL:chrome.runtime.getURL};\n{ const chrome=${messaging ? `(${userWorld})(globalThis.chrome)` : '{}'};\n${source}\n}`
      const body = include.length || exclude.length ? `if (${filter}) {\n${scoped}\n}` : scoped
      const name = crypto.createHash('sha256').update(body).digest('hex') + '.js'
      await fs.writeFile(path.join(generated, name), body)
      return { id: PREFIX + script.id, js: ['axondeck-user-scripts/' + name], matches: script.matches,
        excludeMatches: script.excludeMatches || [], allFrames: !!script.allFrames, runAt: script.runAt || 'document_idle',
        world: script.world === 'MAIN' ? 'MAIN' : 'ISOLATED', persistAcrossSessions: false }
    }))
  }
  async function action(id, op, value) {
    await ready
    const ext = session.extensions.getExtension(id)
    if (!ext?.manifest?.permissions?.includes('userScripts') || (op !== 'native' && !allowed(id))) throw new Error('User scripts are not allowed for this extension.')
    if (!METHODS.has(op)) throw new Error('Invalid user scripts method.')
    if (op === 'target') {
      const tab = Number.isInteger(value?.tabId) && webContents.fromId(value.tabId)
      if (!tab || tab.session !== session) throw new Error('Invalid user scripts target.')
      return
    }
    const own = rows[id] || { scripts: [], worlds: [] }
    if (op === 'get') return { scripts: own.scripts, native: await compile(id, own.scripts), conventional: own.conventional || [] }
    if (op === 'worlds') return own.worlds
    let next
    if (op === 'prepare' || op === 'commit') {
      if (!Array.isArray(value) || value.length > 1000) throw new Error('Invalid user scripts.')
      const scripts = value.map(validateScript)
      if (new Set(scripts.map((s) => s.id)).size !== scripts.length) throw new Error('Duplicate script ID.')
      if (op === 'prepare') return compile(id, scripts)
      next = { ...own, scripts: [...own.scripts.filter((s) => !scripts.some((v) => v.id === s.id)), ...scripts] }
      await save({ ...rows, [id]: next })
      return
    }
    if (op === 'native') {
      if (!Array.isArray(value) || value.length > 1000 || JSON.stringify(value).length > 8 * 1024 * 1024
        || value.some((s) => typeof s?.id !== 'string' || s.id.startsWith(PREFIX))) throw new Error('Invalid native scripts.')
      next = { ...own, conventional: value }
    } else if (op === 'remove') {
      if (value !== undefined && (!Array.isArray(value) || value.some((v) => typeof v !== 'string'))) throw new Error('Invalid script IDs.')
      next = { ...own, scripts: value ? own.scripts.filter((s) => !value.includes(s.id)) : [] }
    } else if (op === 'world') {
      if (!value || typeof value !== 'object' || (value.csp !== undefined && typeof value.csp !== 'string')
        || (value.worldId !== undefined && typeof value.worldId !== 'string') || (value.messaging !== undefined && typeof value.messaging !== 'boolean')) throw new Error('Invalid user script world.')
      // shortcut: 原生 ISOLATED 共用套件的 CSP／world；多 worldId 或自訂 CSP 需 Electron 原生 userScripts 支援。
      if (value.worldId || value.csp) throw new Error('Custom user script worlds and CSP are not supported by this Electron version.')
      next = { ...own, worlds: [...own.worlds.filter((w) => w.worldId !== value.worldId), value] }
    } else next = { ...own, worlds: value === undefined ? [] : own.worlds.filter((w) => w.worldId !== value) }
    await save({ ...rows, [id]: next })
  }
  const invoke = (id, op, value) => {
    const job = chain.then(() => action(id, op, value))
    chain = job.catch(() => {})
    return job
  }
  // popup 與 worker 會同時呼叫：整段「原生登記＋寫回」共用鎖，避免 get 恢復剛被 unregister 的腳本。
  const leases = new Map(), queues = new Map()
  function release(id, token) {
    const lease = leases.get(id)
    if (lease?.token !== token) return
    clearTimeout(lease.timer); leases.delete(id)
    queues.get(id)?.shift()?.grant()
  }
  async function handle(id, op, value) {
    if (op === 'release') { release(id, value); return }
    if (op === 'acquire') {
      await ready
      if (!session.extensions.getExtension(id)?.manifest.permissions?.includes('userScripts')) throw new Error('Invalid extension.')
      return new Promise((resolve, reject) => {
        const grant = () => {
          const token = crypto.randomUUID(), timer = setTimeout(() => release(id, token), 30_000)
          timer.unref(); leases.set(id, { token, timer }); resolve(token)
        }
        if (!leases.has(id)) grant()
        else { const queue = queues.get(id) || []; queue.push({ grant, reject }); queues.set(id, queue) }
      })
    }
    if (leases.get(id)?.token !== value?.token) throw new Error('Invalid user scripts operation.')
    return invoke(id, op, value.data)
  }
  session.extensions.on('extension-unloaded', (_event, ext) => {
    clearTimeout(leases.get(ext.id)?.timer); leases.delete(ext.id)
    for (const row of queues.get(ext.id) || []) row.reject(new Error('Extension was unloaded.'))
    queues.delete(ext.id)
  })
  const response = async (id, op, value) => {
    try { return { ok: true, data: await handle(id, op, value) } }
    catch (error) { return { ok: false, error: { message: /^(Invalid|User scripts|Custom user script|Named user script|Duplicate script|Extension was)/.test(error.message) ? error.message : 'User scripts operation failed.' } } }
  }
  ipcMain.handle(CHANNEL, (event, op, value) => {
    if (event.sender.session !== session) return { ok: false, error: { message: 'Invalid extension.' } }
    return response(extensionIdOf(event.senderFrame?.url || ''), op, value)
  })
  const workers = new WeakSet()
  session.serviceWorkers.on('running-status-changed', ({ runningStatus, versionId }) => {
    if (runningStatus !== 'starting') return
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker?.scope?.startsWith('chrome-extension://') || workers.has(worker)) return
    workers.add(worker)
    worker.ipc.handle(CHANNEL, (_event, op, value) => response(extensionIdOf(worker.scope), op, value))
  })
  return { ready, clear: (id) => {
    const job = chain.then(async () => { await ready; const next = { ...rows }; delete next[id]; await save(next) })
    chain = job.catch(() => {}); return job
  } }
}

module.exports = { createUserScripts, validateScript, globPattern, PREFIX }
