'use strict'

/**
 * node scripts/probe-pdf-terms.js — 用使用者設定的雲端翻譯模型打真流量：
 * 抽術語（JSON 能不能解析、譯名合不合理），再帶標題＋術語翻一段，看譯名有沒有被採用。
 * 只送下面這段測試文字，不讀使用者文件。
 */

const path = require('path')
const os = require('os')
const fs = require('fs')
const terms = require('../src/main/pdf-translate/terms')
const llm = require('../src/main/local-llm')

const SAMPLE = `Attention Is All You Need
The Transformer replaces recurrent layers with multi-head self-attention. We train the Transformer
on the WMT 2014 English-German dataset and compare against ByteNet and ConvS2S. Positional encoding
injects order information, and label smoothing improves BLEU while hurting perplexity.`

async function main() {
  const config = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || os.homedir(), 'voiceink', 'config.json'), 'utf8'))
  const store = { get: (key, fallback) => config[key] ?? fallback }
  const cloud = require('../src/main/model-scope').readLlm(store, 'file')
  if (cloud.mode !== 'cloud') throw new Error(`翻譯模型不是雲端（${cloud.mode}），這支 probe 只測雲端`)
  console.log(`model ${cloud.modelId} @ ${new URL(cloud.apiUrl).host}`)
  const started = Date.now()
  const found = await terms.extract(SAMPLE, { cloud, store, targetLang: 'zh-TW', signal: new AbortController().signal,
    cached: (_key, make) => make() })
  console.log(`terms ${found.terms.length} (${Date.now() - started} ms)`, found.terms)
  if (!found.terms.some((term) => term.src === 'Transformer' || term.src === 'multi-head self-attention')) {
    throw new Error('沒抽到明顯的術語')
  }
  llm.setStore(store)
  const text = 'The Transformer uses multi-head self-attention, and positional encoding injects order information.'
  const output = await llm.translate(store, text, 'zh-TW', { mode: 'file', scope: 'file', reference: SAMPLE,
    title: 'Attention Is All You Need', docTerms: found.entries })
  console.log('translation', output)
  const used = found.terms.filter((term) => text.toLowerCase().includes(term.src.toLowerCase()) && output.includes(term.tgt))
  console.log(`譯名採用 ${used.length} 個：`, used.map((term) => `${term.src}→${term.tgt}`).join('、'))
  // 內建詞庫對 order information 只有「訂單資訊」；抽術語不參考內建詞庫，不能把它抄進文件術語
  if (found.terms.some((term) => term.tgt.includes('訂單'))) throw new Error('文件術語抄進了內建詞庫的通用譯名')
  // 內建詞庫只當參考：不合上下文的「訂單資訊」不能被硬套
  if (output.includes('訂單')) throw new Error('內建詞庫的單一學科譯名蓋過了上下文')
  // 一般翻譯頁（沒有 PDF 文件術語）也一樣
  const plain = await llm.translate(store, 'Positional encoding injects order information into the sequence model.', 'zh-TW', { mode: 'file', scope: 'file' })
  console.log('plain', plain)
  if (plain.includes('訂單')) throw new Error('一般翻譯仍被內建詞庫帶偏')
}

main().catch((error) => { console.error('FAIL', error.message); process.exitCode = 1 })
