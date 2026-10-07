'use strict'

// 檔案頁右鍵「複製圖片」：圖片檔 → 系統剪貼簿的圖片格，對話框 Ctrl+V 直接變附件。
// 跟「複製」不同：那個複製的是檔案（貼上＝複製檔案），這個複製的是圖本身。

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const Module = require('node:module')
const { tempDir } = require('./lib/test-temp')

const ROOT = path.join(__dirname, '..')
const written = []
const fakeElectron = {
  nativeImage: {
    createFromBuffer: (buf) => {
      if (!buf || !buf.length) return { isEmpty: () => true }
      if (buf.toString('utf8', 0, 9) === 'NOT-IMAGE') return { isEmpty: () => true }
      return { isEmpty: () => false, getSize: () => ({ width: 2, height: 1 }) }
    }
  },
  clipboard: {
    writeImage: (image) => { written.push(image) }
  }
}

const load = Module._load
Module._load = function (name, ...rest) {
  if (name === 'electron') return fakeElectron
  return load.call(this, name, ...rest)
}

function loadMenu() {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-dnd.js'), 'utf8')
    .replace(/^import.*\r?\n/gm, '')
    .replace(/^export /gm, '')
  let seen = null
  const context = {
    console,
    showMenu: (at, menu) => { seen = menu },
    __seen: () => seen,
    __reset: () => { seen = null }
  }
  vm.createContext(context)
  vm.runInContext(`${src}\nthis.showExplorerMenu = showExplorerMenu;`, context)
  return context
}

async function main() {
  const explorer = require('../src/main/explorer')
  try {
    // 1px PNG（真的圖片位元，不是副檔名騙人）
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const dir = tempDir('axondeck-copy-image-')
    const png = path.join(dir, 'a.png')
    const txt = path.join(dir, 'b.txt')
    const svg = path.join(dir, 'c.svg')
    const bad = path.join(dir, 'd.png')
    fs.writeFileSync(png, Buffer.from(pngBase64, 'base64'))
    fs.writeFileSync(txt, 'hello')
    fs.writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    fs.writeFileSync(bad, 'NOT-IMAGE-DATA')

    // 成功：寫進剪貼簿一張圖
    written.length = 0
    const got = await explorer.copyImage(png)
    assert.equal(written.length, 1, 'clipboard.writeImage 要被叫一次')
    assert.deepEqual(got, { width: 2, height: 1 })

    // 非圖片、SVG、壞圖、不存在、資料夾都不收（userMessage 是固定的，不帶路徑）
    const rejectsUserMessage = async (promise, re) => {
      try {
        await promise
      } catch (error) {
        assert.match(String(error?.userMessage || ''), re)
        return
      }
      assert.fail(`應該要失敗：${re}`)
    }
    await rejectsUserMessage(explorer.copyImage(txt), /只有圖片才能複製到剪貼簿/)
    await rejectsUserMessage(explorer.copyImage(svg), /只有圖片才能複製到剪貼簿/)
    await rejectsUserMessage(explorer.copyImage(bad), /這張圖片放不進剪貼簿/)
    await rejectsUserMessage(explorer.copyImage(path.join(dir, 'nope.png')), /找不到這個檔案/)
    await rejectsUserMessage(explorer.copyImage(dir), /只有圖片才能複製到剪貼簿/)
    await rejectsUserMessage(explorer.copyImage('mtp:phone\\DCIM\\a.png'), /手機裡的圖片請先複製到電腦/)
    assert.equal(written.length, 1, '失敗不能多寫剪貼簿')

    // 右鍵選單：有給 act.copyImage 才列「複製圖片」，沒給就不打擾
    const ctx = loadMenu()
    const noop = () => {}
    const base = {
      restore: noop, purge: noop, empty: noop, open: noop, preview: noop,
      openTab: noop, reveal: noop, pin: noop, pinHere: noop, openProject: noop,
      openProjectHere: noop, cut: noop, copy: noop, paste: noop, copyPath: noop,
      copyName: noop, copyImage: noop, shortcut: noop, rename: noop,
      batchRename: noop, remove: noop, newFolder: noop, newFile: noop,
      toggleHidden: noop, refresh: noop, properties: noop
    }
    ctx.__reset()
    ctx.showExplorerMenu({ x: 0, y: 0 }, { items: [{ path: 'C:\\a.png' }], actions: base })
    assert.ok(ctx.__seen().some((m) => m.label === '複製圖片'), '有給 act.copyImage 就要列')
    const noImg = { ...base }
    delete noImg.copyImage
    ctx.__reset()
    ctx.showExplorerMenu({ x: 0, y: 0 }, { items: [{ path: 'C:\\a.png' }], actions: noImg })
    assert.ok(!ctx.__seen().some((m) => m.label === '複製圖片'), '沒給 act.copyImage 就不列')

    // 三份清單對得上（service／ipc／preload／main.js 白名單）
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/explorer/ipc.js'), 'utf8')
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'src/preload/preload.js'), 'utf8')
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main/main.js'), 'utf8')
    const pageSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/scripts/explorer-page.js'), 'utf8')
    assert.ok(ipcSrc.includes("'explorer:copyImage'") && ipcSrc.includes('service.copyImage('), 'ipc 有列')
    assert.ok(preloadSrc.includes("'explorer:copyImage'"), 'preload 有接')
    assert.ok(mainSrc.includes('copyImage: (...args)'), 'main 白名單有接')
    assert.ok(pageSrc.includes('electronAPI.explorer.copyImage('), '檔案頁有呼叫')
    assert.ok(pageSrc.includes('copyImage: canCopyImage(items)'), '檔案頁只給單張本機圖')

    console.log('14 passed, 0 failed')
  } finally {
    Module._load = load
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
