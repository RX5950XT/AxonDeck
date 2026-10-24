/**
 * 獨立編輯視窗：Windows 點兩下 .md／.json／程式碼，或檔案頁開文字檔，都開在這裡。
 * Monaco 編輯＋Markdown 即時預覽；檔案路徑由 main 決定，這頁只讀寫自己那一個檔案。
 */

import { loadMonaco, languageFor } from './ws-monaco.js'
import { renderMarkdown, previewSlice, PREVIEW_MAX_CHARS } from './markdown.js'
import { askConfirm } from './app-dialog.js'
import { mountBigText } from './big-text-view.js'

const api = /** @type {any} */ (window).electronAPI.editorFile
const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))
const ENCODING_LABELS = { utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', big5: 'Big5（唯讀）' }
const MODE_KEY = 'axondeck.editor.markdownMode'
const WRAP_KEY = 'axondeck.editor.wrap'

const state = {
  /** @type {any} */ monaco: null,
  /** @type {any} */ editor: null,
  /** @type {any} */ file: null,
  savedVersion: 0,
  mtimeMs: 0,
  dirty: false,
  saving: false,
  previewTimer: 0,
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

function setDirty(dirty) {
  if (dirty === state.dirty) return
  state.dirty = dirty
  $('edDirty').hidden = !dirty
  const saveButton = /** @type {HTMLButtonElement} */ ($('edSave'))
  saveButton.disabled = !dirty || state.file.readonly
  document.title = `${dirty ? '● ' : ''}${state.file.name} — AxonDeck`
  api.setDirty(dirty)
}

function refreshDirty() {
  setDirty(state.editor.getModel().getAlternativeVersionId() !== state.savedVersion)
}

function paintPreview() {
  if (!state.file.markdown || $('edMain').dataset.mode === 'edit') return
  const box = $('edPreview')
  const top = box.scrollTop
  const model = state.editor.getModel()
  const total = model.getValueLength()
  // 大檔只取開頭那段：`getValue()` 是整份複製，分割模式每停手一次就是一份
  const head = total > PREVIEW_MAX_CHARS ? model.getValueInRange(monacoRangeTo(model.getPositionAt(PREVIEW_MAX_CHARS))) : model.getValue()
  const shown = previewSlice(head, total)
  box.replaceChildren(renderMarkdown(shown.text, 0, state.file.imageBase, { html: true, openLink }))
  if (shown.cut) {
    const note = document.createElement('p')
    note.className = 'ed-preview-cut'
    note.textContent = '檔案太大，預覽只畫開頭一部分；完整內容請切到編輯。'
    box.appendChild(note)
  }
  box.scrollTop = top
}

/** @param {{ lineNumber: number, column: number }} end 從檔頭到 end 的範圍 */
function monacoRangeTo(end) {
  return { startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }
}

/** 預覽裡的相對路徑連結：交給 main 照這個檔案的位置解，另開一扇編輯視窗 */
async function openLink(link) {
  const result = await api.openLink(link)
  if (!result.ok) flash(result.error.message, 'error')
}

function schedulePreview() {
  window.clearTimeout(state.previewTimer)
  state.previewTimer = window.setTimeout(paintPreview, 150)
}

/**
 * @param {string} mode
 * @param {boolean} [remember] 大檔自動改成編輯時不記：不可以蓋掉使用者平常的選擇
 */
function setMode(mode, remember = true) {
  $('edMain').dataset.mode = mode
  for (const button of $('edModes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode))
  }
  // 只記 Markdown 的選擇：程式碼檔永遠是編輯，不能把它蓋掉
  if (state.file.markdown && remember) writePref(MODE_KEY, mode)
  paintPreview()
  if (mode !== 'preview') state.editor.focus()
}

/** Markdown 與程式碼各記各的換行偏好 */
const wrapKey = () => `${WRAP_KEY}.${state.file.markdown ? 'markdown' : 'code'}`

function setWrap(on) {
  state.editor.updateOptions({ wordWrap: on ? 'on' : 'off' })
  $('edWrap').setAttribute('aria-pressed', String(on))
  writePref(wrapKey(), on ? 'on' : 'off')
}

function paintStatus() {
  const pos = state.editor.getPosition()
  $('edCursor').textContent = pos ? `第 ${pos.lineNumber} 行，第 ${pos.column} 欄` : ''
}

async function save(force = false) {
  if (state.file.readonly || state.saving || (!state.dirty && !force)) return
  state.saving = true
  const model = state.editor.getModel()
  const version = model.getAlternativeVersionId()
  const result = await api.save(model.getValue(), force ? 0 : state.mtimeMs)
  state.saving = false
  if (!result.ok) {
    if (result.error.code !== 'STALE') return flash(result.error.message, 'error')
    const overwrite = await askConfirm('這個檔案在外部被改過了', { desc: '要用編輯器裡的內容覆寫嗎？外部的修改會不見。', confirmText: '覆寫', danger: true })
    if (overwrite) await save(true)
    return
  }
  state.mtimeMs = result.data.mtimeMs
  state.savedVersion = version
  refreshDirty()
  notice('')
  flash('已儲存')
}

/** 外部改了檔案：沒改過就直接換成新內容（保留復原紀錄），改過就讓使用者決定 */
async function reload() {
  const result = await api.load()
  if (!result.ok) return flash(result.error.message, 'error')
  const model = state.editor.getModel()
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text: result.data.content }], () => null)
  state.mtimeMs = result.data.mtimeMs
  state.savedVersion = model.getAlternativeVersionId()
  refreshDirty()
  notice('')
  flash('已重新載入')
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

function bindKeys(monaco) {
  const { KeyMod, KeyCode } = monaco
  state.editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyS, () => void save())
  state.editor.addCommand(KeyMod.Alt | KeyCode.KeyZ, () => setWrap($('edWrap').getAttribute('aria-pressed') !== 'true'))
  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase()
    if (event.ctrlKey && !event.shiftKey && key === 's') {
      event.preventDefault()
      void save()
    } else if (event.ctrlKey && event.shiftKey && key === 'v' && state.file.markdown) {
      event.preventDefault()
      setMode($('edMain').dataset.mode === 'preview' ? 'edit' : 'preview')
    }
  })
}

function bindUi() {
  $('edSave').addEventListener('click', () => void save())
  $('edWrap').addEventListener('click', () => setWrap($('edWrap').getAttribute('aria-pressed') !== 'true'))
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
  $('edEncoding').textContent = ENCODING_LABELS[file.encoding] || file.encoding
  $('edModes').hidden = !file.markdown
  if (file.readonly && !file.big) notice('這個檔案不是 UTF-8 編碼，用 Big5 顯示，只能檢視不能儲存。')
}

/** IPC 回 `{ ok, data, error }`：拆成資料或例外，給分段檢視用 */
async function unwrap(pending) {
  const result = await pending
  if (!result.ok) throw new Error(result.error.message)
  return result.data
}

/** 超過 Monaco 上限的檔：唯讀分段檢視（main 只讀畫面要的那幾列） */
async function bootBig(file) {
  for (const id of ['edWrap', 'edSave']) $(id).hidden = true
  $('edLang').textContent = '純文字'
  $('edEol').textContent = ''
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
    $('edEncoding').textContent = ENCODING_LABELS[meta.encoding] || meta.encoding
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
  if (file.big) return bootBig(file)
  const monaco = await monacoReady
  if (!monaco) return fatal('編輯器元件載入失敗，請重新安裝 AxonDeck。')
  state.monaco = monaco
  state.editor = monaco.editor.create($('edSource'), {
    value: file.content,
    language: languageFor(monaco, file.name),
    readOnly: file.readonly,
    automaticLayout: true,
    fontSize: 14,
    lineHeight: 22,
    // 縮圖地圖吃不到透明底（一整條黑塊），跟工作區一樣關掉
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    mouseWheelZoom: true,
    fixedOverflowWidgets: true,
    padding: { top: 10 },
    tabSize: 2
  })
  // 內容已經在 model 裡；留著這份字串，大檔就是白佔一整份記憶體
  file.content = ''
  const model = state.editor.getModel()
  state.savedVersion = model.getAlternativeVersionId()
  const languageId = model.getLanguageId()
  $('edLang').textContent = monaco.languages.getLanguages().find((lang) => lang.id === languageId)?.aliases?.[0] || languageId
  $('edEol').textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF'
  model.onDidChangeContent(() => { refreshDirty(); schedulePreview() })
  state.editor.onDidChangeCursorPosition(paintStatus)
  paintStatus()
  bindKeys(monaco)
  bindUi()
  setWrap(readPref(wrapKey(), file.markdown ? 'on' : 'off') === 'on')
  // Markdown 一打開就是預覽（像看文件）；要改再切編輯／分割
  // 大檔一律先開編輯：預設預覽等於一打開就把整份轉成 DOM
  const big = model.getValueLength() > PREVIEW_MAX_CHARS
  setMode(file.markdown && !big ? readPref(MODE_KEY, 'preview') : 'edit', !big)
}

void boot()
