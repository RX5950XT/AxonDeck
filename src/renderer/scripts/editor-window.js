/**
 * 獨立編輯視窗：Windows 點兩下 .md／.json／程式碼，或檔案頁開文字檔，都開在這裡。
 * Monaco 編輯＋預覽（Markdown／HTML／CSV／Mermaid）；檔案路徑由 main 決定，這頁只讀寫自己那一個檔案。
 * 體驗對照 VS Code／Notepads／Win11 記事本：狀態列每格可點、另存新檔、比較未儲存的變更、縮圖地圖。
 */

import { loadMonaco, languageFor, extendThemes } from './ws-monaco.js'
import { PREVIEW_MAX_CHARS } from './markdown.js'
import { askConfirm } from './app-dialog.js'
import { mountBigText } from './big-text-view.js'
import { showMenu } from './ws-menu.js'
import { initPreview, paintPreview as paintPreviewKind, previewDelay, syncPreviewTo } from './editor-preview.js'
import { ENCODING_LABELS, mountStatus, paintEncoding, paintEol } from './editor-status.js'

const api = /** @type {any} */ (window).electronAPI.editorFile
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const MODE_KEY = 'axondeck.editor.markdownMode'
const WRAP_KEY = 'axondeck.editor.wrap'
const MINIMAP_KEY = 'axondeck.editor.minimap'
const WHITESPACE_KEY = 'axondeck.editor.whitespace'
/** 第一次開某種預覽時的顯示方式：文件與表格直接看結果，HTML／圖表邊寫邊看 */
const DEFAULT_MODES = { markdown: 'preview', csv: 'preview', html: 'split', mermaid: 'split' }
const HEAVY_CHARS = 20 * 1024 * 1024
const HEAVY_LINES = 300000
/** 縮圖地圖與捲軸標記的實色底，跟視窗底色（main 的 titleBarOverlay）一樣 */
const SURFACE = {
  dark: { 'minimap.background': '#111417', 'editorOverviewRuler.background': '#111417' },
  light: { 'minimap.background': '#e9eeec', 'editorOverviewRuler.background': '#e9eeec' }
}

const state = {
  /** @type {any} */ monaco: null,
  /** @type {any} */ editor: null,
  /** @type {any} */ file: null,
  /** 使用者從狀態列指定的編碼；外面改檔重新載入時照它解，不再自動猜 @type {string | undefined} */
  pickedEncoding: undefined,
  /** @type {{ diff: any, original: any } | null} */ diff: null,
  savedVersion: 0,
  mtimeMs: 0,
  dirty: false,
  saving: false,
  previewTimer: 0,
  syncFrame: 0,
  msgTimer: 0
}

function readPref(key, fallback) {
  try { return localStorage.getItem(key) || fallback } catch { return fallback }
}
function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch { /* 沒有儲存空間就只記這一次 */ }
}

function flash(text, tone = '') {
  const el = $('edMsg')
  el.textContent = text
  el.dataset.tone = tone
  window.clearTimeout(state.msgTimer)
  if (tone !== 'error') state.msgTimer = window.setTimeout(() => { el.textContent = '' }, 2500)
}

/** @param {string} text @param {{ label: string, run: () => void } | null} [action] */
function notice(text, action = null) {
  $('edNotice').hidden = !text
  $('edNoticeText').textContent = text
  const button = /** @type {HTMLButtonElement} */ ($('edNoticeAction'))
  button.hidden = !action
  button.textContent = action?.label || ''
  button.onclick = action ? () => action.run() : null
}

function fatal(message) {
  $('edMain').dataset.mode = 'fatal'
  $('edFatal').hidden = false
  $('edFatal').textContent = message
}

const saveButton = () => /** @type {HTMLButtonElement} */ ($('edSave'))
const paintTitle = () => { document.title = `${state.dirty ? '● ' : ''}${state.file.name} — AxonDeck` }
const encodingLabel = (encoding) => ENCODING_LABELS[encoding] || encoding

function setDirty(dirty) {
  if (dirty === state.dirty) return
  state.dirty = dirty
  $('edDirty').hidden = !dirty
  saveButton().disabled = !dirty || state.file.readonly
  paintTitle()
  api.setDirty(dirty)
}

function refreshDirty() {
  setDirty(state.editor.getModel().getAlternativeVersionId() !== state.savedVersion)
}

/** 唯讀＝這個編碼寫不回去（Big5、GBK…）：可以一鍵轉成 UTF-8 存，之後就能改 */
function setReadonly(readonly) {
  state.file.readonly = readonly
  state.editor?.updateOptions({ readOnly: readonly })
  saveButton().disabled = !state.dirty || readonly
  if (state.editor) paintEncoding()
  if (!readonly) return notice('')
  notice(`這個檔案用 ${encodingLabel(state.file.encoding)} 顯示，只能檢視。`, { label: '轉成 UTF-8 並儲存', run: () => void save(false, 'utf8') })
}

const currentMode = () => $('edMain').dataset.mode

function paintPreview() {
  if (!state.file.preview || currentMode() === 'edit') return
  paintPreviewKind(state.file, state.editor.getModel())
  if (currentMode() === 'split') syncPreviewTo(state.editor)
}

/** 預覽裡的相對路徑連結：交給 main 照這個檔案的位置解，另開一扇編輯視窗 */
async function openLink(link) {
  const result = await api.openLink(link)
  if (!result.ok) flash(result.error.message, 'error')
}

function schedulePreview() {
  if (!state.file.preview) return
  window.clearTimeout(state.previewTimer)
  state.previewTimer = window.setTimeout(paintPreview, previewDelay(state.file.preview))
}

/** Markdown 沿用舊的偏好鍵（升級後不跳回預設），其他預覽各記各的 */
const modeKey = () => (state.file.preview === 'markdown' ? MODE_KEY : `${MODE_KEY}.${state.file.preview}`)

/**
 * @param {string} mode
 * @param {boolean} [remember] 大檔自動改成編輯時不記：不可以蓋掉使用者平常的選擇
 */
function setMode(mode, remember = true) {
  $('edMain').dataset.mode = mode
  for (const button of $('edModes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  // 只記有預覽的格式：程式碼檔永遠是編輯，不能把它蓋掉
  if (state.file.preview && remember) writePref(modeKey(), mode)
  paintPreview()
  if (mode !== 'preview') state.editor.focus()
}

/** 有沒有預覽、預設顯示方式：開檔與另存成別種副檔名時都要重算 */
function applyPreviewKind() {
  $('edModes').hidden = !state.file.preview
  if (!state.file.preview) return setMode('edit', false)
  // 大檔一律先開編輯：預設預覽等於一打開就把整份轉成 DOM
  const big = state.editor.getModel().getValueLength() > PREVIEW_MAX_CHARS
  setMode(big ? 'edit' : readPref(modeKey(), DEFAULT_MODES[state.file.preview] || 'edit'), !big)
}

/** Markdown 與程式碼各記各的換行偏好 */
const wrapKey = () => `${WRAP_KEY}.${state.file.preview === 'markdown' ? 'markdown' : 'code'}`

function setWrap(on) {
  state.editor.updateOptions({ wordWrap: on ? 'on' : 'off' })
  $('edWrap').setAttribute('aria-pressed', String(on))
  writePref(wrapKey(), on ? 'on' : 'off')
}

/**
 * @param {boolean} [force] 使用者選了覆寫外部修改
 * @param {string} [encoding] 換成這個編碼存（狀態列「以其他編碼儲存」；唯讀編碼也靠它轉成可編輯）
 */
async function save(force = false, encoding = undefined) {
  const convert = encoding !== undefined
  if (state.saving || (!convert && (state.file.readonly || (!state.dirty && !force)))) return
  state.saving = true
  const model = state.editor.getModel()
  const version = model.getAlternativeVersionId()
  const result = await api.save(model.getValue(), force ? 0 : state.mtimeMs, encoding)
  state.saving = false
  if (!result.ok) {
    if (result.error.code !== 'STALE') return flash(result.error.message, 'error')
    const overwrite = await askConfirm('這個檔案在外部被改過了', { desc: '要用編輯器裡的內容覆寫嗎？外部的修改會不見。', confirmText: '覆寫', danger: true })
    if (overwrite) await save(true, encoding)
    return
  }
  state.mtimeMs = result.data.mtimeMs
  state.savedVersion = version
  state.file.encoding = result.data.encoding
  if (convert) state.pickedEncoding = result.data.encoding
  refreshDirty()
  setReadonly(false)
  flash(convert ? `已用 ${encodingLabel(result.data.encoding)} 儲存` : '已儲存')
}

/** 另存新檔：路徑在 main 的對話框選；之後這扇窗就是新檔案（語言、預覽跟著新副檔名） */
async function saveAs() {
  if (state.saving || !state.editor) return
  state.saving = true
  const model = state.editor.getModel()
  const version = model.getAlternativeVersionId()
  const result = await api.saveAs(model.getValue())
  state.saving = false
  if (!result.ok) return flash(result.error.message, 'error')
  if (result.data.canceled) return
  Object.assign(state.file, result.data)
  state.mtimeMs = result.data.mtimeMs
  state.savedVersion = version
  state.pickedEncoding = undefined
  state.monaco.editor.setModelLanguage(model, languageFor(state.monaco, state.file.name))
  paintHeader(state.file)
  refreshDirty()
  paintTitle()
  setReadonly(false)
  applyPreviewKind()
  flash('已另存新檔')
}

/** 換上 main 剛讀的內容（保留復原紀錄，Ctrl+Z 拿得回來） */
function replaceContent(data) {
  const model = state.editor.getModel()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: data.content }], () => null)
  state.mtimeMs = data.mtimeMs
  state.savedVersion = model.getAlternativeVersionId()
  state.file.encoding = data.encoding
  refreshDirty()
  setReadonly(data.readonly)
  paintEol()
}

/** 外部改了檔案：沒改過就直接換成新內容，改過就讓使用者決定 */
async function reload() {
  const result = await api.load(state.pickedEncoding)
  if (!result.ok) return flash(result.error.message, 'error')
  replaceContent(result.data)
  flash('已重新載入')
}

/** 狀態列「以其他編碼重新開啟」：亂碼時換一個編碼解 */
async function reopen(encoding) {
  if (state.dirty) {
    const discard = await askConfirm('還有沒儲存的修改', { desc: '用其他編碼重新開啟會捨棄這些修改（之後仍可按 Ctrl+Z 拿回來）。', confirmText: '重新開啟', danger: true })
    if (!discard) return
  }
  const result = await api.load(encoding)
  if (!result.ok) return flash(result.error.message, 'error')
  state.pickedEncoding = encoding
  replaceContent(result.data)
  flash(`已用 ${encodingLabel(encoding)} 重新開啟`)
}

async function checkExternal() {
  if (!state.editor || state.saving) return
  const result = await api.stat()
  if (!result.ok) return
  if (!result.data.exists) return notice('這個檔案已經被刪除或搬走了；按儲存會在原位置重新建立。')
  if (Math.abs(result.data.mtimeMs - state.mtimeMs) <= 1) return
  if (!state.dirty) return reload()
  notice('這個檔案在外部被改過了。', { label: '捨棄我的修改並重新載入', run: () => void reload() })
}

/** 比較未儲存的變更（VS Code 的 Compare with Saved、Notepads 的差異檢視）：左邊磁碟、右邊編輯中 */
async function compareWithSaved() {
  if (state.diff) return closeDiff()
  const result = await api.readDisk()
  if (!result.ok) return flash(result.error.message, 'error')
  const { monaco, editor } = state
  const model = editor.getModel()
  const original = monaco.editor.createModel(result.data.content, model.getLanguageId())
  $('edDiff').hidden = false
  $('edMain').dataset.diff = 'on'
  const diff = monaco.editor.createDiffEditor($('edDiffHost'), {
    automaticLayout: true, originalEditable: false, readOnly: state.file.readonly, renderSideBySide: true,
    ignoreTrimWhitespace: false, minimap: { enabled: false }, fontSize: 14, lineHeight: 22, scrollBeyondLastLine: false
  })
  diff.setModel({ original, modified: model })
  state.diff = { diff, original }
  if (!result.data.exists) flash('磁碟上已經沒有這個檔案，左邊是空的')
  else if (!state.dirty) flash('沒有未儲存的變更')
}

function closeDiff() {
  if (!state.diff) return
  state.diff.diff.dispose()
  state.diff.original.dispose()
  state.diff = null
  $('edDiff').hidden = true
  delete $('edMain').dataset.diff
  state.editor.focus()
}

async function openPicked() {
  const result = await api.openPicked()
  if (!result.ok) flash(result.error.message, 'error')
}

function runAction(id) {
  if (!state.editor) return
  state.editor.focus()
  state.editor.trigger('axondeck', id, null)
}

function toggleOption(key, on, apply) {
  writePref(key, on ? 'on' : 'off')
  state.editor.updateOptions(apply(on))
}

function moreMenu() {
  const rect = $('edMore').getBoundingClientRect()
  const ready = Boolean(state.editor)
  const minimap = readPref(MINIMAP_KEY, 'on') === 'on'
  const whitespace = readPref(WHITESPACE_KEY, 'off') === 'on'
  showMenu({ x: rect.right - 240, y: rect.bottom + 4 }, [
    { label: '開啟檔案…', hint: 'Ctrl+O', onSelect: () => void openPicked() },
    { label: '另存新檔…', hint: 'Ctrl+Shift+S', disabled: !ready, onSelect: () => void saveAs() },
    { sep: true },
    { label: state.diff ? '關閉比較' : '比較未儲存的變更', disabled: !ready, onSelect: () => void compareWithSaved() },
    { label: '尋找與取代', hint: 'Ctrl+H', disabled: !ready, onSelect: () => runAction('editor.action.startFindReplaceAction') },
    { label: '指令選擇區', hint: 'F1', disabled: !ready, onSelect: () => runAction('editor.action.quickCommand') },
    { sep: true },
    { label: '縮圖地圖', checked: minimap, disabled: !ready, onSelect: () => toggleOption(MINIMAP_KEY, !minimap, (on) => ({ minimap: { enabled: on } })) },
    { label: '顯示空白字元', checked: whitespace, disabled: !ready, onSelect: () => toggleOption(WHITESPACE_KEY, !whitespace, (on) => ({ renderWhitespace: on ? 'all' : 'selection' })) },
    { sep: true },
    { label: '在 AxonDeck 檔案頁顯示', onSelect: () => void api.reveal() },
    { label: '複製完整路徑', onSelect: async () => { await api.copyPath(); flash('已複製路徑') } }
  ])
}

/** 視窗層級快速鍵：capture 階段先攔，Monaco 不會再收到一次（不然另存會跳兩個對話框） */
function onKey(event) {
  if (!event.ctrlKey || event.altKey || !state.file) return
  const key = event.key.toLowerCase()
  const zoom = { '=': 'editor.action.fontZoomIn', '+': 'editor.action.fontZoomIn', '-': 'editor.action.fontZoomOut', 0: 'editor.action.fontZoomReset' }
  let run = null
  if (key === 's') run = !state.editor ? () => {} : event.shiftKey ? saveAs : () => save()
  else if (key === 'o' && !event.shiftKey) run = openPicked
  else if (key === 'v' && event.shiftKey && state.file.preview) run = () => setMode(currentMode() === 'preview' ? 'edit' : 'preview')
  else if (zoom[key] && state.editor) run = () => runAction(zoom[key])
  if (!run) return
  event.preventDefault()
  event.stopPropagation()
  void run()
}

function bindKeys(monaco) {
  const { KeyMod, KeyCode } = monaco
  state.editor.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => setWrap($('edWrap').getAttribute('aria-pressed') !== 'true'))
}

function bindUi() {
  $('edSave').addEventListener('click', () => void save())
  $('edWrap').addEventListener('click', () => setWrap($('edWrap').getAttribute('aria-pressed') !== 'true'))
  $('edDiffClose').addEventListener('click', closeDiff)
  $('edModes').addEventListener('click', (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest('button[data-mode]')
    if (button) setMode(/** @type {HTMLElement} */ (button).dataset.mode || 'edit')
  })
  window.addEventListener('focus', () => void checkExternal())
  api.onCloseRequest(async () => {
    const discard = await askConfirm('還有沒儲存的修改', { desc: '關閉後這些修改會不見。想留下就先按取消，再按 Ctrl+S 儲存。', confirmText: '不儲存，直接關閉', danger: true })
    if (discard) api.close()
  })
}

function paintHeader(file) {
  document.title = `${file.name} — AxonDeck`
  $('edName').textContent = file.name
  $('edPath').textContent = file.path
  $('edPath').title = file.path
}

/** IPC 回 `{ ok, data, error }`：拆成資料或例外，給分段檢視用 */
async function unwrap(pending) {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

/** 超過 Monaco 上限的檔：唯讀分段檢視（main 只讀畫面要的那幾列） */
async function bootBig() {
  for (const id of ['edWrap', 'edSave', 'edIndent', 'edEol', 'edLang']) $(id).hidden = true
  for (const id of ['edCursor', 'edEncoding']) /** @type {HTMLButtonElement} */ ($(id)).disabled = true
  notice('檔案超過 256MB，用唯讀分段檢視開啟：可以捲動、跳行、搜尋，不能編輯。')
  const loading = document.createElement('p')
  loading.className = 'ed-loading'
  loading.textContent = '正在建立索引（檔案越大越久）…'
  $('edSource').replaceChildren(loading)
  let opened
  try {
    opened = await unwrap(api.bigOpen())
  } catch (error) {
    return fatal(error.message)
  }
  const paintMeta = (meta) => {
    $('edEncoding').textContent = encodingLabel(meta.encoding)
    $('edCursor').textContent = `${meta.lines.toLocaleString()} 行`
  }
  mountBigText($('edSource'), {
    ...opened,
    read: (start, count) => unwrap(api.bigRows(start, count)),
    line: (line) => unwrap(api.bigLine(line)),
    find: (query, afterRow, matchCase) => unwrap(api.bigFind(query, afterRow, matchCase)),
    mtime: async () => (await unwrap(api.stat())).mtimeMs,
    reopen: async () => {
      const meta = await unwrap(api.bigOpen())
      paintMeta(meta)
      return meta
    }
  }, { onError: (message) => flash(message, 'error') }).focus()
  paintMeta(opened)
}

/** @param {any} monaco @param {any} file */
function createEditor(monaco, file) {
  return monaco.editor.create($('edSource'), {
    value: file.content,
    language: languageFor(monaco, file.name),
    readOnly: file.readonly,
    automaticLayout: true,
    fontSize: 14,
    lineHeight: 22,
    // 縮圖地圖與它旁邊的捲軸標記吃不到透明底（會畫成一整條黑／灰塊），底色見 SURFACE
    minimap: { enabled: readPref(MINIMAP_KEY, 'on') === 'on', renderCharacters: false },
    stickyScroll: { enabled: true },
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    renderWhitespace: readPref(WHITESPACE_KEY, 'off') === 'on' ? 'all' : 'selection',
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    mouseWheelZoom: true,
    fixedOverflowWidgets: true,
    padding: { top: 10 },
    tabSize: 2
  })
}

/** 分割模式：編輯器捲動時預覽跟著走（一幀最多算一次） */
function onEditorScroll() {
  if (state.syncFrame || currentMode() !== 'split' || state.file.preview !== 'markdown') return
  state.syncFrame = window.requestAnimationFrame(() => {
    state.syncFrame = 0
    syncPreviewTo(state.editor)
  })
}

async function boot() {
  // 讀檔與載 Monaco 同時跑：大檔光讀進來就要一兩秒，排隊等等於白等
  const monacoReady = loadMonaco()
  const result = await api.load()
  if (!result.ok) return fatal(result.error.message)
  const file = result.data
  state.file = file
  state.mtimeMs = file.mtimeMs
  document.documentElement.dataset.theme = file.theme
  paintHeader(file)
  if (file.big) return bootBig()
  const monaco = await monacoReady
  if (!monaco) return fatal('編輯器元件載入失敗，請重新安裝 AxonDeck。')
  state.monaco = monaco
  extendThemes(monaco, SURFACE)
  state.editor = createEditor(monaco, file)
  // 內容已經在 model 裡；留著這份字串，大檔就是白佔一整份記憶體
  file.content = ''
  const model = state.editor.getModel()
  // 大檔（跟工作區同一條線）：縮圖地圖、sticky scroll、括號配色每打一個字都要重算，183MB 實測打字慢一倍
  if (model.getValueLength() > HEAVY_CHARS || model.getLineCount() > HEAVY_LINES) {
    state.editor.updateOptions({ minimap: { enabled: false }, stickyScroll: { enabled: false }, bracketPairColorization: { enabled: false } })
  }
  state.savedVersion = model.getAlternativeVersionId()
  model.onDidChangeContent(() => { refreshDirty(); schedulePreview() })
  state.editor.onDidScrollChange(onEditorScroll)
  initPreview({ box: $('edPreview'), api, openLink })
  mountStatus({ monaco, editor: state.editor, file: () => state.file, reopen: (enc) => void reopen(enc), saveAs: (enc) => void save(false, enc) })
  bindKeys(monaco)
  bindUi()
  setWrap(readPref(wrapKey(), file.preview === 'markdown' ? 'on' : 'off') === 'on')
  if (file.readonly) setReadonly(true)
  applyPreviewKind()
}

window.addEventListener('keydown', onKey, true)
$('edMore').addEventListener('click', moreMenu)
void boot()
