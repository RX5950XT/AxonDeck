'use strict'

/**
 * 檔案頁右側「詳細資訊」依檔案類型補的那幾段（像檔案總管「內容 › 詳細資料」）：
 * - 影音：ffmpeg 讀檔頭（解析度、幀率、編碼、位元率、取樣率、聲道、標籤）
 * - 文字：自己數行數、編碼、換行
 * - 其他（相片 EXIF、文件、程式版本、捷徑）：問 Windows 屬性系統（殼層 sidecar 的 `props`）
 *
 * 回 `{ groups: [{ title, facts: [[標籤, 值]] }] }`；拿不到就少那段，不報錯。
 */

const { execFile } = require('child_process')
const path = require('path')
const fs = require('../raw-fs')
const paths = require('./paths')

const PROBE_TIMEOUT_MS = 8000
const PROPS_TIMEOUT_MS = 5000
/** 文字檔超過就只看編碼，不整份讀進來數行 */
const MAX_TEXT_SCAN = 32 * 1024 * 1024
const MAX_CHAR_COUNT = 8 * 1024 * 1024

const VIDEO_EXT = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'flv', 'ts', 'mts', 'm2ts',
  '3gp', '3g2', 'mpg', 'mpeg', 'ogv', 'vob', 'rmvb', 'rm', 'asf', 'f4v'
])
const AUDIO_EXT = new Set([
  'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif',
  'ape', 'alac', 'amr', 'mka', 'wv', 'dsf', 'dff', 'ac3', 'dts', 'm4b', 'caf'
])
const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'html', 'htm', 'xml', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf', 'toml', 'yml', 'yaml', 'ps1', 'psm1',
  'bat', 'cmd', 'sh', 'bash', 'zsh', 'svg', 'py', 'rb', 'php', 'go', 'rs', 'c', 'h', 'cc', 'cpp', 'hpp',
  'cs', 'java', 'kt', 'kts', 'swift', 'lua', 'r', 'sql', 'vue', 'svelte', 'srt', 'vtt', 'ass', 'ssa',
  'tex', 'gitignore', 'env', 'properties', 'gradle', 'dart', 'scala', 'pl', 'makefile', 'dockerfile'
])

/** Windows 屬性系統的標準名稱 → 標籤，依段落排好。同一個名稱只出現一次。 */
const PROP_GROUPS = [
  { title: '相機', props: [
    ['System.Photo.CameraManufacturer', '相機製造商'],
    ['System.Photo.CameraModel', '相機型號'],
    ['System.Photo.LensManufacturer', '鏡頭製造商'],
    ['System.Photo.LensModel', '鏡頭型號'],
    ['System.Photo.DateTaken', '拍攝日期'],
    ['System.Photo.FNumber', '光圈'],
    ['System.Photo.ExposureTime', '曝光時間'],
    ['System.Photo.ISOSpeed', 'ISO 感光度'],
    ['System.Photo.ExposureBias', '曝光補償'],
    ['System.Photo.FocalLength', '焦距'],
    ['System.Photo.FocalLengthInFilm35mm', '35mm 等效焦距'],
    ['System.Photo.MaxAperture', '最大光圈'],
    ['System.Photo.ExposureProgram', '曝光程式'],
    ['System.Photo.MeteringMode', '測光模式'],
    ['System.Photo.Flash', '閃光燈'],
    ['System.Photo.WhiteBalance', '白平衡'],
    ['System.Photo.DigitalZoom', '數位變焦'],
    ['System.Photo.Orientation', '方向']
  ] },
  { title: '影像', props: [
    ['System.Image.HorizontalSize', ''],
    ['System.Image.VerticalSize', ''],
    ['System.Image.HorizontalResolution', '水平解析度'],
    ['System.Image.VerticalResolution', '垂直解析度'],
    ['System.Image.BitDepth', '位元深度'],
    ['System.Image.ColorSpace', '色彩表示'],
    ['System.ApplicationName', '軟體']
  ] },
  { title: '位置', props: [
    ['System.GPS.Latitude', '緯度'],
    ['System.GPS.LatitudeRef', ''],
    ['System.GPS.Longitude', '經度'],
    ['System.GPS.LongitudeRef', ''],
    ['System.GPS.Altitude', '高度']
  ] },
  { title: '程式', props: [
    ['System.FileDescription', '檔案描述'],
    ['System.FileVersion', '檔案版本'],
    ['System.Software.ProductName', '產品名稱'],
    ['System.Software.ProductVersion', '產品版本'],
    ['System.OriginalFileName', '原始檔名'],
    ['System.Language', '語言']
  ] },
  { title: '文件', props: [
    ['System.Document.PageCount', '頁數'],
    ['System.Presentation.SlideCount', '投影片數'],
    ['System.Document.WordCount', '字數'],
    ['System.Document.CharacterCount', '字元數'],
    ['System.Document.LastAuthor', '上次儲存者'],
    ['System.Document.RevisionNumber', '修訂編號'],
    ['System.Document.TotalEditingTime', '總編輯時間'],
    ['System.Document.DateCreated', '內容建立日期'],
    ['System.Document.DateSaved', '上次儲存日期'],
    ['System.Document.DatePrinted', '上次列印日期'],
    ['System.Document.Template', '範本']
  ] },
  { title: '捷徑', props: [
    ['System.Link.Arguments', '引數'],
    ['System.Link.Comment', '註解']
  ] },
  { title: '說明', props: [
    ['System.Title', '標題'],
    ['System.Subject', '主旨'],
    ['System.Author', '作者'],
    ['System.Company', '公司'],
    ['System.Keywords', '標籤'],
    ['System.Comment', '註解'],
    ['System.Copyright', '著作權'],
    ['System.Rating', '評等']
  ] }
]

const CODEC_NAMES = {
  h264: 'H.264 (AVC)', hevc: 'H.265 (HEVC)', av1: 'AV1', vp9: 'VP9', vp8: 'VP8', vvc: 'H.266 (VVC)',
  mpeg4: 'MPEG-4 Part 2', mpeg2video: 'MPEG-2', mpeg1video: 'MPEG-1', prores: 'Apple ProRes',
  wmv3: 'WMV 9', vc1: 'VC-1', mjpeg: 'Motion JPEG', theora: 'Theora', dnxhd: 'DNxHD',
  aac: 'AAC', mp3: 'MP3', mp2: 'MP2', opus: 'Opus', vorbis: 'Vorbis', flac: 'FLAC', alac: 'ALAC',
  ac3: 'Dolby Digital (AC-3)', eac3: 'Dolby Digital Plus (E-AC-3)', truehd: 'Dolby TrueHD',
  dts: 'DTS', wmav2: 'WMA', wmapro: 'WMA Pro', amr_nb: 'AMR-NB', amr_wb: 'AMR-WB', ape: "Monkey's Audio",
  wavpack: 'WavPack', subrip: 'SRT', ass: 'ASS', mov_text: 'MP4 文字', hdmv_pgs_subtitle: 'PGS', dvd_subtitle: 'VobSub'
}
const CHANNELS = { mono: '單聲道', stereo: '立體聲', '2.1': '2.1 聲道', quad: '四聲道', '5.0': '5.0 聲道', '5.1': '5.1 聲道', '6.1': '6.1 聲道', '7.1': '7.1 聲道' }
const TAG_LABELS = [
  ['title', '標題'], ['artist', '演出者'], ['album_artist', '專輯演出者'], ['album', '專輯'],
  ['composer', '作曲者'], ['genre', '類型'], ['date', '年份'], ['year', '年份'], ['track', '曲目'],
  ['disc', '光碟'], ['comment', '註解'], ['description', '描述'], ['copyright', '著作權'],
  ['publisher', '發行者'], ['com.apple.quicktime.make', '裝置製造商'], ['com.android.manufacturer', '裝置製造商'],
  ['com.apple.quicktime.model', '裝置型號'], ['com.android.model', '裝置型號'],
  ['com.apple.quicktime.software', '裝置軟體'], ['com.android.version', 'Android 版本'],
  ['com.apple.quicktime.creationdate', '拍攝時間'], ['creation_time', '建立時間'],
  ['com.apple.quicktime.location.iso6709', '拍攝位置'], ['location', '拍攝位置'],
  ['com.android.capture.fps', '拍攝幀率'], ['encoder', '編碼程式']
]

/** 屬性系統的格式化結果常夾著方向控制字元（「‪4032 x 3024‬」） */
function clean(text) {
  return String(text || '').replace(/[‎‏‪-‮⁦-⁩]/g, '').trim()
}

/** 依逗號切，括號裡的逗號不算（`yuv420p(tv, bt709, progressive)`） */
function splitTop(text) {
  const out = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth += 1
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function codecLabel(part) {
  const name = (part.match(/^([\w-]+)/) || [])[1] || ''
  const profile = [...part.matchAll(/\(([^()/]+)\)/g)].map((m) => m[1]).find((p) => !/^0x/i.test(p))
  const nice = CODEC_NAMES[name] || (/^pcm_/.test(name) ? `PCM（${name.slice(4)}）` : name.toUpperCase())
  return profile ? `${nice} · ${profile}` : nice
}

function kbps(text) {
  const m = /(\d+(?:\.\d+)?) kb\/s/.exec(text)
  return m ? `${Math.round(Number(m[1])).toLocaleString('en-US')} kbps` : ''
}

function duration(h, m, s) {
  const total = Number(h) * 3600 + Number(m) * 60 + Number(s)
  const whole = Math.floor(total)
  const hh = Math.floor(whole / 3600)
  const mm = Math.floor((whole % 3600) / 60)
  const ss = String(whole % 60).padStart(2, '0')
  const base = hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
  return total < 60 ? `${base}（${total.toFixed(2)} 秒）` : base
}

function localTime(text) {
  const d = new Date(text)
  return Number.isNaN(d.getTime()) ? text : d.toLocaleString('zh-TW', { hour12: false })
}

/** ISO 6709（`+25.0330+121.5654+010.000/`）→ `25.0330, 121.5654` */
function iso6709(text) {
  const m = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/.exec(text)
  return m ? `${Number(m[1])}, ${Number(m[2])}` : text
}

function pixelsFact(width, height) {
  const total = width * height
  if (!total) return ''
  return total >= 1e4 ? `約 ${Math.round(total / 1e4).toLocaleString('en-US')} 萬像素（${(total / 1e6).toFixed(1)} MP）` : `${total} 像素`
}

function videoFacts(spec, sideText) {
  const parts = splitTop(spec)
  const facts = [['編碼', codecLabel(parts[0] || '')]]
  const res = /(\d{2,5})x(\d{2,5})/.exec(spec)
  if (res) {
    facts.push(['解析度', `${res[1]} × ${res[2]}`])
    facts.push(['像素', pixelsFact(Number(res[1]), Number(res[2]))])
  }
  const fps = /([\d.]+) fps/.exec(spec) || /([\d.]+) tbr/.exec(spec)
  if (fps) facts.push(['幀率', `${Number(fps[1])} fps`])
  const rate = kbps(spec)
  if (rate) facts.push(['視訊位元率', rate])
  const pix = parts.find((p) => /^(yuv|yuvj|rgb|bgr|gbr|nv12|p010|gray)/.test(p))
  if (pix) {
    facts.push(['色彩格式', pix.replace(/\(.*$/, '')])
    const depth = /(?:p|le|be)(10|12|16)/.exec(pix)
    facts.push(['色彩深度', `${depth ? depth[1] : 8} 位元`])
    const hdr = /smpte2084/.test(pix) ? 'HDR10 (PQ)' : /arib-std-b67/.test(pix) ? 'HLG' : ''
    if (/DOVI configuration/i.test(sideText)) facts.push(['HDR', 'Dolby Vision'])
    else if (hdr) facts.push(['HDR', hdr])
    if (/bt2020/.test(pix)) facts.push(['色域', 'BT.2020'])
  }
  const rot = /rotation of (-?[\d.]+) degrees/.exec(sideText)
  if (rot && Number(rot[1])) facts.push(['旋轉', `${Math.abs(Number(rot[1]))}°`])
  return facts
}

function audioFacts(spec, lang) {
  const parts = splitTop(spec)
  const facts = [['編碼', codecLabel(parts[0] || '')]]
  const hz = /(\d+) Hz/.exec(spec)
  if (hz) facts.push(['取樣率', `${(Number(hz[1]) / 1000).toString()} kHz`])
  const layout = parts[2] ? parts[2].replace(/\(.*$/, '') : ''
  if (layout) facts.push(['聲道', CHANNELS[layout] || /^(\d+) channels/.exec(layout)?.[1]?.concat(' 聲道') || layout])
  const fmt = parts[3] || ''
  const bits = /\((\d+) bit\)/.exec(fmt) || /^[su](8|16|24|32|64)p?\b/.exec(fmt)
  if (bits) facts.push(['位元深度', `${bits[1]} 位元`])
  const rate = kbps(spec)
  if (rate) facts.push(['音訊位元率', rate])
  if (lang && lang !== 'und') facts.push(['語言', lang])
  return facts
}

/**
 * 解析 `ffmpeg -i` 印在 stderr 的檔頭。純函式（回歸測試直接餵文字）。
 * @param {string} text
 * @returns {{ title: string, facts: string[][] }[]}
 */
function parseProbe(text) {
  const lines = String(text || '').split(/\r?\n/)
  const media = []
  const tags = new Map()
  const streams = []
  let inTop = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^Input #0/.test(line)) { inTop = true; continue }
    const dur = /^\s+Duration: (\d+):(\d+):(\d+(?:\.\d+)?).*?bitrate: (\S+ kb\/s|N\/A)/.exec(line)
    if (dur) {
      inTop = false
      media.push(['長度', duration(dur[1], dur[2], dur[3])])
      const total = kbps(dur[4])
      if (total) media.push(['總位元率', total])
      continue
    }
    const tag = inTop && /^ {4}(\S[^:]*?)\s*: (.*)$/.exec(line)
    if (tag && tag[1] !== 'Metadata') {
      const key = tag[1].trim().toLowerCase()
      if (!tags.has(key)) tags.set(key, tag[2].trim())
      continue
    }
    const st = /^\s+Stream #0:\d+(?:\[0x[0-9a-f]+\])?(?:\(([\w-]+)\))?: (Video|Audio|Subtitle): (.*)$/.exec(line)
    if (!st) continue
    // 串流底下縮排更深的那幾行（Metadata、Side data）是它自己的附加資訊，到下一個串流為止
    let side = ''
    for (let j = i + 1; j < lines.length && /^ {4,}/.test(lines[j]) && !/^\s+Stream #/.test(lines[j]); j++) side += `${lines[j]}\n`
    streams.push({ lang: st[1] || '', kind: st[2], spec: st[3], side })
  }
  const groups = []
  const cover = streams.find((s) => s.kind === 'Video' && /attached pic/.test(s.spec))
  if (cover) {
    const res = /(\d{2,5})x(\d{2,5})/.exec(cover.spec)
    media.push(['封面', res ? `有（${res[1]} × ${res[2]}）` : '有'])
  }
  if (media.length) groups.push({ title: '媒體', facts: media })
  const videos = streams.filter((s) => s.kind === 'Video' && !/attached pic/.test(s.spec))
  videos.forEach((s, n) => groups.push({ title: videos.length > 1 ? `視訊 ${n + 1}` : '視訊', facts: videoFacts(s.spec, s.side) }))
  const audios = streams.filter((s) => s.kind === 'Audio')
  audios.forEach((s, n) => groups.push({ title: audios.length > 1 ? `音訊 ${n + 1}` : '音訊', facts: audioFacts(s.spec, s.lang) }))
  const subs = streams.filter((s) => s.kind === 'Subtitle')
  if (subs.length) {
    const list = subs.map((s) => [s.lang && s.lang !== 'und' ? s.lang : '', codecLabel(splitTop(s.spec)[0] || '')].filter(Boolean).join(' · '))
    groups.push({ title: '字幕', facts: [['軌數', `${subs.length}`], ['內容', list.join('、')]] })
  }
  const tagFacts = []
  const seen = new Set()
  for (const [key, label] of TAG_LABELS) {
    const value = tags.get(key)
    if (!value || seen.has(label)) continue
    seen.add(label)
    const shown = /time|date/.test(key) && /^\d{4}-\d\d-\d\dT/.test(value) ? localTime(value)
      : /location/.test(key) ? iso6709(value) : value
    tagFacts.push([label, shown])
  }
  if (tagFacts.length) groups.push({ title: '標籤', facts: tagFacts })
  return groups.map((g) => ({ ...g, facts: g.facts.filter((f) => f[1]) })).filter((g) => g.facts.length)
}

function probeMedia(full) {
  let bin
  try {
    bin = require('../ffmpeg-path').resolveFfmpegPath()
  } catch (error) {
    console.error('[explorer] 找不到 ffmpeg，影音詳細資訊略過:', error?.message || error)
    return Promise.resolve([])
  }
  return new Promise((resolve) => {
    // 沒給輸出檔，ffmpeg 印完檔頭就以 exit 1 結束——那是正常的，只看 stderr
    execFile(bin, ['-hide_banner', '-nostdin', '-i', full], {
      timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    }, (_error, _stdout, stderr) => resolve(parseProbe(stderr)))
  })
}

/**
 * 文字檔：編碼、換行、行數、字元數。純函式。
 * @param {Buffer} buf
 * @param {boolean} partial 只讀了前面一段（大檔）
 */
function textFacts(buf, partial) {
  let enc = ''
  let body = buf
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) { enc = 'UTF-8（含 BOM）'; body = buf.subarray(3) }
  else if (buf[0] === 0xff && buf[1] === 0xfe) enc = 'UTF-16 LE'
  else if (buf[0] === 0xfe && buf[1] === 0xff) enc = 'UTF-16 BE'
  let text = null
  if (!enc || enc.startsWith('UTF-8')) {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body)
      if (!enc) enc = body.every((b) => b < 0x80) ? 'ASCII' : 'UTF-8'
    } catch {
      // 大檔截斷可能剛好切在多位元組字元中間：看不出來就別亂下結論
      enc = partial ? '' : '非 UTF-8（可能是 Big5 等舊編碼）'
    }
  }
  const facts = [['編碼', enc]]
  if (enc.startsWith('UTF-16')) return facts
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      if (i > 0 && body[i - 1] === 0x0d) crlf += 1
      else lf += 1
    } else if (body[i] === 0x0d && body[i + 1] !== 0x0a) cr += 1
  }
  const kinds = [crlf && 'CRLF（Windows）', lf && 'LF（Unix）', cr && 'CR（舊 Mac）'].filter(Boolean)
  facts.push(['換行', kinds.length > 1 ? `混合：${kinds.join('、')}` : (kinds[0] || '沒有換行')])
  if (!partial) {
    const lines = body.length ? crlf + lf + cr + (body[body.length - 1] === 0x0a || body[body.length - 1] === 0x0d ? 0 : 1) : 0
    facts.push(['行數', lines.toLocaleString('en-US')])
    if (text !== null && body.length <= MAX_CHAR_COUNT) {
      let chars = 0
      for (const _ of text) chars += 1
      facts.push(['字元數', chars.toLocaleString('en-US')])
    }
  }
  return facts.filter((f) => f[1])
}

async function probeText(full, size) {
  const partial = size > MAX_TEXT_SCAN
  const n = partial ? 64 * 1024 : size
  const buf = Buffer.alloc(n)
  const fh = await fs.promises.open(full, 'r')
  try {
    await fh.read(buf, 0, n, 0)
  } finally {
    await fh.close()
  }
  // 有 NUL 就不是文字檔（UTF-16 例外，它本來就一堆 0）
  if (buf.includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe) && !(buf[0] === 0xfe && buf[1] === 0xff)) return []
  return [{ title: '文字', facts: textFacts(buf, partial) }]
}

/**
 * 屬性系統回來的 `{ name, value }` 排成段落。純函式。
 * @param {{ name: string, value: string }[]} props
 */
function groupProps(props) {
  const byName = new Map((props || []).map((p) => [p.name, clean(p.value)]))
  const groups = []
  for (const group of PROP_GROUPS) {
    const facts = []
    for (const [name, label] of group.props) {
      const value = byName.get(name)
      if (label && value) facts.push([label, value])
    }
    if (group.title === '影像') {
      const w = Number((byName.get('System.Image.HorizontalSize') || '').replace(/\D/g, ''))
      const h = Number((byName.get('System.Image.VerticalSize') || '').replace(/\D/g, ''))
      if (w && h) facts.unshift(['尺寸', `${w} × ${h}`], ['像素', pixelsFact(w, h)])
    }
    if (group.title === '位置') {
      // 系統給的是「25; 1; 58.8000000000029」：排成度分秒，另附一格可以直接貼進地圖的十進位
      const coords = []
      for (const [label, ref] of [['緯度', 'System.GPS.LatitudeRef'], ['經度', 'System.GPS.LongitudeRef']]) {
        const fact = facts.find((f) => f[0] === label)
        const dms = fact && fact[1].split(';').map((n) => Number(n.trim()))
        if (!dms || dms.length !== 3 || dms.some((n) => !Number.isFinite(n))) continue
        const hemi = byName.get(ref) || ''
        fact[1] = `${dms[0]}°${dms[1]}′${Number(dms[2].toFixed(2))}″ ${hemi}`.trim()
        coords.push((/[SW]/i.test(hemi) ? -1 : 1) * (dms[0] + dms[1] / 60 + dms[2] / 3600))
      }
      if (coords.length === 2) facts.push(['座標', coords.map((n) => n.toFixed(6)).join(', ')])
      const alt = facts.find((f) => f[0] === '高度')
      if (alt && /^-?[\d.]+$/.test(alt[1])) alt[1] = `${alt[1]} 公尺`
    }
    // 程式檔也會回「內容建立／上次儲存日期」，其實就是檔案時間；文件段只剩日期就不列
    if (group.title === '文件' && facts.every((f) => /日期$/.test(f[0]))) continue
    if (facts.length) groups.push({ title: group.title, facts })
  }
  return groups
}

async function probeProps(full) {
  const shell = require('./shell')
  const names = PROP_GROUPS.flatMap((g) => g.props.map((p) => p[0]))
  const props = await shell.propsOf(full, names, PROPS_TIMEOUT_MS)
  return groupProps(props)
}

/**
 * @param {unknown} filePath 本機真實路徑（壓縮檔／手機要先由呼叫端換成暫存檔）
 */
async function details(filePath) {
  const full = paths.resolveExisting(filePath)
  let st
  try {
    st = await fs.promises.stat(full)
  } catch {
    throw paths.fail('READ_FAILED', '讀不到這個檔案')
  }
  if (!st.isFile()) return { groups: [] }
  const ext = path.extname(full).slice(1).toLowerCase() || path.basename(full).toLowerCase()
  if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) return { groups: await probeMedia(full) }
  if (TEXT_EXT.has(ext)) return { groups: st.size ? await probeText(full, st.size) : [] }
  return { groups: await probeProps(full) }
}

module.exports = { details, parseProbe, textFacts, groupProps, VIDEO_EXT, AUDIO_EXT }
