/**
 * Office 文件（docx／xlsx／pptx）的內建「簡易檢視」——本機沒有 Office／LibreOffice 時的退路，
 * 也是試算表的預設檢視（表格比 PDF 好查）。原始版面由 main 轉成 PDF（`office-convert.js`）。
 *
 * 文字一律走 textContent、樣式一律走 style 屬性，不碰 innerHTML。
 *
 * shortcut: 不畫圖表、SmartArt、文字方塊外框與主題色；那些交給「原始版面」。
 */

import {
  fetchPackage, revokeImages, all, first, kids, kid, attr, relAttr, relations, relsOf,
  imageFrom, make, hexColor, fontFamily, gridTable, sheetBook, SHEET_LIMITS
} from './ws-office-zip.js'
import { renderOdt, renderOds, renderOdp } from './ws-office-odf.js'

// ===== docx =====

/** 編號格式：numId → (層級 → { fmt, text, start }) */
async function docxNumbering(pkg) {
  const doc = await pkg.xml('word/numbering.xml')
  const abstract = new Map()
  for (const node of all(doc, 'abstractNum')) {
    const levels = new Map()
    for (const lvl of kids(node, 'lvl')) {
      levels.set(Number(attr(lvl, 'ilvl')), {
        fmt: attr(kid(lvl, 'numFmt'), 'val'),
        text: attr(kid(lvl, 'lvlText'), 'val'),
        start: Number(attr(kid(lvl, 'start'), 'val')) || 1
      })
    }
    abstract.set(attr(node, 'abstractNumId'), levels)
  }
  const nums = new Map()
  for (const num of kids(doc?.documentElement, 'num')) nums.set(attr(num, 'numId'), abstract.get(attr(kid(num, 'abstractNumId'), 'val')))
  return nums
}

/** 樣式：styleId → { name, numId, ilvl, basedOn }（標題要看 name：中文版 Word 的 styleId 是「1」「2」） */
async function docxStyles(pkg) {
  const map = new Map()
  for (const style of all(await pkg.xml('word/styles.xml'), 'style')) {
    const numPr = first(style, 'numPr')
    map.set(attr(style, 'styleId'), {
      name: attr(kid(style, 'name'), 'val').toLowerCase(),
      numId: attr(kid(numPr, 'numId'), 'val'),
      ilvl: Number(attr(kid(numPr, 'ilvl'), 'val')) || 0,
      basedOn: attr(kid(style, 'basedOn'), 'val')
    })
  }
  return map
}

function roman(n) {
  const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
  let out = ''
  for (const [value, sym] of table) for (; n >= value; n -= value) out += sym
  return out
}
function counterText(n, fmt) {
  if (fmt === 'lowerLetter' || fmt === 'upperLetter') {
    const letter = String.fromCharCode(97 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1)
    return fmt === 'upperLetter' ? letter.toUpperCase() : letter
  }
  if (fmt === 'lowerRoman') return roman(n)
  if (fmt === 'upperRoman') return roman(n).toUpperCase()
  return String(n)
}

/** 一份文件的編號狀態：每個 numId 各自數到第幾項 */
function numberer(nums) {
  const counts = new Map()
  return (numId, ilvl) => {
    const levels = nums.get(numId)
    const lvl = levels?.get(ilvl)
    if (!lvl) return ''
    const row = counts.get(numId) || []
    row[ilvl] = (row[ilvl] ?? lvl.start - 1) + 1
    row.length = ilvl + 1
    counts.set(numId, row)
    if (lvl.fmt === 'bullet') return '•'
    if (lvl.fmt === 'none') return ''
    return lvl.text.replace(/%(\d)/g, (_, k) => {
      const at = Number(k) - 1
      return counterText(row[at] ?? levels.get(at)?.start ?? 1, levels.get(at)?.fmt || 'decimal')
    })
  }
}

/** 段落的編號：段落自己沒寫就沿著樣式（含 basedOn）往上找 */
function paragraphNumber(pPr, styleId, styles) {
  const numPr = kid(pPr, 'numPr')
  if (numPr) return { numId: attr(kid(numPr, 'numId'), 'val'), ilvl: Number(attr(kid(numPr, 'ilvl'), 'val')) || 0 }
  for (let id = styleId, guard = 0; id && guard < 20; guard++) {
    const style = styles.get(id)
    if (!style) break
    if (style.numId) return { numId: style.numId, ilvl: style.ilvl }
    id = style.basedOn
  }
  return null
}

/** `w:rPr` → 包好樣式的節點 */
function styledRun(props, text) {
  const on = (name) => {
    const node = kid(props, name)
    return Boolean(node) && !['0', 'false', 'none'].includes(attr(node, 'val'))
  }
  /** @type {Node} */
  let node = document.createTextNode(text)
  const span = make('span')
  const size = Number(attr(kid(props, 'sz'), 'val'))
  if (size) span.style.fontSize = `${size / 2}pt`
  const color = hexColor(attr(kid(props, 'color'), 'val'))
  if (color) span.style.color = color
  const fonts = kid(props, 'rFonts')
  const font = fontFamily(attr(fonts, 'eastAsia') || attr(fonts, 'ascii'))
  if (font) span.style.fontFamily = font
  const fill = hexColor(attr(kid(props, 'shd'), 'fill'))
  const highlight = attr(kid(props, 'highlight'), 'val')
  if (fill || /^[a-z]+$/i.test(highlight)) span.style.backgroundColor = fill || highlight
  if (on('b')) span.style.fontWeight = '700'
  if (on('i')) span.style.fontStyle = 'italic'
  const lines = [on('u') && 'underline', (on('strike') || on('dstrike')) && 'line-through'].filter(Boolean)
  if (lines.length) span.style.textDecoration = lines.join(' ')
  const vert = attr(kid(props, 'vertAlign'), 'val')
  if (span.style.length) {
    span.append(node)
    node = span
  }
  if (vert === 'superscript' || vert === 'subscript') {
    const wrap = make(vert === 'superscript' ? 'sup' : 'sub')
    wrap.append(node)
    node = wrap
  }
  return node
}

const ALIGN = { center: 'center', right: 'right', end: 'right', both: 'justify', distribute: 'justify' }

async function docxParagraph(ctx, p) {
  const pPr = kid(p, 'pPr')
  const styleId = attr(kid(pPr, 'pStyle'), 'val')
  const styleName = ctx.styles.get(styleId)?.name || styleId.toLowerCase()
  const level = styleName === 'title' ? 1 : Number(/^heading ?(\d)$/.exec(styleName)?.[1] || 0)
  const node = make(level ? `h${Math.min(level, 6)}` : 'p')
  const align = ALIGN[attr(kid(pPr, 'jc'), 'val')]
  if (align) node.style.textAlign = align
  const num = paragraphNumber(pPr, styleId, ctx.styles)
  if (num && num.numId !== '0') {
    const label = ctx.number(num.numId, num.ilvl)
    if (label) {
      node.style.paddingLeft = `${num.ilvl * 1.5}em`
      node.append(make('span', 'ws-office-num', `${label} `))
    }
  }
  for (const run of all(p, 'r')) {
    // 文字方塊裡的段落另外畫，不要把它的字攤進外層這一段
    if (run.closest('txbxContent') && !p.closest('txbxContent')) continue
    const props = kid(run, 'rPr')
    for (const part of kids(run)) {
      if (part.localName === 't') node.append(styledRun(props, part.textContent || ''))
      else if (part.localName === 'tab') node.append('\t')
      else if (part.localName === 'br' || part.localName === 'cr') node.append(make('br'))
      else if (['drawing', 'pict', 'AlternateContent'].includes(part.localName)) {
        // AlternateContent 只看 Choice，Fallback 是同一張圖的舊格式
        const scope = part.localName === 'AlternateContent' ? first(part, 'Choice') : part
        for (const blip of all(scope, 'blip')) {
          const img = await imageFrom(ctx.pkg, ctx.rels.get(relAttr(blip, 'embed'))?.path || '')
          if (img) node.append(img)
        }
        for (const data of all(scope, 'imagedata')) {
          const img = await imageFrom(ctx.pkg, ctx.rels.get(relAttr(data, 'id'))?.path || '')
          if (img) node.append(img)
        }
      }
    }
  }
  return node
}

async function docxBlocks(ctx, parent, out) {
  for (const child of kids(parent)) {
    if (child.localName === 'p') out.append(await docxParagraph(ctx, child))
    else if (child.localName === 'sdt') await docxBlocks(ctx, kid(child, 'sdtContent'), out)
    else if (child.localName === 'tbl') {
      const table = make('table', 'ws-office-table')
      for (const tr of kids(child, 'tr')) {
        const row = make('tr')
        for (const tc of kids(tr, 'tc')) {
          const tcPr = kid(tc, 'tcPr')
          // 垂直合併的下半格不畫（上面那格已經佔住）
          const merge = kid(tcPr, 'vMerge')
          if (merge && attr(merge, 'val') !== 'restart') continue
          const cell = make('td')
          const span = Number(attr(kid(tcPr, 'gridSpan'), 'val')) || 1
          if (span > 1) cell.colSpan = span
          const fill = hexColor(attr(kid(tcPr, 'shd'), 'fill'))
          if (fill) cell.style.backgroundColor = fill
          await docxBlocks(ctx, tc, cell)
          row.append(cell)
        }
        table.append(row)
      }
      out.append(table)
    }
  }
}

async function renderDocx(pkg) {
  const doc = await pkg.xml('word/document.xml')
  if (!doc) throw new Error('缺 word/document.xml')
  const ctx = {
    pkg,
    rels: await relations(pkg, 'word/_rels/document.xml.rels', 'word'),
    styles: await docxStyles(pkg),
    number: numberer(await docxNumbering(pkg))
  }
  const page = make('article', 'ws-office-doc')
  await docxBlocks(ctx, first(doc, 'body'), page)
  return page
}

// ===== xlsx =====

/** `AB12` → 欄索引 27（從 0 算） */
function columnIndex(ref) {
  let n = 0
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] || 'A') n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

/** Excel 內建的日期／時間格式編號 */
const DATE_IDS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])
const TIME_IDS = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56])

/** 每個樣式索引（`c@s`）→ 'date' | 'time' | 'percent:<小數位>' | '' */
async function xlsxFormats(pkg) {
  const styles = await pkg.xml('xl/styles.xml')
  const custom = new Map(all(styles, 'numFmt').map((fmt) => [Number(attr(fmt, 'numFmtId')), attr(fmt, 'formatCode')]))
  return kids(first(styles, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId'))
    if (DATE_IDS.has(id)) return 'date'
    if (TIME_IDS.has(id)) return 'time'
    if (id === 9) return 'percent:0'
    if (id === 10) return 'percent:2'
    // 去掉引號字串、[顏色]／[$地區]、跳脫字元後，還有 y/m/d/h/s 就是日期時間
    const code = (custom.get(id) || '').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '')
    if (code.includes('%')) return `percent:${(/\.(0+)/.exec(code)?.[1] || '').length}`
    if (/[yd]/i.test(code)) return /[hs]/i.test(code) ? 'datetime' : 'date'
    if (/[hs]/i.test(code)) return 'time'
    if (/m/i.test(code) && !/[#0?]/.test(code)) return 'date'
    return ''
  })
}

const pad = (n) => String(n).padStart(2, '0')
/** 序號 → 日期字串。1900 系統從 1899-12-30 起算（含 Excel 那個 1900 閏年 bug 的位移） */
function serialDate(serial, kind, date1904) {
  const ms = Math.round((serial + (date1904 ? 1462 : 0) - 25569) * 86400000)
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return String(serial)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}`
  return kind === 'time' ? time : kind === 'datetime' || (kind === 'date' && serial % 1) ? `${day} ${time}` : day
}

/** 浮點雜訊收掉（0.1+0.2 → 0.3），跟 Excel 一樣看 15 位有效數字 */
function plainNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : value
}

function sheetGrid(sheet, shared, formats, date1904) {
  /** @type {Array<Array<{ text: string, num?: boolean }>>} */
  const grid = []
  let width = 0
  let clipped = false
  for (const row of all(sheet, 'row')) {
    const r = (Number(attr(row, 'r')) || grid.length + 1) - 1
    if (r >= SHEET_LIMITS.rows) { clipped = true; break }
    const cells = (grid[r] = grid[r] || [])
    let next = 0
    for (const c of kids(row, 'c')) {
      const col = attr(c, 'r') ? columnIndex(attr(c, 'r')) : next
      next = col + 1
      if (col >= SHEET_LIMITS.cols) { clipped = true; continue }
      const type = attr(c, 't')
      const formula = kid(c, 'f')?.textContent
      const raw = kid(c, 'v')?.textContent
      let text = ''
      let num = false
      // openpyxl 之類會寫一個空的 <v></v>：有公式卻沒結果一樣當成「沒算過」
      if (formula && !raw) text = `=${formula}`
      else if (raw === undefined) text = all(c, 't').map((t) => t.textContent).join('')
      else if (type === 's') text = shared[Number(raw)] || ''
      else if (type === 'b') text = raw === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'str' || type === 'e' || type === 'inlineStr') text = raw
      else {
        const fmt = formats[Number(attr(c, 's')) || 0] || ''
        num = true
        if (fmt.startsWith('percent:')) text = `${(Number(raw) * 100).toFixed(Number(fmt.slice(8)))}%`
        else if (fmt) text = serialDate(Number(raw), fmt, date1904)
        else text = plainNumber(raw)
      }
      cells[col] = { text, num }
      width = Math.max(width, col + 1)
    }
  }
  return gridTable(grid, width, clipped)
}

/** 有沒有「有公式、沒結果」的格子（程式產生、沒被 Excel 算過的檔案） */
async function hasStaleFormulas(pkg, paths) {
  for (const path of paths) {
    if (all(await pkg.xml(path), 'c').some((c) => kid(c, 'f') && !kid(c, 'v')?.textContent)) return true
  }
  return false
}

async function renderXlsx(pkg, options = {}) {
  const book = await pkg.xml('xl/workbook.xml')
  if (!book) throw new Error('缺 xl/workbook.xml')
  const rels = await relations(pkg, 'xl/_rels/workbook.xml.rels', 'xl')
  const sheets = all(book, 'sheet').map((sheet) => ({ name: attr(sheet, 'name'), path: rels.get(relAttr(sheet))?.path || '' }))
  if (options.convertXlsx && await hasStaleFormulas(pkg, sheets.map((s) => s.path))) {
    // 交給 Office／LibreOffice 重算一份；轉不了就照原樣顯示公式
    try {
      return await renderXlsx(await fetchPackage(await options.convertXlsx()))
    } catch (error) {
      console.warn('[工作區] 試算表重算失敗，顯示公式本身', error?.message || error)
    }
  }
  const shared = all(await pkg.xml('xl/sharedStrings.xml'), 'si')
    .map((si) => all(si, 't').filter((t) => t.parentElement?.localName !== 'rPh').map((t) => t.textContent).join(''))
  const formats = await xlsxFormats(pkg)
  const date1904 = ['1', 'true'].includes(attr(first(book, 'workbookPr'), 'date1904'))
  return sheetBook(sheets.map((sheet) => ({
    name: sheet.name,
    paint: async () => {
      const xml = await pkg.xml(sheet.path)
      return xml ? sheetGrid(xml, shared, formats, date1904) : make('p', 'ws-unsupported-meta', '這張工作表讀不到。')
    }
  })))
}

// ===== pptx =====

/** 投影片上的字級與座標都換成「投影片寬度的百分比」，卡片多寬字就跟著多大（cqw） */
function slideCtx(cx, cy) {
  return {
    x: (emu) => `${(emu / cx) * 100}%`,
    y: (emu) => `${(emu / cy) * 100}%`,
    pt: (pt) => `${(pt * 12700 / cx) * 100}cqw`
  }
}

/** `a:xfrm` → { x, y, w, h }（EMU） */
function readXfrm(xfrm) {
  const off = kid(xfrm, 'off')
  const ext = kid(xfrm, 'ext')
  if (!off || !ext) return null
  return { x: Number(attr(off, 'x')), y: Number(attr(off, 'y')), w: Number(attr(ext, 'cx')), h: Number(attr(ext, 'cy')) }
}

/** 版面配置／母片裡同一個佔位框（先比 idx，再比 type） */
function findPlaceholder(tree, ph) {
  const type = attr(ph, 'type') || 'body'
  const idx = attr(ph, 'idx')
  const isTitle = (t) => t === 'title' || t === 'ctrTitle'
  const shapes = all(tree, 'sp').map((sp) => ({ sp, ph: first(kid(sp, 'nvSpPr'), 'ph') })).filter((one) => one.ph)
  return (idx && shapes.find((one) => attr(one.ph, 'idx') === idx))
    || shapes.find((one) => {
      const t = attr(one.ph, 'type') || 'body'
      return t === type || (isTitle(t) && isTitle(type))
    })
    || null
}

function phXfrm(trees, ph) {
  for (const tree of trees) {
    const found = findPlaceholder(tree, ph)
    const box = found && readXfrm(first(kid(found.sp, 'spPr'), 'xfrm'))
    if (box) return box
  }
  return null
}

function place(node, box, s) {
  node.style.left = s.x(box.x)
  node.style.top = s.y(box.y)
  node.style.width = s.x(box.w)
  node.style.height = s.y(box.h)
}

function pptxRun(run, s, defaultPt) {
  const props = kid(run, 'rPr')
  const span = make('span', '', kid(run, 't')?.textContent || '')
  const size = Number(attr(props, 'sz')) / 100 || defaultPt
  span.style.fontSize = s.pt(size)
  if (attr(props, 'b') === '1') span.style.fontWeight = '700'
  if (attr(props, 'i') === '1') span.style.fontStyle = 'italic'
  if (attr(props, 'u') && attr(props, 'u') !== 'none') span.style.textDecoration = 'underline'
  const color = hexColor(attr(first(kid(props, 'solidFill'), 'srgbClr'), 'val'))
  if (color) span.style.color = color
  const font = fontFamily(attr(kid(props, 'ea'), 'typeface') || attr(kid(props, 'latin'), 'typeface'))
  if (font && !font.startsWith('"+')) span.style.fontFamily = font
  return span
}

const PPT_ALIGN = { ctr: 'center', r: 'right', just: 'justify' }

function pptxText(body, s, phType) {
  const box = make('div', 'ws-office-shape-text')
  const isTitle = phType === 'title' || phType === 'ctrTitle'
  const isBody = phType === 'body' || phType === 'obj'
  const defaultPt = isTitle ? 36 : isBody ? 20 : 18
  if (attr(kid(body, 'bodyPr'), 'anchor') === 'ctr') box.style.justifyContent = 'center'
  if (attr(kid(body, 'bodyPr'), 'anchor') === 'b') box.style.justifyContent = 'flex-end'
  for (const para of kids(body, 'p')) {
    const pPr = kid(para, 'pPr')
    const p = make('p')
    const lvl = Number(attr(pPr, 'lvl')) || 0
    if (lvl) p.style.paddingLeft = `${lvl * 1.5}em`
    const align = PPT_ALIGN[attr(pPr, 'algn')] || (phType === 'ctrTitle' || phType === 'subTitle' ? 'center' : '')
    if (align) p.style.textAlign = align
    const runs = kids(para).filter((one) => one.localName === 'r' || one.localName === 'fld' || one.localName === 'br')
    const hasText = runs.some((one) => (kid(one, 't')?.textContent || '').trim())
    if (hasText && !kid(pPr, 'buNone') && (kid(pPr, 'buChar') || isBody)) p.append(make('span', 'ws-office-num', '• '))
    for (const run of runs) p.append(run.localName === 'br' ? make('br') : pptxRun(run, s, defaultPt))
    if (!runs.length) p.style.fontSize = s.pt(defaultPt)
    box.append(p)
  }
  return box
}

/** 群組：子物件的座標要換算回投影片座標 */
function groupMap(grpSpPr, outer) {
  const xfrm = first(grpSpPr, 'xfrm')
  const box = readXfrm(xfrm)
  const chOff = kid(xfrm, 'chOff')
  const chExt = kid(xfrm, 'chExt')
  if (!box || !chOff || !chExt) return outer
  const cx = Number(attr(chOff, 'x'))
  const cy = Number(attr(chOff, 'y'))
  const sx = box.w / (Number(attr(chExt, 'cx')) || box.w || 1)
  const sy = box.h / (Number(attr(chExt, 'cy')) || box.h || 1)
  return (b) => outer({ x: box.x + (b.x - cx) * sx, y: box.y + (b.y - cy) * sy, w: b.w * sx, h: b.h * sy })
}

async function pptxShapes(ctx, tree, canvas, map) {
  for (const shape of kids(tree)) {
    const name = shape.localName
    if (name === 'grpSp') {
      await pptxShapes(ctx, shape, canvas, groupMap(kid(shape, 'grpSpPr'), map))
      continue
    }
    if (name !== 'sp' && name !== 'pic' && name !== 'graphicFrame') continue
    const ph = first(kids(shape)[0], 'ph')
    const own = readXfrm(first(kid(shape, name === 'graphicFrame' ? 'xfrm' : 'spPr'), 'xfrm') || kid(shape, 'xfrm'))
    const box = own || (ph && phXfrm(ctx.inherited, ph))
    if (!box) continue
    const node = make('div', 'ws-office-shape')
    place(node, map(box), ctx.s)
    if (name === 'pic') {
      const img = await imageFrom(ctx.pkg, ctx.rels.get(relAttr(first(shape, 'blip'), 'embed'))?.path || '')
      if (!img) continue
      node.append(img)
    } else if (name === 'graphicFrame') {
      const tbl = first(shape, 'tbl')
      if (tbl) {
        const table = make('table', 'ws-office-table')
        for (const tr of kids(tbl, 'tr')) {
          const row = make('tr')
          for (const tc of kids(tr, 'tc')) {
            if (attr(tc, 'hMerge') === '1' || attr(tc, 'vMerge') === '1') continue
            const cell = make('td')
            if (Number(attr(tc, 'gridSpan')) > 1) cell.colSpan = Number(attr(tc, 'gridSpan'))
            cell.append(pptxText(kid(tc, 'txBody'), ctx.s, ''))
            row.append(cell)
          }
          table.append(row)
        }
        node.append(table)
      } else node.append(make('div', 'ws-office-chart', '圖表（切到「原始版面」才看得到）'))
    } else {
      const fill = hexColor(attr(first(kid(kid(shape, 'spPr'), 'solidFill'), 'srgbClr'), 'val'))
      if (fill) node.style.backgroundColor = fill
      const body = kid(shape, 'txBody')
      if (body) node.append(pptxText(body, ctx.s, ph ? (attr(ph, 'type') || 'body') : ''))
      if (!fill && !body) continue
    }
    canvas.append(node)
  }
}

async function renderPptx(pkg) {
  const pres = await pkg.xml('ppt/presentation.xml')
  if (!pres) throw new Error('缺 ppt/presentation.xml')
  const rels = await relations(pkg, 'ppt/_rels/presentation.xml.rels', 'ppt')
  const size = first(pres, 'sldSz')
  const cx = Number(attr(size, 'cx')) || 12192000
  const cy = Number(attr(size, 'cy')) || 6858000
  const s = slideCtx(cx, cy)
  const deck = make('div', 'ws-office-deck')
  const ids = all(first(pres, 'sldIdLst'), 'sldId')
  for (const [index, sld] of ids.entries()) {
    const path = rels.get(relAttr(sld))?.path || ''
    const slide = await pkg.xml(path)
    if (!slide) continue
    const where = relsOf(path)
    const slideRels = await relations(pkg, where.rels, where.dir)
    // 沒寫座標的佔位框跟版面配置拿，再沒有就跟母片拿
    const layoutPath = [...slideRels.values()].find((rel) => rel.type.endsWith('/slideLayout'))?.path || ''
    const layoutWhere = relsOf(layoutPath)
    const masterPath = [...(await relations(pkg, layoutWhere.rels, layoutWhere.dir)).values()]
      .find((rel) => rel.type.endsWith('/slideMaster'))?.path || ''
    const inherited = [await pkg.xml(layoutPath), await pkg.xml(masterPath)].map((doc) => first(doc, 'spTree')).filter(Boolean)

    const card = make('section', 'ws-office-slide')
    card.append(make('div', 'ws-office-slide-no', `第 ${index + 1} 張`))
    const canvas = make('div', 'ws-office-slide-canvas')
    canvas.style.aspectRatio = `${cx} / ${cy}`
    const bg = hexColor(attr(first(first(slide, 'bg'), 'srgbClr'), 'val'))
    if (bg) canvas.style.backgroundColor = bg
    await pptxShapes({ pkg, rels: slideRels, inherited, s }, first(slide, 'spTree'), canvas, (b) => b)
    card.append(canvas)
    deck.append(card)
  }
  if (!deck.childElementCount) deck.append(make('p', 'ws-unsupported-meta', '這份簡報沒有投影片。'))
  return deck
}

// ===== 入口 =====

const RENDERERS = {
  docx: renderDocx, docm: renderDocx,
  xlsx: renderXlsx, xlsm: renderXlsx,
  pptx: renderPptx, pptm: renderPptx,
  odt: renderOdt, ods: renderOds, odp: renderOdp
}

/** 簡易檢視畫得出來的副檔名（xls 要先請 main 轉成 xlsx） */
export const SIMPLE_EXTS = new Set([...Object.keys(RENDERERS), 'xls'])
/** 試算表：預設用表格看 */
export const SHEET_EXTS = new Set(['xls', 'xlsx', 'xlsm', 'ods'])

/**
 * @param {string} url `vi-media://` 網址
 * @param {string} ext 副檔名（小寫）
 * @param {{ convertXlsx?: () => Promise<string> }} [options] 請 main 轉一份重算過的 xlsx
 * @returns {Promise<HTMLElement>}
 */
export async function renderOffice(url, ext, options = {}) {
  revokeImages()
  if (ext === 'xls') {
    if (!options.convertXlsx) throw new Error('不支援的格式')
    return wrap(await renderXlsx(await fetchPackage(await options.convertXlsx())))
  }
  const render = RENDERERS[ext]
  if (!render) throw new Error('不支援的格式')
  return wrap(await render(await fetchPackage(url), options))
}

function wrap(node) {
  const root = make('div', 'ws-office')
  root.append(node)
  return root
}
