'use strict'

/**
 * Linux 媒體播放器：哪些檔案給 Chromium 的 <video>／<audio> 播、播放清單怎麼排、字幕找哪幾個。
 * 全是純函式（讀目錄／讀檔由呼叫端注入），規則比照 Windows 原生播放器
 * （native/axondeck-probe/src/bin/axondeck-media/library.rs）：
 *   - 開影片 → 同資料夾所有影片照自然排序當播放清單；音訊同理（不混播）
 *   - .m3u／.m3u8／.pls／.cue → 只收本機相對／絕對路徑，網址、註解、巢狀播放清單、不認得的副檔名一律丟掉
 */

const path = require('path')
const formats = require('../media-formats.json')

const KIND = new Map(Object.entries(formats).flatMap(([kind, list]) => list.map((ext) => [ext, kind])))

/**
 * Chromium（Electron 內建 FFmpeg，含 H.264／AAC）能直接播的容器。
 * 容器對了編碼不一定對（例如 HEVC 的 mp4、AC3 音軌的 mkv）：播放頁收到 error 會自己改走 mpv。
 */
const HTML5_MIME = Object.freeze({
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  ogv: 'video/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm'
})

const SUB_EXT = new Set(['srt', 'vtt', 'ass', 'ssa'])
const MAX_LIST = 10000
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024

function extOf(file) {
  return path.extname(String(file || '')).slice(1).toLowerCase()
}

/** @returns {'video' | 'audio' | 'image' | 'playlist' | ''} */
function kindOf(file) {
  return KIND.get(extOf(file)) || ''
}

function playable(file) {
  const kind = kindOf(file)
  return kind === 'video' || kind === 'audio'
}

/** 跟 Windows 一樣只收本機絕對路徑；網址、NUL、相對路徑都不要 */
function localFile(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !file.includes('\0') && !file.includes('://')
}

/**
 * @param {string} file
 * @returns {{ path: string, name: string, kind: 'video' | 'audio', html5: boolean, mime: string }}
 */
function planItem(file) {
  const ext = extOf(file)
  const kind = kindOf(file) === 'audio' ? 'audio' : 'video'
  const mime = HTML5_MIME[ext] || ''
  return { path: file, name: path.basename(file), kind, html5: Boolean(mime), mime }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** 檔案總管式的自然排序（對應 Windows 的 StrCmpLogicalW）：ep2 排在 ep10 前面 */
function naturalSort(files) {
  return [...files].sort((a, b) => collator.compare(path.basename(a), path.basename(b)) || (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * 同資料夾、同種類（影片／音訊）的檔案。
 * @param {string} seed
 * @param {string[]} names 資料夾裡的檔名（只看名字；呼叫端已濾掉資料夾）
 */
function siblings(seed, names) {
  const dir = path.dirname(seed)
  const want = kindOf(seed)
  const list = []
  for (const name of names.slice(0, MAX_LIST)) {
    if (typeof name !== 'string' || name.includes('/') || name.includes('\0')) continue
    if (kindOf(name) !== want) continue
    list.push(path.join(dir, name))
  }
  if (!list.includes(seed)) list.push(seed)
  return naturalSort(list)
}

/**
 * 解析播放清單（比照 Windows library.rs 的 playlist）。
 * @param {string} seed 播放清單的絕對路徑
 * @param {string} text 內容
 * @returns {string[]}
 */
function parsePlaylist(seed, text) {
  const dir = path.dirname(seed)
  const ext = extOf(seed)
  const out = []
  const lines = String(text || '').replace(/^\ufeff/, '').split(/\r?\n/).slice(0, MAX_LIST)
  for (const raw of lines) {
    const line = raw.trim()
    let value = line
    if (ext === 'pls') {
      const eq = line.indexOf('=')
      if (eq < 0 || !line.slice(0, eq).toLowerCase().startsWith('file')) continue
      value = line.slice(eq + 1).trim()
    } else if (ext === 'cue') {
      // CUE 先播整個來源檔（分軌要 seek／end offset，Windows 版也還沒做）
      const m = /^FILE "([^"]*)"/.exec(line)
      if (!m) continue
      value = m[1]
    }
    if (!value || value.startsWith('#') || value.includes('://') || value.includes('\0')) continue
    value = value.replace(/^"+|"+$/g, '')
    if (!value) continue
    const file = path.isAbsolute(value) ? path.normalize(value) : path.join(dir, value)
    if (!localFile(file) || !playable(file)) continue
    out.push(file)
  }
  return out
}

/**
 * 同名字幕：`movie.srt`、`movie.zh-TW.srt`、`movie.en.vtt`、`movie.ass`。
 * @param {string} file 影片絕對路徑
 * @param {string[]} names 同資料夾的檔名
 * @returns {Array<{ path: string, label: string, lang: string, format: string }>}
 */
function findSubtitles(file, names) {
  const dir = path.dirname(file)
  const base = path.basename(file, path.extname(file))
  const out = []
  for (const name of names.slice(0, MAX_LIST)) {
    if (typeof name !== 'string') continue
    const format = extOf(name)
    if (!SUB_EXT.has(format)) continue
    const stem = name.slice(0, -(format.length + 1))
    let lang = ''
    if (stem === base) lang = ''
    else if (stem.startsWith(`${base}.`) && /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})?$/.test(stem.slice(base.length + 1))) lang = stem.slice(base.length + 1)
    else continue
    out.push({ path: path.join(dir, name), label: lang ? `${lang}（${format}）` : name, lang, format })
  }
  // 沒標語言的（movie.srt）排最前面，再照語言；同語言 SRT／VTT 在 ASS 前面（內建播放器只吃前兩種）
  const rank = (f) => (f === 'srt' || f === 'vtt' ? 0 : 1)
  return out.sort((a, b) => (a.lang ? 1 : 0) - (b.lang ? 1 : 0) || collator.compare(a.lang, b.lang) || rank(a.format) - rank(b.format) || collator.compare(a.path, b.path))
}

/**
 * SRT → WebVTT（<track> 只吃 VTT）。HTML 標籤留著（VTT 也用 <i>／<b>），其他照抄。
 * @param {string} text
 */
function srtToVtt(text) {
  const body = String(text || '')
    .replace(/^\ufeff/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
    .replace(/\{\\an?\d+\}/g, '')
  return `WEBVTT\n\n${body.trim()}\n`
}

/**
 * 這一首要用哪個後端。
 * @param {{ html5: boolean }} item
 * @param {{ mpv: string, ffplay: string }} tools 絕對路徑；沒有就空字串
 * @param {{ html5Failed?: boolean }} [state]
 * @returns {'html5' | 'mpv' | 'ffplay' | 'system'}
 */
function chooseBackend(item, tools, state = {}) {
  if (item.html5 && !state.html5Failed) return 'html5'
  if (tools.mpv) return 'mpv'
  if (tools.ffplay) return 'ffplay'
  return 'system'
}

const TOOL_DIRS = ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin']

/**
 * 只找固定的絕對路徑，不從 PATH 找（AxonDeck 從桌面啟動時 PATH 不可靠，也不想被同名程式頂替）。
 * @param {'mpv' | 'ffplay'} name
 * @param {(file: string) => boolean} exists
 */
function findTool(name, exists) {
  for (const dir of TOOL_DIRS) {
    const file = path.join(dir, name)
    if (exists(file)) return file
  }
  return ''
}

module.exports = {
  HTML5_MIME,
  SUB_EXT,
  extOf,
  kindOf,
  playable,
  localFile,
  planItem,
  naturalSort,
  siblings,
  parsePlaylist,
  findSubtitles,
  srtToVtt,
  chooseBackend,
  findTool
}
