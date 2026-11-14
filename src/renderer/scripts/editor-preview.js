/**
 * 獨立編輯視窗的預覽區：Markdown、HTML（即時）、CSV／TSV 表格、Mermaid 圖。
 * 分割模式下 Markdown 預覽跟著編輯器捲（像 VS Code 的 scroll sync，以標題當錨點）。
 */

import { renderMarkdown, previewSlice, PREVIEW_MAX_CHARS } from './markdown.js'
import { renderCsv } from './editor-csv.js'

/** CSV 表格只畫前 5000 列，開頭這麼多字就夠了 */
const TABLE_MAX_CHARS = 4 * 1024 * 1024
/** 行數超過這個不掃標題（捲動同步退回按比例） */
const SYNC_MAX_LINES = 200000
const HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})/

const view = {
  /** @type {HTMLElement | null} */ box: null,
  /** @type {any} */ api: null,
  /** @type {(link: string) => void} */ openLink: () => {},
  /** 原始碼裡標題所在的行號（1-based），跟預覽裡的 h1～h6 一一對應 */
  headingLines: /** @type {number[]} */ ([]),
  htmlSeq: 0
}

/** @param {{ box: HTMLElement, api: any, openLink: (link: string) => void }} options */
export function initPreview(options) {
  Object.assign(view, options)
}

/** 從檔頭取到第 max 個字：`getValue()` 是整份複製，大檔每停手一次就是一份 */
function headOf(model, max) {
  const total = model.getValueLength()
  if (total <= max) return { text: model.getValue(), total }
  const end = model.getPositionAt(max)
  return { text: model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column }), total }
}

function note(text) {
  const p = document.createElement('p')
  p.className = 'ed-preview-cut'
  p.textContent = text
  return p
}

/** Markdown 原始碼裡標題的行號（略過碼塊裡的 `#`） */
function scanHeadings(model) {
  if (model.getLineCount() > SYNC_MAX_LINES) return []
  const lines = []
  let fence = ''
  model.getLinesContent().forEach((line, i) => {
    const m = FENCE.exec(line)
    if (m && (!fence || m[1][0] === fence[0])) fence = fence ? '' : m[1]
    else if (!fence && HEADING.test(line)) lines.push(i + 1)
  })
  return lines
}

function paintMarkdown(file, model) {
  const { text, total } = headOf(model, PREVIEW_MAX_CHARS)
  const shown = previewSlice(text, total)
  view.box.replaceChildren(renderMarkdown(shown.text, 0, file.imageBase, { html: true, openLink: view.openLink }))
  if (shown.cut) view.box.appendChild(note('檔案太大，預覽只畫開頭一部分；完整內容請切到編輯。'))
  view.headingLines = scanHeadings(model)
}

function paintMermaid(model) {
  const source = model.getValue()
  // 圍欄比內容裡最長的反引號串多一個，內容裡有 ``` 也不會提早收掉
  const longest = Math.max(2, ...(source.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  view.box.replaceChildren(renderMarkdown(`${fence}mermaid\n${source}\n${fence}`, 0, '', { html: false }))
}

function paintTable(file, model) {
  const { text, total } = headOf(model, TABLE_MAX_CHARS)
  view.box.replaceChildren(renderCsv(text, file.name, total > text.length))
}

/**
 * HTML：main 給一個 `vi-preview://` 站台網址（根目錄＝檔案所在資料夾，送的是編輯中這一版）。
 * 這裡開的是任意下載來的檔案：iframe 只給 `allow-scripts`（不給 same-origin），協定又不開 CORS，
 * 頁面照樣載得到旁邊的 CSS／圖片／腳本，但腳本讀不到同資料夾其他檔案的內容（`workspace/media.js` 的 PREVIEW_SCHEME）。
 */
async function paintHtml(model) {
  const seq = ++view.htmlSeq
  const result = await view.api.previewHtml(model.getValue())
  if (seq !== view.htmlSeq) return
  if (!result.ok) {
    view.box.replaceChildren(note(result.error.message))
    return
  }
  let frame = /** @type {HTMLIFrameElement | null} */ (view.box.querySelector('iframe.ed-html'))
  if (!frame) {
    frame = document.createElement('iframe')
    frame.className = 'ed-html'
    frame.title = 'HTML 預覽'
    frame.setAttribute('sandbox', 'allow-scripts allow-forms')
    view.box.replaceChildren(frame)
  }
  frame.src = result.data
}

/**
 * @param {{ preview: string, name: string, imageBase: string }} file
 * @param {any} model
 */
export function paintPreview(file, model) {
  if (!view.box) return
  view.box.dataset.kind = file.preview
  const top = view.box.scrollTop
  if (file.preview === 'html') return void paintHtml(model)
  if (file.preview === 'csv') paintTable(file, model)
  else if (file.preview === 'mermaid') paintMermaid(model)
  else paintMarkdown(file, model)
  view.box.scrollTop = top
}

/** 打字時多久重畫一次：HTML 要重新載入 iframe，等久一點 */
export const previewDelay = (kind) => (kind === 'html' ? 450 : 150)

function offsetIn(box, node) {
  return node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
}

/**
 * 分割模式：編輯器捲到哪，Markdown 預覽跟到對應的位置。
 * 以標題當錨點、兩個標題之間按比例；標題對不上（例如預覽只畫開頭）就整份按比例。
 * @param {any} editor
 */
export function syncPreviewTo(editor) {
  const box = view.box
  if (!box || box.dataset.kind !== 'markdown') return
  const top = editor.getVisibleRanges()[0]?.startLineNumber || 1
  const nodes = [...box.querySelectorAll('h1.md-h, h2.md-h, h3.md-h, h4.md-h, h5.md-h, h6.md-h')]
  const lines = view.headingLines
  const room = box.scrollHeight - box.clientHeight
  if (!nodes.length || nodes.length !== lines.length) {
    const ratio = editor.getScrollTop() / Math.max(1, editor.getScrollHeight() - editor.getLayoutInfo().height)
    box.scrollTop = ratio * room
    return
  }
  const i = lines.findLastIndex((line) => line <= top)
  const fromLine = i < 0 ? 1 : lines[i]
  const fromY = i < 0 ? 0 : offsetIn(box, nodes[i])
  const toLine = lines[i + 1] ?? editor.getModel().getLineCount()
  const toY = nodes[i + 1] ? offsetIn(box, nodes[i + 1]) : box.scrollHeight
  box.scrollTop = Math.min(room, fromY + ((top - fromLine) / Math.max(1, toLine - fromLine)) * (toY - fromY))
}
