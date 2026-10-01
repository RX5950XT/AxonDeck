const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const vm = require('vm')
const { tempDir, removeTree } = require('./lib/test-temp')

const dir = tempDir('icon-fallback-')
const LOGO = 'data:image/png;base64,LOGO'
const GENERIC = 'data:image/png;base64,GENERIC'
const REAL = 'data:image/png;base64,REAL'
let shown = LOGO
let pending = true
let shellAvailable = true
const shellExt = require('../src/main/explorer/shell')
shellExt.iconOf = async target => shellAvailable ? (target === process.execPath ? LOGO : shown) : ''
shellExt.genericIconOf = async () => GENERIC
shellExt.thumbOf = async () => ({ url: shown, pending, overlay: REAL })
const originalLoad = Module._load
Module._load = function (name) {
  if (name === 'electron') return { app: { getFileIcon: async target => ({
    isEmpty: () => !shown, toDataURL: () => target === process.execPath ? LOGO : shown
  }) }, shell: {} }
  return originalLoad.apply(this, arguments)
}
const explorer = require('../src/main/explorer')
Module._load = originalLoad

async function main() {
  const file = path.join(dir, 'model.gguf')
  const exe = path.join(dir, 'VoiceInk.exe')
  fs.writeFileSync(file, 'x'); fs.writeFileSync(exe, 'x')
  assert.equal((await explorer.fileIcon(file)).fallback, true, '一般檔案不能拿 App logo 當圖示')
  assert.equal((await explorer.fileIcon(exe)).url, LOGO, '執行檔保留自己的圖示')
  shown = GENERIC
  assert.equal((await explorer.fileIcon(file)).fallback, true, 'Windows 通用空白圖改用檔案類型圖')
  shown = REAL
  assert.equal((await explorer.fileIcon(file)).url, REAL, '正確的 Windows 圖示要保留')
  shown = LOGO
  const interim = await explorer.fileIcon(file, { thumb: true, size: 96 })
  assert.equal(interim.fallback, true); assert.equal(interim.pending, true)
  assert.equal(interim.overlay, REAL, '換預設圖仍保留同步標記')
  pending = false
  assert.equal((await explorer.fileIcon(file, { thumb: true })).url, LOGO, '照片內容是 logo 時仍保留真縮圖')
  shellAvailable = false
  assert.equal((await explorer.fileIcon(file)).fallback, true, 'Electron 退路也要擋 App logo')
  shown = ''
  assert.equal((await explorer.fileIcon(file)).fallback, true, '圖示都讀不到仍回預設圖')
  console.log('PASS 圖示來源、App logo、空白圖、執行檔、真縮圖、pending 與 overlay')

  const context = { document: { createElement: () => ({}) }, console }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/explorer-icons.js'), 'utf8')
    .replace(/^export /gm, ''), context)
  const urls = new Set()
  for (const ext of ['txt', 'js', 'pdf', 'png', 'mp4', 'mp3', 'zip', 'xlsx', 'gguf', 'ttf', 'exe', 'unknown']) {
    const el = { dataset: {}, replaceChildren: image => { el.image = image } }
    context.paintDefaultFileIcon(el, { ext })
    assert.match(el.image.src, /^data:image\/svg\+xml,/)
    assert.ok(decodeURIComponent(el.image.src).includes('<title>'))
    urls.add(el.image.src)
  }
  assert.equal(urls.size, 12, '十二種檔案類型有各自圖示')
  const el = { dataset: {}, replaceChildren: image => { el.image = image } }
  context.paintDefaultFileIcon(el, { ext: '"><script>alert(1)</script>' })
  assert.ok(!decodeURIComponent(el.image.src).includes('<script>'), '外部副檔名不能變成 SVG 程式碼')
  el.firstElementChild = el.image
  el.children = [el.image]
  const decoded = el.image
  context.showIcon(el, { fallback: true })
  assert.equal(el.image, decoded, 'pending 的同一張圖不能反覆換 img')
  console.log('PASS 十二種類型預設 SVG 與外部輸入安全檢查')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => removeTree(dir))
