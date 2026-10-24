'use strict'

/**
 * plocate／mlocate 後端：系統已經有每天由 updatedb 更新的整機檔名資料庫，就直接借用，
 * 不再自己建一份（省下第一次索引的時間與磁碟 I/O）。
 *
 * 資料庫太舊（預設超過 36 小時沒更新，代表 updatedb 計時器沒在跑）就不用它，改走 App 自建索引。
 * 系統工具一律指名絕對路徑；參數陣列、shell: false；樣式前面一定有 `--`，不會被當成選項。
 */

const path = require('path')
const { spawn } = require('child_process')
const rawFs = require('../raw-fs')

const CANDIDATES = [
  { bin: '/usr/bin/plocate', db: ['/var/lib/plocate/plocate.db'], name: 'plocate' },
  { bin: '/usr/bin/locate', db: ['/var/lib/plocate/plocate.db', '/var/lib/mlocate/mlocate.db', '/var/lib/locate/locatedb', '/var/cache/locate/locatedb'], name: 'locate' },
  { bin: '/usr/bin/mlocate', db: ['/var/lib/mlocate/mlocate.db'], name: 'mlocate' }
]
const FRESH_MS = 36 * 60 * 60 * 1000
const TIMEOUT_MS = 15_000
const MAX_STDOUT = 16 * 1024 * 1024

/**
 * @param {{ fsp?: any, now?: () => number, candidates?: typeof CANDIDATES, freshMs?: number }} [deps]
 * @returns {Promise<{ available: boolean, fresh: boolean, bin: string, name: string, db: string, dbMtimeMs: number }>}
 */
async function probeLocate(deps = {}) {
  const fsp = deps.fsp || rawFs.promises
  const now = deps.now || Date.now
  const freshMs = Number(deps.freshMs) > 0 ? Number(deps.freshMs) : FRESH_MS
  for (const c of deps.candidates || CANDIDATES) {
    try {
      await fsp.access(c.bin, rawFs.constants.X_OK)
    } catch {
      continue
    }
    for (const db of c.db) {
      let st
      try { st = await fsp.stat(db) } catch { continue }
      const dbMtimeMs = Number(st.mtimeMs) || 0
      return { available: true, fresh: now() - dbMtimeMs < freshMs, bin: c.bin, name: c.name, db, dbMtimeMs }
    }
    // 有程式但找不到資料庫（從沒跑過 updatedb）：等同沒有
  }
  return { available: false, fresh: false, bin: '', name: '', db: '', dbMtimeMs: 0 }
}

/**
 * 跑一次 locate，回傳路徑陣列（-0 分隔，檔名有換行也不會切錯）。
 * -b：只比對檔名（跟 UFFS／App 索引一樣）；-i：不分大小寫；沒有萬用字元時 locate 自己當 *樣式*。
 * @param {string} bin
 * @param {string} pattern
 * @param {{ limit: number, spawnFn?: typeof spawn, onChild?: (child: any) => void }} opts
 * @returns {Promise<string[]>}
 */
function runLocate(bin, pattern, opts) {
  const spawnFn = opts.spawnFn || spawn
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnFn(bin, ['-i', '-b', '-0', '-l', String(opts.limit), '--', pattern], {
        shell: false, stdio: ['ignore', 'pipe', 'ignore']
      })
    } catch {
      reject(new Error('LOCATE_SPAWN'))
      return
    }
    opts.onChild?.(child)
    const chunks = []
    let size = 0
    const timer = setTimeout(() => { try { child.kill() } catch { /* 已結束 */ } }, TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_STDOUT) { try { child.kill() } catch { /* 已結束 */ } return }
      chunks.push(chunk)
    })
    child.on('error', () => { clearTimeout(timer); reject(new Error('LOCATE_SPAWN')) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // locate 沒有命中時 exit 1，不是錯誤
      if (code !== 0 && code !== 1 && code !== null) { reject(new Error('LOCATE_FAILED')); return }
      const text = Buffer.concat(chunks).toString('utf8')
      resolve(text.split('\0').filter((p) => p && p.startsWith('/')).map((p) => path.normalize(p)))
    })
  })
}

module.exports = { probeLocate, runLocate, CANDIDATES, FRESH_MS }
