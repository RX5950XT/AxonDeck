'use strict'

/**
 * 走 SQLite 的兩家用量來源（Main Process）。
 *
 * - **OpenCode**：`~/.local/share/opencode/opencode.db` 的 `message` 表，
 *   `data` 是一份 JSON，assistant 訊息帶 `cost`／`tokens`／`modelID`。
 *   **自帶花費**，不必靠單價表。
 * - **Antigravity**：兩份加總，彼此不重疊（反代只收 OpenAI 協定的外部工具，CLI 自己直連上游）：
 *   1. **Antigravity CLI** `~/.gemini/antigravity-cli/conversations/<id>.db`（`readAntigravityCli`）；
 *   2. **AxonDeck 自己的 AGY 反代日誌** `<userData>/agy-logs.db`（`readAntigravity`）。
 *   Antigravity IDE 的對話不在這裡，算不到；這個限制要讓 UI 講清楚。
 *
 * 都用 Electron 內建 `node:sqlite`、`readOnly: true`、`allowExtension: false`
 * 與參數化固定 SQL（跟額度頁讀 OpenCode 同一套規矩）。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

/** 單次查詢的列數上限 */
const MAX_ROWS = 50000
/** OpenCode 訊息建立後這麼久還沒完成，就當作放棄了 */
const UNFINISHED_WAIT_MS = 24 * 3600_000

/** @type {(() => object) | null} */
let sqliteModule = null

/**
 * `node:sqlite` 是 Electron 內建，但在純 node 測試環境可能沒有——延後 require，
 * 拿不到就讓呼叫端把這一家標成不可用，而不是讓整個同步掛掉。
 * @returns {object | null}
 */
function loadSqlite() {
  if (sqliteModule) return sqliteModule
  try {
    sqliteModule = require('node:sqlite')
  } catch {
    sqliteModule = null
  }
  return sqliteModule
}

/**
 * @param {string} file
 * @returns {object | null}
 */
function openReadOnly(file) {
  const sqlite = loadSqlite()
  if (!sqlite || !fs.existsSync(file)) return null
  try {
    return new sqlite.DatabaseSync(file, { readOnly: true, allowExtension: false })
  } catch {
    // 檔案被鎖住（OpenCode 正在寫）或版本不合：這一輪跳過，不影響其他家
    return null
  }
}

/** @returns {string} */
function opencodeDbPath() {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

/**
 * OpenCode：`message` 表，只取 assistant 且帶 tokens 的那些。
 *
 * @param {number} sinceMs 只取這之後建立的（增量游標）
 * @param {string} [dbPath]
 * @returns {Array<object>} 標準用量事件
 */
function readOpencode(sinceMs, dbPath = opencodeDbPath()) {
  const db = openReadOnly(dbPath)
  if (!db) return []
  try {
    const rows = db.prepare(
      `SELECT time_created, data FROM message
       WHERE time_created > ? AND data LIKE '%"tokens"%'
       ORDER BY time_created ASC LIMIT ?`
    ).all(sinceMs, MAX_ROWS)

    const events = []
    for (const row of rows) {
      let data
      try {
        data = JSON.parse(row.data)
      } catch {
        continue
      }
      if (data?.role !== 'assistant' || !data.tokens) continue
      // 還在跑的訊息 token 還沒寫完（實測最久 10 小時才寫完）：游標是建立時間，掃過去就不會回頭，
      // 所以停在這裡，下次從它開始。一天還沒完成的當作放棄，不讓它永遠卡住後面
      if (!data.time?.completed && Date.now() - Number(row.time_created) < UNFINISHED_WAIT_MS) break
      const tokens = data.tokens
      const cache = tokens.cache || {}
      const input = Number(tokens.input) || 0
      const cacheRead = Number(cache.read) || 0
      const output = Number(tokens.output) || 0
      const reasoning = Number(tokens.reasoning) || 0
      const cacheWrite = Number(cache.write) || 0
      const costUsd = Number.isFinite(Number(data.cost)) ? Number(data.cost) : null
      if (!input && !output && !reasoning && !cacheRead && !cacheWrite && !costUsd) continue
      events.push({
        ts: Number(row.time_created) || 0,
        model: String(data.modelID || 'unknown'),
        // OpenCode 的 input 不含 cache（實測 input 152079 / cache.read 128 / total 152528）
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        requests: 1,
        // 自帶花費，比我們用單價表推算準
        costUsd
      })
    }
    return events
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      // 已關閉
    }
  }
}

/**
 * Antigravity：讀 AxonDeck 自己的 AGY 反代日誌。
 *
 * @param {number} sinceMs 結束時間游標
 * @param {string} dbPath `<userData>/agy-logs.db`
 * @returns {Array<object>}
 */
function readAntigravity(sinceMs, dbPath) {
  const db = openReadOnly(dbPath)
  if (!db) return []
  try {
    const rows = db.prepare(
      // 日誌在請求「結束」才寫入，所以增量要照結束時間（ts + duration_ms）走；
      // 照開始時間走，先開始、後結束的那筆會落在游標之前，永遠漏算
      `SELECT ts, ts + duration_ms AS end_ts, model, mapped_model, input_tokens, output_tokens, thought_tokens, cached_tokens
       FROM request_logs
       WHERE ts + duration_ms > ? AND status < 400
       ORDER BY end_ts ASC LIMIT ?`
    ).all(sinceMs, MAX_ROWS)

    return rows.map((row) => ({
      ts: Number(row.ts) || 0,
      endTs: Number(row.end_ts) || 0,
      model: String(row.mapped_model || row.model || 'unknown'),
      // Gemini 的 promptTokenCount 已含快取，扣掉才不會重複計價
      input: Math.max(0, (Number(row.input_tokens) || 0) - (Number(row.cached_tokens) || 0)),
      output: Number(row.output_tokens) || 0,
      reasoning: Number(row.thought_tokens) || 0,
      cacheRead: Number(row.cached_tokens) || 0,
      cacheWrite: 0,
      requests: 1,
      costUsd: null
    }))
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      // 已關閉
    }
  }
}

/**
 * 最小 protobuf 解碼：欄位號 → 值陣列（varint 是數字，其餘是 Buffer）。壞資料丟例外。
 * @param {Uint8Array | undefined} input
 * @returns {Map<number, Array<number | Buffer>>}
 */
function protoMap(input) {
  const b = Buffer.from(input || []), out = new Map()
  let i = 0
  const varint = () => {
    let n = 0, shift = 0, byte
    do {
      if (i >= b.length || shift > 63) throw new Error('BAD_PROTO')
      byte = b[i++]
      n += (byte & 127) * 2 ** shift
      shift += 7
    } while (byte & 128)
    return n
  }
  while (i < b.length) {
    const key = varint(), wire = key % 8, field = Math.floor(key / 8)
    let value
    if (wire === 0) value = varint()
    else {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : wire === 5 ? 4 : -1
      if (!field || length < 0 || i + length > b.length) throw new Error('BAD_PROTO')
      value = b.subarray(i, i + length)
      i += length
    }
    if (!out.has(field)) out.set(field, [])
    out.get(field).push(value)
  }
  return out
}

/**
 * `gen_metadata` 一列＝一次模型呼叫。欄位是實測反推的（本機 2 萬筆全部吻合）：
 * 1.4 用量 {2 輸入（不含快取）, 5 快取讀取, 9 思考, 10 回答；3 = 9 + 10}；1.19 模型名，
 * 少數只有 1.3 模型編號；1.20 鍵值表的 `last_step_index` 指到 `steps`，那一步 metadata 1.1 是秒數。
 * @returns {object | null}
 */
function agyGen(data, stepMeta) {
  const gen = protoMap(protoMap(data).get(1)?.[0])
  const usage = protoMap(gen.get(4)?.[0])
  const num = (field) => Number(usage.get(field)?.[0]) || 0
  let stepIndex = NaN
  for (const entry of gen.get(20) || []) {
    const pair = protoMap(entry)
    if (String(pair.get(1)?.[0] || '') === 'last_step_index') stepIndex = Number(String(pair.get(2)?.[0] || ''))
  }
  const meta = Number.isInteger(stepIndex) ? stepMeta.get(stepIndex)?.metadata : null
  const ts = Number(protoMap(protoMap(meta).get(1)?.[0]).get(1)?.[0]) * 1000
  if (!Number.isFinite(ts) || ts <= 0) return null
  const name = gen.get(19)?.[0]
  return {
    ts,
    model: Buffer.isBuffer(name) ? name.toString('utf8') : '',
    modelId: String(gen.get(3)?.[0] ?? ''),
    input: num(2),
    output: num(10),
    reasoning: num(9),
    cacheRead: num(5),
    cacheWrite: 0,
    requests: 1,
    costUsd: null
  }
}

/** @param {string} root */
function agyCliFiles(root) {
  const dir = path.join(root, 'conversations')
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((name) => /^[0-9a-f-]{36}\.db$/.test(name)).map((name) => [name.slice(0, -3), path.join(dir, name)])
}

/**
 * 讀一份對話檔 `since` 之後的呼叫。
 * @returns {{ idx: number | undefined, events: Array<object> }}
 */
function readAgyConversation(file, since, models) {
  const out = { idx: undefined, events: [] }
  const db = openReadOnly(file)
  if (!db) return out
  try {
    const rows = db.prepare('SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx LIMIT ?').all(since, MAX_ROWS)
    const stepMeta = db.prepare('SELECT metadata FROM steps WHERE idx = ?')
    for (const row of rows) {
      let event = null
      try {
        event = agyGen(row.data, stepMeta)
      } catch {
        // 這一列格式不認得：跳過，不卡住後面
      }
      // 最後一筆還是 0 的可能正在跑：一天內先不推游標，下次再讀
      const empty = event && !event.input && !event.output && !event.reasoning && !event.cacheRead
      if (empty && row === rows[rows.length - 1] && Date.now() - event.ts < UNFINISHED_WAIT_MS) break
      if (event?.model && event.modelId) models[event.modelId] = event.model
      if (event) out.events.push(event)
      out.idx = row.idx
    }
  } catch {
    // 正在寫或版本不合：這一份下次再讀（已讀到的照收，游標停在那裡）
  } finally {
    try {
      db.close()
    } catch {
      // 已關閉
    }
  }
  return out
}

/**
 * Antigravity CLI：每個對話一份 `conversations/<id>.db`。子代理也是自己一份（母對話不含它的用量，
 * 實測 1.5 萬個 request_id 跨檔零重複），所以每份照算。**CLI 會自己刪對話檔**，呼叫端要逐檔記帳。
 *
 * @param {(id: string) => number | undefined} sinceOf 對話 id → 上次讀到的 `gen_metadata.idx`
 * @param {Record<string, string>} models 模型編號 → 名稱（就地更新；給只有編號的那幾筆用）
 * @param {string} root `~/.gemini/antigravity-cli`
 * @returns {Array<{ id: string, path: string, idx: number | undefined, events: Array<object> }>}
 */
function readAntigravityCli(sinceOf, models, root) {
  const files = agyCliFiles(root).map(([id, file]) => {
    const since = sinceOf(id)
    return { id, path: file, ...readAgyConversation(file, Number.isInteger(since) ? since : -1, models) }
  })
  const named = ({ modelId, ...event }) => ({ ...event, model: event.model || models[modelId] || 'unknown' })
  return files.map((file) => ({ ...file, events: file.events.map(named) }))
}

module.exports = {
  MAX_ROWS,
  readOpencode,
  readAntigravity,
  readAntigravityCli
}
