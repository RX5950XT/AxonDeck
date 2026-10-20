/**
 * AxonDeck - 語音轉文字頁
 *
 * 轉錄、錄音、即時字幕、語音輸入在同一頁。辨識模型、翻譯模型兩邊共用同一組選單
 * （寫 `fileAsr`／`fileLlm`，main 會抄到 `liveAsr`／`liveLlm`）。
 * 目標語言是同一個 `<select id="liveLanguage">`。語音輸入的辨識、整理、輸出語言各自選。
 *
 * 檔案轉入在 `transcribe.js`，即時字幕在 `live-caption.js`，
 * 錄音機在 `recorder.js`，語音輸入在 `dictation-page.js`。
 */

import { electronAPI, getSettings } from './app.js'
import {
  asrOptions,
  translateOptions,
  fillSelect,
  readScope,
  writeScope,
  readinessHint,
  warnNotReady
} from './model-picker.js'
import { syncCustomSelects } from './custom-select.js'

/**
 * 共用選單寫 file scope（main 同步到 live）。語音輸入的整理模型由 `dictation-page.js` 畫。
 * @type {Record<'file'|'dictation', { asr: string, llm: string|null, hint: string|null }>}
 */
const PICKERS = {
  file: { asr: 'fileAsrModel', llm: 'fileLlmModel', hint: 'fileModelHint' },
  dictation: { asr: 'dictationAsrModel', llm: null, hint: null }
}

let bound = false

/** 各 scope 目前的選項清單（給「選到還沒裝好的東西」提示用） */
const opts = {
  file: { asr: [], llm: [] },
  dictation: { asr: [], llm: [] }
}

/**
 * @param {'file'|'dictation'} scope
 * @param {'asr'|'llm'} kind
 */
function bindPicker(scope, kind) {
  const id = PICKERS[scope][kind]
  if (!id) return
  const select = /** @type {HTMLSelectElement|null} */ (document.getElementById(id))
  select?.addEventListener('change', async () => {
    await writeScope(scope, kind, select.value)
    updateHint(scope)
    warnNotReady(readinessHint(select, opts[scope][kind]))
    document.dispatchEvent(new CustomEvent('settings-changed'))
  })
}

function bindOnce() {
  if (bound) return
  bound = true

  for (const scope of /** @type {const} */ (['file', 'dictation'])) {
    bindPicker(scope, 'asr')
    bindPicker(scope, 'llm')
  }
}

/**
 * @param {'file'|'dictation'} scope
 */
function updateHint(scope) {
  const hintId = PICKERS[scope].hint
  if (!hintId) return
  const hint = document.getElementById(hintId)
  if (!hint) return
  const msgs = [
    readinessHint(document.getElementById(PICKERS[scope].asr), opts[scope].asr),
    PICKERS[scope].llm
      ? readinessHint(document.getElementById(PICKERS[scope].llm), opts[scope].llm)
      : ''
  ].filter(Boolean)
  // 沒問題時整條收起來：這一行只是為了「選到還沒裝好的東西」而存在，
  // 常駐一句說明文字只是把版面吃掉
  hint.textContent = msgs.join(' ')
  hint.classList.toggle('is-warning', msgs.length > 0)
  hint.classList.toggle('hidden', msgs.length === 0)
}

/**
 * 進頁時重讀（模型可能剛下載完、設定可能剛改過）
 */
export async function refreshSttPage() {
  bindOnce()
  const [settings, status] = await Promise.all([getSettings(), electronAPI.models.status()])
  const map = status.models || {}

  for (const scope of /** @type {const} */ (['file', 'dictation'])) {
    const chosen = await readScope(scope)
    opts[scope].asr = asrOptions(map, settings)
    fillSelect(document.getElementById(PICKERS[scope].asr), opts[scope].asr, chosen.asr)
    if (PICKERS[scope].llm) {
      opts[scope].llm = translateOptions(map, settings)
      fillSelect(document.getElementById(PICKERS[scope].llm), opts[scope].llm, chosen.llm)
    }
    updateHint(scope)
  }
  // fillSelect 只改原始 <select>；畫面上的 listbox 要跟著換文字
  syncCustomSelects()
}
