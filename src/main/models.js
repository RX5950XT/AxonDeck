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
/**
 * Linux CUDA 另外 pin：llama.cpp 官方 release 從 b10988（2026-09-15）才開始附 Ubuntu CUDA 產物
 * （`llama-*-bin-ubuntu-cuda-13.3-<arch>.tar.gz`＋`cudart-llama-*-bin-ubuntu-cuda-13.3-<arch>.tar.gz`），
 * b10666 只有 Windows CUDA。取第一個有官方 Linux CUDA 的版本，跟 b10666 差最少；Vulkan 仍是 b10666。
 */
const LLAMA_BUILD_LINUX_CUDA = 'b10988'
const BREEZE_BUILD = 'v0.1.0'
/**
 * Breeze-TTS-2 官方預建：Windows x64 zip、Linux x64 tar.gz（glibc ≥ 2.35，需 libvulkan1；沒 GPU 會退 CPU）。
 * 官方沒有 Linux arm64／macOS 產物，這些平台不列 Breeze。
 */
function breezeRuntime() {
  if (HOST.platform === 'win32') {
    const dir = `breeze-tts-2-${BREEZE_BUILD}-windows-x64-vulkan`
    return { dir, file: `${dir}.zip`, totalBytes: 73809893,
      check: ['breeze-server.exe', 'breeze-cli.exe', 'libbreeze.dll'], binary: 'breeze-server.exe',
      sha256: '1c5178577a9fb90e84b43269880d17acafd466030abf615c6df4ccc163eac0d8' }
  }
  if (HOST.platform === 'linux' && HOST.arch === 'x64') {
    const dir = `breeze-tts-2-${BREEZE_BUILD}-linux-x64-vulkan`
    return { dir, file: `${dir}.tar.gz`, totalBytes: 72195854,
      check: ['breeze-server', 'breeze-cli'], binary: 'breeze-server',
      sha256: '41f309bea160cdeb3c01721f97ea66125b4047a5726b01fd5559f1abb608b2a0' }
  }
  return null
}

/**
 * Miroxen 的模型都放在同一個 `models/miroxen/`（引擎用 `--models` 指過去，資料夾結構照 Miroxen README）。
 * 圖片標準版與 Turbo 共用文字／視覺編碼器、VAE 與 tokenizer：檔案在了就不重下，刪除時只刪沒人用的。
 * 每個檔案固定 revision＋SHA-256；本機檔名照 Miroxen 的預設（上游檔名不同時下載後改名）。
 */
const HF = (repo, rev, file) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`
const QI = 'image/qwen-image-2.1/'
const H3 = 'video/minimax-h3/'
const QI_SHARED = [
  [`${QI}Qwen-Image-2.1-Turbo-Abliterated-Uncensored-AD-Q4_K.gguf`, HF('AtomicChat/Qwen-Image-2.1-Turbo-Abliterated-Uncensored-GGUF',
    'df96693dbdfb8738c0bf1bbd0337d149808db948', 'Qwen-Image-2.1-Turbo-Uncensored-AD-Q4_K.gguf'),
  5287517120, '8123f36d2b3e562deef164dffdae33bdb1d152797ad10bb630827eaa7bce795d'],
  [`${QI}mmproj-Qwen3VL-8B-Instruct-F16.gguf`, HF('Qwen/Qwen3-VL-8B-Instruct-GGUF', 'f982a07559d4a2f6c8744d840bf6fccab30eea96',
    'mmproj-Qwen3VL-8B-Instruct-F16.gguf'), 1159029824, 'ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38'],
  [`${QI}vae/texture_fix_vae_for_qwen_image_2.1_bf16.safetensors`, HF('madebyollin/texture-fix-vae-for-qwen-image-2.1',
    '1f80456b6de9d89043c133ff1f3875449b8bd016', 'texture_fix_vae_for_qwen_image_2.1_bf16.safetensors'),
  675509688, '05e9af8da4697d1a5118b674c3d90e95f932702d2c5a8900d7d4f05076403cc7'],
  [`${QI}hf/processor/tokenizer.json`, HF('Qwen/Qwen-Image-2.1', 'd26bb61231c349cf6b7896fa83353113880e1ba3', 'processor/tokenizer.json'),
    11422654, 'aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4']
]
const H3_REV = 'd629413c2e5b51b38c453668b75ca3b06ca92703'
const H3_HF_REV = '42ed227ee7df40d41602854ae760620d6eb651fe'
const H3_LORA_REV = 'a29e57d195f80ead07c89f89e55ecf2911e893c5'

/**
 * @param {Array<[string, string, number, string]>} list [本機相對路徑, 下載網址, 位元組, SHA-256]
 */
function miroxenFiles(list) {
  return {
    dir: 'miroxen',
    runtime: 'miroxen',
    requires: 'miroxenruntime',
    kind: 'imagegen',
    totalBytes: list.reduce((sum, [, , bytes]) => sum + bytes, 0),
    files: list.map(([file]) => file),
    urls: Object.fromEntries(list.map(([file, url]) => [file, url])),
    fileBytes: Object.fromEntries(list.map(([file, , bytes]) => [file, bytes])),
    sha256: Object.fromEntries(list.map(([file, , , sha]) => [file, sha]))
  }
}

/**
 * 模型 registry
 * files 為相對於模型資料夾的路徑，自 base URL 直接下載（免解壓）
 * archive: true 表示下載到的是 zip，下載後解壓到模型資料夾根層
 * check: 有值時以「這些檔案都在」判定已安裝（archive 解壓後檔名跟下載名不同）
 */

/** 執行平台；測試用 vm 沙盒沒有 process 時視為原本的 Windows 行為。 */
const HOST = (typeof process === 'object' && process) ? process : { platform: 'win32', arch: 'x64' }

/**
 * llama.cpp 官方 release 依平台選產物；非 win32 絕不下 Windows zip。
 * @returns {{ files: string[], check: string[], binary: string, totalBytes: number, labelSuffix: string }}
 */
function llamaVulkanRuntime() {
  if (HOST.platform === 'win32') {
    return {
      labelSuffix: 'Vulkan',
      totalBytes: 34478547,
      files: [`llama-${LLAMA_BUILD}-bin-win-vulkan-x64.zip`],
      check: ['llama-server.exe', 'ggml-vulkan.dll', 'mtmd.dll'],
      binary: 'llama-server.exe'
    }
  }
  if (HOST.platform === 'linux') {
    const arch = HOST.arch === 'arm64' ? 'arm64' : 'x64'
    return {
      labelSuffix: 'Vulkan',
      totalBytes: 33_000_000,
      files: [`llama-${LLAMA_BUILD}-bin-ubuntu-vulkan-${arch}.tar.gz`],
      check: ['llama-server'],
      binary: 'llama-server',
      // 官方 tar.gz 外面包一層 `llama-bXXXX/`；不剝掉 llama-server 會落在子資料夾、判定成「缺少必要檔案」
      stripComponents: 1
    }
  }
  // darwin
  const arch = HOST.arch === 'arm64' ? 'arm64' : 'x64'
  return {
    labelSuffix: 'Metal／CPU',
    totalBytes: 11_000_000,
    files: [`llama-${LLAMA_BUILD}-bin-macos-${arch}.tar.gz`],
    check: ['llama-server'],
    binary: 'llama-server'
  }
}

function llamaCudaRuntime() {
  if (HOST.platform === 'linux') return llamaCudaRuntimeLinux()
  if (HOST.platform !== 'win32') return null
  return {
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
  }
}

/**
 * Linux CUDA：llama 那包＋cudart 那包（libcudart／libcublas／libcublasLt）解到同一層。
 * `llama-server` 與 `libggml-cuda.so` 的 RUNPATH 是 `$ORIGIN`，不用設 LD_LIBRARY_PATH；
 * `libcuda.so.1` 來自 NVIDIA 驅動（≥ 580，CUDA 13.x）。沒有驅動時 CUDA 後端載不起來，llama 退回 CPU。
 */
function llamaCudaRuntimeLinux() {
  const arch = HOST.arch === 'arm64' ? 'arm64' : 'x64'
  const sizes = arch === 'arm64' ? 145_000_065 + 518_393_301 : 149_162_456 + 410_248_850
  return {
    label: `llama.cpp 執行環境 · CUDA 13.3（${LLAMA_BUILD_LINUX_CUDA}）`,
    kind: 'runtime',
    totalBytes: sizes,
    base: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD_LINUX_CUDA}/`,
    files: [
      `llama-${LLAMA_BUILD_LINUX_CUDA}-bin-ubuntu-cuda-13.3-${arch}.tar.gz`,
      `cudart-llama-${LLAMA_BUILD_LINUX_CUDA}-bin-ubuntu-cuda-13.3-${arch}.tar.gz`
    ],
    archive: true,
    stripComponents: 1,
    check: ['llama-server', 'libggml-cuda.so', 'libcudart.so.13'],
    binary: 'llama-server'
  }
}

const _llamaVulkan = llamaVulkanRuntime()
const _llamaCuda = llamaCudaRuntime()
const _breeze = breezeRuntime()

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
  // PDF 版面翻譯的 Python 執行環境只鎖了 Windows wheel（paddlepaddle win_amd64＋uv.exe），其他平台不列
  ...(HOST.platform === 'win32' ? {
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
  pdfruntimegpu: {
    label: 'PDF GPU 加速（NVIDIA）',
    kind: 'runtime',
    runtime: 'pdf',
    gpu: true,
    description: '版面辨識改用顯示卡，約快 45 倍（整份 PDF 約快 2～3 倍）；裝了就自動使用，約 2.5 GB 下載、5 GB 空間。',
    totalBytes: 5000000000,
    files: []
  },
  } : {}),
  ...(_breeze ? {
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
    totalBytes: _breeze.totalBytes,
    base: `https://github.com/HoppouAI/Breeze-TTS-2.cpp/releases/download/${BREEZE_BUILD}/`,
    files: [_breeze.file],
    archive: true,
    check: _breeze.check.map(name => `${_breeze.dir}/${name}`),
    binary: `${_breeze.dir}/${_breeze.binary}`,
    sha256: { [_breeze.file]: _breeze.sha256 }
  },
  } : {}),
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
  ...(_llamaCuda ? { llamaruntimecuda: _llamaCuda } : {}),
  /** GPU ASR 的執行檔（llama-server）；archive 內是扁平結構，解壓即用 */
  llamaruntime: {
    label: `llama.cpp 執行環境 · ${_llamaVulkan.labelSuffix}（${LLAMA_BUILD}）`,
    kind: 'runtime',
    totalBytes: _llamaVulkan.totalBytes,
    base: `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/`,
    files: _llamaVulkan.files,
    archive: true,
    check: _llamaVulkan.check,
    binary: _llamaVulkan.binary,
    ...(_llamaVulkan.stripComponents ? { stripComponents: _llamaVulkan.stripComponents } : {})
  },
  // Miroxen 只有 Windows 版（miroxen-win-x64.zip＋cuBLAS DLL），其他平台不列引擎也不列生成模型
  ...(HOST.platform === 'win32' ? {
  /** Miroxen 引擎：跟著 GitHub latest release 走（`miroxen/runtime.js` 自己裝），只給 CUDA 13 驅動的 NVIDIA 卡 */
  miroxenruntime: {
    label: 'Miroxen 圖片影像引擎',
    kind: 'runtime',
    runtime: 'miroxen',
    description: '圖片與影音生成專用；NVIDIA RTX 30／40／50（驅動 580 以上），Miroxen 發新版可直接更新。',
    totalBytes: 700000000,
    files: []
  },
  miroxenqwenturbo: {
    label: 'Qwen-Image-2.1 Turbo · 圖片（8 步）',
    description: '文字生圖、編輯、透明圖；固定 8 步，約比標準版快 4.5 倍。和標準版共用編碼器與 VAE。',
    ...miroxenFiles([
      [`${QI}Qwen-Image-2.1-Turbo-Q8_0.gguf`, HF('AtomicChat/Qwen-Image-2.1-Turbo-GGUF', 'f5996597b053664d0885cfaa0dcc88afb47f92f6',
        'Qwen-Image-2.1-Turbo-Q8_0.gguf'), 7591554784, '99f498fb7188be7eac9eb5f345a9e074d30eef3ca235b419e92563e5b48073c4'],
      ...QI_SHARED
    ])
  },
  miroxenqwen: {
    label: 'Qwen-Image-2.1 標準 · 圖片（40 步）',
    description: '細節與文字最穩；可用 LoRA。和 Turbo 共用編碼器與 VAE。',
    ...miroxenFiles([
      [`${QI}qwen-image-2.1-UC-Q8_0.gguf`, HF('abenzerps/Qwen-Image-2.1-Uncensored-GGUF', '6b34e59458d3eb7ba6a6f86a116aed5253dc02c3',
        'qwen-image-2.1-UC-Q8_0.gguf'), 7591557920, 'cde456c72ea3ecebfc1be783300e972711d875e0c5f1bed33d42b66b156affa8'],
      ...QI_SHARED
    ])
  },
  miroxenh3: {
    label: 'MiniMax-H3 · 影音',
    description: '文字／首尾幀生成影片與配套音訊，也能用圖片、影片、音訊當參考素材；建議 16GB 以上顯存。',
    ...miroxenFiles([
      [`${H3}minimax_h3_fl2va_pruned-Q4_K.gguf`, HF('unsloth/MiniMax-H3-GGUF', H3_REV, 'minimax_h3_fl2va_pruned-Q4_K.gguf'),
        11420663904, 'dd948e08ad0ba3c71bd42f368e283dd82e790f5122a63b276e22a3e0283d0c10'],
      [`${H3}minimax_h3_ref2va_pruned-Q4_K.gguf`, HF('unsloth/MiniMax-H3-GGUF', H3_REV, 'minimax_h3_ref2va_pruned-Q4_K.gguf'),
        11381096544, '2fa5840021cf6967843eaeefde9aaa277e540de02986d5ee3d5b0e6a7a8c9dec'],
      [`${H3}MiniMax-H3-TextEncoder-Qwen3VL-32B-abliterated-Q3_K_S_vis.gguf`, HF('pottokao/MiniMax-H3-TextEncoder-Qwen3VL-32B-abliterated-GGUF',
        '823f5ab888c52d5413c00518c70f5955dcbccb83', 'MiniMax-H3-TextEncoder-Qwen3VL-32B-abliterated-Q3_K_S_vis.gguf'),
      12646554528, '74b04cd89568fe4e74f371ebec3c52bbe16ffe25a9f3ba0c50687db556e6151d'],
      [`${H3}vae/minimax_h3_video_vae_fp16.safetensors`, HF('unsloth/MiniMax-H3-GGUF', H3_REV, 'vae/minimax_h3_video_vae_fp16.safetensors'),
        5207808496, '7c1f131492e7eddacaac9069a61b81bdd39de5cc96561e677c5eab1cdce5e522'],
      [`${H3}vae/minimax_h3_audio_vae_fp32.safetensors`, HF('unsloth/MiniMax-H3-GGUF', H3_REV, 'vae/minimax_h3_audio_vae_fp32.safetensors'),
        605254808, '8e505d95dd1561d47abd43d4238fd40d9bb1ae9e147ed0a4cba778d76ae4db48'],
      [`${H3}hf/tokenizer/tokenizer.json`, HF('MiniMaxAI/MiniMax-H3', H3_HF_REV, 'tokenizer/tokenizer.json'),
        7032403, 'a5d85b6dcc535e6b93115a9ef287e6132fdbf30270da6218194ba742261173c7'],
      [`${H3}hf/vae/config.json`, HF('MiniMaxAI/MiniMax-H3', H3_HF_REV, 'vae/config.json'),
        2011, '78f67deec3d63aae807f2bfe7154bc1e26f6372cb20b63265fcbae1b62bb5745'],
      [`${H3}hf/audio_vae/config.json`, HF('MiniMaxAI/MiniMax-H3', H3_HF_REV, 'audio_vae/config.json'),
        2271, '9a3c645ff892b376c6f5f4c8685964cd75474731af594ff058492a0000caabb6']
    ])
  },
  miroxenh3turbo: {
    label: 'MiniMax-H3 加速 LoRA（4／8 步）',
    description: '影片只算 4 或 8 步，約快 4～7 倍；工作台勾選後自動套用建議步數。需先有 MiniMax-H3。',
    ...miroxenFiles([
      ['loras/video/minimax_h3_fl2v_turbo_4step_v1.2_768p_bf16.safetensors', HF('lightx2v/Minimax-h3-Turbo', H3_LORA_REV,
        'minimax_h3_fl2v_turbo_4step_v1.2_768p_bf16.safetensors'), 1383677808, 'c3d4a2cf618efea71b9e21a4baaa12d412f1eb6c2b6f86efacaf0ebb6814b689'],
      ['loras/video/minimax_h3_fl2v_turbo_8step_v1.0_768p_bf16.safetensors', HF('lightx2v/Minimax-h3-Turbo', H3_LORA_REV,
        'minimax_h3_fl2v_turbo_8step_v1.0_768p_bf16.safetensors'), 1383677808, '9b0efe3613b43a84e30febaa43af27432ea9d0711eac7bba904b2556b175f6d4'],
      ['loras/video/minimax_h3_ref2v_turbo_8step_v1.0_768p_bf16.safetensors', HF('lightx2v/Minimax-h3-Turbo', H3_LORA_REV,
        'minimax_h3_ref2v_turbo_8step_v1.0_768p_bf16.safetensors'), 1383677808, '9bac880b1a5d7ac052171cf6cce769f0cceaaa42ffa51de4b8e41143a2bdd2d2']
    ])
  },
  } : {}),
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

/** Miroxen 圖片／影音模型（共用 `models/miroxen/`） */
const MIROXEN_MODEL_KEYS = Object.keys(MODELS).filter((key) => MODELS[key].runtime === 'miroxen' && MODELS[key].kind !== 'runtime')

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
  return path.join(modelsRoot(), MODELS[key]?.dir || key)
}

/**
 * 模型是否已完整下載
 * archive 型別解壓後的檔名跟下載名不同，所以判定看 `check` 而不是 `files`
 */
function isDownloaded(key) {
  const def = MODELS[key]
  if (!def) return false
  if (def.runtime === 'pdf' && def.kind === 'runtime') {
    return !activeDownloads.has(key) && require('./pdf-translate/runtime').isReady(modelDir(key), def.gpu ? 'gpu' : 'cpu')
  }
  if (def.runtime === 'miroxen' && def.kind === 'runtime') {
    return !activeDownloads.has(key) && require('./miroxen/runtime').isReady(modelDir(key))
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
  return s.replace(/['\u2018-\u201b]/g, '$&$&')
}

/**
 * 解壓 archive 到模型資料夾根層。
 * Windows：PowerShell Expand-Archive（僅 .zip）。
 * 其他平台：tar（.tar.gz／.tgz）或 unzip（.zip）；絕不呼叫 powershell。
 * @param {string} archivePath
 * @param {string} destDir
 * @returns {Promise<void>}
 */
function expandArchive(archivePath, destDir, options = {}) {
  return new Promise((resolve, reject) => {
    const lower = String(archivePath).toLowerCase()
    /** @type {string} */
    let file
    /** @type {string[]} */
    let args
    if (HOST.platform === 'win32') {
      if (!lower.endsWith('.zip')) {
        reject(new Error('Windows 僅支援解壓 .zip'))
        return
      }
      file = 'powershell.exe'
      args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `Expand-Archive -LiteralPath '${psQuote(archivePath)}' -DestinationPath '${psQuote(destDir)}' -Force`
      ]
    } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      file = 'tar'
      args = ['-xzf', archivePath, '-C', destDir]
      const strip = Number(options.stripComponents) || 0
      if (strip > 0) args.push(`--strip-components=${strip}`)
    } else if (lower.endsWith('.zip')) {
      file = 'unzip'
      args = ['-o', archivePath, '-d', destDir]
    } else {
      reject(new Error(`不支援的壓縮格式：${path.basename(archivePath)}`))
      return
    }
    const child = spawn(file, args, { windowsHide: true, stdio: 'ignore' })
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
      await require('./pdf-translate/runtime').install({ dir: modelDir(key), signal: controller.signal, variant: def.gpu ? 'gpu' : 'cpu',
        onProgress: progress => onProgress({ key, receivedBytes: 0, totalBytes: def.totalBytes,
          ...progress, cancellable: true }) })
      activeDownloads.delete(key)
      return status()
    }
    if (def.runtime === 'miroxen' && def.kind === 'runtime') {
      await require('./miroxen/runtime').install({ dir: modelDir(key), signal: controller.signal, expand: expandArchive,
        onProgress: progress => onProgress({ key, ...progress }) })
      activeDownloads.delete(key)
      return status()
    }
    const dependency = key === 'paddleocrvl16' ? 'ppdoclayoutv3'
      : (def.runtime === 'breeze' || def.runtime === 'miroxen' || (def.runtime === 'pdf' && def.kind === 'ocr')) ? def.requires : null
    if (dependency && (!isDownloaded(dependency)
      || (key === 'paddleocrvl16' && !isDownloaded('pdfruntime')))) {
      const cancelDependency = () => cancelDownload(dependency)
      controller.signal.addEventListener('abort', cancelDependency, { once: true })
      try {
        await download(dependency, progress => {
          onProgress(progress)
          onProgress({ key, receivedBytes: 0, totalBytes: def.totalBytes,
            stage: key === 'paddleocrvl16' ? '準備 PDF 辨識模型與執行環境…'
              : def.runtime === 'pdf' ? '準備 PDF 執行環境…'
                : def.runtime === 'miroxen' ? '準備圖片影像引擎…' : '準備語音執行環境…',
            cancellable: progress.cancellable ?? !progress.stage })
        })
      }
      finally { controller.signal.removeEventListener('abort', cancelDependency) }
      if (controller.signal.aborted) throw new Error('下載已取消')
    }
    for (const file of def.files) {
      const dest = path.join(modelDir(key), file)
      await fsp.mkdir(path.dirname(dest), { recursive: true })

      // 共用資料夾（Miroxen）裡別的模型已經下好、大小對得上的檔案不重下
      if ((!def.sha256?.[file] || (def.dir && sizeMatches(dest, def.fileBytes?.[file]))) && fs.existsSync(dest)) {
        received += (await fsp.stat(dest)).size
        emit(true)
        continue
      }

      const completed = received
      const result = await downloadFile({
        url: def.urls?.[file] || def.base + file,
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
        await expandArchive(zipPath, modelDir(key), { stripComponents: def.stripComponents })
        await fsp.rm(zipPath, { force: true })
      }
      if (!isDownloaded(key)) throw new Error('解壓完成但缺少必要檔案')
      if (HOST.platform !== 'win32' && def.binary) {
        try { fs.chmodSync(path.join(modelDir(key), def.binary), 0o755) } catch { /* 沒有也無妨 */ }
      }
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
  if (MODELS[key].dir) await removeSharedFiles(key)
  else removeTreeSync(modelDir(key))
  return status()
}

/** @param {string} file @param {number | undefined} bytes */
function sizeMatches(file, bytes) {
  try { return !!bytes && fs.statSync(file).size === bytes } catch { return false }
}

/**
 * 共用資料夾只刪這顆自己的檔案，其他已下載模型還用得到的留著（例如 Turbo 與標準版共用的編碼器）。
 * @param {string} key
 */
async function removeSharedFiles(key) {
  const def = MODELS[key]
  const inUse = new Set(Object.entries(MODELS)
    .filter(([other, d]) => other !== key && d.dir === def.dir && isDownloaded(other))
    .flatMap(([, d]) => d.files))
  for (const file of def.files.filter((f) => !inUse.has(f))) {
    const target = path.join(modelDir(key), file)
    await fsp.rm(target, { force: true })
    await fsp.rm(`${target}.part`, { force: true })
  }
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
  LLAMA_BUILD_LINUX_CUDA,
  expandArchive,
  MIROXEN_MODEL_KEYS,
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
