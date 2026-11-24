/**
 * 獨立編輯視窗的狀態列：每一格都點得開（對照 VS Code／Notepads／Win11 記事本）。
 *   行欄 → 跳到某一行；選取字數
 *   縮排 → 空格／Tab、寬度、整份轉換
 *   編碼 → 以其他編碼重新開啟、以 UTF-8／UTF-8 BOM／UTF-16 LE 儲存
 *   換行字元 → LF／CRLF
 *   語言 → 可搜尋的語言清單
 */

import { showMenu } from './ws-menu.js'

export const ENCODING_LABELS = {
  utf8: 'UTF-8', utf8bom: 'UTF-8 BOM', utf16le: 'UTF-16 LE', utf16be: 'UTF-16 BE', big5: 'Big5',
  gbk: 'GBK', gb18030: 'GB18030', shift_jis: 'Shift JIS', 'euc-kr': 'EUC-KR', 'windows-1252': 'Western（Windows 1252）'
}
const REOPEN = ['utf8', 'utf8bom', 'utf16le', 'utf16be', 'big5', 'gbk', 'gb18030', 'shift_jis', 'euc-kr', 'windows-1252']
const SAVE = ['utf8', 'utf8bom', 'utf16le']

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id))

/**
 * @typedef {{
 *   monaco: any, editor: any, file: () => any,
 *   reopen: (encoding: string) => void, saveAs: (encoding: string) => void
 * }} StatusHooks
 */

/** @type {StatusHooks | null} */
let hooks = null

/** 選單從那一格的上緣往上長（狀態列在視窗最下面） */
function menuAt(button, items) {
  const rect = button.getBoundingClientRect()
  showMenu({ x: rect.left, y: rect.top }, items)
  const menu = /** @type {HTMLElement | null} */ (document.querySelector('body > .ws-menu:last-of-type'))
  if (menu) menu.style.top = `${Math.max(4, rect.top - menu.offsetHeight - 4)}px`
}

export function paintCursor() {
  const { editor } = /** @type {StatusHooks} */ (hooks)
  const pos = editor.getPosition()
  const model = editor.getModel()
  const chars = editor.getSelections().reduce((sum, sel) => sum + model.getValueLengthInRange(sel), 0)
  $('edCursor').textContent = pos ? `第 ${pos.lineNumber} 行，第 ${pos.column} 欄${chars ? `（已選取 ${chars.toLocaleString()} 字）` : ''}` : ''
}

export function paintIndent() {
  const { insertSpaces, tabSize } = hooks.editor.getModel().getOptions()
  $('edIndent').textContent = `${insertSpaces ? '空格' : 'Tab'}：${tabSize}`
}

export function paintEol() {
  $('edEol').textContent = hooks.editor.getModel().getEOL() === '\r\n' ? 'CRLF' : 'LF'
}

export function paintEncoding() {
  const file = hooks.file()
  $('edEncoding').textContent = `${ENCODING_LABELS[file.encoding] || file.encoding}${file.readonly ? '（唯讀）' : ''}`
}

export function paintLanguage() {
  const { monaco, editor } = hooks
  const id = editor.getModel().getLanguageId()
  $('edLang').textContent = monaco.languages.getLanguages().find((lang) => lang.id === id)?.aliases?.[0] || id
}

function indentMenu(button) {
  const { editor } = hooks
  const model = editor.getModel()
  const { insertSpaces, tabSize } = model.getOptions()
  const set = (next) => { model.updateOptions(next); paintIndent() }
  const run = (id) => { editor.focus(); editor.trigger('axondeck', id, null); paintIndent() }
  menuAt(button, [
    { label: '使用空格縮排', checked: insertSpaces, onSelect: () => set({ insertSpaces: true }) },
    { label: '使用 Tab 縮排', checked: !insertSpaces, onSelect: () => set({ insertSpaces: false }) },
    { sep: true },
    ...[2, 4, 8].map((size) => ({ label: `縮排寬度 ${size}`, checked: tabSize === size, onSelect: () => set({ tabSize: size, indentSize: size }) })),
    { sep: true },
    { label: '把縮排全部轉成空格', onSelect: () => run('editor.action.indentationToSpaces') },
    { label: '把縮排全部轉成 Tab', onSelect: () => run('editor.action.indentationToTabs') }
  ])
}

function encodingMenu(button) {
  const file = hooks.file()
  const reopen = REOPEN.map((enc) => ({ label: ENCODING_LABELS[enc], checked: file.encoding === enc, onSelect: () => hooks.reopen(enc) }))
  const save = SAVE.map((enc) => ({ label: ENCODING_LABELS[enc], checked: file.encoding === enc && !file.readonly, onSelect: () => hooks.saveAs(enc) }))
  menuAt(button, [
    { label: '以其他編碼重新開啟', children: reopen },
    { label: '以其他編碼儲存', children: save }
  ])
}

function eolMenu(button) {
  const { monaco, editor } = hooks
  const model = editor.getModel()
  const crlf = model.getEOL() === '\r\n'
  // pushEOL 進復原紀錄、版本號會變：跟其他修改一樣標成未儲存
  const set = (seq) => { model.pushEOL(seq); paintEol() }
  menuAt(button, [
    { label: 'LF（macOS／Linux）', checked: !crlf, onSelect: () => set(monaco.editor.EndOfLineSequence.LF) },
    { label: 'CRLF（Windows）', checked: crlf, onSelect: () => set(monaco.editor.EndOfLineSequence.CRLF) }
  ])
}

/** 可搜尋的語言清單（Monaco 沒有公開 quick pick，自己做一個小的） */
function languagePicker(button) {
  const { monaco, editor } = hooks
  document.querySelector('.ed-picker')?.remove()
  const current = editor.getModel().getLanguageId()
  const langs = monaco.languages.getLanguages()
    .map((lang) => ({ id: lang.id, name: lang.aliases?.[0] || lang.id, exts: (lang.extensions || []).join(' ') }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const box = document.createElement('div')
  box.className = 'ed-picker'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-label', '選擇語言模式')
  const input = document.createElement('input')
  input.className = 'ed-picker-input'
  input.placeholder = '選擇語言模式（輸入名稱或副檔名）'
  const list = document.createElement('div')
  list.className = 'ed-picker-list'
  list.setAttribute('role', 'listbox')
  box.append(input, list)
  let shown = langs
  let active = Math.max(0, langs.findIndex((lang) => lang.id === current))
  const close = () => { box.remove(); window.removeEventListener('pointerdown', outside, true); editor.focus() }
  const outside = (event) => { if (!box.contains(event.target)) close() }
  const pick = (lang) => {
    monaco.editor.setModelLanguage(editor.getModel(), lang.id)
    paintLanguage()
    close()
  }
  const paint = () => {
    list.replaceChildren(...shown.map((lang, i) => {
      const row = document.createElement('div')
      row.className = 'ed-picker-row'
      row.setAttribute('role', 'option')
      row.setAttribute('aria-selected', String(i === active))
      row.textContent = lang.name
      if (lang.id === current) row.classList.add('is-current')
      const exts = document.createElement('span')
      exts.className = 'ed-picker-exts'
      exts.textContent = lang.exts
      row.appendChild(exts)
      row.addEventListener('pointerdown', (event) => { event.preventDefault(); pick(lang) })
      return row
    }))
    list.children[active]?.scrollIntoView({ block: 'nearest' })
  }
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase()
    shown = q ? langs.filter((lang) => `${lang.name} ${lang.id} ${lang.exts}`.toLowerCase().includes(q)) : langs
    active = 0
    paint()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
    else if (event.key === 'Enter' && shown[active]) pick(shown[active])
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      active = Math.max(0, Math.min(shown.length - 1, active + (event.key === 'ArrowDown' ? 1 : -1)))
      paint()
    } else return
    event.preventDefault()
  })
  document.body.appendChild(box)
  const rect = button.getBoundingClientRect()
  box.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`
  box.style.bottom = `${window.innerHeight - rect.top + 4}px`
  paint()
  input.focus()
  window.addEventListener('pointerdown', outside, true)
}

/** @param {StatusHooks} next */
export function mountStatus(next) {
  hooks = next
  const { editor } = next
  const bind = (id, fn) => $(id).addEventListener('click', () => fn($(id)))
  bind('edCursor', () => { editor.focus(); editor.trigger('axondeck', 'editor.action.gotoLine', null) })
  bind('edIndent', indentMenu)
  bind('edEncoding', encodingMenu)
  bind('edEol', eolMenu)
  bind('edLang', languagePicker)
  editor.onDidChangeCursorSelection(paintCursor)
  editor.getModel().onDidChangeOptions(paintIndent)
  editor.onDidChangeModelLanguage(paintLanguage)
  paintCursor()
  paintIndent()
  paintEol()
  paintEncoding()
  paintLanguage()
}
