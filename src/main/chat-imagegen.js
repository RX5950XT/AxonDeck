/**
 * AxonDeck - 聊天裡的生圖模型（Main Process）
 *
 * 兩條路：
 * - 文字＋圖片模型（Gemini image 等）走原本的 `/chat/completions`＋`modalities`，比例／解析度放 `image_config`。
 * - 只吐圖的模型（Qwen-Image、Seedream、FLUX、gpt-image…）在 OpenRouter 對 chat/completions 回 404，
 *   要改打 `/images/generations`（OpenAI 標準路徑；OpenRouter 的 `/images` 也收這個別名）。
 *   這條不是串流，回 `data[].b64_json`。
 * 不認模型名猜路線：先走 chat，被 4xx 拒絕再退到 images，新模型不用改程式。
 */

const chatImages = require('./chat-images')
const chatParams = require('./chat-params')

/** 生圖一張常常要半分鐘以上，不能套聊天的 60 秒首 token 逾時 */
const IMAGES_TIMEOUT_MS = 180000
/** 回應整包上限（base64 圖，四張高解析也夠） */
const MAX_RESPONSE_CHARS = 40 * 1024 * 1024

/** 提示詞裡的字 → 比例（使用者在選單選了就不看提示詞） */
const ASPECT_HINTS = [
  [/橫式|橫幅|橫向|寬螢幕|電腦桌布|封面圖|landscape|widescreen/i, '16:9'],
  [/直式|直幅|直向|手機桌布|限時動態|限動|story/i, '9:16'],
  [/正方形|方形|頭像|大頭貼|square|avatar/i, '1:1']
]
const TRANSPARENT_HINT = /透明背景|背景透明|透明底|去背|無背景|沒有背景|transparent( background)?|no background/i

/**
 * 選單沒指定（auto）的項目從提示詞猜：寫了「16:9」「直式」「4K」「透明背景」就照著送。
 * 選單選了什麼就用什麼，提示詞只補空位。
 * @param {unknown} options
 * @param {string} prompt
 * @returns {{ aspectRatio: string, resolution: string, transparent: boolean }}
 */
function resolveOptions(options, prompt) {
  const picked = chatParams.sanitizeImageOptions(options)
  const text = String(prompt || '')
  let aspectRatio = picked.aspectRatio
  if (aspectRatio === 'auto') {
    const literal = /(\d{1,2})\s*[:：比]\s*(\d{1,2})/.exec(text)
    const ratio = literal ? `${literal[1]}:${literal[2]}` : ''
    if (chatParams.ASPECT_RATIOS.includes(ratio) && ratio !== 'auto') aspectRatio = ratio
    else aspectRatio = ASPECT_HINTS.find(([re]) => re.test(text))?.[1] || 'auto'
  }
  let resolution = picked.resolution
  if (resolution === 'auto') {
    const tier = /(?<![a-z0-9])([124])k(?![a-z0-9])/i.exec(text)
    resolution = tier ? `${tier[1]}K` : (/高解析|超高清|高清/.test(text) ? '2K' : 'auto')
  }
  return { aspectRatio, resolution, transparent: TRANSPARENT_HINT.test(text) }
}

/**
 * chat/completions 的生圖欄位（這條路沒有透明背景欄位）
 * @param {unknown} options
 * @param {string} [prompt]
 * @returns {Record<string, unknown>}
 */
function chatFields(options, prompt = '') {
  const { aspectRatio, resolution } = resolveOptions(options, prompt)
  const config = {}
  if (aspectRatio !== 'auto') config.aspect_ratio = aspectRatio
  if (resolution !== 'auto') config.image_size = resolution
  return Object.keys(config).length ? { image_config: config } : {}
}

/**
 * chat/completions 被拒絕時要不要改走 images 端點。
 * 401／402／429／5xx 換條路也一樣失敗，直接回報。
 * @param {number} status
 */
function shouldFallback(status) {
  return [400, 404, 405, 422].includes(status)
}

/**
 * 參考圖：最後一則使用者訊息自己附的圖；沒附就拿最近一張生成圖（「再藍一點」這種接著改）。
 * @param {Array<{ role: string, images?: string[] }>} messages
 * @returns {string[]} 圖片檔名
 */
function referenceNames(messages) {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'user') return []
  if (last.images?.length) return last.images
  for (let i = messages.length - 2; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].images?.length) return messages[i].images
  }
  return []
}

/**
 * @param {string[]} names
 * @returns {Promise<string[]>} data URL
 */
async function toDataUrls(names) {
  const out = []
  for (const name of names) {
    const url = await chatImages.toDataUrl(name)
    if (url) out.push(url)
  }
  return out
}

/**
 * @param {{ data?: unknown, usage?: { completion_tokens?: unknown } }} json
 * @returns {{ images: string[], tokens: number }}
 */
function parseImagesResponse(json) {
  const images = []
  for (const item of Array.isArray(json?.data) ? json.data : []) {
    const b64 = typeof item?.b64_json === 'string' ? item.b64_json : ''
    const mime = /^image\/(png|jpeg|webp)$/.test(item?.media_type) ? item.media_type : 'image/png'
    if (b64) images.push(`data:${mime};base64,${b64}`)
  }
  const tokens = Number(json?.usage?.completion_tokens) || 0
  return { images, tokens }
}

/**
 * 打 `/images/generations`。只送使用者有選的欄位；參考圖走 OpenRouter 的 `input_references`。
 * @param {{ apiUrl: string, apiKey: string, model: string, prompt: string, references: string[],
 *   options: unknown, signal: AbortSignal }} req
 * @returns {Promise<{ ok: true, images: string[], tokens: number } | { ok: false, status: number }>}
 */
async function generate(req) {
  const { aspectRatio, resolution, transparent } = resolveOptions(req.options, req.prompt)
  /** @type {Record<string, unknown>} */
  const body = { model: req.model, prompt: req.prompt, n: 1 }
  if (aspectRatio !== 'auto') body.aspect_ratio = aspectRatio
  if (resolution !== 'auto') body.resolution = resolution
  // 透明只有 png／webp 存得下
  if (transparent) Object.assign(body, { background: 'transparent', output_format: 'png' })
  if (req.references.length) {
    body.input_references = req.references.map((url) => ({ type: 'image_url', image_url: { url } }))
  }
  const res = await fetch(`${req.apiUrl.replace(/\/+$/, '')}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal
  })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    return { ok: false, status: res.status }
  }
  const text = await res.text()
  if (text.length > MAX_RESPONSE_CHARS) return { ok: false, status: 502 }
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, status: 502 }
  }
  return { ok: true, ...parseImagesResponse(json) }
}

/**
 * 只吐圖的模型：chat/completions 拒絕後改打 images 端點（非串流，一次拿整張圖）
 * @param {{ apiUrl: string, apiKey: string, modelId: string, imageOptions: object }} cfg
 * @param {string} prompt 最後一則使用者訊息
 * @param {string[]} refs 參考圖檔名
 * @param {AbortSignal} signal
 * @returns {Promise<{ error: string } | { images: string[], tokens: number }>}
 */
async function generateForChat(cfg, prompt, refs, signal) {
  if (!prompt.trim()) return { error: '這顆是生圖模型，請用文字描述想要的圖' }
  const out = await generate({
    apiUrl: cfg.apiUrl,
    apiKey: cfg.apiKey,
    model: cfg.modelId,
    prompt,
    references: await toDataUrls(refs),
    options: cfg.imageOptions,
    signal
  })
  if (!out.ok) {
    console.error(`[chat] images API error: HTTP ${out.status}`)
    return { error: `API 錯誤（${out.status}）` }
  }
  if (!out.images.length) return { error: '模型沒有回傳圖片' }
  return out
}

module.exports = {
  generateForChat,
  IMAGES_TIMEOUT_MS, resolveOptions, chatFields, shouldFallback, referenceNames, toDataUrls, parseImagesResponse, generate
}
