'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-icons.js'), 'utf8')
  .replace(/^export /gm, '')
const PNG = 'data:image/png;base64,AAA'

function flush() {
  return Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve())
}

function loadIcons(fileIcon) {
  const timers = []
  const observers = []
  let nextTimer = 1
  const context = {
    console,
    Map,
    Set,
    WeakSet,
    Math,
    setTimeout(fn, ms) {
      const item = { id: nextTimer++, fn, ms }
      timers.push(item)
      return item.id
    },
    clearTimeout(id) {
      const index = timers.findIndex((item) => item.id === id)
      if (index >= 0) timers.splice(index, 1)
    },
    IntersectionObserver: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        observers.push(this)
      }

      observe(el) {
        this.callback([{ isIntersecting: true, target: el }])
      }

      unobserve() {}

      disconnect() {
        this.disconnected = true
      }
    },
    document: {
      createElement() {
        return { src: '', alt: '', draggable: false }
      }
    },
    window: { electronAPI: { explorer: { fileIcon } } }
  }
  vm.createContext(context)
  vm.runInContext(SOURCE, context)
  return { context, timers, observers }
}

function element(filePath) {
  return {
    dataset: { path: filePath },
    isConnected: true,
    textContent: '',
    replaceChildren(node) { this.child = node }
  }
}

function host(grid, elements) {
  return {
    classList: { contains: (name) => grid && name === 'is-grid' },
    querySelectorAll: () => elements,
    isConnected: true
  }
}

async function testCooldownCancelsPendingWork() {
  let resolve
  const el = element('C:\\pending.pdf')
  const env = loadIcons(() => new Promise((done) => { resolve = done }))
  env.context.paintFileIcons(host(true, [el]), () => Promise.resolve({ ok: false }))
  assert.equal(env.timers.length, 0)
  assert.equal(typeof env.context.clearFileIconWork, 'function')

  env.context.clearFileIconWork()
  assert.equal(env.timers.length, 0)
  assert.equal(env.observers[0].disconnected, true)
  resolve({ ok: true, data: { url: PNG, pending: true } })
  await flush()
  assert.equal(env.timers.length, 0)
  assert.equal(el.child, undefined)
}

async function testGridAsksThumbForAnyFile() {
  const html = element('C:\\notes.html')
  const folder = element('C:\\Photos')
  const env = loadIcons((filePath) => Promise.resolve({
    ok: true,
    data: { url: PNG, pending: false, path: filePath }
  }))
  const thumbs = []
  env.context.window.electronAPI.explorer.fileIcon = (filePath, opts) => {
    thumbs.push({ filePath, thumb: Boolean(opts && opts.thumb) })
    return Promise.resolve({ ok: true, data: { url: PNG } })
  }
  env.context.paintFileIcons(host(true, [html, folder]), () => Promise.resolve({ ok: false }))
  await flush()
  assert.equal(thumbs.length, 2, '方格檢視每個可見列都要問縮圖')
  assert.equal(thumbs[0].thumb, true, 'html 也要縮圖，不能只收圖片副檔名')
  assert.equal(thumbs[1].thumb, true, '資料夾也要問殼層縮圖')
}

async function testStaleFinallyUsesCurrentQueueContext() {
  const oldRequests = []
  const first = [1, 2, 3, 4].map((n) => element(`C:\\old-${n}.pdf`))
  const next = element('C:\\new.pdf')
  let readOld = 0
  let readNew = 0
  const env = loadIcons((filePath) => new Promise((resolve) => {
    oldRequests.push({ filePath, resolve })
  }))

  env.context.paintFileIcons(host(true, first), () => {
    readOld += 1
    return Promise.resolve({ ok: true, data: { url: 'old-read' } })
  })
  assert.equal(oldRequests.length, 4)

  env.context.paintFileIcons(host(false, [next]), () => {
    readNew += 1
    return Promise.resolve({ ok: true, data: { url: 'new-read' } })
  })
  assert.equal(readNew, 0)

  oldRequests[0].resolve({ ok: true, data: { url: PNG } })
  await flush()
  assert.equal(oldRequests.length, 4)
  assert.equal(readOld, 0)
  assert.equal(readNew, 1)
}

/**
 * 同一個 `#exList` 節點重畫（`paintList` 的 `replaceChildren`）：新列跟舊列同一個
 * 快取鍵。舊請求回來時要寫進快取並補畫現行那一列，不能整筆丟掉再要一次——
 * 否則監看／點選一重畫，整片縮圖就回到 fallback 再載一次（一直閃爍）。
 */
function repaintHost(env, h, elements) {
  h.elements = elements
  env.context.paintFileIcons(h, () => Promise.resolve({ ok: false }))
}

function gridHost(elements) {
  const h = host(true, elements)
  h.elements = elements
  h.querySelectorAll = () => h.elements
  return h
}

function iconEl(filePath, iconKey) {
  const el = element(filePath)
  el.dataset.iconKey = iconKey
  return el
}

async function testRepaintKeepsInflightThumb() {
  const resolvers = []
  let calls = 0
  const env = loadIcons(() => new Promise((resolve) => {
    calls += 1
    resolvers.push(resolve)
  }))
  const key = 'C:\\pics\\a.png:1000:f'
  const h = gridHost([iconEl('C:\\pics\\a.png', key)])
  env.context.paintFileIcons(h, () => Promise.resolve({ ok: false }))
  assert.equal(calls, 1)

  // 重畫：舊列被換掉，新列同一個快取鍵，請求還在飛
  const el2 = iconEl('C:\\pics\\a.png', key)
  repaintHost(env, h, [el2])
  resolvers[0]({ ok: true, data: { url: PNG } })
  await flush()
  await flush()
  assert.equal(calls, 1, '載入中的縮圖不能因為重畫再要一次')
  assert.equal(el2.child && el2.child.src, PNG, '遲到的結果要補畫到現行那一列')
}

async function testRetryBudgetSurvivesRepaint() {
  let calls = 0
  const env = loadIcons(() => {
    calls += 1
    return Promise.resolve({ ok: true, data: { url: PNG, pending: true } })
  })
  const key = 'C:\\pics\\b.mp4:2000:f'
  const h = gridHost([iconEl('C:\\pics\\b.mp4', key)])
  for (let i = 0; i < 5; i += 1) {
    repaintHost(env, h, [iconEl('C:\\pics\\b.mp4', key)])
    await flush()
    await flush()
  }
  // 1 次初問＋3 次重試；重畫不能把預算歸零，否則 pending 的影片／PDF 永遠停不下來
  assert.equal(calls, 4, `重試預算要跨重畫共用，實際要了 ${calls} 次`)
  assert.equal(env.timers.length, 0, '預算用完就停，不再排重試')
}

async function testCacheHitRepaintNeedsNoRequest() {
  let calls = 0
  const env = loadIcons(() => {
    calls += 1
    return Promise.resolve({ ok: true, data: { url: PNG } })
  })
  const key = 'C:\\pics\\c.png:3000:f'
  const h = gridHost([iconEl('C:\\pics\\c.png', key)])
  env.context.paintFileIcons(h, () => Promise.resolve({ ok: false }))
  await flush()
  assert.equal(calls, 1)
  const el2 = iconEl('C:\\pics\\c.png', key)
  repaintHost(env, h, [el2])
  await flush()
  assert.equal(calls, 1, '快取命中就不能再問殼層')
  assert.equal(el2.child && el2.child.src, PNG, '快取要同步畫上，不閃 fallback')
}

Promise.resolve()
  .then(testCooldownCancelsPendingWork)
  .then(testGridAsksThumbForAnyFile)
  .then(testStaleFinallyUsesCurrentQueueContext)
  .then(testRepaintKeepsInflightThumb)
  .then(testRetryBudgetSurvivesRepaint)
  .then(testCacheHitRepaintNeedsNoRequest)
  .then(() => console.log('6 passed, 0 failed'))
  .catch((error) => {
    console.error(error.stack || error)
    process.exitCode = 1
  })
