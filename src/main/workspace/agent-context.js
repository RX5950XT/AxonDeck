'use strict'

/**
 * 終端機分頁旁的「上下文用了多少」（參考 t3code `contextWindow.ts`）：只讀記錄檔尾巴的最後一筆用量。
 *
 * - Codex：`token_count` 事件的 `last_token_usage.total_tokens`／`model_context_window`（記錄自己給上限）。
 * - Claude：最後一則主對話 assistant 的 usage（輸入＋快取讀寫＋輸出）。記錄沒有上限，**不拿模型名稱猜**，
 *   只回用量。
 */

const fsp = require('../raw-fs').promises
const agents = require('./agents')

/** 一輪的用量一定在尾巴這麼多位元組內（Codex 一筆 token_count 不到 1KB，Claude 一則回答可能很長） */
const TAIL_BYTES = 512 * 1024
/** `agent:id:cwd` → 記錄檔。Codex 找檔要掃整個 sessions 目錄，不能每輪都找一次。 */
const fileCache = new Map()

/**
 * @param {'claude' | 'codex'} agent
 * @param {string} text 記錄檔尾巴（第一行可能被切掉一半）
 * @returns {{ used: number, max: number | null } | null}
 */
function parseContextTail(agent, text) {
  const lines = String(text || '').split('\n')
  const marker = agent === 'codex' ? '"token_count"' : '"usage"'
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(marker)) continue
    let row
    try { row = JSON.parse(lines[i]) } catch { continue }
    const hit = agent === 'codex' ? codexUsage(row) : claudeUsage(row)
    if (hit) return hit
  }
  return null
}

function codexUsage(row) {
  const info = row?.payload?.type === 'token_count' ? row.payload.info : null
  const used = Number(info?.last_token_usage?.total_tokens)
  if (!Number.isFinite(used) || used <= 0) return null
  const max = Number(info.model_context_window)
  return { used, max: Number.isFinite(max) && max > 0 ? max : null }
}

function claudeUsage(row) {
  if (row?.type !== 'assistant' || row.isSidechain) return null
  const u = row.message?.usage
  const used = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
    .reduce((sum, key) => sum + (Number(u?.[key]) || 0), 0)
  return used > 0 ? { used, max: null } : null
}

async function readTail(file) {
  const handle = await fsp.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const start = Math.max(0, size - TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    await handle.read(buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * @param {string} projectPath
 * @param {string} agent
 * @param {string} sessionId
 * @returns {Promise<{ used: number, max: number | null } | null>}
 */
async function contextUsage(projectPath, agent, sessionId) {
  if (agent !== 'claude' && agent !== 'codex') return null
  const key = `${agent}:${sessionId}:${projectPath}`
  for (const fresh of [false, true]) {
    let file = fresh ? '' : fileCache.get(key)
    if (!file) {
      file = (await agents.findSessionFile(projectPath, agent, sessionId)).file
      fileCache.set(key, file)
    }
    try {
      return parseContextTail(agent, await readTail(file))
    } catch (error) {
      // 記錄被搬進 archived_sessions 之類：清快取重找一次
      fileCache.delete(key)
      if (fresh || error?.code !== 'ENOENT') throw error
    }
  }
  return null
}

module.exports = { contextUsage, parseContextTail }
