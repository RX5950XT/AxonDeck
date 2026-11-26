// OPFS（navigator.storage.getDirectory）：Electron 43 對 chrome-extension:// 一律回 SecurityError
// （擴充功能頁與 service worker 都一樣，一般 http 頁正常）。ScriptCat 1.5 新增腳本時要查 OPFS 裡的
// 垃圾桶，被擋就整個裝不起來。原生被擋時改用同一個擴充功能來源的 IndexedDB 撐起最小子集：
// 取得／建立資料夾與檔案、刪除（含遞迴）、列出內容、讀檔、寫檔（createWritable）。
// 原生能用就照用原生（以後 Electron 修好不會把資料寫到兩邊）。
const { contextBridge, webFrame } = require('electron')

function install() {
  const storage = globalThis.navigator?.storage
  if (!storage?.getDirectory || storage.__axonOpfs) return
  const native = storage.getDirectory.bind(storage)
  const fail = (message, name) => new DOMException(message, name)
  let dbReady = null
  const db = () => {
    dbReady ||= new Promise((resolve, reject) => {
      const req = globalThis.indexedDB.open('axondeck-opfs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('entries')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return dbReady
  }
  const run = async (mode, work) => {
    const tx = (await db()).transaction('entries', mode)
    const result = work(tx.objectStore('entries'))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || fail('aborted', 'AbortError'))
    })
    return result && 'result' in result ? result.result : result
  }
  const get = (key) => run('readonly', (s) => s.get(key))
  const childPrefix = (path) => (path ? `${path}/` : '')
  const checkName = (name) => {
    const text = String(name)
    if (!text || text === '.' || text === '..' || /[/\\]/.test(text)) throw new TypeError(`Name is not allowed: ${text}`)
    return text
  }
  const bytesOf = async (data) => {
    if (typeof data === 'string') return new TextEncoder().encode(data)
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    throw new TypeError('Unsupported write data')
  }

  class Handle {
    constructor(kind, path) {
      this.kind = kind
      this.path = path
      this.name = path.split('/').pop()
    }
    async isSameEntry(other) { return other instanceof Handle && other.kind === this.kind && other.path === this.path }
  }

  class FileHandle extends Handle {
    constructor(path) { super('file', path) }
    async getFile() {
      const entry = await get(this.path)
      if (!entry || entry.kind !== 'file') throw fail('A requested file or directory could not be found.', 'NotFoundError')
      return new File([entry.blob], this.name, { lastModified: entry.lastModified })
    }
    async createWritable(options = {}) {
      const path = this.path
      const entry = await get(path)
      let bytes = options.keepExistingData && entry?.blob ? new Uint8Array(await entry.blob.arrayBuffer()) : new Uint8Array(0)
      let position = 0
      const place = (chunk) => {
        const end = position + chunk.length
        if (end > bytes.length) { const grown = new Uint8Array(end); grown.set(bytes); bytes = grown }
        bytes.set(chunk, position)
        position = end
      }
      return {
        async write(data) {
          if (data && typeof data === 'object' && 'type' in data && !(data instanceof Blob)) {
            if (data.type === 'seek') { position = Number(data.position) || 0; return }
            if (data.type === 'truncate') { this.truncate(data.size); return }
            if (Number.isFinite(data.position)) position = data.position
            place(await bytesOf(data.data))
            return
          }
          place(await bytesOf(data))
        },
        async seek(next) { position = Number(next) || 0 },
        async truncate(size) {
          const next = new Uint8Array(Math.max(0, Number(size) || 0))
          next.set(bytes.subarray(0, next.length))
          bytes = next
          position = Math.min(position, bytes.length)
        },
        async close() {
          await run('readwrite', (s) => s.put({ kind: 'file', blob: new Blob([bytes]), lastModified: Date.now() }, path))
        },
        async abort() { bytes = new Uint8Array(0) }
      }
    }
  }

  class DirectoryHandle extends Handle {
    constructor(path) { super('directory', path) }
    async child(name, kind, create) {
      const path = childPrefix(this.path) + checkName(name)
      const entry = await get(path)
      if (entry && entry.kind !== kind) throw fail('The path supplied exists, but was not an entry of requested type.', 'TypeMismatchError')
      if (!entry) {
        if (!create) throw fail('A requested file or directory could not be found.', 'NotFoundError')
        const value = kind === 'file' ? { kind, blob: new Blob([]), lastModified: Date.now() } : { kind }
        await run('readwrite', (s) => s.put(value, path))
      }
      return kind === 'file' ? new FileHandle(path) : new DirectoryHandle(path)
    }
    getDirectoryHandle(name, options = {}) { return this.child(name, 'directory', !!options.create) }
    getFileHandle(name, options = {}) { return this.child(name, 'file', !!options.create) }
    async removeEntry(name, options = {}) {
      const path = childPrefix(this.path) + checkName(name)
      const entry = await get(path)
      if (!entry) throw fail('A requested file or directory could not be found.', 'NotFoundError')
      const range = globalThis.IDBKeyRange.bound(`${path}/`, `${path}/\uffff`)
      const nested = await run('readonly', (s) => s.getAllKeys(range))
      if (nested.length && !options.recursive) throw fail('The object can not be modified in this way.', 'InvalidModificationError')
      await run('readwrite', (s) => { s.delete(path); s.delete(range) })
    }
    async resolve(other) {
      if (!(other instanceof Handle)) return null
      if (other.path === this.path) return []
      const prefix = childPrefix(this.path)
      return other.path.startsWith(prefix) ? other.path.slice(prefix.length).split('/') : null
    }
    async * entries() {
      const prefix = childPrefix(this.path)
      const range = prefix ? globalThis.IDBKeyRange.bound(prefix, `${prefix}\uffff`) : undefined
      const [keys, values] = await run('readonly', (s) => {
        const k = s.getAllKeys(range)
        const v = s.getAll(range)
        return { get result() { return [k.result, v.result] } }
      })
      for (let i = 0; i < keys.length; i += 1) {
        const rest = keys[i].slice(prefix.length)
        if (!rest || rest.includes('/')) continue
        yield [rest, values[i].kind === 'file' ? new FileHandle(keys[i]) : new DirectoryHandle(keys[i])]
      }
    }
    async * keys() { for await (const [name] of this.entries()) yield name }
    async * values() { for await (const [, handle] of this.entries()) yield handle }
    [Symbol.asyncIterator]() { return this.entries() }
  }

  let mode = null
  Object.defineProperty(storage, '__axonOpfs', { value: true })
  Object.defineProperty(storage, 'getDirectory', {
    configurable: true,
    value: async () => {
      mode ||= native().then(() => 'native', (error) => (error?.name === 'SecurityError' ? 'idb' : 'native'))
      return (await mode) === 'native' ? native() : new DirectoryHandle('')
    }
  })
}

if (process.type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')) {
  if ('executeInMainWorld' in contextBridge) contextBridge.executeInMainWorld({ func: install })
  else webFrame.executeJavaScript(`(${install})()`)
}
