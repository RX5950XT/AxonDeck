import { createElement, copyModelId, createProxyPage, formatPercent, formatReset } from './proxy-page.js'

/**
 * 反向代理頁（Antigravity＋Grok 共用一個端點）：骨架在 proxy-page.js，這裡只有憑證指引與模型型錄。
 * 維護 token 的是 Antigravity CLI／IDE 與 Grok CLI（誰在跑誰續期），AxonDeck 只讀不寫，
 * 所以指引能做的就是把使用者導回那些工具。
 */

/** 官方文件（CLI 安裝說明）。取自 agy.exe 內建的字串，非自行推測。 */
const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/docs'

/** 依偵測到的來源給不同指引：沒裝過的人光看「請先登入」不知道要裝什麼、去哪裝 */
function agyGuidance(info) {
  const sources = info?.sources || {}
  const toolName = sources.cli ? 'Antigravity CLI' : 'Antigravity'

  if (!sources.cli && !sources.ide) {
    return {
      title: '這台機器沒有偵測到 Antigravity CLI 或 IDE',
      steps: [
        { text: '安裝 Antigravity CLI：', link: ANTIGRAVITY_DOCS_URL },
        { text: '開終端機執行 ', code: 'agy', tail: '，依指示用 Google 帳號登入一次' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  if (info?.code === 'TOKEN_EXPIRED') {
    return {
      title: `已偵測到 ${toolName}，但 token 過期了`,
      steps: [
        { text: '執行任一個 ', code: 'agy', tail: ' 指令，它會自動把 token 續期' },
        { text: '回到這一頁按「重新整理」' }
      ]
    }
  }
  return {
    title: `已偵測到 ${toolName}，但尚未登入`,
    steps: [
      { text: '開終端機執行 ', code: 'agy', tail: '，依指示用 Google 帳號登入' },
      { text: '回到這一頁按「重新整理」' }
    ]
  }
}

/**
 * 兩家都沒登入時才會出現（登入任一家就能用）：Antigravity 的指引，再補一行 Grok 的登入方式。
 * @param {object} info
 */
function credentialGuidance(info) {
  const agy = agyGuidance(info)
  const grokStep = info?.grok?.sources?.cli === false
    ? { text: '要用 Grok 模型：到設定頁「CLI 版本」安裝 Grok CLI，再執行 ', code: 'grok', tail: ' 登入 SuperGrok 帳號' }
    : { text: '要用 Grok 模型：開終端機執行 ', code: 'grok', tail: ' 登入 SuperGrok 帳號' }
  return { title: agy.title, steps: [...agy.steps.slice(0, -1), grokStep, agy.steps[agy.steps.length - 1]] }
}

/** 狀態列：兩家各自的登入狀態；任一家可用就算正常 */
function credentialSummary(info) {
  const agy = info?.agy || info
  const grok = info?.grok
  const agyText = agy?.connected ? `已連線${agy.tier ? ` · ${agy.tier}` : ''}` : '未登入'
  const grokText = grok?.connected ? '已連線' : '未登入'
  return { text: `Antigravity ${agyText}／Grok ${grokText}`, ok: Boolean(agy?.connected || grok?.connected) }
}

// ===== Grok（SuperGrok 訂閱；模型名一律 grok-*，同一個端點轉過去） =====

/** 每週額度標籤：billing 的已用百分比與這一期結束時間 */
function grokQuotaTag(quota) {
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
function buildGrokModelLine(model) {
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

const grokModelsOf = (data) => (Array.isArray(data?.grok?.models) ? data.grok.models : [])

/** @returns {HTMLElement | null} */
function buildGrokGroup(data) {
  const models = grokModelsOf(data)
  if (!models.length) return null
  const section = createElement('section', 'agy-model-group')
  const head = createElement('div', 'agy-model-group-head')
  const title = createElement('h3', 'agy-model-group-title', 'Grok（SuperGrok）')
  title.title = '所有模型共用同一份每週額度；強度 chip 會帶 -<強度> 後綴'
  head.appendChild(title)
  const tag = grokQuotaTag(data.grok.quota)
  if (tag) head.appendChild(tag)
  section.appendChild(head)
  for (const model of models) section.appendChild(buildGrokModelLine(model))
  return section
}

/** 依額度池分組；生圖與 IDE 內部／方案用不了的另外放，不跟可對話的混在一起 */
const MODEL_GROUPS = Object.freeze([
  { key: 'claude', title: 'Claude 池', hint: '同池共用 5 小時與每週額度，依 token 成本比例扣' },
  { key: 'gemini', title: 'Gemini 池', hint: '同池共用 5 小時與每週額度，依 token 成本比例扣' },
  { key: 'image', title: '生圖', hint: '聊天端點回 markdown 圖片，另有 /v1/images/generations' },
  { key: 'internal', title: 'IDE 內部／方案不可用', hint: '不能拿來對話' }
])

const isUsable = (model) => model.chatCapable || model.image
const modelsOf = (data) => (Array.isArray(data?.models) ? data.models : [])

function modelGroupOf(model) {
  if (model.image) return 'image'
  if (!model.chatCapable) return 'internal'
  return model.pool === 'claude' ? 'claude' : 'gemini'
}

/**
 * 上游的單模型數字是「目前卡住它的那一道」：平常是 5 小時，每週用掉較多時改回每週。
 * 看重置時間離現在多遠才分得出是哪一道。
 * @param {Array<object>} models
 * @returns {HTMLElement | null}
 */
function poolQuotaTag(models) {
  const known = models.filter((model) => typeof model.remainingFraction === 'number')
  if (!known.length) return null
  const tightest = known.reduce((min, model) => (model.remainingFraction < min.remainingFraction ? model : min))
  const percent = tightest.remainingFraction * 100
  const resetMs = Date.parse(tightest.resetTime || '')
  const weekly = Number.isFinite(resetMs) && resetMs - Date.now() > 6 * 60 * 60 * 1000
  const reset = formatReset(tightest.resetTime)
  const tag = createElement('span', 'agy-model-tag is-quota', `${weekly ? '週' : '5h'} 剩 ${formatPercent(percent)}`)
  if (percent < 10) tag.classList.add('is-low')
  tag.title = `${weekly ? '每週' : '5 小時'}額度${reset ? `，${reset} 重置` : ''}；完整兩道額度見額度儀表板`
  return tag
}

/** @param {{ title: string, hint: string, models: Array<object> }} group */
function buildModelGroup(group) {
  const section = createElement('section', 'agy-model-group')
  const head = createElement('div', 'agy-model-group-head')
  const title = createElement('h3', 'agy-model-group-title', group.title)
  title.title = group.hint
  head.appendChild(title)
  const quota = poolQuotaTag(group.models)
  if (quota) head.appendChild(quota)
  section.appendChild(head)

  // 型錄已在 main 端排好序（同一顆模型的檔位相鄰），照出現順序收成模型線即可
  const lines = new Map()
  for (const model of group.models) {
    const key = model.line || model.id
    if (!lines.has(key)) lines.set(key, [])
    lines.get(key).push(model)
  }
  for (const [line, variants] of lines) section.appendChild(buildModelLine(line, variants))
  return section
}

/** 一顆模型一列：名字點了複製第一個檔位，後面每個檔位一顆 chip 各自複製完整 ID */
function buildModelLine(line, variants) {
  const row = createElement('div', 'agy-model-line')
  if (variants.every((model) => !isUsable(model))) row.classList.add('is-internal')

  const first = variants.find((model) => !model.deprecated) || variants[0]
  const name = createElement('button', 'agy-model-name', line)
  name.type = 'button'
  name.title = `點一下複製 ${first.id}`
  name.setAttribute('aria-label', `複製模型 ID ${first.id}`)
  name.addEventListener('click', () => copyModelId(first.id))
  row.appendChild(name)

  const chips = createElement('div', 'agy-model-variants')
  const single = variants.length === 1 && !variants[0].variant
  if (!single) for (const model of variants) chips.appendChild(buildVariantChip(model))
  row.appendChild(chips)

  const meta = createElement('div', 'agy-model-meta')
  if (first.disabled) {
    const tag = createElement('span', 'agy-model-tag is-deprecated', '方案不可用')
    if (first.note) tag.title = first.note
    meta.appendChild(tag)
  }
  if (first.maxTokens) {
    const context = createElement('span', 'agy-model-tag', `${Math.round(first.maxTokens / 1000)}k`)
    context.title = `輸入上限 ${first.maxTokens} tokens${first.provider ? `・${first.provider.toLowerCase()}` : ''}`
    meta.appendChild(context)
  }
  row.appendChild(meta)
  return row
}

function buildVariantChip(model) {
  const chip = createElement('button', 'agy-model-variant', model.variant || '預設')
  chip.type = 'button'
  chip.setAttribute('aria-label', `複製模型 ID ${model.id}`)
  chip.title = model.deprecated
    ? `${model.id}（已淘汰${model.replacedBy ? ` → ${model.replacedBy}` : ''}）`
    : `點一下複製 ${model.id}`
  if (model.deprecated) chip.classList.add('is-deprecated')
  chip.addEventListener('click', () => copyModelId(model.id))
  return chip
}

function renderModels(data) {
  const showAll = document.getElementById('agyModelsShowAll')?.checked === true
  const rows = showAll ? modelsOf(data) : modelsOf(data).filter(isUsable)
  const groups = MODEL_GROUPS
    .map((group) => ({ ...group, models: rows.filter((model) => modelGroupOf(model) === group.key) }))
    .filter((group) => group.models.length)
    .map(buildModelGroup)
  const grok = buildGrokGroup(data)
  return grok ? [...groups, grok] : groups
}

function modelsMeta(data) {
  const agy = modelsOf(data)
  const parts = agy.length ? [`Antigravity ${agy.length} 個（對話可用 ${agy.filter(isUsable).length}）`] : []
  if (grokModelsOf(data).length) parts.push(`Grok ${grokModelsOf(data).length} 個`)
  return parts.length ? parts.join('、') : '沒有已登入的上游'
}

const page = createProxyPage({
  prefix: 'agy',
  api: 'agy',
  defaultPort: 8788,
  credentialLabel: 'Antigravity 憑證無法使用',
  credentialGuidance,
  credentialSummary,
  modelsMeta,
  renderModels,
  bindExtra: ({ renderModelCatalog }) => {
    document.getElementById('agyModelsShowAll')?.addEventListener('change', renderModelCatalog)
  }
})

export const refreshAgyPage = page.refresh
/** 離開頁面就停止輪詢，別讓背景一直查 DB */
export const cooldownAgyPage = page.cooldown
