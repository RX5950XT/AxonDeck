#!/usr/bin/env node
/**
 * models.dev 補單價（`src/main/codeusage/models-dev.js`）：只收原廠、只補不蓋、快取存讀。
 */

'use strict'

const path = require('path')
const { tempDir, removeTree } = require('./lib/test-temp')
const ROOT = path.join(__dirname, '..')
const { extractPrices, createModelsDev } = require(path.join(ROOT, 'src/main/codeusage/models-dev.js'))
const pricing = require(path.join(ROOT, 'src/main/codeusage/pricing.js'))

let passed = 0
let failed = 0
function ok(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

const api = {
  somerelay: { models: { 'kimi-k9': { cost: { input: 99, output: 99 } } } },
  moonshotai: { models: { 'kimi-k9': { cost: { input: 1, output: 4, cache_read: 0.2 } } } },
  anthropic: { models: { 'claude-new-9-1-20270101': { cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } } } },
  openai: { models: { 'free-thing': { cost: { input: 0, output: 0 } }, 'gpt-x': { cost: { input: 'x', output: 1 } } } }
}
const prices = extractPrices(api, pricing.normalizeModel)
ok('只收原廠：轉售商的價不算', prices['kimi-k9']?.input === 1)
ok('非 Anthropic 沒給寫入價 → 0，1 小時同價', prices['kimi-k9'].cacheWrite === 0 && prices['kimi-k9'].cacheWrite1h === 0)
ok('Anthropic id 照內建規則正規化（去日期、4-5 → 4.5）', prices['claude-new-9.1']?.cacheWrite === 3.75 && prices['claude-new-9.1'].cacheWrite1h === undefined)
ok('免費／壞資料不收', !prices['free-thing'] && !prices['gpt-x'])

async function main() {
  const dir = tempDir('axondeck-models-dev-')
  try {
    let calls = 0
    const fetchImpl = async () => { calls++; return { ok: true, json: async () => api } }
    let clock = Date.UTC(2026, 9, 17)
    const file = path.join(dir, 'models-dev-prices.json')
    const dev = createModelsDev({ file, normalize: pricing.normalizeModel, fetchImpl, now: () => clock })
    await dev.ensure()
    await new Promise((r) => setTimeout(r, 50))
    ok('第一次背景抓、存檔', calls === 1 && dev.priceOf('kimi-k9')?.output === 4)
    pricing.setFallbackPrice(dev.priceOf)
    ok('內建表有的不被蓋', pricing.priceFor('gpt-6-luna').input === 0.1)
    ok('內建表沒有的補上', pricing.priceFor('kimi-k9').input === 1)
    ok('自訂仍最優先', pricing.priceFor('kimi-k9', { 'kimi-k9': { input: 7, output: 7 } }).input === 7)
    clock += 3600_000
    await dev.ensure()
    ok('一天內不重抓', calls === 1)
    const reopened = createModelsDev({ file, normalize: pricing.normalizeModel, fetchImpl: async () => { throw new Error('offline') }, now: () => clock })
    await reopened.ensure()
    ok('重開從快取讀', reopened.priceOf('kimi-k9')?.input === 1)
  } finally {
    pricing.setFallbackPrice(null)
    removeTree(dir)
  }
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main()
