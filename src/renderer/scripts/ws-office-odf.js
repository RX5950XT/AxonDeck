/**
 * OpenDocument（odt／ods／odp）的內建簡易檢視。跟 OOXML 一樣是 zip 包 XML，內容都在 `content.xml`。
 *
 * shortcut: 粗斜體、顏色這些「自動樣式」不套；投影片照順序排、不照座標。要原樣請用「原始版面」。
 */

import { all, first, kids, attr, imageFrom, make, gridTable, sheetBook, SHEET_LIMITS } from './ws-office-zip.js'

async function content(pkg) {
  const doc = await pkg.xml('content.xml')
  if (!doc) throw new Error('缺 content.xml')
  return doc
}

/** 段落裡的行內內容：文字、空白、tab、換行、span、連結、圖片 */
async function inline(pkg, node, out) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) { out.append(child.textContent || ''); continue }
    if (child.nodeType !== Node.ELEMENT_NODE) continue
    const el = /** @type {Element} */ (child)
    const name = el.localName
    if (name === 's') out.append(' '.repeat(Math.min(Number(attr(el, 'c')) || 1, 200)))
    else if (name === 'tab') out.append('\t')
    else if (name === 'line-break') out.append(make('br'))
    else if (name === 'image') {
      const img = await imageFrom(pkg, attr(el, 'href'))
      if (img) out.append(img)
    } else if (name !== 'annotation' && name !== 'note') await inline(pkg, el, out)
  }
}

async function odtBlocks(pkg, parent, out, depth = 0) {
  for (const child of kids(parent)) {
    const name = child.localName
    if (name === 'h') {
      const node = make(`h${Math.min(Number(attr(child, 'outline-level')) || 1, 6)}`)
      await inline(pkg, child, node)
      out.append(node)
    } else if (name === 'p') {
      const node = make('p')
      await inline(pkg, child, node)
      out.append(node)
    } else if (name === 'list') {
      for (const item of kids(child, 'list-item')) {
        const box = make('div')
        box.style.paddingLeft = '1.2em'
        await odtBlocks(pkg, item, box, depth + 1)
        box.firstElementChild?.prepend(make('span', 'ws-office-num', '• '))
        out.append(box)
      }
    } else if (name === 'table') {
      const table = make('table', 'ws-office-table')
      for (const tr of all(child, 'table-row')) {
        const row = make('tr')
        for (const tc of kids(tr, 'table-cell')) {
          const cell = make('td')
          const span = Number(attr(tc, 'number-columns-spanned')) || 1
          if (span > 1) cell.colSpan = span
          await odtBlocks(pkg, tc, cell, depth)
          row.append(cell)
        }
        table.append(row)
      }
      out.append(table)
    } else if (['section', 'index-body', 'table-of-content', 'frame', 'text-box'].includes(name)) {
      await odtBlocks(pkg, child, out, depth)
    } else if (name === 'image') {
      const img = await imageFrom(pkg, attr(child, 'href'))
      if (img) out.append(img)
    }
  }
}

export async function renderOdt(pkg) {
  const page = make('article', 'ws-office-doc')
  await odtBlocks(pkg, first(await content(pkg), 'text'), page)
  return page
}

/** 一張 ODS 工作表 → 格子。儲存格顯示文字就是 `text:p`（存檔時已經照格式排好了） */
function odsGrid(table) {
  /** @type {Array<Array<{ text: string, num?: boolean }>>} */
  const grid = []
  let width = 0
  let clipped = false
  let r = 0
  for (const row of all(table, 'table-row')) {
    const rowRepeat = Number(attr(row, 'number-rows-repeated')) || 1
    const cells = []
    let c = 0
    for (const cell of kids(row).filter((one) => one.localName === 'table-cell' || one.localName === 'covered-table-cell')) {
      const repeat = Number(attr(cell, 'number-columns-repeated')) || 1
      const text = kids(cell, 'p').map((p) => p.textContent).join('\n')
      const num = ['float', 'percentage', 'currency'].includes(attr(cell, 'value-type'))
      // 整列空白重複到底（ODS 會寫「這格之後 1000 多欄都空」）只前進不填
      for (let k = 0; k < repeat && c < SHEET_LIMITS.cols; k++, c++) if (text) cells[c] = { text, num }
      if (c >= SHEET_LIMITS.cols && repeat > 0 && text) clipped = true
    }
    const used = cells.length
    for (let k = 0; k < rowRepeat; k++, r++) {
      if (r >= SHEET_LIMITS.rows) { clipped = clipped || used > 0; break }
      if (used) grid[r] = cells
    }
    if (r >= SHEET_LIMITS.rows) break
    width = Math.max(width, used)
  }
  return gridTable(grid, width, clipped)
}

export async function renderOds(pkg) {
  const tables = kids(first(await content(pkg), 'spreadsheet'), 'table')
  return sheetBook(tables.map((table) => ({ name: attr(table, 'name'), paint: async () => odsGrid(table) })))
}

export async function renderOdp(pkg) {
  const deck = make('div', 'ws-office-deck')
  const pages = all(first(await content(pkg), 'presentation'), 'page')
  for (const [index, page] of pages.entries()) {
    const card = make('section', 'ws-office-slide ws-office-slide-flow')
    card.append(make('div', 'ws-office-slide-no', `第 ${index + 1} 張`))
    for (const frame of kids(page, 'frame')) {
      const isTitle = attr(frame, 'class') === 'title'
      const img = first(frame, 'image')
      const box = first(frame, 'text-box')
      if (box) {
        for (const p of all(box, 'p')) {
          const node = make(isTitle ? 'h3' : 'p')
          await inline(pkg, p, node)
          if ((node.textContent || '').trim()) card.append(node)
        }
      } else if (img) {
        const pic = await imageFrom(pkg, attr(img, 'href'))
        if (pic) card.append(pic)
      }
    }
    deck.append(card)
  }
  if (!deck.childElementCount) deck.append(make('p', 'ws-unsupported-meta', '這份簡報沒有投影片。'))
  return deck
}
