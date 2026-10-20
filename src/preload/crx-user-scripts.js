'use strict'
const { contextBridge, ipcRenderer, webFrame } = require('electron')
function install() {
  const chrome = globalThis.chrome, bridge = globalThis.__axonUserScripts
  if (!chrome?.runtime?.id || !bridge || chrome.userScripts || !chrome.runtime.getManifest().permissions?.includes('userScripts')) return
  const native = { ...chrome.scripting }, prefix = 'axondeck-user-'
  let token
  const invoke = (op, data) => bridge.invoke(op, { token, data })
  let chain = Promise.resolve()
  function serial(fn) {
    const job = chain.then(async () => {
      token = await bridge.invoke('acquire')
      try { return await fn() }
      finally { await bridge.invoke('release', token); token = undefined }
    })
    chain = job.catch(() => {}); return job
  }
  const taggedEvent = (event, convert) => {
    const listeners = new Map()
    return {
      addListener(fn) { if (!listeners.has(fn)) { const listener = (...args) => convert(fn, ...args); listeners.set(fn, listener); event.addListener(listener) } },
      removeListener(fn) { const listener = listeners.get(fn); if (listener) event.removeListener(listener); listeners.delete(fn) },
      hasListener: (fn) => listeners.has(fn), hasListeners: () => listeners.size > 0
    }
  }
  const tag = '__axondeckUserScript'
  const onMessage = chrome.runtime.onMessage, onConnect = chrome.runtime.onConnect
  chrome.runtime.onUserScriptMessage = taggedEvent(onMessage,
    (fn, row, sender, reply) => row && Object.hasOwn(row, tag) ? fn(row[tag], sender, reply) : undefined)
  chrome.runtime.onMessage = taggedEvent(onMessage, (fn, row, sender, reply) => row && Object.hasOwn(row, tag) ? undefined : fn(row, sender, reply))
  chrome.runtime.onConnect = taggedEvent(onConnect, (fn, port) => port.name.startsWith('axondeck-user:') ? undefined : fn(port))
  chrome.runtime.onUserScriptConnect = taggedEvent(onConnect, (fn, port) => {
    if (!port.name.startsWith('axondeck-user:')) return
    fn({ name: port.name.slice(14), sender: port.sender, disconnect: () => port.disconnect(), onDisconnect: port.onDisconnect,
      postMessage: (message) => port.postMessage({ [tag]: message }),
      onMessage: taggedEvent(port.onMessage, (listener, row) => listener(row?.[tag] ?? row)) })
  })
  const registered = async () => {
    const saved = await invoke('get')
    const active = await native.getRegisteredContentScripts()
    const missing = [...saved.conventional, ...saved.native].filter((row) => !active.some((item) => item.id === row.id))
    if (missing.length) await native.registerContentScripts(missing)
    const changed = saved.native.filter((row) => active.some((item) => item.id === row.id && JSON.stringify(item.js) !== JSON.stringify(row.js)))
    if (changed.length) await native.updateContentScripts(changed)
    return saved.scripts
  }
  const api = {
    async getScripts(filter = {}) { const scripts = await registered(); return filter.ids ? scripts.filter((s) => filter.ids.includes(s.id)) : scripts },
    async register(scripts) {
      const own = await registered()
      if (scripts.some((s) => own.some((row) => row.id === s.id))) throw new Error('Duplicate script ID.')
      await native.registerContentScripts(await invoke('prepare', scripts))
      await invoke('commit', scripts)
    },
    async update(scripts) {
      const own = await registered()
      const merged = scripts.map((script) => { const found = own.find((row) => row.id === script.id); if (!found) throw new Error('Script ID does not exist.'); return { ...found, ...script } })
      const prepared = await invoke('prepare', merged)
      await native.updateContentScripts(prepared)
      await invoke('commit', merged)
    },
    async unregister(filter = {}) { await registered(); await native.unregisterContentScripts(filter.ids ? { ids: filter.ids.map((id) => prefix + id) } : { ids: (await native.getRegisteredContentScripts()).filter((s) => s.id.startsWith(prefix)).map((s) => s.id) }); await invoke('remove', filter.ids) },
    async execute(details) {
      await invoke('target', details.target)
      const [script] = await invoke('prepare', [{ id: 'execute', matches: ['<all_urls>'], world: details.world, worldId: details.worldId, js: details.js }])
      return native.executeScript({ target: details.target, injectImmediately: !!details.injectImmediately, world: script.world, files: script.js })
    },
    async configureWorld(value) { await invoke('world', value); await registered() }, getWorldConfigurations: () => invoke('worlds'),
    async resetWorldConfiguration(id) { await invoke('reset', id); await registered() }
  }
  const safe = Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => serial(() => fn(...args))]))
  Object.defineProperty(chrome, 'userScripts', { value: safe, configurable: true, enumerable: true })
  // Electron removeExtension 會清掉動態內容腳本；跟使用者腳本一同恢復，ScriptCat 才不會少了傳訊的 scripting bootstrap。
  const scripting = { ...native }
  for (const method of ['registerContentScripts', 'updateContentScripts', 'unregisterContentScripts']) {
    scripting[method] = (...args) => serial(async () => {
      const result = await native[method](...args)
      await invoke('native', (await native.getRegisteredContentScripts()).filter((s) => !s.id.startsWith(prefix)))
      return result
    })
  }
  Object.defineProperty(chrome, 'scripting', { value: scripting, configurable: true, enumerable: true })
}
if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  contextBridge.exposeInMainWorld('__axonUserScripts', { invoke: async (op, value) => {
    const result = await ipcRenderer.invoke('crx-user-scripts', op, value)
    if (!result.ok) throw new Error(result.error.message)
    return result.data
  } })
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: install })
  else webFrame.executeJavaScript(`(${install})()`)
}
