'use strict'

/**
 * 一個獨立 electron-store 檔（`<userData>/<name>.json`）的懶載入與序列化存取。
 * electron-store 是 ESM，只能動態 import；讀改寫要排隊，否則兩個並發的 get→set 會互相蓋掉。
 * @param {string} name
 */
function createSerialStore(name) {
  /** @type {Promise<import('electron-store').default> | null} */
  let ready = null
  let chain = Promise.resolve()

  /** @returns {Promise<import('electron-store').default>} */
  function getStore() {
    ready ||= import('electron-store').then((mod) => new mod.default({ name }))
    return ready
  }

  /**
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  function withStore(fn) {
    const run = chain.then(fn, fn)
    chain = run.then(() => {}, () => {})
    return run
  }

  return { getStore, withStore }
}

module.exports = { createSerialStore }
