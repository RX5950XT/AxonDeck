/**
 * 聊天輸入列的兩顆選單鈕：思考強度、生圖選項（比例／解析度）。
 *
 * 檔位名稱照 OpenAI／OpenRouter 的 effort 原樣存（main 的 `chat-params.js` 是邊界，這裡只是 UI）。
 * 選到生圖模型時藏思考鈕、換成生圖選項鈕——生圖模型不吃 reasoning，main 也不會送。
 */

import { electronAPI } from './app.js'
import { openChatMenu, closeChatMenu } from './chat-menu.js'

/** @type {Array<{ value: string, label: string, hint: string }>} */
const THINK_LEVELS = [
  { value: 'default', label: '自動', hint: '不指定，交給模型預設' },
  { value: 'off', label: '關閉', hint: '不思考，直接回答' },
  { value: 'minimal', label: '最低', hint: '幾乎不想，最快' },
  { value: 'low', label: '低', hint: '想一下就答' },
  { value: 'medium', label: '中', hint: '一般問題的平衡點' },
  { value: 'high', label: '高', hint: '數學、程式、推理' },
  { value: 'xhigh', label: '極高', hint: '難題，慢且貴' },
  { value: 'max', label: '最高', hint: '模型支援的上限' }
]
const ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9']
const RESOLUTIONS = ['auto', '1K', '2K', '4K']

/** @type {HTMLButtonElement | null} */
let thinkBtn = null
/** @type {HTMLButtonElement | null} */
let imageBtn = null
let thinking = 'default'
let imageOptions = { aspectRatio: 'auto', resolution: 'auto' }

export function initComposerMenus() {
  thinkBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('chatThinkBtn'))
  imageBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('chatImageBtn'))
  thinkBtn?.addEventListener('click', () => openChatMenu(thinkBtn, THINK_LEVELS.map((level) => ({
    label: level.label,
    hint: level.hint,
    checked: level.value === thinking,
    onSelect: () => void setThinking(level.value)
  }))))
  imageBtn?.addEventListener('click', () => openChatMenu(imageBtn, [
    ...ASPECTS.map((value) => ({
      label: value === 'auto' ? '比例：自動' : `比例 ${value}`,
      checked: value === imageOptions.aspectRatio,
      onSelect: () => void setImageOptions({ ...imageOptions, aspectRatio: value })
    })),
    { separator: true },
    ...RESOLUTIONS.map((value) => ({
      label: value === 'auto' ? '解析度：自動' : `解析度 ${value}`,
      checked: value === imageOptions.resolution,
      onSelect: () => void setImageOptions({ ...imageOptions, resolution: value })
    }))
  ]))
}

export async function refreshComposerMenus() {
  const [level, options] = await Promise.all([
    electronAPI.store.get('chatThinking', 'default'),
    electronAPI.store.get('chatImageOptions', {})
  ])
  thinking = THINK_LEVELS.some((l) => l.value === level) ? level : 'default'
  imageOptions = { aspectRatio: options?.aspectRatio || 'auto', resolution: options?.resolution || 'auto' }
  paint()
}

/**
 * 生圖模型：藏思考、顯示生圖選項
 * @param {boolean} on
 */
export function setImageMode(on) {
  closeChatMenu()
  if (thinkBtn) thinkBtn.hidden = on
  if (imageBtn) imageBtn.hidden = !on
}

/** @param {string} value */
async function setThinking(value) {
  await electronAPI.store.set('chatThinking', value)
  thinking = value
  paint()
}

/** @param {{ aspectRatio: string, resolution: string }} next */
async function setImageOptions(next) {
  await electronAPI.store.set('chatImageOptions', next)
  imageOptions = next
  paint()
}

function paint() {
  const level = THINK_LEVELS.find((l) => l.value === thinking) || THINK_LEVELS[0]
  if (thinkBtn) {
    setLabel(thinkBtn, level.value === 'default' ? '思考' : `思考 · ${level.label}`)
    thinkBtn.classList.toggle('is-active', level.value !== 'default' && level.value !== 'off')
    thinkBtn.title = `思考強度：${level.label}（${level.hint}）`
  }
  if (imageBtn) {
    const parts = [imageOptions.aspectRatio, imageOptions.resolution].filter((v) => v !== 'auto')
    setLabel(imageBtn, parts.length ? parts.join(' · ') : '圖片選項')
    imageBtn.classList.toggle('is-active', parts.length > 0)
    imageBtn.title = '生圖的比例與解析度（自動＝不指定，交給模型）'
  }
}

/**
 * @param {HTMLElement} btn
 * @param {string} text
 */
function setLabel(btn, text) {
  const span = btn.querySelector('span')
  if (span) span.textContent = text
}
