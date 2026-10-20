'use strict'

/**
 * node scripts/build-glossary-data.js
 * 下載國家教育研究院學術名詞（政府資料開放授權條款第 1 版，需標示出處），整併成內建術語庫
 * src/main/glossary-data/naer-terms.tsv.gz：每行「英文\t譯名1\t譯名2…」，譯名依出現次數排序。
 * 只有一個學科收的詞不收：常是該科特有的用法（電子計算機的 order information＝訂單資訊），
 * 實測模型拿到就照抄，「位置編碼注入順序資訊」變「注入訂單資訊」；附上學科名稱要它自己判斷也一樣照抄。
 * 前面的學科優先（同分時），所以數理放前面、工程放後面。
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const FIELDS = ['數學學術名詞', '統計學學術名詞', '物理學學術名詞', '力學學術名詞', '物理化學儀器設備學術名詞', '化學名詞-化學術語學術名詞', '化學名詞-化學元素',
  '化學名詞-高中以下化學名詞', '化學名詞-無機化合物', '天文學學術名詞', '地球科學學術名詞', '地質學學術名詞', '礦物學學術名詞', '氣象學學術名詞',
  '海洋科學學術名詞', '海洋地質學學術名詞', '生命科學學術名詞', '生態學學術名詞', '動物學學術名詞', '生物學名詞-植物學學術名詞', '計量學學術名詞', '核能學術名詞', '化學工程學術名詞',
  '土木工程學術名詞', '水利工程學學術名詞', '電機工程學術名詞', '電力工程學術名詞', '電子工程學術名詞', '電子計算機學術名詞', '資訊名詞-高中含以下資訊學術名詞', '通訊工程學術名詞',
  '機械工程學術名詞', '機構與機器原理學術名詞', '工業工程學術名詞', '工程圖學學術名詞', '生產自動化學術名詞', '材料科學名詞-金屬材料學術名詞', '材料科學名詞-能源材料學術名詞',
  '材料科學名詞-高分子材料學術名詞', '材料科學名詞-陶瓷材料學術名詞', '航空太空學術名詞', '造船工程學術名詞', '測量學學術名詞', '礦冶工程學術名詞', '鑄造學學術名詞']
const BASE = 'https://opendata.naer.edu.tw/' + encodeURIComponent('學術名詞') + '/'
const OUT = path.join(__dirname, '..', 'src', 'main', 'glossary-data', 'naer-terms.tsv.gz')
// 片語頭尾是這些字的不收：on voltage（接通電壓）會撞到 depends on voltage
const EDGE_STOPWORDS = new Set(('a an the of on in at by for to from with without into onto as and or nor not no off up out over '
  + 'under per via is are be been being this that these those its it his her their our your my any some all each every '
  + 'than then so such very more most less least').split(' '))


function csvRows(text) {
  const rows = []
  let row = [], cell = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' } else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

/** 英文詞條：去掉 [選用字]、{=縮寫}、（註），倒裝「end， feed」轉回 feed end；只收 1–5 個英文字 */
function cleanSource(raw) {
  let s = raw.replace(/\{[^}]*\}/g, '').replace(/[[\]]/g, '').replace(/\([^)]*\)|（[^）]*）/g, ' ')
  const inverted = s.split(/[，,]\s*/)
  if (inverted.length === 2 && inverted[1].trim()) s = `${inverted[1]} ${inverted[0]}`
  s = s.toLowerCase().replace(/\s+/g, ' ').trim()
  if (!/^[a-z][a-z0-9' -]*[a-z0-9]$/.test(s)) return ''
  const words = s.split(' ')
  if (words.length > 5) return ''
  // 單字不收：就算各學科譯法一致，一般文章也常是別的意思（Chinese models≠中文、morning paper≠紙）
  if (words.length === 1) return ''
  if (words.length > 1 && (EDGE_STOPWORDS.has(words[0]) || EDGE_STOPWORDS.has(words.at(-1)))) return ''
  return s
}

/** 中文譯名：多個用「；」分開；去掉 [ ]〔〕記號與 {分類} 註 */
function cleanTargets(raw) {
  return raw.replace(/\{[^}]*\}/g, '').split(/[；;]/)
    .map((t) => t.replace(/[[\]〔〕]/g, '').replace(/\s+/g, '').trim())
    .filter((t) => t && t.length <= 30 && /\p{Script=Han}/u.test(t) && !/[A-Za-z]{3}/.test(t))
}

async function main() {
  /** @type {Map<string, Map<string, { score: number, first: number }>>} */
  const terms = new Map()
  /** @type {Map<string, Set<number>>} */
  const fields = new Map()
  let rows = 0
  for (const [rank, field] of FIELDS.entries()) {
    const url = BASE + encodeURIComponent(`國家教育研究院-${field}.csv`)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${field} 下載失敗 ${res.status} ${url}`)
    const table = csvRows((await res.text()).replace(/^﻿/, ''))
    const header = table.shift()
    const en = header.findIndex((h) => h.includes('英文')), zh = header.findIndex((h) => h.includes('中文'))
    if (en < 0 || zh < 0) throw new Error(`${field} 欄位不認得：${header}`)
    for (const row of table) {
      const source = cleanSource(row[en] || '')
      const targets = source ? cleanTargets(row[zh] || '') : []
      if (!targets.length) continue
      rows++
      const bucket = terms.get(source) || new Map()
      targets.forEach((target, index) => {
        const entry = bucket.get(target) || { score: 0, first: rank }
        entry.score += index === 0 ? 2 : 1
        bucket.set(target, entry)
      })
      terms.set(source, bucket)
      fields.set(source, (fields.get(source) || new Set()).add(rank))
    }
    console.log(`${field}：累計 ${terms.size} 條`)
  }
  const lines = []
  for (const [source, bucket] of [...terms].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const ranked = [...bucket].sort((a, b) => b[1].score - a[1].score || a[1].first - b[1].first)
    const top = ranked[0][1].score
    // 「方程」「方程式」只差一個「式」算同一個，留分數高的
    const keep = ranked.filter(([, entry]) => entry.score * 2 >= top).map(([target]) => target)
      .filter((target, index, all) => !all.slice(0, index).some((other) => other.replace(/式$/, '') === target.replace(/式$/, '')))
      .slice(0, 3)
    if (fields.get(source).size > 1) lines.push([source, ...keep].join('\t'))
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, zlib.gzipSync(lines.join('\n') + '\n', { level: 9 }))
  console.log(`來源 ${rows} 列 → ${lines.length} 條，${(fs.statSync(OUT).size / 1048576).toFixed(1)} MB`)
}

main().catch((error) => { console.error(error); process.exit(1) })
