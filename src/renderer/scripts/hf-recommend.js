/**
 * AxonDeck — Local SI 的「推薦」子分頁＋「執行環境」的推論方式
 *
 * 推薦：語音辨識與翻譯用的固定模型（`models.js` 的 registry；執行環境另在「執行環境」分頁裝）。
 * 推論方式：不給選，main 自動偵測（NVIDIA 且 VRAM ≥ 8GB 走 GPU，其餘 CPU），這裡只顯示結果
 * 與 CUDA 環境的安裝按鈕。原本都在設定頁的「本地模型」。
 */

import { electronAPI, showToast, cleanIpcError, openInFilesPage } from './app.js'

/** registry 的 kind → 顯示分組（執行環境在「執行環境」分頁，這裡不列） */
const MODEL_GROUPS = [
  ['asr', '語音辨識'],
  ['llm', '翻譯']
]

let bound = false
/** 最近一次模型狀態 @type {Record<string, any>} */
let latestModels = {}
let cudaInstallInProgress = false

/** @param {string} id @returns {HTMLElement | null} */
const $ = (id) => document.getElementById(id)

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  return Math.round(bytes / (1024 * 1024)) + ' MB'
}

async function openModelsFolder(key) {
  try { await openInFilesPage(await electronAPI.models.openFolder(key)) }
  catch (error) { showToast(cleanIpcError(error), 'error') }
}

function bindOnce() {
  if (bound) return
  bound = true
  $('openModelsFolderBtn')?.addEventListener('click', () => void openModelsFolder())
  $('modelsPathText')?.addEventListener('click', () => void openModelsFolder())
  $('installCudaEnvBtn')?.addEventListener('click', () => void onInstallCudaEnv())
  $('refreshGpuEnvBtn')?.addEventListener('click', () => void refreshInference(true))
  electronAPI.models.onProgress(onModelProgress)
}

/** 進「推薦」子分頁 */
export async function refreshRecommend() {
  bindOnce()
  const list = $('modelList')
  const pathText = $('modelsPathText')
  if (!list || !pathText) return
  const status = await electronAPI.models.status()
  latestModels = status.models || {}
  pathText.textContent = status.root
  pathText.title = status.root

  list.replaceChildren()
  for (const [kind, title] of MODEL_GROUPS) {
    const group = Object.values(latestModels).filter((m) => m.kind === kind)
    if (!group.length) continue
    const heading = document.createElement('p')
    heading.className = 'model-group-title'
    heading.textContent = title
    list.appendChild(heading)
    for (const model of group) list.appendChild(renderModelItem(model))
  }
}

function renderModelItem(model) {
  const item = document.createElement('div')
  item.className = 'model-item'
  item.dataset.key = model.key

  const needsRuntime = model.requires && !latestModels[model.requires]?.downloaded
  const runtimeLabel = latestModels[model.requires]?.label || model.requires
  const stateText = model.downloaded
    ? needsRuntime
      ? `${formatBytes(model.totalBytes)} · 已下載，還缺「${runtimeLabel}」（到執行環境安裝）`
      : `${formatBytes(model.totalBytes)} · 已下載`
    : model.downloading
      ? '下載中…'
      : needsRuntime
        ? `${formatBytes(model.totalBytes)} · 需搭配「${runtimeLabel}」`
        : formatBytes(model.totalBytes)

  const name = document.createElement('p')
  name.className = 'model-name'
  name.textContent = model.label

  const size = document.createElement('p')
  size.className = model.downloaded ? 'model-size downloaded' : 'model-size'
  size.textContent = stateText

  const info = document.createElement('div')
  info.className = 'model-info'
  info.append(name, size)

  const actions = document.createElement('div')
  actions.className = 'model-actions'

  const row = document.createElement('div')
  row.className = 'model-row'
  row.append(info, actions)

  const progressFill = document.createElement('div')
  progressFill.className = 'model-progress-fill'
  const progress = document.createElement('div')
  progress.className = 'model-progress hidden'
  progress.appendChild(progressFill)

  item.append(row, progress)

  if (model.downloading) {
    actions.appendChild(actionBtn('取消', 'btn-secondary', () => electronAPI.models.cancel(model.key)))
    progress.classList.remove('hidden')
  } else if (model.downloaded) {
    actions.appendChild(actionBtn('📂', 'btn-secondary', () => void openModelsFolder(model.key)))
    actions.appendChild(deleteButton(model))
  } else {
    actions.appendChild(actionBtn('下載', 'btn-primary', () => startDownload(model)))
  }
  return item
}

function deleteButton(model) {
  const btn = actionBtn('刪除', 'btn-secondary', async () => {
    // 就地二次確認：模型動輒 1～2.7GB，誤點就要重新下載
    if (btn.dataset.armed !== '1') {
      btn.dataset.armed = '1'
      btn.classList.add('btn-danger')
      btn.textContent = '確定刪除？'
      setTimeout(() => {
        btn.dataset.armed = ''
        btn.classList.remove('btn-danger')
        btn.textContent = '刪除'
      }, 3000)
      return
    }
    try {
      const st = await electronAPI.engine.status()
      if (st.asrLoaded || st.llmLoaded) {
        showToast('請先停止字幕／轉錄再刪除模型', 'error')
        return
      }
      await electronAPI.models.delete(model.key)
      refreshRecommend()
    } catch (e) {
      showToast(`刪除失敗: ${cleanIpcError(e)}`, 'error')
    }
  })
  return btn
}

function actionBtn(text, cls, onClick) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `btn ${cls} btn-sm`
  btn.textContent = text
  btn.addEventListener('click', onClick)
  return btn
}

async function startDownload(model) {
  const promise = electronAPI.models.download(model.key)
  promise.catch(() => {}) // 先標記已處理，避免 refresh 期間出現 unhandled rejection
  await refreshRecommend() // 立刻顯示「下載中」狀態
  try {
    if (model.requires && !latestModels[model.requires]?.downloaded) {
      showToast('自動安裝這顆模型需要的執行環境')
      await electronAPI.models.download(model.requires)
    }
    await promise
  } catch (error) {
    const message = cleanIpcError(error)
    if (message.includes('已取消')) showToast('已取消下載')
    else showToast(`下載失敗: ${message}`, 'error')
  }
  await refreshRecommend()
}

function onModelProgress({ key, receivedBytes, totalBytes, stage }) {
  const percent = totalBytes > 0 ? Math.min(100, (receivedBytes / totalBytes) * 100) : 0
  // 解壓階段（main 送 stage）已經取消不了，文字照實講、取消鈕停用
  const text = stage || `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} (${percent.toFixed(0)}%)`
  const item = $('modelList')?.querySelector(`.model-item[data-key="${key}"]`)
  if (!item) return
  const progress = item.querySelector('.model-progress')
  progress.classList.remove('hidden')
  progress.querySelector('.model-progress-fill').style.width = percent + '%'
  item.querySelector('.model-size').textContent = text
  const cancelBtn = /** @type {HTMLButtonElement|null} */ (item.querySelector('.model-actions .btn'))
  if (cancelBtn && stage) cancelBtn.disabled = true
}

// ===== 推論方式（自動）=====

/**
 * 顯示自動偵測的推論方式與 CUDA 環境列
 * @param {boolean} [forceRefresh]
 */
export async function refreshInference(forceRefresh = false) {
  bindOnce()
  let cap
  try {
    cap = forceRefresh
      ? await electronAPI.system.refreshGpuCapability()
      : await electronAPI.system.gpuCapability()
  } catch {
    cap = { ok: false, reason: '無法偵測 GPU', hasCudaRuntime: false, canInstallCuda: false, backends: [] }
  }
  const backends = Array.isArray(cap?.backends) ? cap.backends.filter((b) => b !== 'cpu-fallback') : []
  const hint = $('hfInferHint')
  if (hint) {
    hint.textContent = cap?.ok
      ? `自動：GPU（${cap.name}，${cap.vramMiB} MiB${backends.length ? `，${backends.join(' / ')}` : ''}）。本地翻譯走 GPU。`
      : `自動：CPU（${cap?.reason || '沒有 8GB 以上的 NVIDIA 顯示卡'}）。`
  }

  const hasCuda = !!cap?.hasCudaRuntime
  $('cudaEnvRow')?.classList.toggle('hidden', !(cap?.ok || cap?.canInstallCuda))
  const status = $('cudaEnvStatus')
  if (status && !cudaInstallInProgress) {
    status.textContent = hasCuda
      ? 'CUDA Runtime：已就緒'
      : cap?.hasVulkan
        ? 'CUDA Runtime：未安裝（目前用 Vulkan，裝了會更快）'
        : 'CUDA Runtime：未安裝，建議安裝'
  }
  const btn = /** @type {HTMLButtonElement | null} */ ($('installCudaEnvBtn'))
  if (btn) {
    btn.disabled = cudaInstallInProgress || hasCuda || !cap?.canInstallCuda
    btn.textContent = hasCuda ? 'CUDA 已就緒' : '安裝 CUDA 環境'
  }
}

async function onInstallCudaEnv() {
  if (cudaInstallInProgress) return
  cudaInstallInProgress = true
  const btn = /** @type {HTMLButtonElement | null} */ ($('installCudaEnvBtn'))
  const status = $('cudaEnvStatus')
  const bar = $('cudaInstallProgress')
  const fill = $('cudaInstallProgressFill')
  if (btn) btn.disabled = true
  bar?.classList.remove('hidden')
  if (fill) fill.style.width = '5%'
  if (status) status.textContent = '準備安裝…將跳出系統管理員確認（UAC）'

  const unsub = electronAPI.system.onCudaInstallProgress?.((p) => {
    if (status && p?.message) status.textContent = p.message
    if (fill && typeof p?.percent === 'number') fill.style.width = `${Math.max(0, Math.min(100, p.percent))}%`
  })
  try {
    const result = await electronAPI.system.installCudaEnv()
    if (result?.ok) showToast(result.message || 'CUDA 環境已安裝')
    else showToast(result?.message || '安裝失敗', 'error')
  } catch (e) {
    showToast(`安裝失敗：${cleanIpcError(e)}`, 'error')
  } finally {
    cudaInstallInProgress = false
    if (typeof unsub === 'function') unsub()
    bar?.classList.add('hidden')
    if (fill) fill.style.width = '0%'
    await refreshInference(true)
  }
}
