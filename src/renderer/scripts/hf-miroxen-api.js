/**
 * AxonDeck — Local SI 執行環境的「圖片影像 API」面板
 *
 * Miroxen 工作台內嵌時藏掉自己的 API 分頁，網址、金鑰、區網開關改在這裡。
 * 開區網 = 引擎改聽 0.0.0.0:8188（main 會照新設定重開正在跑的引擎）。
 */

import { electronAPI, showToast, cleanIpcError } from './app.js'

let bound = false
let showKey = false

/** @param {string} id */
const $ = (id) => document.getElementById(id)

async function call(promise) {
  const result = await promise
  if (!result?.ok) throw new Error(result?.error?.message || '圖片影像引擎操作失敗')
  return result.data
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); showToast('已複製', 'success') }
  catch { showToast('複製失敗', 'error') }
}

/** @param {string} label @param {string} value @param {{ text: string, onClick: () => void }[]} actions */
function row(label, value, actions = []) {
  const item = document.createElement('div')
  item.className = 'hf-setting-row'
  const text = document.createElement('div')
  text.className = 'hf-setting-text'
  const name = document.createElement('span')
  name.className = 'hf-setting-label'
  name.textContent = label
  const val = document.createElement('span')
  val.className = 'hf-setting-value'
  val.textContent = value
  text.append(name, val)
  const buttons = document.createElement('div')
  buttons.className = 'hf-inline-actions'
  for (const action of actions) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'btn btn-secondary btn-sm'
    button.textContent = action.text
    button.addEventListener('click', action.onClick)
    buttons.append(button)
  }
  item.append(text, buttons)
  return item
}

function paint(api) {
  const rows = []
  rows.push(api.running
    ? row('本機', `${api.local}/v1`, [{ text: '複製', onClick: () => void copy(`${api.local}/v1`) }])
    : row('本機', '引擎沒在跑；到「生成圖片影像」頁就會啟動'))
  for (const url of api.lanUrls) {
    rows.push(row('區網', `${url}/v1（工作台：${url}/）`, [{ text: '複製', onClick: () => void copy(`${url}/v1`) }]))
  }
  rows.push(row('API 金鑰', showKey ? api.key : '•'.repeat(16), [
    { text: showKey ? '隱藏' : '顯示', onClick: () => { showKey = !showKey; void refreshMiroxenApi() } },
    { text: '複製', onClick: () => void copy(api.key) }
  ]))
  $('hfMiroxenApiRows')?.replaceChildren(...rows)
  const lan = /** @type {HTMLInputElement} */ ($('hfMiroxenLan'))
  lan.checked = api.lan
  const hint = $('hfMiroxenApiHint')
  if (hint) {
    hint.textContent = !api.lan
      ? '目前只有這台電腦連得到。打開區網後改用固定埠 8188，同一個 Wi-Fi／路由器下的裝置都能連。'
      : api.running
        ? '別台用瀏覽器開「工作台」網址就能生成（第一次在它的 API 分頁填金鑰）；其他程式把 API Base URL 填區網網址、金鑰放 Authorization: Bearer。Windows 防火牆跳出詢問時請按「允許」。端點說明見 Miroxen 的 docs/API.md。'
        : '區網已打開；引擎啟動後這裡會列出別台要填的網址。'
  }
}

export async function refreshMiroxenApi() {
  const panel = $('hfMiroxenApi')
  if (!panel) return
  let api
  try { api = await call(electronAPI.miroxen.api()) } catch { return panel.classList.add('hidden') }
  panel.classList.toggle('hidden', !api.installed)
  if (!api.installed) return
  if (!bound) {
    bound = true
    $('hfMiroxenLan')?.addEventListener('change', async (event) => {
      const box = /** @type {HTMLInputElement} */ (event.target)
      box.disabled = true
      try { paint(await call(electronAPI.miroxen.setLan(box.checked))) }
      catch (error) { showToast(cleanIpcError(error), 'error'); void refreshMiroxenApi() }
      finally { box.disabled = false }
    })
  }
  paint(api)
}
