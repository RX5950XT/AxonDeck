'use strict'

/**
 * 工作區 Office 預覽（`ws-office.js`）：在真的 Chromium 裡解 docx／xlsx／pptx／odt／ods／odp，確認畫得出內容。
 * 檔案是這裡自己拼的最小 OOXML（deflate 壓縮，走 DecompressionStream 那條）。
 *
 *   用法：npx electron scripts/test-workspace-office.js（`run-tests.js` 認這行，改用 Electron 跑）
 */

const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { pathToFileURL } = require('url')
const { tempDir, removeTree } = require('./lib/test-temp')

/** 最小 zip 寫入器（全部 deflate，CRC 用 zlib.crc32） */
function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const raw = Buffer.from(text)
    const data = zlib.deflateRawSync(raw)
    const crc = zlib.crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, data)
    centrals.push(central, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(centrals.length / 2, 8)
  end.writeUInt16LE(centrals.length / 2, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'

const docx = zip({
  'word/document.xml': `<w:document ${W} ${R}><w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>報告標題</w:t></w:r></w:p>
    <w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="FF0000"/><w:sz w:val="28"/></w:rPr><w:t>粗體字</w:t></w:r><w:r><w:t xml:space="preserve"> 與一般字 &lt;script&gt;</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t>樣式項目</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>第一步</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>子步驟</w:t></w:r></w:p>
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>第二步</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>乙</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`,
  'word/styles.xml': `<w:styles ${W}>
    <w:style w:styleId="1"><w:name w:val="heading 1"/></w:style>
    <w:style w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
  </w:styles>`,
  'word/numbering.xml': `<w:numbering ${W}>
    <w:abstractNum w:abstractNumId="10"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="x"/></w:lvl></w:abstractNum>
    <w:abstractNum w:abstractNumId="20">
      <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl>
      <w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%1.%2)"/></w:lvl>
    </w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="10"/></w:num>
    <w:num w:numId="2"><w:abstractNumId w:val="20"/></w:num>
  </w:numbering>`
})

const XL = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const workbook = {
  'xl/workbook.xml': `<workbook ${XL} ${R}><sheets>
    <sheet name="銷售" sheetId="1" r:id="rId1"/><sheet name="第二張" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships ${RELS}>
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  'xl/sharedStrings.xml': `<sst ${XL}><si><t>品項</t></si><si><r><t>蘋</t></r><r><t>果</t></r></si></sst>`,
  'xl/styles.xml': `<styleSheet ${XL}><numFmts><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm"/></numFmts>
    <cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
  'xl/worksheets/sheet1.xml': `<worksheet ${XL}><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>42</v></c><c r="D1"><v>0.30000000000000004</v></c></row>
    <row r="2"><c r="A2" s="1"><v>45580</v></c><c r="B2" s="2"><v>0.1234</v></c><c r="C2" s="3"><v>45580.5</v></c></row>
    <row r="3"><c r="B3" t="s"><v>1</v></c><c r="AA3" t="b"><v>1</v></c></row></sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml': `<worksheet ${XL}><sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>第二張內容</t></is></c></row></sheetData></worksheet>`
}
const xlsx = zip(workbook)
// 公式沒有快取結果：要請 main 重算（測試裡由 convertXlsx 回一份「算好」的）
const staleXlsx = zip({ ...workbook, 'xl/worksheets/sheet2.xml': `<worksheet ${XL}><sheetData>
  <row r="1"><c r="A1"><f>1+1</f></c><c r="B1"><f>2+2</f><v></v></c></row></sheetData></worksheet>` })
const freshXlsx = zip({ ...workbook, 'xl/worksheets/sheet1.xml': `<worksheet ${XL}><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>重算過的</t></is></c></row></sheetData></worksheet>` })

const pptx = zip({
  'ppt/presentation.xml': `<p:presentation ${P} ${R}><p:sldSz cx="12192000" cy="6858000"/><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships ${RELS}><Relationship Id="rId2" Target="slides/slide1.xml"/></Relationships>`,
  'ppt/slides/_rels/slide1.xml.rels': `<Relationships ${RELS}><Relationship Id="rId1" Type="http://x/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`,
  'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${P} ${A}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="1219200" y="685800"/><a:ext cx="6096000" cy="1371600"/></a:xfrm></p:spPr></p:sp>
  </p:spTree></p:cSld></p:sldLayout>`,
  'ppt/slides/slide1.xml': `<p:sld ${P} ${A}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>簡報標題</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="0" y="3429000"/><a:ext cx="6096000" cy="3429000"/></a:xfrm></p:spPr>
      <p:txBody><a:p><a:pPr lvl="1"/><a:r><a:rPr sz="2400" b="1"/><a:t>第一點</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:sld>`
})

const O = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0"'
const odt = zip({ 'content.xml': `<office:document-content ${O}><office:body><office:text>
  <text:h text:outline-level="2">ODT 標題</text:h><text:p>前<text:s text:c="2"/>後<text:span>行內</text:span></text:p>
  <text:list><text:list-item><text:p>清單一</text:p></text:list-item></text:list>
  <table:table><table:table-row><table:table-cell><text:p>格子</text:p></table:table-cell></table:table-row></table:table>
</office:text></office:body></office:document-content>` })
const ods = zip({ 'content.xml': `<office:document-content ${O}><office:body><office:spreadsheet>
  <table:table table:name="表一"><table:table-row><table:table-cell office:value-type="string"><text:p>名稱</text:p></table:table-cell>
    <table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16380"/></table:table-row>
    <table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>` })
const odp = zip({ 'content.xml': `<office:document-content ${O}><office:body><office:presentation>
  <draw:page draw:name="p1"><draw:frame presentation:class="title"><draw:text-box><text:p>ODP 標題</text:p></draw:text-box></draw:frame>
    <draw:frame><draw:text-box><text:p>ODP 內文</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>` })

async function main() {
  const dir = tempDir('office-')
  const html = path.join(dir, 'host.html')
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><body></body>')
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } })
  try {
    await win.loadFile(html)
    const moduleUrl = pathToFileURL(path.join(__dirname, '../src/renderer/scripts/ws-office.js')).href
    const blob = (buf) => `URL.createObjectURL(new Blob([Uint8Array.from(atob(${JSON.stringify(buf.toString('base64'))}), (c) => c.charCodeAt(0))]))`
    /** convertXlsx 給了就回 freshXlsx，並記下被叫了幾次 */
    const run = (buf, ext, { script = '', convert = false } = {}) => win.webContents.executeJavaScript(`(async () => {
      const { renderOffice } = await import(${JSON.stringify(moduleUrl)})
      let converted = 0
      const options = ${convert} ? { convertXlsx: async () => { converted++; return ${blob(freshXlsx)} } } : {}
      const node = await renderOffice(${blob(buf)}, ${JSON.stringify(ext)}, options)
      document.body.replaceChildren(node)
      ${script}
      return { text: node.innerText, html: node.innerHTML, converted }
    })()`)
    const expect = (ok, message) => { if (!ok) throw new Error(message) }

    const d = await run(docx, 'docx')
    expect(/<h1>報告標題<\/h1>/.test(d.html), `docx 標題（styleId=1、name=heading 1）不對：${d.html}`)
    expect(d.html.includes('font-weight: 700') && d.html.includes('color: rgb(255, 0, 0)') && d.html.includes('font-size: 14pt'), 'docx 粗體／顏色／字級沒套上')
    expect(d.html.includes('text-align: center'), 'docx 置中沒套上')
    expect(!d.html.includes('<script>') && d.text.includes('<script>'), 'docx 文字沒有被當成純文字')
    expect(d.text.includes('• 樣式項目'), `docx 樣式帶的項目符號不見了：${d.text}`)
    expect(d.text.includes('1. 第一步') && d.text.includes('1.a) 子步驟') && d.text.includes('2. 第二步'), `docx 編號不對：${d.text}`)
    expect(d.html.includes('<td><p>甲</p></td><td><p>乙</p></td>'), 'docx 表格不對')

    const x = await run(xlsx, 'xlsx')
    for (const want of ['品項', '42', '0.3', '2024-10-15', '12.34%', '2024-10-15 12:00', '蘋果', 'TRUE', 'AA', '銷售']) {
      expect(x.text.includes(want), `xlsx 少了 ${JSON.stringify(want)}：${x.text}`)
    }
    expect(!x.text.includes('0.30000000000000004'), 'xlsx 浮點雜訊沒收掉')
    const x2 = await run(xlsx, 'xlsx', { script: `
      node.querySelectorAll('.ws-office-tab')[1].click()
      await new Promise((r) => setTimeout(r, 100))` })
    expect(x2.text.includes('第二張內容'), 'xlsx 切到第二張工作表沒內容')
    const stale = await run(staleXlsx, 'xlsx', { convert: true })
    expect(stale.converted === 1 && stale.text.includes('重算過的'), `沒算過的公式應該請 main 重算：${stale.text}`)
    const staleNoConv = await run(staleXlsx, 'xlsx', { script: `
      node.querySelectorAll('.ws-office-tab')[1].click()
      await new Promise((r) => setTimeout(r, 100))` })
    expect(staleNoConv.text.includes('=1+1') && staleNoConv.text.includes('=2+2'), `不能重算時要顯示公式本身：${staleNoConv.text}`)
    const fresh = await run(xlsx, 'xlsx', { convert: true })
    expect(fresh.converted === 0, '公式都有結果就不該重算')
    const xls = await run(Buffer.from('legacy'), 'xls', { convert: true })
    expect(xls.converted === 1 && xls.text.includes('重算過的'), 'xls 要先轉成 xlsx 再畫')

    const p = await run(pptx, 'pptx')
    expect(p.text.includes('簡報標題') && p.text.includes('第一點') && p.text.includes('第 1 張'), `pptx 文字不對：${p.text}`)
    expect(p.html.includes('left: 10%; top: 10%; width: 50%; height: 20%'), `pptx 標題沒跟版面配置拿座標：${p.html}`)
    expect(p.html.includes('top: 50%') && /font-size: 2\.\d+cqw/.test(p.html), `pptx 內文座標／字級不對：${p.html}`)

    const t = await run(odt, 'odt')
    for (const want of ['<h2>ODT 標題</h2>', '<p>前  後行內</p>', '• </span>清單一', '<td><p>格子</p></td>']) {
      expect(t.html.includes(want), `odt 少了 ${want}：${t.html}`)
    }
    const s = await run(ods, 'ods')
    expect(s.text.includes('名稱') && s.text.includes('3') && s.text.includes('表一'), `ods 不對：${s.text}`)
    expect(!s.text.includes('只顯示前') && (s.html.match(/<tr>/g) || []).length === 2, `ods 結尾的空白重複列／欄不該畫出來：${s.html.slice(0, 400)}`)
    const o = await run(odp, 'odp')
    expect(/<h3>ODP 標題<\/h3>/.test(o.html) && o.text.includes('ODP 內文'), `odp 不對：${o.text}`)

    const bad = await win.webContents.executeJavaScript(`import(${JSON.stringify(moduleUrl)})
      .then(({ renderOffice }) => renderOffice(URL.createObjectURL(new Blob(['not a zip'])), 'docx'))
      .then(() => 'no-error', (err) => err.message)`)
    expect(bad === '不是 zip 檔', `壞檔應該報錯：${bad}`)

    console.log('PASS Office 預覽：docx 編號／樣式／表格、xlsx 日期百分比／多工作表／公式重算、xls 轉檔、pptx 座標、odt／ods／odp、壞檔報錯')
  } finally {
    win.destroy()
    removeTree(dir)
  }
}

app.whenReady().then(main).then(() => app.exit(0), (err) => {
  console.error('FAIL', err.message)
  app.exit(1)
})
