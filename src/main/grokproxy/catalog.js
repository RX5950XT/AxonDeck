'use strict'

const upstream = require('./upstream')

/**
 * Grok 模型型錄：上游 `/v1/models` 的解析與快取，加上「客戶端送來的名字 → 上游模型＋思考強度」。
 *
 * 上游每顆模型自帶 `reasoning_efforts`（xhigh／high／medium／low），Responses 用
 * `reasoning.effort` 選。很多客戶端只能填模型名，所以多開一組 `<模型>-<強度>` 的別名。
 */

const CACHE_TTL_MS = 10 * 60 * 1000
const DEFAULT_MODEL = 'grok-4.7'
const EFFORTS = Object.freeze(['xhigh', 'high', 'medium', 'low'])
const EFFORT_SUFFIX = /^(.+)-(xhigh|high|medium|low)$/

let cache = { at: 0, models: [], quota: null }

function reset() {
  cache = { at: 0, models: [], quota: null }
}

/**
 * @param {object} payload 上游 `/v1/models`
 * @returns {Array<{ id: string, name: string, description: string, contextWindow: number, efforts: string[], defaultEffort: string }>}
 */
function parseModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows
    .filter((row) => typeof row?.id === 'string' && row.id && (!row.api_backend || row.api_backend === 'responses'))
    .map((row) => {
      const efforts = (Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : [])
        .map((item) => String(item?.id || item?.value || ''))
        .filter((id) => EFFORTS.includes(id))
      const preferred = (Array.isArray(row.reasoning_efforts) ? row.reasoning_efforts : []).find((item) => item?.default)
      return {
        id: row.id,
        name: typeof row.name === 'string' ? row.name.slice(0, 80) : row.id,
        description: typeof row.description === 'string' ? row.description.slice(0, 200) : '',
        contextWindow: Number(row.context_window) > 0 ? Number(row.context_window) : 0,
        efforts,
        defaultEffort: String(preferred?.id || row.reasoning_effort || '')
      }
    })
}

/**
 * 每週額度：billing 的 creditUsagePercent 與這一期的結束時間。
 * @param {object} payload
 * @returns {{ usedPercent: number, resetAt: string } | null}
 */
function parseQuota(payload) {
  const config = payload?.config
  const used = Number(config?.creditUsagePercent)
  if (!Number.isFinite(used)) return null
  const end = String(config?.currentPeriod?.end || config?.billingPeriodEnd || '')
  return { usedPercent: Math.max(0, Math.min(100, used)), resetAt: Number.isFinite(Date.parse(end)) ? end : '' }
}

/**
 * @param {{ force?: boolean, options?: object, now?: () => number }} [params]
 * @returns {Promise<{ models: Array<object>, quota: object|null, cached: boolean, fetchedAt: number }>}
 */
async function list({ force = false, options = {}, now = Date.now } = {}) {
  const nowMs = now()
  if (!force && cache.at && nowMs - cache.at < CACHE_TTL_MS) {
    return { models: cache.models, quota: cache.quota, cached: true, fetchedAt: cache.at }
  }
  const signal = AbortSignal.timeout(30_000)
  const [models, quota] = await Promise.all([
    upstream.models({ signal, options }).then(parseModels),
    // 額度只是附帶資訊，查不到不能讓模型清單跟著失敗
    upstream.billing({ signal, options }).then(parseQuota).catch(() => null)
  ])
  cache = { at: nowMs, models, quota }
  return { models, quota, cached: false, fetchedAt: nowMs }
}

/** 給轉送用：有快取就用，沒有才查；查不到回空陣列（退回預設模型） */
async function snapshot({ options } = {}) {
  if (cache.at && Date.now() - cache.at < CACHE_TTL_MS) return cache.models
  try {
    return (await list({ options })).models
  } catch {
    return cache.models
  }
}

/**
 * 客戶端送來的名字 → 上游模型與思考強度。
 * - 型錄裡有的照用；`<模型>-<強度>` 拆開
 * - 其他 `grok-*` 原樣送（型錄可能還沒更新）
 * - 其餘（例如 Claude Code 沒設模型時送的 claude-*）換成預設模型
 * @param {unknown} raw
 * @param {Array<{ id: string }>} models
 * @returns {{ model: string, mapped: string, effort: string }}
 */
function resolveModel(raw, models) {
  const model = String(raw || '').replace(/\[1m\]$/i, '').trim()
  const known = new Set(models.map((item) => item.id))
  if (known.has(model)) return { model, mapped: model, effort: '' }
  const match = model.match(EFFORT_SUFFIX)
  if (match && (known.has(match[1]) || (!known.size && match[1].startsWith('grok-')))) {
    return { model, mapped: match[1], effort: match[2] }
  }
  if (/^grok-/i.test(model)) return { model, mapped: model, effort: '' }
  return { model, mapped: models[0]?.id || DEFAULT_MODEL, effort: '' }
}

/**
 * OpenAI `/v1/models` 形狀：本體加上各強度別名。
 * @param {{ options?: object }} [params]
 */
async function listForApi({ options } = {}) {
  const models = await snapshot({ options })
  const rows = models.length ? models : [{ id: DEFAULT_MODEL, efforts: EFFORTS }]
  return rows.flatMap((model) => [model.id, ...model.efforts.map((effort) => `${model.id}-${effort}`)])
    .map((id) => ({ id, object: 'model', created: 0, owned_by: 'xai' }))
}

module.exports = {
  CACHE_TTL_MS,
  DEFAULT_MODEL,
  list,
  listForApi,
  parseModels,
  parseQuota,
  reset,
  resolveModel,
  snapshot
}
