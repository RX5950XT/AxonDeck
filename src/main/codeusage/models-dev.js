'use strict'

/**
 * 內建單價表沒有的模型，用 models.dev 的公開報價補（參考 magpie 用 models.dev 補模型資訊）。
 *
 * 優先序：使用者自訂 → 內建表（人工查證過）→ 這裡。**只補不蓋**，而且只收原廠那一家的價：
 * 同一顆模型在 models.dev 會掛在幾十家轉售商底下，價錢各不相同，拿錯一家就差好幾倍。
 * 一天最多抓一次（整包約 6MB），只把原廠模型的單價存一份小檔在 userData。
 */

const fsp = require('fs').promises
const path = require('path')

const API_URL = 'https://models.dev/api.json'
const REFRESH_MS = 24 * 3600_000
const FETCH_TIMEOUT_MS = 30_000
/** 原廠（models.dev 的 provider id）；轉售商一律不收 */
const FIRST_PARTY = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'zhipuai', 'alibaba', 'mistral', 'minimax']

const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)

/**
 * models.dev 的 api.json → `{ 正規化 id: Price }`。
 * 沒給快取寫入價的當成不收（只有 Anthropic 系列收寫入費，其他家寫 0 才不會被推成 ×1.25）。
 * @param {unknown} api
 * @param {(id: string) => string} normalize `pricing.normalizeModel`
 */
function extractPrices(api, normalize) {
  const out = {}
  for (const provider of FIRST_PARTY) {
    const models = api?.[provider]?.models
    if (!models || typeof models !== 'object') continue
    for (const [rawId, model] of Object.entries(models)) {
      const cost = model?.cost
      const input = num(cost?.input)
      const output = num(cost?.output)
      if (input === undefined || output === undefined || input + output === 0) continue
      const id = normalize(rawId)
      if (!id || id === 'unknown' || out[id]) continue
      const cacheWrite = num(cost.cache_write) ?? 0
      out[id] = {
        input,
        output,
        ...(num(cost.cache_read) !== undefined ? { cacheRead: num(cost.cache_read) } : {}),
        cacheWrite,
        // Anthropic 的 1 小時快取是 5 分鐘的 1.6 倍（交給 costParts 推）；其他家沒有兩檔
        ...(provider === 'anthropic' ? {} : { cacheWrite1h: cacheWrite })
      }
    }
  }
  return out
}

/**
 * @param {{ file: string, normalize: (id: string) => string, fetchImpl?: typeof fetch, now?: () => number }} deps
 */
function createModelsDev({ file, normalize, fetchImpl = fetch, now = Date.now }) {
  let prices = {}
  let fetchedAt = 0
  let loaded = null
  let refreshing = null

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'))
      if (raw && typeof raw.prices === 'object') prices = raw.prices
      fetchedAt = Number(raw?.fetchedAt) || 0
    } catch { /* 第一次用或檔案壞了：等下次抓 */ }
  }

  async function refresh() {
    const res = await fetchImpl(API_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw Object.assign(new Error('MODELS_DEV_HTTP'), { status: res.status })
    const next = extractPrices(await res.json(), normalize)
    if (!Object.keys(next).length) throw new Error('MODELS_DEV_EMPTY')
    prices = next
    fetchedAt = now()
    await fsp.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify({ fetchedAt, prices }), 'utf8')
    await fsp.rename(tmp, file)
  }

  return {
    /** 讀快取，過期就背景重抓（不擋查詢；抓到之後下一次查詢就有價） */
    async ensure() {
      loaded ||= load()
      await loaded
      if (refreshing || now() - fetchedAt < REFRESH_MS) return
      refreshing = refresh()
        .catch((error) => console.warn(`[models.dev] refresh failed: ${error.status ? `HTTP ${error.status}` : error.code || error.name}`))
        .finally(() => { refreshing = null })
    },
    priceOf: (model) => prices[model] || null
  }
}

module.exports = { createModelsDev, extractPrices, FIRST_PARTY }
