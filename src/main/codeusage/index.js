'use strict'

/**
 * 五家 AI CLI 的 token 用量統計（Main Process）。
 *
 * 跟「額度」頁不同：那邊看的是**訂閱還剩多少**（官方 API），這裡看的是
 * **本機記錄裡實際用掉多少 token、跑了幾次、大概花多少錢**。
 *
 * 資料一律折成「每小時 × 供應商 × 模型 × 價格級距」的桶子存進 `<userData>/code-usage.json`，
 * 原始事件不留（幾十萬筆，留了只是白佔硬碟）。時間範圍是 main 的白名單，
 * renderer 只送 key——跟 `agy/logs.js` 的統計同一套規矩。
 *
 * **這裡不打任何網路**：全部來自本機檔案。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const pricing = require('./pricing')
const parsers = require('./parsers')
const scan = require('./scan')
const dbSources = require('./db-sources')

const HOUR_MS = 3600_000
const DAY_MS = 24 * HOUR_MS
/** 一次 stats 最多回幾格序列 */
const MAX_SERIES_POINTS = 96
/** 模型分佈最多回幾筆 */
const MAX_MODEL_ROWS = 12

/**
 * 五家供應商。`key` 同時是桶子的欄位值與 UI 的識別。
 * @type {ReadonlyArray<{ key: string, label: string, kind: 'jsonl' | 'sqlite', note?: string }>}
 */
const PROVIDERS = Object.freeze([
  { key: 'claude', label: 'Claude Code', kind: 'jsonl' },
  { key: 'codex', label: 'Codex', kind: 'jsonl' },
  { key: 'grok', label: 'Grok Build', kind: 'jsonl' },
  { key: 'opencode', label: 'OpenCode', kind: 'sqlite' },
  {
    key: 'antigravity',
    label: 'Antigravity',
    kind: 'sqlite',
    // 這條一定要顯示在 UI 上，否則使用者會以為數字是完整的
    note: 'Antigravity 本機沒有 session 記錄，只統計得到經過本 App 的 AGY 反代那部分。'
  }
])

/** 統計時間範圍白名單（跟 AGY 統計一致） */
const STAT_RANGES = Object.freeze({
  '24h': { hours: 24, bucket: 'hour' },
  '7d': { hours: 24 * 7, bucket: 'day' },
  '30d': { hours: 24 * 30, bucket: 'day' },
  all: { hours: 0, bucket: 'day' }
})

/** @type {{ userDataPath: string, homeDir: string }} */
const paths = { userDataPath: '', homeDir: '' }

/** @type {import('electron-store') | null} */
let store = null
/** @type {Promise<import('electron-store')> | null} */
let storeReady = null
let syncing = null

/**
 * @param {{ userDataPath?: string, homeDir?: string }} options
 */
function configure(options = {}) {
  if (typeof options.userDataPath === 'string') paths.userDataPath = options.userDataPath
  if (typeof options.homeDir === 'string') paths.homeDir = options.homeDir
}

function homeDir() {
  return paths.homeDir || os.homedir()
}

async function getStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = import('electron-store').then((mod) => {
      if (!store) store = new mod.default({ name: 'code-usage' })
      return store
    })
  }
  return storeReady
}

// ===== 桶子 =====

/**
 * 桶子的 key：`小時起點|供應商|正規化模型`；長上下文加 `|long`。
 * @param {number} ts
 * @param {string} provider
 * @param {string} model
 * @param {boolean} [longContext]
 * @returns {string}
 */
function bucketKey(ts, provider, model, longContext = false) {
  return `${Math.floor(ts / HOUR_MS) * HOUR_MS}|${provider}|${model}${longContext ? '|long' : ''}`
}

/**
 * 把用量事件累進桶子表。
 * @param {Map<string, object>} buckets
 * @param {string} provider
 * @param {object} event
 */
function addEvent(buckets, provider, event) {
  if (!event || !Number.isFinite(event.ts) || event.ts <= 0) return
  const model = pricing.normalizeModel(event.model)
  // 不是模型名的 id（某些代理會寫 `model: "m"`）直接不收：留著只會在
  // 「未設單價」那一列上永遠掛著一顆使用者填不了單價的東西
  if (pricing.isJunkModel(model)) return
  const totalTokens = (event.input || 0) + (event.output || 0) + (event.cacheRead || 0)
    + (event.cacheWrite || 0) + (event.cacheWrite1h || 0) + (event.reasoning || 0)
  const hasCost = Number.isFinite(event.costUsd) && event.costUsd > 0
  // 只有 unknown 且 0 token 的空事件（取消請求遺留）才丟棄；有具體模型名的即便 token 為 0 也是真實請求
  if (model === 'unknown' && totalTokens === 0 && !hasCost) return
  const promptTokens = (event.input || 0) + (event.cacheRead || 0)
    + (event.cacheWrite || 0) + (event.cacheWrite1h || 0)
  const threshold = pricing.priceFor(model)?.longContext?.threshold
  const longContext = Number.isFinite(threshold) && promptTokens > threshold
  const key = bucketKey(event.ts, provider, model, longContext)
  let bucket = buckets.get(key)
  if (!bucket) {
    bucket = {
      ts: Math.floor(event.ts / HOUR_MS) * HOUR_MS,
      provider,
      model,
      longContext,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      requests: 0,
      // 來源自己算好的花費；沒有的話留 null，之後靠單價表推
      reportedCost: null
    }
    buckets.set(key, bucket)
  }
  bucket.input += event.input || 0
  bucket.output += event.output || 0
  bucket.reasoning += event.reasoning || 0
  bucket.cacheRead += event.cacheRead || 0
  bucket.cacheWrite += event.cacheWrite || 0
  bucket.cacheWrite1h += event.cacheWrite1h || 0
  bucket.requests += event.requests || 0
  if (Number.isFinite(event.costUsd)) {
    bucket.reportedCost = (bucket.reportedCost || 0) + event.costUsd
  }
}

/**
 * 讀檔後正規化：code-usage.json 可能被手改或版本不符。
 * @param {unknown} raw
 * @returns {Map<string, object>}
 */
function loadBuckets(raw) {
  const buckets = new Map()
  if (!Array.isArray(raw)) return buckets
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const ts = Number(item.ts)
    const provider = String(item.provider || '')
    const model = String(item.model || '')
    if (!Number.isFinite(ts) || !provider || !model) continue
    // 舊檔裡已經記進去的假 id（`m` 之類）讀檔時就丟掉，不必等使用者去按重掃
    if (pricing.isJunkModel(model)) continue
    const input = Number(item.input) || 0
    const output = Number(item.output) || 0
    const reasoning = Number(item.reasoning) || 0
    const cacheRead = Number(item.cacheRead) || 0
    const cacheWrite = Number(item.cacheWrite) || 0
    const cacheWrite1h = Number(item.cacheWrite1h) || 0
    const totalTokens = input + output + reasoning + cacheRead + cacheWrite + cacheWrite1h
    // **不可以寫成 `Number.isFinite(Number(item.reportedCost))`**：`Number(null)` 是 0，
    // 存進 json 的 `reportedCost: null`（＝這家沒自帶花費）會被讀成「來源說花了 0 元」，
    // `withCost` 就直接回 0 而不去查單價表——症狀是整頁花費恆為 0，而且因為不是 null，
    // 連「未設單價」的警語都不會出現（實測 all 範圍算出 1645 美元，實際 46794 美元）
    const reportedCost = typeof item.reportedCost === 'number' && Number.isFinite(item.reportedCost)
      ? item.reportedCost
      : null
    // 0 token 且無實際花費的 unknown 幽靈桶子（例如被取消的請求遺留的 unknown 桶）直接濾除
    if (model === 'unknown' && totalTokens === 0 && !reportedCost) continue
    const longContext = item.longContext === true && Boolean(pricing.priceFor(model)?.longContext)
    buckets.set(bucketKey(ts, provider, model, longContext), {
      ts,
      provider,
      model,
      longContext,
      input,
      output,
      reasoning,
      cacheRead,
      cacheWrite,
      cacheWrite1h,
      requests: Number(item.requests) || 0,
      reportedCost
    })
  }
  return buckets
}

// ===== 同步 =====

/**
 * 三家 JSONL 來源的定義。路徑固定在 main，renderer 碰不到。
 * @returns {Array<object>}
 */
/**
 * @param {{ countChildren?: Set<string>, knownIds?: Iterable<string> }} [extra]
 *   `countChildren`：Grok 子代理裡**要另外算**的那些（母那一輪沒含到的）；
 *   `knownIds`：已被刪掉的檔算過、但還有複本在別的檔的 Claude 訊息 id
 */
function jsonlSources(extra = {}) {
  const home = homeDir()
  return [
    {
      provider: 'claude',
      // 有 axondeck-probe.exe 就走原生解析（usage.rs），規則與 parsers.js 一致
      native: 'claude',
      roots: [path.join(home, '.claude', 'projects')],
      knownIds: extra.knownIds,
      match: (name) => name.endsWith('.jsonl'),
      parseLine: parsers.parseClaudeLine,
      newState: parsers.newState,
      // 檔名＝session UUID，跟著檔案走
      keyOf: (file) => path.basename(file)
    },
    {
      provider: 'codex',
      native: 'codex',
      roots: [
        path.join(home, '.codex', 'sessions'),
        path.join(home, '.codex', 'archived_sessions')
      ],
      // 新版 Codex 會把舊 session 壓成 `.jsonl.zst`（實測本機九成的 session 都是）
      match: (name) => name.endsWith('.jsonl') || name.endsWith('.jsonl.zst'),
      parseLine: parsers.parseCodexLine,
      newState: parsers.newState,
      // 檔名含 UUID；session 會被搬進 archived_sessions、也會被壓縮，游標不能認絕對路徑或副檔名
      keyOf: (file) => path.basename(file).replace(/\.zst$/, '')
    },
    {
      provider: 'grok',
      native: 'grok',
      roots: [
        path.join(home, '.grok', 'sessions'),
        path.join(home, '.grok', 'archived_sessions')
      ],
      match: (name) => name === 'updates.jsonl',
      parseLine: parsers.parseGrokLine,
      newState: parsers.newState,
      // 檔名一律叫 updates.jsonl，session 身分在上一層資料夾名
      keyOf: (file) => path.basename(path.dirname(file)),
      // 子代理預設不算（母 session 已含），母那一輪沒含到的才照算
      skipFile: (file) => !extra.countChildren?.has(path.basename(path.dirname(file))) && isGrokSubagent(file)
    }
  ]
}

/**
 * Grok 子代理自己的 session。母 session 那一輪的 `usage` 已經含「那一輪結束前跑完的子代理」
 * （`~/.grok/docs/user-guide/14-headless-mode.md`；實測子代理的 modelCalls 跟母那一輪的完全對得上），
 * 再讀子代理自己的檔會算兩次（實測本機 58 個、3700 萬 token）。哪些例外要照算見 `grokCountChildren`。
 * @param {string} file updates.jsonl
 * @returns {boolean}
 */
function isGrokSubagent(file) {
  const dir = path.dirname(file)
  const read = (name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
    } catch {
      return null
    }
  }
  // prompt_context.json 開 session 就寫；summary.json 之後才有，當備援
  if (read('prompt_context.json')?.audience === 'subagent') return true
  return String(read('summary.json')?.session_kind || '').startsWith('subagent')
}

/**
 * 掃一輪本機記錄。第一次會讀滿 5GB 等級的資料（實測），所以**只在使用者按同步時跑**，
 * 而且同時間只准跑一個。
 *
 * @param {{ onProgress?: (payload: object) => void }} [options]
 * @returns {Promise<object>}
 */
function sync(options = {}) {
  if (syncing) return syncing
  syncing = runSync(options).finally(() => {
    syncing = null
  })
  return syncing
}

/**
 * @param {{ onProgress?: (payload: object) => void }} options
 */
/**
 * Grok 要另外算的子代理：母 session 解析時定案的（`parsers.js#resolveSubagents`），
 * 加上開了一天、母那一輪還沒結束的（母那一輪大概永遠不會記到用量了）。
 * @param {Record<string, object>} cursors
 * @returns {Set<string>}
 */
function grokCountChildren(cursors) {
  const out = new Set()
  const stale = Date.now() - DAY_MS
  for (const [key, cursor] of Object.entries(cursors)) {
    if (!key.startsWith('grok:')) continue
    for (const id of cursor?.countChildren || []) out.add(id)
    for (const entry of cursor?.subagents || []) {
      if (Array.isArray(entry) && Number(entry[2]) < stale) out.add(String(entry[0]))
    }
  }
  return out
}

/**
 * 被工具刪掉的檔：它貢獻的用量併進封存區，之後整份重讀時加回去。訊息 id 只留還有複本在別的檔的那些
 * （Claude resume／fork 會複製舊訊息；不留的話重讀時那份複本會被當成新的再算一次）。
 * @param {Record<string, object>} removed `pruneCursors` 清掉的游標
 * @param {Record<string, object>} cursors 還在的游標
 * @param {Map<string, object>} archive 就地併入
 * @param {Set<string>} archiveIds 就地併入
 */
function archiveRemoved(removed, cursors, archive, archiveIds) {
  const gone = Object.values(removed).filter(Boolean)
  for (const cursor of gone) {
    for (const bucket of loadBuckets(cursor.contrib).values()) mergeBucket(archive, bucket)
  }
  const ids = gone.flatMap((cursor) => (Array.isArray(cursor.seen) ? cursor.seen : []))
  if (!ids.length) return
  const alive = new Set(Object.values(cursors).flatMap((cursor) => (Array.isArray(cursor?.seen) ? cursor.seen : [])))
  for (const id of ids) {
    if (alive.has(id)) archiveIds.add(id)
  }
}

async function runSync(options) {
  const s = await getStore()
  // 正規化規則改過 → 舊桶子掛在舊 key 上，增量掃描永遠碰不到它們。
  // 自己整份重讀一次，不必使用者去按「全部重讀」。
  const fullRescan = pricing.needsFullRescan(s.get('rulesVersion', 0))
  // 重讀時舊桶子先留著：來源檔已被工具自己刪掉的那段（Claude Code 只留約 30 天）重讀不回來
  const previous = fullRescan ? loadBuckets(s.get('buckets', [])) : null
  const buckets = fullRescan ? new Map() : loadBuckets(s.get('buckets', []))
  const cursors = fullRescan ? {} : s.get('cursors', {}) || {}
  const dbCursors = fullRescan ? {} : s.get('dbCursors', {}) || {}
  // 被工具刪掉的檔留下的用量與訊息 id；整份重讀時靠它補回來源已經不在的那段
  const archive = loadBuckets(s.get('archive', []))
  const archiveIds = new Set((s.get('archiveIds', []) || []).filter((id) => typeof id === 'string'))
  // 「全部」要真的是全部：不限檔案修改時間，游標讓之後每次只讀新增的部分
  const sinceMs = 0
  const report = { providers: {}, scannedBytes: 0 }

  // 每個檔累計貢獻多少，存在它的游標上（`contrib`）；檔案被刪時才知道要封存哪一份
  const contribs = new Map()
  const fold = (provider) => (event, key) => {
    addEvent(buckets, provider, event)
    if (!contribs.has(key)) contribs.set(key, loadBuckets(cursors[key]?.contrib))
    addEvent(contribs.get(key), provider, event)
  }
  const scanOnce = async (source) => {
    const result = await scan.scanSource(source, cursors, fold(source.provider), sinceMs)
    report.scannedBytes += result.scannedBytes
    return result
  }

  for (const source of jsonlSources({ countChildren: grokCountChildren(cursors), knownIds: archiveIds })) {
    options.onProgress?.({ provider: source.provider, state: 'scanning' })
    let result = await scanOnce(source)
    if (source.provider === 'grok') {
      // 母 session 這一輪才定案要另外算的子代理，剛才那一輪已經被跳過了：補掃一次（其他檔沒變，很快）
      const countChildren = grokCountChildren(cursors)
      const late = [...countChildren].some((id) => !cursors[`grok:${id}`])
      if (late) result = await scanOnce(jsonlSources({ countChildren }).find((item) => item.provider === 'grok'))
    }
    report.providers[source.provider] = result
  }
  for (const [key, map] of contribs) {
    if (cursors[key]) cursors[key] = { ...cursors[key], contrib: [...map.values()] }
  }

  // OpenCode：SQL 直接依時間增量，不需要檔案游標
  options.onProgress?.({ provider: 'opencode', state: 'scanning' })
  const opencodeSince = Number(dbCursors.opencode) || 0
  const opencodeEvents = dbSources.readOpencode(opencodeSince)
  for (const event of opencodeEvents) addEvent(buckets, 'opencode', event)
  if (opencodeEvents.length) {
    dbCursors.opencode = opencodeEvents[opencodeEvents.length - 1].ts
  }
  report.providers.opencode = { files: 1, events: opencodeEvents.length }

  // Antigravity：只有 AGY 反代日誌
  options.onProgress?.({ provider: 'antigravity', state: 'scanning' })
  const agyDb = paths.userDataPath ? path.join(paths.userDataPath, 'agy-logs.db') : ''
  // 游標是結束時間（antigravityEnd）；舊版只存開始時間，沿用一次當起點
  const agySince = Number(dbCursors.antigravityEnd) || Number(dbCursors.antigravity) || 0
  const agyEvents = agyDb ? dbSources.readAntigravity(agySince, agyDb) : []
  for (const event of agyEvents) addEvent(buckets, 'antigravity', event)
  if (agyEvents.length) {
    dbCursors.antigravityEnd = agyEvents[agyEvents.length - 1].endTs
  }
  report.providers.antigravity = { files: 1, events: agyEvents.length }

  if (previous) {
    // 有記帳的已刪檔整份加回去；記帳之前就被刪掉的（舊版沒記）才退回用舊桶子推
    for (const bucket of archive.values()) mergeBucket(buckets, bucket)
    // JSONL：現存最舊檔案的修改時間之前才可能有檔被刪；SQLite 兩家整份都在，只補新資料最早那筆之前的
    const since = Object.fromEntries(Object.entries(report.providers).map(([provider, result]) => [
      provider,
      Number.isFinite(result.oldestMtimeMs) ? result.oldestMtimeMs : earliestTs(buckets, provider)
    ]))
    keepOrphans(buckets, previous, since)
  }
  archiveRemoved(scan.pruneCursors(cursors), cursors, archive, archiveIds)
  // shortcut: 桶子永久保留（一年約幾 MB），真的太大再把舊的小時桶併成日桶
  const rows = [...buckets.values()]
  const syncedAt = Date.now()
  // electron-store 每次 set 都會重讀與重寫 JSON；大游標檔案要一次寫完。
  s.set({
    buckets: rows,
    cursors,
    dbCursors,
    archive: [...archive.values()],
    archiveIds: [...archiveIds],
    rulesVersion: pricing.RULES_VERSION,
    syncedAt
  })

  return { ...report, fullRescan, buckets: rows.length, syncedAt }
}

// ===== 統計 =====

/**
 * 一格（時間桶／模型／供應商）的空累加器。
 *
 * **四種 token 要分開留著**：長對話九成以上的量走快取，只回一個總數的話
 * 使用者看到幾十億 token 完全無從判斷那是真的在打模型還是在讀快取（價差 10 倍）。
 * `tokens` 是四項的總和，圖表的長度還是照它算。
 * @returns {object}
 */
function emptyTotals() {
  return {
    requests: 0, tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0
  }
}

/**
 * 把一個桶子累進累加器。5 分鐘與 1 小時的快取寫入在 UI 上合成一項
 * （價錢在 `pricing.costOf` 已經各算各的，這裡只是顯示用）。
 * @param {object} item
 * @param {object} row
 * @returns {object}
 */
function addTotals(item, row) {
  const cacheWrite = (row.cacheWrite || 0) + (row.cacheWrite1h || 0)
  item.requests += row.requests || 0
  item.input += row.input || 0
  item.output += row.output || 0
  item.cacheRead += row.cacheRead || 0
  item.cacheWrite += cacheWrite
  item.tokens += (row.input || 0) + (row.output || 0) + (row.cacheRead || 0) + cacheWrite
  return item
}

/**
 * SQL 只會回「有資料的桶」，直接畫等於把 3 小時的量攤成整條時間軸。
 * 這裡照 `agy/logs.js` 的做法把中間的空格補零。
 *
 * @param {Array<object>} rows
 * @param {number} from
 * @param {number} to
 * @param {'hour'|'day'|'week'} bucket
 * @returns {Array<object>}
 */
function fillSeries(rows, from, to, bucket) {
  const step = bucket === 'hour' ? HOUR_MS : bucket === 'week' ? 7 * DAY_MS : DAY_MS
  // 週桶從週一開始：1970-01-01 是週四，往後 4 天才是第一個週一
  const base = bucket === 'week' ? 4 * DAY_MS : 0
  // 日／週桶要切在「當地」零點：直接取 DAY_MS 的整數倍是 UTC 零點，臺灣凌晨 0～8 點會算進前一天
  const slotOf = (ts) => {
    const offset = bucket === 'hour' ? 0 : new Date(ts).getTimezoneOffset() * 60_000
    return Math.floor((ts - offset - base) / step) * step + offset + base
  }
  const start = slotOf(from)
  const end = slotOf(to)
  const byTs = new Map()
  for (const row of rows) {
    const slot = slotOf(row.ts)
    const item = byTs.get(slot) || { ts: slot, ...emptyTotals() }
    addTotals(item, row)
    item.costUsd += row.costUsd || 0
    // 沒有單價的不是 0 元：記下來，浮動提示才不會寫成 $0
    if (row.costUsd === null) item.uncosted = true
    byTs.set(slot, item)
  }
  const out = []
  const points = Math.min(MAX_SERIES_POINTS, Math.floor((end - start) / step) + 1)
  const first = end - (points - 1) * step
  for (let ts = first; ts <= end; ts += step) {
    out.push(byTs.get(ts) || { ts, ...emptyTotals() })
  }
  return out
}

/**
 * 把桶子加上金額。**沒有單價又沒有來源花費的，`costUsd` 留 null 並記進
 * `uncostedModels`**——填 0 會讓總額少一截而且完全看不出來。
 *
 * @param {object} bucket
 * @param {Record<string, object>} custom
 * @returns {object}
 */
function withCost(bucket, custom) {
  if (Number.isFinite(bucket.reportedCost)) {
    return { ...bucket, costUsd: bucket.reportedCost, costSource: 'reported' }
  }
  const price = pricing.priceFor(bucket.model, custom)
  const cost = pricing.costOf(bucket, price)
  return {
    ...bucket,
    costUsd: cost,
    costSource: cost === null ? 'none' : 'estimated'
  }
}

/**
 * 統計。renderer 只送 range key，小時數與分桶格式由這裡決定。
 * @param {{ range?: string, provider?: string }} [query]
 * @returns {Promise<object>}
 */
let modelsDevPrices = null
/** 內建表沒有的模型用 models.dev 補；沒設 userData（測試）就不連網 */
function modelsDev() {
  if (!modelsDevPrices && paths.userDataPath) {
    modelsDevPrices = require('./models-dev').createModelsDev({
      file: path.join(paths.userDataPath, 'models-dev-prices.json'),
      normalize: pricing.normalizeModel
    })
    pricing.setFallbackPrice(modelsDevPrices.priceOf)
  }
  return modelsDevPrices
}

/**
 * `YYYY-MM-DD` → 當地零點；格式錯或日期不存在（2/30）回 NaN。
 * @param {unknown} text
 * @returns {number}
 */
function parseDay(text) {
  const match = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(text) : null
  if (!match) return NaN
  const [y, m, d] = match.slice(1).map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date.getTime() : NaN
}

/**
 * 範圍白名單＋自訂起訖日（含迄日當天）。自訂的格式不對就退回 7 天，不信任 renderer 給的數字。
 * @param {{ range?: string, from?: string, to?: string }} query
 * @returns {{ rangeKey: string, from: number, to: number, bucket: 'hour'|'day' }}
 */
function resolveRange(query) {
  const now = Date.now()
  if (query.range === 'custom') {
    const from = parseDay(query.from)
    const to = Math.min(now, parseDay(query.to) + DAY_MS)
    if (from < to) return { rangeKey: 'custom', from, to, bucket: to - from <= 2 * DAY_MS ? 'hour' : 'day' }
  }
  const rangeKey = Object.prototype.hasOwnProperty.call(STAT_RANGES, query.range) ? query.range : '7d'
  const range = STAT_RANGES[rangeKey]
  return { rangeKey, from: range.hours ? now - range.hours * HOUR_MS : 0, to: now, bucket: range.bucket }
}

async function stats(query = {}) {
  await modelsDev()?.ensure()
  const s = await getStore()
  const custom = pricing.sanitizeCustomPrices(s.get('customPrices', {}))
  const { rangeKey, from, to, bucket: rangeBucket } = resolveRange(query)

  const all = loadBuckets(s.get('buckets', []))
  const providerFilter = PROVIDERS.some((item) => item.key === query.provider)
    ? query.provider
    : ''

  const rows = [...all.values()]
    .filter((bucket) => bucket.ts >= from && bucket.ts < to && (!providerFilter || bucket.provider === providerFilter))
    .map((bucket) => withCost(bucket, custom))

  const summary = {
    requests: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite1h: 0,
    costUsd: 0,
    uncostedRequests: 0
  }
  const byModel = new Map()
  const byProvider = new Map()
  const uncosted = new Set()

  for (const row of rows) {
    summary.requests += row.requests
    summary.input += row.input
    summary.output += row.output
    summary.reasoning += row.reasoning
    summary.cacheRead += row.cacheRead
    summary.cacheWrite += row.cacheWrite
    summary.cacheWrite1h += row.cacheWrite1h
    if (row.costUsd === null) {
      summary.uncostedRequests += row.requests
      uncosted.add(row.model)
    } else {
      summary.costUsd += row.costUsd
    }

    for (const [map, key] of [[byModel, row.model], [byProvider, row.provider]]) {
      const item = map.get(key) || {
        key, ...emptyTotals(), uncosted: false,
        costParts: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
      addTotals(item, row)
      if (row.costUsd === null) item.uncosted = true
      else item.costUsd += row.costUsd
      if (row.costSource === 'estimated') {
        const parts = pricing.costParts(row, pricing.priceFor(row.model, custom))
        if (parts) {
          item.costParts.input += parts.input
          item.costParts.output += parts.output
          item.costParts.cacheRead += parts.cacheRead
          item.costParts.cacheWrite += parts.cacheWrite
        }
      }
      map.set(key, item)
    }
  }

  // 不用 Math.min(...rows)：「全部」的小時桶會多到超過參數上限
  const seriesFrom = from || rows.reduce((min, row) => Math.min(min, row.ts), to)
  // 「全部」超過圖表格數上限就改成一週一格，不然最早那段會被切掉
  const bucket = rangeBucket === 'day' && (to - seriesFrom) / DAY_MS >= MAX_SERIES_POINTS ? 'week' : rangeBucket
  const uncostedList = [...uncosted].sort()
  return {
    range: rangeKey,
    bucket,
    from: seriesFrom,
    to,
    syncedAt: Number(s.get('syncedAt', 0)) || 0,
    needsRescan: pricing.needsFullRescan(s.get('rulesVersion', 0)),
    summary,
    // 自訂範圍的 to 是隔天零點（不含），序列只畫到前一刻
    series: fillSeries(rows, seriesFrom, to - 1, bucket),
    models: [...byModel.values()].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_MODEL_ROWS),
    providers: PROVIDERS.map((item) => ({
      key: item.key,
      label: item.label,
      note: item.note || '',
      ...(byProvider.get(item.key) || { ...emptyTotals(), uncosted: false })
    })),
    uncostedModels: uncostedList,
    prices: pricing.priceList(custom, uncostedList)
  }
}

/**
 * 存使用者自訂單價。
 * @param {unknown} raw
 */
async function savePrices(raw) {
  const s = await getStore()
  const clean = pricing.sanitizeCustomPrices(raw)
  s.set('customPrices', clean)
  return pricing.priceList(clean)
}

/**
 * @param {Map<string, object>} buckets
 * @param {string} provider
 * @returns {number} 這家最早的桶子；沒有就 Infinity
 */
function earliestTs(buckets, provider) {
  let min = Infinity
  for (const bucket of buckets.values()) {
    if (bucket.provider === provider && bucket.ts < min) min = bucket.ts
  }
  return min
}

/**
 * 重新掃描：標成要整份重讀，下一次同步從頭讀。**桶子不清**——重讀時才知道哪段
 * 來源檔已經不在了，那段要靠舊桶子留著（`keepOrphans`）。
 */
async function reset() {
  const s = await getStore()
  s.set({ cursors: {}, dbCursors: {}, rulesVersion: 0 })
  return true
}

/**
 * 重讀後把「重讀不回來」的舊桶子併回去——只給**記帳之前**就被刪掉的檔用（之後刪的有 `archive`）。
 * 兩個條件都要成立才留舊的：
 * 1. 早於 `before[家]`（現存最舊來源檔的時間）——之後的時段來源檔都還在，重讀結果就是完整答案，
 *    沒資料就是真的沒有（或新規則刻意不算，例如 Grok 子代理），不能拿舊的補。
 * 2. 那一小時重讀後一筆都沒有——有新資料的小時以新的為準（舊的可能是舊規則算錯的）。
 * 模型名照新規則重新正規化。同一小時只剩部分檔案時，記帳前被刪的那部分推不回來（舊版沒有逐檔紀錄）。
 * @param {Map<string, object>} buckets 重讀結果，就地補進去
 * @param {Map<string, object>} previous 重讀前的桶子
 * @param {Record<string, number>} before 每家「這之前才可能缺檔」的時間；沒有的家＝沒有任何現存來源，全留
 */
function keepOrphans(buckets, previous, before) {
  const covered = new Set([...buckets.values()].map((bucket) => `${bucket.ts}|${bucket.provider}`))
  for (const old of previous.values()) {
    const limit = Object.prototype.hasOwnProperty.call(before, old.provider) ? before[old.provider] : Infinity
    // 桶子是整點起算：整個小時都在 limit 之前才算「可能缺檔」
    if (old.ts + HOUR_MS > limit || covered.has(`${old.ts}|${old.provider}`)) continue
    mergeBucket(buckets, old)
  }
}

/**
 * 把一個舊桶子併進表裡：模型名照新規則重新正規化，撞到同一格（兩個舊名正規化成同一個）就加總。
 * @param {Map<string, object>} buckets 就地併入
 * @param {object} old
 */
function mergeBucket(buckets, old) {
  const model = pricing.normalizeModel(old.model)
  if (pricing.isJunkModel(model)) return
  const longContext = old.longContext && Boolean(pricing.priceFor(model)?.longContext)
  const key = bucketKey(old.ts, old.provider, model, longContext)
  const into = buckets.get(key)
  if (!into) {
    buckets.set(key, { ...old, model, longContext })
    return
  }
  const merged = { ...into }
  for (const field of ['input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'requests']) {
    merged[field] = (into[field] || 0) + (old[field] || 0)
  }
  merged.reportedCost = into.reportedCost === null && old.reportedCost === null
    ? null
    : (into.reportedCost || 0) + (old.reportedCost || 0)
  buckets.set(key, merged)
}

module.exports = {
  PROVIDERS,
  STAT_RANGES,
  HOUR_MS,
  DAY_MS,
  configure,
  bucketKey,
  addEvent,
  loadBuckets,
  fillSeries,
  resolveRange,
  keepOrphans,
  archiveRemoved,
  grokCountChildren,
  withCost,
  sync,
  stats,
  savePrices,
  reset
}
