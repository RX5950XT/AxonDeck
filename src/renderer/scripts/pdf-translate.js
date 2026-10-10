import { electronAPI, cleanIpcError, switchPage } from './app.js'

let el
let file = null
let job = null
let ready = false
let pending = false
let previousJobId = null
let revision = 0
let getLanguages
let onStateChange = () => {}

export function getPdfFile() { return file }
export function isPdfRunning() { return job?.state === 'running' }
export function isPdfReady() { return ready }

function setError(message = '') {
  el.error.textContent = message
  el.error.hidden = !message
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function paint() {
  const running = isPdfRunning()
  el.root.setAttribute('aria-busy', running ? 'true' : 'false')
  el.pick.disabled = pending || running
  el.chip.hidden = !file
  el.remove.hidden = !file || running
  if (file) el.file.textContent = `${file.name} · ${formatSize(file.size)}`
  el.setup.hidden = ready || !file
  const missing = el.setupText.dataset.missing
  if (file && !ready) {
    el.setupText.textContent = missing
      ? `尚缺：${missing}。可到 Local SI 安裝；翻譯模型沿用上方選擇。`
      : '請到 Local SI 安裝文件辨識模型與執行環境，並確認上方翻譯模型已就緒。'
  }
  el.progress.hidden = !job
  el.progress.max = job?.pages > 0 ? job.pages : 1
  if (job?.pages > 0) el.progress.value = job.state === 'done' ? job.pages : Math.min(job.page || 0, job.pages)
  else el.progress.removeAttribute('value')
  const stages = { opening: '開啟文件', ocr: '辨識文字與版面', translate: '翻譯文字', render: '排回 PDF', saving: '產生 PDF' }
  const done = job?.translatedBlocks > 0
    ? `已翻譯 ${job.translatedBlocks} 處文字，可以另存 PDF`
    : '檔案處理完成，但未成功翻譯文字；請核對內容。'
  const states = { done, failed: '檔案翻譯失敗', cancelled: '已停止翻譯' }
  const pages = job?.pages > 0 ? ` · ${job.page || 0} / ${job.pages} 頁` : ''
  el.status.hidden = !job
  if (job) {
    el.status.textContent = running
      ? `${stages[job.stage] || '處理檔案'}${pages}`
      : states[job?.state] || ''
  }
  const warningLabels = {
    overflow: '譯文放不下，已保留原文',
    untranslated: '部分文字未能轉換，已保留原文',
    unsupported: '旋轉的文字尚無法替換，已保留原文',
    spotting: '文字位置不可靠，已保留原文',
    small_text: '為配合原版面，部分譯文已縮小字體'
  }
  el.warnings.replaceChildren(...(job?.warnings || []).map((warning) => {
    const li = document.createElement('li')
    li.textContent = typeof warning === 'string' ? warning
      : `${warningLabels[warning.code] || '部分內容需要核對'}（${warning.count} 處）`
    return li
  }))
  el.warnings.hidden = !el.warnings.children.length
  el.save.hidden = job?.state !== 'done'
  el.save.disabled = pending
  onStateChange()
}

export async function refreshPdfTranslate() {
  if (!el || pending || !electronAPI.pdfTranslate) return
  const version = revision
  try {
    const result = await electronAPI.pdfTranslate.status()
    if (version !== revision || pending) return
    if (!result.ok) throw new Error(result.error?.message || '無法確認檔案翻譯狀態')
    file = result.data.file
    job = result.data.job
    ready = result.data.ready
    el.setupText.dataset.missing = (result.data.missing || []).join('、')
    setError(job?.error || '')
    paint()
  } catch (error) {
    if (version !== revision) return
    ready = false
    setError(cleanIpcError(error))
    paint()
  }
}

async function selectFile(path) {
  if (pending || isPdfRunning()) return
  pending = true
  revision++
  setError()
  paint()
  try {
    const result = path
      ? await electronAPI.pdfTranslate.inspect(path)
      : await electronAPI.pdfTranslate.pick()
    if (!result.ok) throw new Error(result.error?.message || '無法開啟檔案')
    if (result.data) {
      file = result.data
      job = null
    }
  } catch (error) {
    setError(cleanIpcError(error))
  } finally {
    pending = false
    paint()
  }
}

export function detachPdfFile() {
  if (pending || isPdfRunning() || !file) return false
  file = null
  job = null
  setError()
  paint()
  return true
}

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('無法讀取剪貼簿圖片'))
    reader.readAsDataURL(blob)
  })
}

// 剪貼簿圖片沒有路徑：讀成 data: 交給 main 落暫存再驗（跟拖放同一條驗證）。
async function attachPastedImage(image) {
  pending = true
  revision++
  setError()
  paint()
  try {
    const result = await electronAPI.pdfTranslate.pasteImage({ name: image.name, dataUrl: await readAsDataUrl(image) })
    if (!result.ok) throw new Error(result.error?.message || '無法使用剪貼簿圖片')
    if (result.data) {
      file = result.data
      job = null
    }
  } catch (error) {
    setError(cleanIpcError(error))
  } finally {
    pending = false
    paint()
  }
}

export async function startPdfJob() {
  if (pending || isPdfRunning() || !file || !ready) return false
  pending = true
  revision++
  previousJobId = job?.jobId
  job = null
  setError()
  paint()
  try {
    const result = await electronAPI.pdfTranslate.start({ fileId: file.fileId, ...getLanguages() })
    if (!result.ok) throw new Error(result.error?.message || '無法開始檔案翻譯')
    // 進度可能比 start 的回覆更早到；不要把完成狀態蓋回處理中。
    if (job?.jobId !== result.data.jobId) job = { jobId: result.data.jobId, state: 'running' }
    return true
  } catch (error) {
    setError(cleanIpcError(error))
    return false
  } finally {
    pending = false
    paint()
  }
}

export async function cancelPdfJob() {
  if (pending || !isPdfRunning()) return false
  pending = true
  revision++
  paint()
  try {
    const result = await electronAPI.pdfTranslate.cancel(job.jobId)
    if (!result.ok) throw new Error(result.error?.message || '無法停止檔案翻譯')
    return true
  } catch (error) {
    setError(cleanIpcError(error))
    return false
  } finally {
    pending = false
    paint()
    await refreshPdfTranslate()
  }
}

async function save() {
  if (pending || job?.state !== 'done') return
  pending = true
  let savedName = ''
  setError()
  paint()
  try {
    const result = await electronAPI.pdfTranslate.save(job.jobId)
    if (!result.ok) throw new Error(result.error?.message || '無法儲存 PDF')
    if (result.data.saved) savedName = result.data.name
  } catch (error) {
    setError(cleanIpcError(error))
  } finally {
    pending = false
    paint()
    if (savedName) el.status.textContent = `已儲存：${savedName}`
  }
}

const ACCEPT = /\.(pdf|png|jpe?g|webp|bmp|tiff?)$/i

export function initPdfTranslate(options) {
  getLanguages = options.getLanguages
  if (typeof options.onStateChange === 'function') onStateChange = options.onStateChange
  const pane = document.getElementById(options.dropTarget || 'translateInputPane')
  el = Object.fromEntries(['root', 'pick', 'remove', 'chip', 'file', 'status', 'progress', 'warnings', 'error', 'setup', 'setupText', 'models', 'save']
    .map((key) => [key, document.getElementById(`pdfTranslate${key[0].toUpperCase()}${key.slice(1)}`)]))
  if (!el.root) return
  if (!electronAPI.pdfTranslate) {
    setError('檔案翻譯尚未可用。')
    return
  }
  el.pick.addEventListener('click', () => selectFile())
  el.remove.addEventListener('click', detachPdfFile)
  el.save.addEventListener('click', save)
  el.models.addEventListener('click', () => switchPage('hfmodels'))
  if (pane) {
    pane.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      const allowed = !pending && !isPdfRunning()
      event.dataTransfer.dropEffect = allowed ? 'copy' : 'none'
      pane.classList.toggle('is-dragover', allowed)
    })
    pane.addEventListener('dragleave', (event) => {
      if (!pane.contains(event.relatedTarget)) pane.classList.remove('is-dragover')
    })
    pane.addEventListener('drop', (event) => {
      event.preventDefault()
      pane.classList.remove('is-dragover')
      if (pending || isPdfRunning()) return
      const files = [...(event.dataTransfer?.files || [])]
      if (files.length !== 1 || !ACCEPT.test(files[0].name)) {
        setError('一次請拖入一份 PDF 或圖片檔。')
        return
      }
      try {
        const path = electronAPI.getPathForFile(files[0])
        if (!path) throw new Error('無法取得檔案位置，請改用「＋ 檔案」。')
        selectFile(path)
      } catch (error) {
        setError(cleanIpcError(error))
      }
    })
    pane.addEventListener('paste', (event) => {
      const images = [...(event.clipboardData?.files || [])].filter((item) => item.type.startsWith('image/'))
      if (!images.length) return
      // 純文字照常進入輸入框：不吃字，只在能接時攔下圖片。
      if (images.length !== 1 || pending || isPdfRunning()) {
        setError(images.length !== 1 ? '一次請貼上一張圖片。' : '檔案處理中，稍後再貼上。')
        return
      }
      event.preventDefault()
      attachPastedImage(images[0])
    })
  }
  electronAPI.pdfTranslate.onProgress((progress) => {
    if (!progress?.jobId || (job && job.jobId !== progress.jobId) || (!job && !pending)) return
    if (!job && progress.jobId === previousJobId) return
    if (job && job.state !== 'running' && progress.state === 'running') return
    job = progress
    revision++
    setError(progress.error || '')
    paint()
  })
  document.addEventListener('settings-changed', refreshPdfTranslate)
  paint()
  refreshPdfTranslate()
}
