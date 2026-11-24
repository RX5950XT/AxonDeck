'use strict'

/**
 * 系統剪貼簿裡的檔案清單格式。
 * Windows：FileNameW／Preferred DropEffect（由 index.js 讀）。
 * Linux：GNOME 的 `x-special/gnome-copied-files`、KDE 的 cut 標記，以及通用的 `text/uri-list`。
 */

const { pathToFileURL, fileURLToPath } = require('url')
const path = require('path')

const GNOME_FILES = 'x-special/gnome-copied-files'
const URI_LIST = 'text/uri-list'
const KDE_CUT = 'application/x-kde-cutselection'

/**
 * @param {string} text
 * @returns {string[]} 絕對路徑
 */
function parseUriList(text) {
  if (!text) return []
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const raw = line.trim()
    if (!raw || raw.startsWith('#') || !raw.toLowerCase().startsWith('file:')) continue
    try {
      const full = fileURLToPath(raw)
      if (full) out.push(full)
    } catch { /* 不是本機路徑 */ }
  }
  return out
}

/**
 * @param {string} text
 * @returns {{ mode: 'copy'|'cut', paths: string[] }}
 */
function parseGnomeCopiedFiles(text) {
  const lines = String(text || '').split(/\r?\n/)
  const mode = (lines[0] || '').trim().toLowerCase() === 'cut' ? 'cut' : 'copy'
  return { mode, paths: parseUriList(lines.slice(1).join('\n')) }
}

function readClipText(cb, format) {
  if (!cb) return ''
  try {
    const buf = cb.readBuffer(format)
    if (buf && buf.length) return buf.toString('utf8')
  } catch { /* 這個格式沒有 */ }
  return ''
}

function linuxHasFiles(cb) {
  if (!cb) return false
  if (parseGnomeCopiedFiles(readClipText(cb, GNOME_FILES)).paths.length) return true
  if (parseUriList(readClipText(cb, URI_LIST)).length) return true
  return false
}

function linuxClipMode(cb) {
  const gnome = readClipText(cb, GNOME_FILES)
  if (gnome) return parseGnomeCopiedFiles(gnome).mode
  const kde = readClipText(cb, KDE_CUT).trim()
  if (kde === '1') return 'cut'
  return 'copy'
}

function linuxClipSig(cb) {
  return [readClipText(cb, GNOME_FILES), readClipText(cb, URI_LIST)].join('|')
}

/**
 * 目的地是不是來源自己或它底下（不能把資料夾貼進自己裡面）。
 * Windows 路徑不分大小寫；Linux／macOS 要分。
 * @param {string} source
 * @param {string} destination
 */
function pathContains(source, destination) {
  if (process.platform === 'win32') {
    const a = source.toLowerCase()
    const b = destination.toLowerCase()
    return b === a || b.startsWith(a + path.sep)
  }
  return destination === source || destination.startsWith(source + path.sep)
}

module.exports = {
  GNOME_FILES,
  URI_LIST,
  KDE_CUT,
  parseUriList,
  parseGnomeCopiedFiles,
  readClipText,
  linuxHasFiles,
  linuxClipMode,
  linuxClipSig,
  pathContains,
  pathToFileURL
}
