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
const VARIANT = 'data:image/png;base64,VARIANT'
const BADGED = 'data:image/png;base64,BADGED'
let shown = LOGO
let pending = true
let shellAvailable = true
let badgeBase = VARIANT
let thumbShown
const FOLDER = 'data:image/png;base64,FOLDER'
let folderRequest
const shellExt = require('../src/main/explorer/shell')
shellExt.iconOf = async target => shellAvailable ? (target === process.execPath ? LOGO : shown) : ''
shellExt.iconInfoOf = async target => ({
  url: await shellExt.iconOf(target), baseUrl: shown === BADGED ? badgeBase : await shellExt.iconOf(target),
  ...(shown === BADGED ? { overlay: REAL } : {})
})
shellExt.genericIconOf = async () => GENERIC
shellExt.thumbOf = async (target, size, folderPreview) => {
  if (target === dir) {
    folderRequest = folderPreview
    return { url: folderPreview ? FOLDER : BADGED, entries: [{ name: 'model.gguf', dir: false }], overlay: REAL }
  }
  return { url: target === process.execPath ? LOGO : thumbShown ?? shown, pending, overlay: REAL }
}
const originalLoad = Module._load
Module._load = function (name) {
  if (name === 'electron') return { app: { getFileIcon: async target => ({
    isEmpty: () => !shown, toDataURL: () => target === process.execPath ? LOGO : shown
  }) }, shell: {}, nativeImage: { createFromDataURL: url => ({
    toDataURL: () => url,
    isEmpty: () => false, getSize: () => ({ width: 1, height: 1 }),
    toBitmap: () => Buffer.from(url === LOGO ? [20, 40, 60, 255]
      : url === VARIANT ? [21, 39, 64, 255] : url === GENERIC ? [150, 150, 150, 255] : [100, 100, 100, 255])
  }) } }
  return originalLoad.apply(this, arguments)
}
const explorer = require('../src/main/explorer')
Module._load = originalLoad

async function main() {
  const file = path.join(dir, 'model.gguf')
  const exe = path.join(dir, 'AxonDeck.exe')
  fs.writeFileSync(file, 'x'); fs.writeFileSync(exe, 'x')
  assert.equal((await explorer.fileIcon(file)).fallback, true, '一般檔案不能拿 App logo 當圖示')
  assert.equal((await explorer.fileIcon(exe)).url, LOGO, '執行檔保留自己的圖示')
  shown = VARIANT
  assert.equal((await explorer.fileIcon(file)).fallback, true, '同一張 logo 的像素略有誤差仍要排除')
  assert.equal((await explorer.fileIcon(exe)).url, VARIANT, '執行檔保留略有誤差的自身圖示')
  shown = BADGED
  const badged = await explorer.fileIcon(file)
  assert.equal(badged.fallback, true, '同步標記不能讓 App logo 漏過比對')
  assert.equal(badged.overlay, REAL, '清單換成類型圖示仍保留同步標記')
  badgeBase = REAL
  const validBadge = await explorer.fileIcon(file)
  assert.equal(validBadge.url, BADGED, '正確且已有同步標記的 Windows 圖示要保留')
  assert.equal(validBadge.overlay, undefined, '正確清單圖示不重複疊同步標記')
  shown = GENERIC
  assert.equal((await explorer.fileIcon(file)).fallback, true, 'Windows 通用空白圖改用檔案類型圖')
  shown = REAL
  assert.equal((await explorer.fileIcon(file)).url, REAL, '正確的 Windows 圖示要保留')
  thumbShown = VARIANT
  assert.equal((await explorer.fileIcon(file, { thumb: true })).url, REAL,
    '暫時的大圖是有色差的 logo 時改用正確類型圖示')
  thumbShown = undefined
  shown = LOGO
  const interim = await explorer.fileIcon(file, { thumb: true, size: 96 })
  assert.equal(interim.fallback, true); assert.equal(interim.pending, true)
  assert.equal(interim.overlay, REAL, '換預設圖仍保留同步標記')
  pending = false
  assert.equal((await explorer.fileIcon(file, { thumb: true })).url, LOGO, '照片內容是 logo 時仍保留真縮圖')
  shellAvailable = false
  shown = VARIANT
  assert.equal((await explorer.fileIcon(file)).fallback, true, 'Electron 退路也要擋像素略有誤差的 logo')
  shown = LOGO
  assert.equal((await explorer.fileIcon(file)).fallback, true, 'Electron 退路也要擋 App logo')
  let dragged
  await explorer.startDrag([file], { startDrag: spec => { dragged = spec.icon } })
  assert.notEqual(dragged.toDataURL(), LOGO, '拖曳備用圖不能重新拿回已排除的 App logo')
  shown = ''
  assert.equal((await explorer.fileIcon(file)).fallback, true, '圖示都讀不到仍回預設圖')
  console.log('PASS 圖示來源、App logo、空白圖、執行檔、真縮圖、pending 與 overlay')

  shown = LOGO; pending = true; shellAvailable = true
  const folder = await explorer.fileIcon(dir, { thumb: true, size: 128 })
  assert.equal(folderRequest, true, '資料夾要拿沒有混入內容 logo 的外框')
  assert.equal(folder.url, FOLDER)
  assert.equal(folder.overlay, REAL, '資料夾外框保留同步標記')
  assert.equal(folder.previews.length, 1, '保留資料夾內容預覽')
  assert.equal(folder.previews[0].fallback, true, '資料夾裡面的檔案也要過濾 App logo')
  assert.equal(folder.pending, true, '子縮圖還沒完成時繼續重試')
  pending = false; shown = REAL
  const photoFolder = await explorer.fileIcon(dir, { thumb: true, size: 128 })
  assert.equal(photoFolder.previews[0].url, REAL, '內容的真縮圖要保留')
  assert.equal(photoFolder.pending, undefined)
  console.log('PASS 資料夾內容共用圖示過濾、真縮圖、同步標記與 pending')

  const context = { document: { createElement: () => ({}) }, console }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/explorer-icons.js'), 'utf8')
    .replace(/^export /gm, ''), context)
  const urls = new Set()
  const kinds = new Set()
  for (const ext of ['txt', 'js', 'pdf', 'png', 'mp4', 'mp3', 'zip', 'xlsx', 'gguf', 'ttf', 'exe', 'unknown',
    'docx', 'pptx', 'json', 'wav', 'flac', 'stl', '3mf']) {
    const el = { dataset: {}, replaceChildren: image => { el.image = image } }
    context.paintDefaultFileIcon(el, { ext })
    assert.match(el.image.src, /^data:image\/svg\+xml,/)
    assert.ok(decodeURIComponent(el.image.src).includes('<title>'))
    urls.add(el.image.src)
    kinds.add(el.dataset.iconType)
  }
  assert.equal(urls.size, 19, '十九種副檔名有各自圖示')
  assert.equal(kinds.size, 15, '全部十五種圖示類型都包含在驗證中')
  const el = { dataset: {}, replaceChildren: image => { el.image = image } }
  context.paintDefaultFileIcon(el, { ext: '"><script>alert(1)</script>' })
  assert.ok(!decodeURIComponent(el.image.src).includes('<script>'), '外部副檔名不能變成 SVG 程式碼')
  el.firstElementChild = el.image
  el.children = [el.image]
  const decoded = el.image
  context.showIcon(el, { fallback: true })
  assert.equal(el.image, decoded, 'pending 的同一張圖不能反覆換 img')
  console.log('PASS 全部十五種類型、十九種副檔名預設 SVG 與外部輸入安全檢查')

  function element() {
    return { dataset: {}, children: [], replaceChildren(...nodes) {
      this.children = nodes; this.firstElementChild = nodes[0]
    } }
  }
  context.document.createElement = element
  const folderEl = element()
  const folderData = { url: FOLDER, overlay: REAL, previews: [{ name: 'sample.wav', fallback: true }] }
  context.showIcon(folderEl, folderData)
  const card = folderEl.children.find(node => node.className === 'ex-folder-preview')
  assert.equal(card?.dataset.iconType, 'audio', '資料夾內容預覽顯示已過濾的音訊圖')
  assert.match(card.firstElementChild.src, /^data:image\/svg\+xml,/)
  assert.equal(folderEl.children.at(-1).src, REAL, '資料夾標記放在內容最上面')
  const oldCard = card
  context.showIcon(folderEl, folderData)
  assert.equal(folderEl.children[1], oldCard, '相同資料夾預覽不重建已解碼圖')
  context.showIcon(folderEl, { ...folderData, previews: [{ name: 'photo.png', url: REAL }] })
  assert.equal(folderEl.children[1].firstElementChild.src, REAL, '內容更新時換成真照片縮圖')
  console.log('PASS 資料夾內容繪製、類型預設圖、照片、同步標記與重試不重建')
}
main().catch(error => { console.error(error); process.exitCode = 1 }).finally(() => removeTree(dir))
