'use strict'

// 圖示獨立排隊：慢磁碟或殼層不阻塞每輪取樣；失敗也快取，避免一直重試。
function createProcessIcons({ getFileIcon, limit = 512, concurrency = 4 } = {}) {
  const cache = new Map()
  const pending = new Set()
  const queue = []
  let active = 0
  const keyFor = (exePath) => typeof exePath === 'string' ? exePath.toLowerCase() : ''

  async function load(exePath, key) {
    let icon = ''
    let timer
    try {
      const read = getFileIcon || ((file, options) => require('electron').app.getFileIcon(file, options))
      const result = await Promise.race([
        Promise.resolve().then(() => read(exePath, { size: 'small' })),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), 2000); timer.unref?.() })
      ])
      const data = result && !result.isEmpty() ? result.toDataURL() : ''
      if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) icon = data
    } catch { /* 不可讀的映像檔使用預設圖示，不透傳系統錯誤 */ }
    finally { clearTimeout(timer) }
    cache.set(key, icon)
    while (cache.size > limit) cache.delete(cache.keys().next().value)
    pending.delete(key)
    active -= 1
    drain()
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const [file, key] = queue.shift()
      active += 1
      void load(file, key)
    }
  }

  return {
    read(exePath) {
      const file = typeof exePath === 'string' ? exePath.replace(/^\\\\\?\\(?=[a-z]:\\)/i, '') : ''
      const key = keyFor(file)
      if (!key || !/^[a-z]:\\/i.test(file) || file.length > 32767) return ''
      if (cache.has(key)) return cache.get(key)
      if (!pending.has(key) && pending.size < limit) {
        pending.add(key)
        queue.push([file, key])
        drain()
      }
      return ''
    }
  }
}

module.exports = { createProcessIcons }
