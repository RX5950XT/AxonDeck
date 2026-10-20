'use strict'

/**
 * PDF 譯文快取：原文＋模型＋語言＋術語設定相同就不再送翻。
 * 中途取消、失敗重來、同一份文件再翻一次都直接用；30 天沒用到的清掉。
 * 存在 userData（本機磁碟），內容是使用者自己文件的原文與譯文。
 */

const path = require('path')
const { createHash } = require('crypto')

const KEEP_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ROWS = 200000

let db = null

function open(userDataPath) {
  if (db) return db
  const { DatabaseSync } = require('node:sqlite')
  db = new DatabaseSync(path.join(userDataPath, 'pdf-translate-cache.sqlite'))
  db.exec('CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, text TEXT NOT NULL, used INTEGER NOT NULL)')
  db.prepare('DELETE FROM translations WHERE used < ?').run(Date.now() - KEEP_MS)
  db.prepare('DELETE FROM translations WHERE key IN (SELECT key FROM translations ORDER BY used DESC LIMIT -1 OFFSET ?)').run(MAX_ROWS)
  return db
}

function keyOf(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

function get(key) {
  const row = db?.prepare('SELECT text FROM translations WHERE key = ?').get(key)
  if (!row) return null
  db.prepare('UPDATE translations SET used = ? WHERE key = ?').run(Date.now(), key)
  return row.text
}

function set(key, text) {
  if (!db || typeof text !== 'string' || !text.trim()) return
  db.prepare('INSERT OR REPLACE INTO translations (key, text, used) VALUES (?, ?, ?)').run(key, text, Date.now())
}

/** 全部清掉並縮小檔案；回傳清掉幾筆 */
function clear(userDataPath) {
  const removed = open(userDataPath).prepare('DELETE FROM translations').run().changes
  db.exec('VACUUM')
  return Number(removed)
}

function close() {
  db?.close()
  db = null
}

module.exports = { open, keyOf, get, set, clear, close }
