'use strict'

/**
 * 翻譯前先請雲端模型從整份文件抽出術語、定好譯名，每一批翻譯都帶上，
 * 同一份論文的人名、方法名前後譯法才會一致。只有雲端用：本地小模型吐不出可靠的 JSON。
 */

const glossary = require('../glossary')
const { readResponseText } = require('../usage/shared')

const CHUNK_CHARS = 10000
const MAX_CHUNKS = 3
const MAX_TERMS = 300
const TIMEOUT_MS = 120000
const LANGUAGES = { 'zh-TW': '臺灣繁體中文', 'zh-CN': '簡體中文', en: '英文', ja: '日文', ko: '韓文' }

function prompt(text, targetLang, reference) {
  const known = reference.length
    ? `\n下列參考譯名有出現就照用：\n${reference.map((term) => `${term.source} → ${term.targets[0]}`).join('\n')}\n` : ''
  return `從下面的文件內容找出關鍵術語，翻成${LANGUAGES[targetLang]}。
- 只收專有名詞（人名、機構、地名、定理／演算法／方法名稱）和這個領域專用的名詞片語；不收整句、虛詞，也不收 model、case 這類泛用詞。
- 不收數學變數、符號、公式片段。
- 每個詞只列一次，依第一次出現的順序；片語最多 5 個字。
- 譯名依這份文件的領域與上下文決定，不是字典上最常見的意思；拿不準的詞不要列。
- 人名、產品名沒有通行譯名就保留原文。${known}
只回 JSON 陣列，例如 [{"src":"Transformer","tgt":"Transformer"}]；沒有就回 []。不要其他文字。

<document>
${text}
</document>`
}

/** 模型回的 JSON：只留原文真的出現過、不含換行與「=」的詞（「=」是術語表的分隔符） */
function parseTerms(output, text) {
  const start = output.indexOf('['), end = output.lastIndexOf(']')
  if (start < 0 || end <= start) return []
  let value
  try { value = JSON.parse(output.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(value)) return []
  const lower = text.toLowerCase()
  const valid = (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= 100 && !/[=\r\n]/.test(item)
  return value.filter((item) => valid(item?.src) && valid(item?.tgt) && lower.includes(item.src.trim().toLowerCase()))
    .map((item) => ({ src: item.src.trim(), tgt: item.tgt.trim() }))
}

async function ask(cloud, content, signal) {
  const response = await fetch(`${cloud.apiUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cloud.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cloud.modelId, temperature: 0, reasoning: { exclude: true },
      messages: [{ role: 'user', content }] }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
  })
  const body = await readResponseText(response, 4 * 1024 * 1024)
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status })
  const answer = JSON.parse(body)?.choices?.[0]?.message?.content
  return typeof answer === 'string' ? answer : ''
}

/**
 * @param {{ cloud: object, store: object, targetLang: string, signal: AbortSignal, cached: (key: string[], make: () => Promise<string>) => Promise<string> }} options
 * @returns {Promise<{ entries: ReturnType<typeof glossary.parse>, terms: { src: string, tgt: string }[] }>}
 */
async function extract(sample, options) {
  const chunks = []
  for (let at = 0; at < sample.length && chunks.length < MAX_CHUNKS; at += CHUNK_CHARS) chunks.push(sample.slice(at, at + CHUNK_CHARS))
  // 只參考使用者自訂詞條：內建詞庫是跨學科的通用譯名（order information→訂單資訊），會把模型帶偏
  const rules = options.targetLang === 'zh-TW' ? { ...glossary.load(options.store), builtin: false } : null
  const results = await Promise.all(chunks.map(async (chunk) => {
    const content = prompt(chunk, options.targetLang, glossary.find(rules, chunk))
    try {
      return parseTerms(await options.cached(['terms', content], () => ask(options.cloud, content, options.signal)), chunk)
    } catch (error) {
      options.signal.throwIfAborted()
      // 抽不到術語照樣翻，只是少了一致的譯名；上游訊息不進 log
      console.error(`[pdf-translate] 術語抽取失敗${error?.status ? `: HTTP ${error.status}` : ''}`)
      return []
    }
  }))
  const seen = new Set()
  const terms = results.flat().filter((term) => !seen.has(term.src.toLowerCase()) && seen.add(term.src.toLowerCase())).slice(0, MAX_TERMS)
  return { terms, entries: glossary.parse(terms.map((term) => `${term.src}=${term.tgt}`).join('\n')) }
}

module.exports = { extract, parseTerms }
