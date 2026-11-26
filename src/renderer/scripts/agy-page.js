import { createElement, copyModelId, createProxyPage, formatPercent, formatReset } from './proxy-page.js'

/**
 * AGY 反向代理頁：骨架在 proxy-page.js，這裡只有 Antigravity 的憑證指引與模型型錄。
 * 維護 token 的是 Antigravity CLI 或 IDE（誰在跑誰續期），AxonDeck 只讀不寫，
 * 所以指引能做的就是把使用者導回那兩個工具。
 */

/** 官方文件（CLI 安裝說明）。取自 agy.exe 內建的字串，非自行推測。 */
const ANTIGRAVITY_DOCS_URL = 'https://antigravity.google/docs'

/** 依偵測到的來源給不同指引：沒裝過的人光看「請先登入」不知道要裝什麼、去哪裝 */
function credentialGuidance(info) {
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

/** 依額度池分組；生圖與 IDE 內部／方案用不了的另外放，不跟可對話的混在一起 */
const MODEL_GROUPS = Object.freeze([
  { key: 'claude', title: 'Claude／GPT 池', hint: '同池共用 5 小時與每週額度，依 token 成本比例扣' },
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
  return MODEL_GROUPS
    .map((group) => ({ ...group, models: rows.filter((model) => modelGroupOf(model) === group.key) }))
    .filter((group) => group.models.length)
    .map(buildModelGroup)
}

const page = createProxyPage({
  prefix: 'agy',
  api: 'agy',
  defaultPort: 8788,
  credentialLabel: 'Antigravity 憑證無法使用',
  credentialGuidance,
  modelsMeta: (data) => `共 ${modelsOf(data).length} 個（對話可用 ${modelsOf(data).filter(isUsable).length}）`,
  renderModels,
  bindExtra: ({ renderModelCatalog }) => {
    document.getElementById('agyModelsShowAll')?.addEventListener('change', renderModelCatalog)
  }
})

export const refreshAgyPage = page.refresh
/** 離開頁面就停止輪詢，別讓背景一直查 DB */
export const cooldownAgyPage = page.cooldown
