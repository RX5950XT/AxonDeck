'use strict'

/**
 * 額度提醒（參考 magpie `provider/quota_alert.go` 的 reset reminder）：
 * - 週／月窗口再 `LEAD_MS` 內就重置、但還有一大截沒用（用量 < `UNDER_PERCENT`）→「記得用掉」
 * - Codex 重置次數快過期 →「N 次重置將於幾點過期」
 * 每一次窗口只講一次：記號存「這一輪的重置時間」，讀到的重置時間跟記號差不到 `SAME_RUN_MS` 就是同一輪
 * （Codex 的重置時間是「現在＋剩幾秒」，每次讀都會飄一點）。
 */

const { PROVIDER_META } = require('./constants')

const LEAD_MS = 6 * 3600_000
const UNDER_PERCENT = 85
const SAME_RUN_MS = 10 * 60_000
/** 讀不到的帳號（登出、換帳號）記號留多久 */
const KEEP_MS = 40 * 24 * 3600_000
const LONG_KINDS = new Set(['weekly', 'monthly'])

/** @param {number} ms @param {number} nowMs */
function clock(ms, nowMs) {
  const at = new Date(ms)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  return new Date(nowMs).toDateString() === at.toDateString() ? `今天 ${time}` : `${at.getMonth() + 1}/${at.getDate()} ${time}`
}

/**
 * 某一張卡（或 Claude 多帳號的某一個帳號）底下要講的話。
 * @returns {Array<{ key: string, until: number, title: string, body: string }>}
 */
function cardAlerts(provider, who, windows, resetCredits, nowMs) {
  const name = PROVIDER_META[provider]?.label || provider
  const title = who ? `${name}（${who}）` : name
  const out = []
  for (const w of windows || []) {
    if (!LONG_KINDS.has(w.kind) || !(w.limit > 0)) continue
    const used = (w.used / w.limit) * 100
    const until = Date.parse(w.resetAt)
    if (!Number.isFinite(until) || until <= nowMs || until - nowMs > LEAD_MS || used >= UNDER_PERCENT) continue
    const span = w.kind === 'weekly' ? '每週' : '每月'
    out.push({
      key: `${provider}|${who}|${w.id}`,
      until,
      title: `${title}額度快重置了`,
      body: `${w.label ? `${w.label} ` : ''}${span}額度還剩 ${Math.round(100 - used)}%，${clock(until, nowMs)} 重置，記得用掉`
    })
  }
  const expiring = (resetCredits?.credits || []).map((c) => Date.parse(c.expiresAt))
    .filter((ms) => Number.isFinite(ms) && ms > nowMs && ms - nowMs <= LEAD_MS)
  if (expiring.length) {
    const until = Math.min(...expiring)
    out.push({
      key: `${provider}|${who}|reset-credits`,
      until,
      title: `${title}重置次數快過期了`,
      body: `${expiring.length} 次重置還沒用，最早 ${clock(until, nowMs)} 過期`
    })
  }
  return out
}

/**
 * @param {Array<object>} accounts `usage` 狀態裡的 accounts
 * @param {Record<string, { at: number, until: number }>} marks 講過的記號（不改它，回傳新的一份）
 * @param {number} nowMs
 * @returns {{ alerts: Array<{ title: string, body: string }>, marks: Record<string, { at: number, until: number }> }}
 */
function dueReminders(accounts, marks, nowMs) {
  const next = Object.fromEntries(Object.entries(marks || {}).filter(([, m]) => nowMs - (m?.at || 0) < KEEP_MS))
  const alerts = []
  for (const account of accounts || []) {
    const cards = account.profiles?.length
      ? account.profiles.map((p) => ({ who: p.email || p.id, windows: p.windows }))
      : [{ who: '', windows: account.windows }]
    // 重置次數只掛在整張卡上（Codex 沒有多帳號）
    cards[0].resetCredits = account.resetCredits
    for (const card of cards) {
      for (const alert of cardAlerts(account.provider, card.who, card.windows, card.resetCredits, nowMs)) {
        const old = next[alert.key]
        if (old && Math.abs(old.until - alert.until) < SAME_RUN_MS) continue
        next[alert.key] = { at: nowMs, until: alert.until }
        alerts.push({ title: alert.title, body: alert.body })
      }
    }
  }
  return { alerts, marks: next }
}

module.exports = { dueReminders, LEAD_MS, UNDER_PERCENT }
