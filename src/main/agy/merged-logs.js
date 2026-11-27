'use strict'

/**
 * 反代頁的日誌與統計：Antigravity 與 Grok 共用一個服務，但日誌各存一份 SQLite
 * （`agy-logs.db` 是用量統計的 Antigravity 來源，混進 Grok 會算錯家），畫面上合起來看。
 */

const MAX_MODEL_ROWS = 8

/**
 * 兩份 `list()` 結果依時間合併，取最新的 `limit` 筆。
 * @param {{ logs: object[], total: number }} a
 * @param {{ logs: object[], total: number }} b
 * @param {number} limit
 */
function mergeLogs(a, b, limit) {
  const logs = [...a.logs, ...b.logs].sort((x, y) => y.ts - x.ts).slice(0, limit)
  return { logs, total: (a.total || 0) + (b.total || 0) }
}

/**
 * 兩份 `stats()` 結果相加。序列依桶的 period 對齊（兩邊都是本機時區、同一種分桶），
 * 「全部」範圍兩邊起點不同時取聯集。
 * @param {object} a
 * @param {object} b
 */
function mergeStats(a, b) {
  const summary = { ...a.summary }
  for (const [key, value] of Object.entries(b.summary || {})) summary[key] = (Number(summary[key]) || 0) + (Number(value) || 0)

  const byPeriod = new Map()
  for (const row of [...a.series, ...b.series]) {
    const into = byPeriod.get(row.period)
    byPeriod.set(row.period, into
      ? { ...into, requests: into.requests + row.requests, tokens: into.tokens + row.tokens }
      : { ...row })
  }
  const series = [...byPeriod.values()].sort((x, y) => x.start - y.start)

  const models = [...a.models, ...b.models].sort((x, y) => y.requests - x.requests).slice(0, MAX_MODEL_ROWS)
  return { ...a, from: Math.min(a.from, b.from), to: Math.max(a.to, b.to), summary, series, models }
}

module.exports = { mergeLogs, mergeStats }
