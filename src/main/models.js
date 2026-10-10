/**
 * AxonDeck - 本地模型下載與管理（Main Process）
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const fsp = require('fs/promises')
const { downloadFile } = require('./hfmodels/download')
const { spawn } = require('child_process')
const { removeTreeSync } = require('./safe-rm')

/**
 * llama.cpp 執行環境版本（pin 住，不抓 latest：換版本要人看過 release note）
 * Windows Vulkan 版是自帶 CPU backend DLL 的完整包，任何有現代顯卡驅動的機器都能跑，
 * 不需要 CUDA／cuDNN。CUDA 版另外要 239MB＋373MB cudart，先不做第二套。
 */
const LLAMA_BUILD = 'b10666'
const BREEZE_BUILD = 'v0.1.0'
const BREEZE_DIR = `breeze-tts-2-${BREEZE_BUILD}-windows-x64-vulkan`

/**
 * 模型 registry
 * files 為相對於模型資料夾的路徑，自 base URL 直接下載（免解壓）
 * archive: true 表示下載到的是 zip，下載後解壓到模型資料夾根層
 * check: 有值時以「這些檔案都在」判定已安裝（archive 解壓後檔名跟下載名不同）
 */
const MODELS = {
  paddleocrvl16: {
    label: 'PaddleOCR-VL-1.6 · 文件辨識',
    kind: 'ocr',
    runtime: 'llama',
    requires: 'llamaruntime',
    description: '辨識文字、公式、表格與圖表，和翻譯模型共用 llama.cpp。',
    totalBytes: 1817539616,
    base: 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/',
    files: ['PaddleOCR-VL-1.6-GGUF.gguf', 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf'],
    gguf: 'PaddleOCR-VL-1.6-GGUF.gguf',
    mmproj: 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf',
    fileBytes: { 'PaddleOCR-VL-1.6-GGUF.gguf': 935769056, 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf': 881770560 },
    sha256: {
      'PaddleOCR-VL-1.6-GGUF.gguf': 'f3ae46ec885050acf4b3d31944431e1fd90d50664fb09126af4a3c050ba14ee8',
      'PaddleOCR-VL-1.6-GGUF-mmproj.gguf': '204d757d7610d9b3faab10d506d69e5b244e32bf765e2bab2d0167e65e0a058a'
    }
  },
  ppdoclayoutv3: {
    label: 'PP-DocLayoutV3 · 版面辨識',
    kind: 'ocr',
    runtime: 'pdf',
    requires: 'pdfruntime',
    description: '找出段落、公式、表格與圖表的位置。',
    totalBytes: 132004944,
    base: 'https://huggingface.co/PaddlePaddle/PP-DocLayoutV3/resolve/main/',
    files: ['inference.json', 'inference.pdiparams', 'inference.yml'],
    fileBytes: { 'inference.json': 1196890, 'inference.pdiparams': 130806572, 'inference.yml': 1482 },
    sha256: {
      'inference.json': '2b68367c5b312a03de5a6e1642c597c8f95165a7e40cd59c6700cf4a5042f4fd',
      'inference.pdiparams': '70bd316b0582769ec968829fd1feb1a6a58b7c941b938327e551b6b12b45c137',
      'inference.yml': '506fcfac13b3b546ae40d7886b44126420f392adb694e3f8bb6a6286a1f90fdc'
    }
  },
  pdfruntime: {
    label: 'PDF 文件執行環境（PaddleOCR / PyMuPDF）',
    kind: 'runtime',
    runtime: 'pdf',
    description: '自帶 Python；版面辨識走 CPU，文字辨識共用 llama.cpp。',
    totalBytes: 800000000,
    files: []
  },
  breezetts2q8: {
    label: 'Breeze-TTS-2 · Q8_0',
    kind: 'tts',
    runtime: 'breeze',
    requires: 'breezeruntime',
    description: '中英文語音生成、聲音設計、語音克隆、語氣指導、聲音收藏、串流與實驗性語音轉換。',
    licenseUrl: 'https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE',
    totalBytes: 3568844480,
    base: 'https://huggingface.co/HoppouAI/Breeze-TTS-2.cpp/resolve/main/',
    files: ['breeze-tts-2-q8_0.gguf'],
    gguf: 'breeze-tts-2-q8_0.gguf',
    sha256: { 'breeze-tts-2-q8_0.gguf': 'a02bcc4b69b0601032727f8040c4942149b1b73aa0f69022fe5aaa6a8f0ef879' }
  },
  breezeruntime: {
    label: `Breeze-TTS-2 執行環境（${BREEZE_BUILD}）`,
    kind: 'runtime',
    runtime: 'breeze',
    description: '語音生成專用；Vulkan 與 CPU，和 llama.cpp 分開。',
    totalBytes: 73809893,
    base: `https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/download/${BREEZE_BUILD}/`,
    files: [`${BREEZE_DIR}.zip`],
    archive: true,
    check: ['breeze-server.exe', 'breeze-cli.exe', 'libbreeze.dll'].map(name => `${BREEZE_DIR}/${name}`),
    binary: `${BREEZE_DIR}/breeze-server.exe`,
    sha256: { [`${BREEZE_DIR}.zip`]: '1c5178577a9fb90e84b43269880d17acafd466030abf615c6df4ccc163eac0d8' }
  },
  qwen3asr: {
    label: 'Qwen3-ASR 0.6B · Q8_0',
    kind: 'asr',
    runtime: 'llama',
    totalBytes: 1019141728,
    base: 'https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/main/',
    files: [
      'Qwen3-ASR-0.6B-Q8_0.gguf', 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf'
    ],
    gguf: 'Qwen3-ASR-0.6B-Q8_0.gguf',
    mmproj: 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf',
    requires: 'llamaruntime'
  },
  /** 大顆的那個：跟 0.6B 共用同一顆 llama-server（CUDA 或 Vulkan 擇一） */
  qwen3asrgpu: {
    label: 'Qwen3-ASR 1.7B · Q8_0',
    kind: 'asr',
    runtime: 'llama',
    totalBytes: 2520744288,
    base: 'https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF/resolve/main/',
    files: ['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf'],
    gguf: 'Qwen3-ASR-1.7B-Q8_0.gguf',
    mmproj: 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
    requires: 'llamaruntime'
  },
  /**
   * 同一版的 CUDA 建置（可選）。NVIDIA 卡上 prompt 處理與 MoE offload 明顯快過 Vulkan，
   * 代價是要多下載一份 CUDA runtime。
   *
   * **兩個 zip 解到同一個資料夾**：llama 那包不含 CUDA runtime DLL，少了 cudart
   * `llama-server.exe` 會在啟動時因為找不到 DLL 而直接結束（沒有可讀的錯誤訊息）。
   * CUDA 13.x 需要 NVIDIA 驅動 ≥ 580；UI 只在偵測到夠新的驅動時才建議裝。
   *
   * ponytail: `check` 只認 llama 那包的檔案（zip 內容清單拿不到，cudart 的 DLL 檔名
   * 隨 CUDA 小版本會變）。cudart 沒解開的症狀是「啟動失敗」，`runtime.js` 的
   * stderr 尾巴看得到，不會靜默錯。
   */
  llamaruntimecuda: {
    label: `llama.cpp 執行環境 · CUDA 13.3（${LLAMA_BUILD}）`,
    kind: 'runtime',
    totalBytes: 537_500_000,
    base: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/`,
    files: [
      `llama-${LLAMA_BUILD}-bin-win-cuda-13.3-x64.zip`,
      'cudart-llama-bin-win-cuda-13.3-x64.zip'
    ],
    archive: true,
    check: ['llama-server.exe', 'ggml-cuda.dll'],
    binary: 'llama-server.exe'
  },
  /** GPU ASR 的執行檔（llama-server）；zip 內是扁平結構，解壓即用 */
  llamaruntime: {
    label: `llama.cpp 執行環境 · Vulkan（${LLAMA_BUILD}）`,
    kind: 'runtime',
    totalBytes: 34478547,
    base: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/`,
    files: [`llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`],
    archive: true,
    check: ['llama-server.exe', 'ggml-vulkan.dll', 'mtmd.dll'],
    binary: 'llama-server.exe'
  },
  /** 微調：繁中／英文／日文三語翻譯（v5e Q4_K_M） */
  linguaforge08q4: {
    label: 'LinguaForge 0.8B · Q4_K_M（繁中/英/日）',
    kind: 'llm',
    requires: 'llamaruntime',
    totalBytes: 529296832,
    base: 'https://huggingface.co/RX5950XT/LinguaForge-Qwen3.5-0.8B-zhTW-en-ja/resolve/main/',
    files: ['gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'],
    gguf: 'gguf-v5e/linguaforge-v5e-0.8b-Q4_K_M.gguf'
  },
  /** IndexTeam 官方 GGUF：Qwen3.5 2B 微調的 150 語翻譯模型（只用文字，不下 mmproj） */
  indextranslate2b: {
    label: 'Index-Translate 2B · Q4_K_M（多語）',
    kind: 'llm',
    requires: 'llamaruntime',
    totalBytes: 1312164352,
    base: 'https://huggingface.co/IndexTeam/Index-Translate-2B-GGUF/resolve/main/',
    files: ['Index-Translate-2B.Q4_K_M.gguf'],
    gguf: 'Index-Translate-2B.Q4_K_M.gguf'
  }
}

/** 本地翻譯模型 key 白名單（順序：推薦在前） */
const LLM_MODEL_KEYS = ['linguaforge08q4', 'indextranslate2b']

/** 本地 ASR 模型 key 白名單（順序：推薦在前） */
const ASR_MODEL_KEYS = ['qwen3asr', 'qwen3asrgpu']

/** 只有 GGUF OCR 送進 router；版面模型由 PDF 執行環境載入。 */
const OCR_MODEL_KEYS = ['paddleocrvl16']

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isLlmKey(key) {
  return typeof key === 'string' && LLM_MODEL_KEYS.includes(key)
}

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isAsrKey(key) {
  return typeof key === 'string' && ASR_MODEL_KEYS.includes(key)
}

/** 已下架的 key → 現行 key（舊使用者存過的設定要讀得回來） */
const RETIRED_MODEL_KEYS = Object.freeze({
  linguaforge08: 'linguaforge08q4',
  qwen35translate: 'indextranslate2b',
  qwen354b: 'indextranslate2b'
})

/**
 * @param {unknown} key
 * @returns {unknown} 非下架 key 原樣回傳（含非字串，交給呼叫端的白名單擋）
 */
function migrateModelKey(key) {
  return (typeof key === 'string' && RETIRED_MODEL_KEYS[key]) || key
}

/**
 * GGUF 相對路徑（相對 modelDir）
 * @param {string} key
 * @returns {string | null}
 */
function ggufRelativePath(key) {
  const def = MODELS[key]
  if (!def || !def.gguf) return null
  return def.gguf
}

/**
 * 檔案絕對路徑（modelDir + registry 內的相對路徑欄位）
 * @param {string} key
 * @param {'gguf'|'mmproj'|'binary'} field
 * @returns {string | null}
 */
function filePath(key, field) {
  const rel = MODELS[key]?.[field]
  return typeof rel === 'string' && rel ? path.join(modelDir(key), rel) : null
}

// 進行中的下載（key → AbortController）
const activeDownloads = new Map()

/**
 * 模型存放根目錄
 */
function modelsRoot() {
  return path.join(app.getPath('userData'), 'models')
}

/**
 * 單一模型的資料夾
 */
function modelDir(key) {
  return path.join(modelsRoot(), key)
}

/**
 * 模型是否已完整下載
 * archive 型別解壓後的檔名跟下載名不同，所以判定看 `check` 而不是 `files`
 */
function isDownloaded(key) {
  const def = MODELS[key]
  if (!def) return false
  if (def.runtime === 'pdf' && def.kind === 'runtime') {
    return !activeDownloads.has(key) && require('./pdf-translate/runtime').isReady(modelDir(key))
  }
  if (def.kind === 'ocr' && activeDownloads.has(key)) return false
  if (def.kind === 'tts' && activeDownloads.has(key)) return false
  const want = def.check || def.files
  return want.every(f => {
    const target = path.join(modelDir(key), f)
    if (def.fileBytes?.[f]) {
      try { return fs.statSync(target).isFile() && fs.statSync(target).size === def.fileBytes[f] }
      catch { return false }
    }
    if (def.runtime !== 'breeze') return fs.existsSync(target)
    try {
      const stat = fs.statSync(target)
      return stat.isFile() && stat.size > 0 && (def.archive || stat.size === def.totalBytes)
    } catch { return false }
  })
}

/**
 * 全部模型狀態
 */
function status() {
  const result = {}
  for (const [key, def] of Object.entries(MODELS)) {
    result[key] = {
      key,
      label: def.label,
      kind: def.kind,
      totalBytes: def.totalBytes,
      requires: def.requires || null,
      description: def.description || '',
      licenseUrl: def.licenseUrl || '',
      downloaded: isDownloaded(key),
      downloading: activeDownloads.has(key)
    }
  }
  return { models: result, root: modelsRoot() }
}

/**
 * PowerShell 單引號字串裡的 `'` 要寫成 `''`（使用者名稱含單引號時路徑會帶進來）
 * @param {string} s
 * @returns {string}
 */
function psQuote(s) {
  return s.replace(/'/g, "''")
}

/**
 * 解壓 zip 到模型資料夾根層，成功後刪掉 zip。
 * 用 PowerShell 的 Expand-Archive：Windows 內建，不必為了一次解壓加一個依賴。
 * @param {string} zipPath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function expandArchive(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${psQuote(zipPath)}' -DestinationPath '${psQuote(destDir)}' -Force`
      ],
      { windowsHide: true, stdio: 'ignore' }
    )
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`解壓失敗（結束碼 ${code}）`))
    })
  })
}

/**
 * 下載模型（逐檔下載，onProgress 回報累計進度）
 * @param {string} key
 * @param {(p: {key: string, receivedBytes: number, totalBytes: number}) => void} onProgress
 */
async function download(key, onProgress) {
  const def = MODELS[key]
  if (!def) throw new Error(`未知的模型: ${key}`)
  if (activeDownloads.has(key)) throw new Error('此模型正在下載中')

  const controller = new AbortController()
  activeDownloads.set(key, controller)

  let received = 0
  let lastEmit = 0
  const emit = (force) => {
    const now = Date.now()
    if (!force && now - lastEmit < 300) return
    lastEmit = now
    onProgress({ key, receivedBytes: received, totalBytes: def.totalBytes })
  }

  try {
    if (def.runtime === 'pdf' && def.kind === 'runtime') {
      await require('./pdf-translate/runtime').install({ dir: modelDir(key), signal: controller.signal,
        onProgress: progress => onProgress({ key, receivedBytes: 0, totalBytes: def.totalBytes,
          ...progress, cancellable: true }) })
      activeDownloads.delete(key)
      return status()
    }
    const dependency = key === 'paddleocrvl16' ? 'ppdoclayoutv3'
      : (def.runtime === 'breeze' || (def.runtime === 'pdf' && def.kind === 'ocr')) ? def.requires : null
    if (dependency && (!isDownloaded(dependency)
      || (key === 'paddleocrvl16' && !isDownloaded('pdfruntime')))) {
      const cancelDependency = () => cancelDownload(dependency)
      controller.signal.addEventListener('abort', cancelDependency, { once: true })
      try {
        await download(dependency, progress => {
          onProgress(progress)
          onProgress({ key, receivedBytes: 0, totalBytes: def.totalBytes,
            stage: key === 'paddleocrvl16' ? '準備 PDF 辨識模型與執行環境…'
              : def.runtime === 'pdf' ? '準備 PDF 執行環境…' : '準備語音執行環境…',
            cancellable: progress.cancellable ?? !progress.stage })
        })
      }
      finally { controller.signal.removeEventListener('abort', cancelDependency) }
      if (controller.signal.aborted) throw new Error('下載已取消')
    }
    for (const file of def.files) {
      const dest = path.join(modelDir(key), file)
      await fsp.mkdir(path.dirname(dest), { recursive: true })

      if (!def.sha256?.[file] && fs.existsSync(dest)) {
        received += (await fsp.stat(dest)).size
        emit(true)
        continue
      }

      const completed = received
      const result = await downloadFile({
        url: def.base + file,
        dest,
        expectedBytes: def.fileBytes?.[file] || (def.sha256?.[file] && def.files.length === 1 ? def.totalBytes : undefined),
        sha256: def.sha256?.[file],
        signal: controller.signal,
        onProgress: (info) => {
          received = completed + info.received
          emit()
        }
      })
      received = completed + result.bytes
      emit(true)
    }

    if (def.archive) {
      onProgress({ key, receivedBytes: def.totalBytes, totalBytes: def.totalBytes, stage: '解壓中…' })
      for (const file of def.files) {
        const zipPath = path.join(modelDir(key), file)
        await expandArchive(zipPath, modelDir(key))
        await fsp.rm(zipPath, { force: true })
      }
      if (!isDownloaded(key)) throw new Error('解壓完成但缺少必要檔案')
    }
  } catch (err) {
    // .part 留給下次續傳；只有明確移除模型時才一併刪掉。
    if (err.name === 'AbortError') throw new Error('下載已取消')
    throw err
  } finally {
    activeDownloads.delete(key)
  }

  return status()
}

/**
 * 取消下載
 */
function cancelDownload(key) {
  const controller = activeDownloads.get(key)
  if (controller) controller.abort()
  return true
}

/**
 * 刪除模型（先取消下載，避免寫入與 rm 競態）
 */
async function remove(key) {
  if (!MODELS[key]) throw new Error(`未知的模型: ${key}`)
  if (activeDownloads.has(key)) {
    cancelDownload(key)
    // 等 download 的 finally 清掉 activeDownloads（最多等幾秒）
    const deadline = Date.now() + 15000
    while (activeDownloads.has(key) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  removeTreeSync(modelDir(key))
  return status()
}

/**
 * 路徑必須落在 models 根目錄內（防 openFolder 路徑遍歷）
 * @param {string} dir
 */
function assertUnderModelsRoot(dir) {
  const root = path.resolve(modelsRoot())
  const resolved = path.resolve(dir)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('非法路徑')
  }
}

/**
 * 模型資料夾的路徑（不存在就先建）。由 renderer 用 App 自己的「檔案」頁開，不叫系統檔案總管。
 * @param {string} [key] 省略則開 models 根目錄；否則必須是 registry 內 key
 * @returns {Promise<string>}
 */
async function openFolder(key) {
  if (key && !MODELS[key]) throw new Error(`未知的模型: ${key}`)
  const dir = key ? modelDir(key) : modelsRoot()
  assertUnderModelsRoot(dir)
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

module.exports = {
  MODELS,
  LLM_MODEL_KEYS,
  ASR_MODEL_KEYS,
  OCR_MODEL_KEYS,
  LLAMA_BUILD,
  isLlmKey,
  isAsrKey,
  RETIRED_MODEL_KEYS,
  migrateModelKey,
  ggufRelativePath,
  filePath,
  modelDir,
  isDownloaded,
  status,
  download,
  cancelDownload,
  remove,
  openFolder
}
