'use strict'

/**
 * 客戶端 model → cloudcode-pa 實際 model。
 *
 * 上游只認得少數幾個真實 ID，但 Claude Code CLI 之類的工具會送死的模型名
 * （claude-sonnet-4-5-20250929），不映射就直接 400。
 * 策略：精確表 → 前綴規則 → 原樣透傳（讓使用者能試沒公開的模型）。
 */

/** 上游實際存在的模型；也是 /v1/models 回傳的清單 */
const UPSTREAM_MODELS = Object.freeze([
  // 取自上游 fetchAvailableModels（只留對話可用、未淘汰的），不是手寫的。
  // 這份會過期——`npx electron scripts/probe-agy-upstream.js` 會列出當下的真相。
  'gemini-3.7-flash-high',
  'gemini-3.7-flash-medium',
  'gemini-3.7-flash-low',
  'gemini-3.7-flash-tiered',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-tiered',
  'gemini-3.5-flash-low',
  'gemini-3.5-flash-extra-low',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-low',
  'gemini-3-flash',
  'gemini-3-flash-agent',
  'gemini-pro-agent',
  'gemini-2.5-flash',
  'gemini-2.5-flash-thinking',
  'gemini-2.5-flash-lite',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium'
])


/**
 * 未知模型的退路，必須是實測 200 的模型。
 * 原本是 gemini-3-pro-preview，但它回 404 Requested entity was not found，
 * 等於「不認得的模型一律掛掉」。（驗證：scripts/probe-agy-upstream.js）
 */
const DEFAULT_MODEL = 'gemini-3.7-flash-medium'

/** 精確映射（移植自 Antigravity-Manager 的 model_mapping.rs） */
const EXACT_MAP = Object.freeze({
  // Claude Sonnet
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  // claude-sonnet-4-6-thinking 上游回 404（sandbox／daily 皆然），一律導到非 thinking 版；
  // claude-opus-4-6-thinking 則實測可用，保留。
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4-6',
  'claude-sonnet-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022': 'claude-sonnet-4-6',
  'claude-3-5-sonnet-20240620': 'claude-sonnet-4-6',
  // Claude Opus
  'claude-opus-4': 'claude-opus-4-6-thinking',
  'claude-opus-4-5': 'claude-opus-4-6-thinking',
  'claude-opus-4-5-thinking': 'claude-opus-4-6-thinking',
  'claude-opus-4-5-20251101': 'claude-opus-4-6-thinking',
  'claude-opus-4-6': 'claude-opus-4-6-thinking',
  'claude-opus-4-6-thinking': 'claude-opus-4-6-thinking',
  // Claude Haiku（上游沒有對應的小模型，一律走 Sonnet）
  'claude-haiku-4': 'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001': 'claude-sonnet-4-6',
  'claude-3-haiku-20240307': 'claude-sonnet-4-6',
  // Gemini
  // pro 級一律導到 gemini-pro-agent：*-pro-preview 兩個都回 404、gemini-3-pro-low 回 500，
  // 實測只有 gemini-pro-agent／gemini-3.1-pro-low／gemini-3-flash 這三個能用。
  // （模型可用性隨帳號方案而異，這裡以 Google AI Pro 實測為準）
  'gemini-3.1-pro': 'gemini-pro-agent',
  'gemini-3.1-pro-high': 'gemini-pro-agent',
  'gemini-3-pro': 'gemini-pro-agent',
  'gemini-3-pro-high': 'gemini-pro-agent',
  // gemini-3.1-flash 上游沒有這個 id（只有 -lite），導到最新世代的 flash。
  // 注意不要把 gemini-3-flash 寫進來：它是真實存在的上游模型，
  // 使用者明確指名時就該用它，映射表只負責翻譯「上游沒有的名字」。
  'gemini-3.1-flash': 'gemini-3.7-flash-medium'
})

/**
 * 前綴規則，第一個命中就用。
 * 順序有意義：長前綴要排在短前綴之前（`gemini-2.5-flash` 必須先於 `gemini-2.5`）。
 */
const PREFIX_RULES = Object.freeze([
  ['claude-3-5-sonnet', 'claude-sonnet-4-6'],
  ['claude-3-7-sonnet', 'claude-sonnet-4-6'],
  ['claude-sonnet', 'claude-sonnet-4-6'],
  ['claude-opus', 'claude-opus-4-6-thinking'],
  ['claude-haiku', 'claude-sonnet-4-6'],
  ['claude-3', 'claude-sonnet-4-6'],
  ['gemini-1.5-flash', 'gemini-3.7-flash-medium'],
  ['gemini-2.0-flash', 'gemini-3.7-flash-medium'],
  ['gemini-2.5-flash', 'gemini-3.7-flash-medium'],
  ['gemini-1.5-pro', 'gemini-pro-agent'],
  ['gemini-2.0-pro', 'gemini-pro-agent'],
  ['gemini-2.5-pro', 'gemini-pro-agent'],
  ['gpt-5', 'gemini-pro-agent'],
  ['gpt-4', 'gemini-pro-agent'],
  ['gpt-3.5', 'gemini-3.7-flash-low'],
  ['o1', 'gemini-pro-agent'],
  ['o3', 'gemini-pro-agent'],
  ['o4', 'gemini-pro-agent']
])

/** 上游會拒絕的字元；擋掉路徑穿越與 header 注入 */
const SAFE_MODEL = /^[A-Za-z0-9._:@\/-]{1,120}$/

const CLAUDE_FAMILY = /(opus|sonnet|haiku)/

/**
 * Claude 名字裡的家族與世代。`claude-opus-5-5`、`claude-opus-4-6-thinking`、
 * `claude-3-5-sonnet-20241022` 都要認得；8 位數日期不算世代。
 * @param {string} id
 * @returns {{ family: string, version: number[] } | null}
 */
function claudeShape(id) {
  const lower = id.toLowerCase()
  const family = CLAUDE_FAMILY.exec(lower)?.[1]
  if (!lower.startsWith('claude-') || !family) return null
  const version = lower.replace(/-\d{8}\b/, '').match(/\d+/g)?.map(Number) || []
  return { family, version }
}

function compareVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0)
  }
  return 0
}

/**
 * 在即時型錄裡挑 Claude：同家族同世代優先，沒有就同家族最新；Haiku 上游沒有就退 Sonnet、
 * 沒有 Opus 也退 Sonnet。靜態表寫死 `claude-opus-4-6-thinking`，帳號已經換成新世代的人
 * 會被導回舊模型報錯——型錄才知道這個帳號現在有什麼。
 * @param {string} model
 * @param {Array<{ id: string }>} usable
 * @returns {string}
 */
function pickClaude(model, usable) {
  const want = claudeShape(model)
  if (!want) return ''
  const rows = usable.map((row) => ({ id: row.id, shape: claudeShape(row.id) })).filter((row) => row.shape)
  const order = want.family === 'sonnet' ? ['sonnet', 'opus'] : [want.family, 'sonnet', 'opus']
  const thinking = model.toLowerCase().endsWith('-thinking')
  for (const family of order) {
    const same = rows.filter((row) => row.shape.family === family)
    if (!same.length) continue
    const newest = same.reduce((best, row) => (compareVersion(row.shape.version, best) > 0 ? row.shape.version : best), [])
    const target = same.some((row) => compareVersion(row.shape.version, want.version) === 0) ? want.version : newest
    const pool = same.filter((row) => compareVersion(row.shape.version, target) === 0)
    return (pool.find((row) => row.id.endsWith('-thinking') === thinking) || pool[0]).id
  }
  return ''
}

/**
 * @param {unknown} raw 客戶端送來的 model
 * @param {Array<{ id: string, chatCapable?: boolean, deprecated?: boolean, replacedBy?: string }> | null} [live]
 *   即時型錄（`catalog.parseCatalog` 的 models）；拿不到時給 null，退回靜態表
 * @returns {{ model: string, mapped: string, known: boolean }}
 *   model 是清洗後的原始名稱，mapped 是實際要送上游的名稱
 */
function resolveModel(raw, live = null) {
  // Claude Code 的 1M 宣告後綴（`[1m]`），上游不認得，SAFE_MODEL 也不收中括號
  const model = typeof raw === 'string' ? raw.trim().replace(/\[1m\]$/i, '') : ''
  // `/` 要放行（google/gemini-3-flash 這種 OpenRouter 風格是合法的），但 `..` 沒有正當用途
  if (!model || !SAFE_MODEL.test(model) || model.includes('..')) {
    return { model, mapped: DEFAULT_MODEL, known: false }
  }

  if (Array.isArray(live) && live.length) {
    const usable = live.filter((row) => row && row.chatCapable !== false && !row.deprecated)
    const hit = live.find((row) => row?.id === model)
    if (hit && !hit.deprecated) return { model, mapped: hit.id, known: true }
    if (hit?.replacedBy) return { model, mapped: hit.replacedBy, known: true }
    const claude = pickClaude(model, usable)
    if (claude) return { model, mapped: claude, known: true }
  }

  const exact = EXACT_MAP[model]
  if (exact) return { model, mapped: exact, known: true }

  if (UPSTREAM_MODELS.includes(model)) return { model, mapped: model, known: true }

  const lower = model.toLowerCase()
  for (const [prefix, target] of PREFIX_RULES) {
    if (lower.startsWith(prefix)) return { model, mapped: target, known: true }
  }

  // 表外的名字原樣透傳：使用者可能想試上游剛上線、我們還沒收錄的模型
  return { model, mapped: model, known: false }
}

/**
 * `/v1/models`（OpenAI）與 `/v1/models/claude`（Anthropic）共用的清單。
 * @param {number} nowMs
 */
function listModels(nowMs = Date.now()) {
  const created = Math.floor(nowMs / 1000)
  return UPSTREAM_MODELS.map((id) => ({
    id,
    object: 'model',
    created,
    owned_by: 'antigravity'
  }))
}

/** 帶 thinking 的模型要開思考預算，其餘關掉省 token */
function supportsThinking(mapped) {
  return typeof mapped === 'string' && (
    mapped.endsWith('-thinking') ||
    mapped.startsWith('gemini-3') ||
    mapped === 'gemini-pro-agent'
  )
}

/**
 * 拒絕 `thinkingBudget: 0` 的模型。
 *
 * 名稱刻意不叫「只能思考的模型」：gemini-3.6-flash 系列照樣能關思考
 * （`includeThoughts: false` 可用），它只是不接受把預算設成 0。
 *
 * 上游對這件事的錯誤訊息還不只一種——
 *   gemini-pro-agent／3.1-pro-low → 400 "Budget 0 is invalid. This model only works in thinking mode."
 *   gemini-3.6-flash-*／gpt-oss   → 400 "Request contains an invalid argument."
 * 後者看起來像請求整個壞掉，很容易被誤判成模型不可用（實測踩過）。
 *
 * 一律以實測為準，不要照模型名猜：claude-opus-4-6-thinking 名字有 thinking，
 * 但它接受 budget 0。名單維護方式見 `scripts/probe-agy-upstream.js`。
 */
const REJECTS_ZERO_BUDGET = Object.freeze(new Set([
  'gemini-pro-agent',
  'gemini-3-pro-low',
  'gemini-3.1-pro-low',
  'gemini-3.6-flash-high',
  'gemini-3.6-flash-medium',
  'gemini-3.6-flash-low',
  'gemini-3.6-flash-tiered',
  'gpt-oss-120b-medium'
]))

/** 能不能對這個模型送 thinkingBudget: 0（送得成就能省下 thinking token） */
function allowsZeroThinkingBudget(mapped) {
  return !REJECTS_ZERO_BUDGET.has(String(mapped || '').trim())
}

module.exports = {
  allowsZeroThinkingBudget,
  REJECTS_ZERO_BUDGET,
  DEFAULT_MODEL,
  UPSTREAM_MODELS,
  listModels,
  resolveModel,
  supportsThinking
}
