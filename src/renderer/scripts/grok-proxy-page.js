import { createElement, copyModelId, createProxyPage, formatPercent, formatReset } from './proxy-page.js'

/**
 * Grok 反向代理頁：骨架在 proxy-page.js，這裡只有 Grok 的憑證指引與模型型錄。
 * token 由 Grok CLI 維護（`~/.grok/auth.json`），AxonDeck 只讀，所以指引一律導回 CLI。
 */

function credentialGuidance(info) {
  if (!info?.sources?.cli) {
    return {
      title: '這台機器沒有偵測到 Grok CLI 的登入資料',
      steps: [
        { text: '到設定頁「CLI 版本」安裝 Grok CLI' },
        { text: '開終端機執行 ', code: 'grok', tail: '，依指示登入 SuperGrok 帳號' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  if (info?.code === 'TOKEN_EXPIRED') {
    return {
      title: 'Grok 登入過期，自動續期沒成功',
      steps: [
        { text: '開終端機執行一次 ', code: 'grok', tail: '，讓它重新登入或續期' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  return {
    title: '已偵測到 Grok CLI，但還沒登入',
    steps: [
      { text: '開終端機執行 ', code: 'grok', tail: '，依指示登入' },
      { text: '回到這一頁按「重新整理」' }
    ]
  }
}

/** 每週額度標籤：billing 的已用百分比與這一期結束時間 */
function quotaTag(quota) {
  if (!quota) return null
  const left = Math.max(0, 100 - quota.usedPercent)
  const reset = formatReset(quota.resetAt)
  const tag = createElement('span', 'agy-model-tag is-quota', `週 剩 ${formatPercent(left)}`)
  if (left < 10) tag.classList.add('is-low')
  tag.title = `SuperGrok 每週額度${reset ? `，${reset} 重置` : ''}；所有模型共用`
  return tag
}

/**
 * 一顆模型一列：名字複製本體 ID（上游預設強度），每個強度一顆 chip 複製 `<id>-<強度>`。
 * @param {{ id: string, name: string, description: string, contextWindow: number, efforts: string[], defaultEffort: string }} model
 */
function buildModelLine(model) {
  const row = createElement('div', 'agy-model-line')
  const name = createElement('button', 'agy-model-name', model.id)
  name.type = 'button'
  name.title = `${model.name}${model.description ? `：${model.description}` : ''}\n點一下複製 ${model.id}`
  name.setAttribute('aria-label', `複製模型 ID ${model.id}`)
  name.addEventListener('click', () => copyModelId(model.id))
  row.appendChild(name)

  const chips = createElement('div', 'agy-model-variants')
  for (const effort of model.efforts) {
    const id = `${model.id}-${effort}`
    const chip = createElement('button', 'agy-model-variant', effort === model.defaultEffort ? `${effort}（預設）` : effort)
    chip.type = 'button'
    chip.title = `點一下複製 ${id}`
    chip.setAttribute('aria-label', `複製模型 ID ${id}`)
    chip.addEventListener('click', () => copyModelId(id))
    chips.appendChild(chip)
  }
  row.appendChild(chips)

  const meta = createElement('div', 'agy-model-meta')
  if (model.contextWindow) {
    const context = createElement('span', 'agy-model-tag', `${Math.round(model.contextWindow / 1000)}k`)
    context.title = `上下文 ${model.contextWindow} tokens`
    meta.appendChild(context)
  }
  row.appendChild(meta)
  return row
}

const modelsOf = (data) => (Array.isArray(data?.models) ? data.models : [])

function renderModels(data) {
  const models = modelsOf(data)
  if (!models.length) return []
  const section = createElement('section', 'agy-model-group')
  const head = createElement('div', 'agy-model-group-head')
  const title = createElement('h3', 'agy-model-group-title', 'SuperGrok')
  title.title = '所有模型共用同一份每週額度；強度 chip 會帶 -<強度> 後綴'
  head.appendChild(title)
  const tag = quotaTag(data.quota)
  if (tag) head.appendChild(tag)
  section.appendChild(head)
  for (const model of models) section.appendChild(buildModelLine(model))
  return [section]
}

const page = createProxyPage({
  prefix: 'grok',
  api: 'grokProxy',
  defaultPort: 8789,
  credentialLabel: 'Grok 登入無法使用',
  credentialGuidance,
  modelsMeta: (data) => `共 ${modelsOf(data).length} 個`,
  renderModels
})

export const refreshGrokProxyPage = page.refresh
/** 離開頁面就停止輪詢，別讓背景一直查 DB */
export const cooldownGrokProxyPage = page.cooldown
