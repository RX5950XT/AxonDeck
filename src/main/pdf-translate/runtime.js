'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { downloadFile } = require('../hfmodels/download')

const UV_VERSION = '0.13.0'
const PYTHON_VERSION = '3.12.12'
const COMMON = ['paddleocr[doc-parser]==3.7.0', 'pymupdf==1.28.2']
// GPU 版只差 Paddle 本體與它要的 CUDA 函式庫（cu129 才支援 RTX 50 系列），版面偵測約快 45 倍。
// 其餘套件照 requirements-<variant>.txt 的版本＋官方 SHA-256 安裝。
const VARIANTS = Object.freeze({
  cpu: { wheel: 'paddlepaddle-3.3.1-cp312-cp312-win_amd64.whl', index: 'cpu/paddlepaddle', bytes: 104794793,
    sha256: '324b5122cf3887dfbd15db17f36e2421ef923fd4569d26111bf1a21fe84d442b', paddle: 'paddlepaddle' },
  gpu: { wheel: 'paddlepaddle_gpu-3.3.1-cp312-cp312-win_amd64.whl', index: 'cu129/paddlepaddle-gpu', bytes: 809980301,
    sha256: 'f5b26250b46f1f7fe8f51571392d2e8f9c07c1e32fa127f4ca563fe1a0d01103', paddle: 'paddlepaddle-gpu' }
})
// PyPI 官方在亞洲常只有 0.1 MB/s（GPU 版 2.3 GB 的 CUDA 函式庫要好幾小時）；清華實測 22 MB/s。
// 鏡像只是換下載點：每個檔案都要對上鎖定清單裡的官方 SHA-256（--require-hashes），對不上 uv 就拒裝。
// files 是同一個測速檔（nvidia-cuda-runtime，3.5 MB）在各鏡像的位置，官方放最後當退路。
const PROBE = 'b8/1c/c6352858f84e5203279300a9fb4f9d7613cbab5fd4afd78613bb9bcdc64c/nvidia_cuda_runtime_cu12-12.9.37-py3-none-win_amd64.whl'
const PYPI_INDEXES = Object.freeze([
  { simple: 'https://pypi.tuna.tsinghua.edu.cn/simple', files: 'https://pypi.tuna.tsinghua.edu.cn/packages/' },
  { simple: 'https://mirrors.ustc.edu.cn/pypi/simple', files: 'https://mirrors.ustc.edu.cn/pypi/packages/' },
  { simple: 'https://mirrors.cloud.tencent.com/pypi/simple', files: 'https://mirrors.cloud.tencent.com/pypi/packages/' },
  { simple: 'https://pypi.org/simple', files: 'https://files.pythonhosted.org/packages/' }
])

function packagesOf(variant) {
  return [`${VARIANTS[variant].paddle}==3.3.1`, ...COMMON]
}

/** 抓測速檔前 3 MB、最多 5 秒，回 bytes／秒。量 256 KB 只量到連線延遲（會挑到 4 MB/s 的騰訊而不是 22 MB/s 的清華） */
async function measure(url, signal) {
  const controller = new AbortController()
  const stop = () => controller.abort()
  signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, 5000)
  const started = Date.now()
  let bytes = 0
  try {
    const response = await fetch(url, { headers: { range: 'bytes=0-3145727' }, signal: controller.signal })
    if (response.ok && response.body) for await (const chunk of response.body) bytes += chunk.length
  } catch { /* 逾時或連不上：用已收到的量算，0 就排最後 */ }
  finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
  }
  signal?.throwIfAborted()
  return bytes / Math.max(0.001, (Date.now() - started) / 1000)
}

/** 各 PyPI 鏡像依實測速度排序；一個一個量，同時量會互搶頻寬。官方永遠留在最後當退路 */
async function rankedIndexes(signal) {
  const mirrors = PYPI_INDEXES.slice(0, -1)
  const speeds = []
  for (const index of mirrors) speeds.push({ index, speed: await measure(index.files + PROBE, signal) })
  return [...speeds.sort((a, b) => b.speed - a.speed).map(({ index }) => index), PYPI_INDEXES.at(-1)]
}

function stampOf(variant) { return JSON.stringify({ python: PYTHON_VERSION, packages: packagesOf(variant) }) }

function pythonExe(dir) { return path.join(dir, 'venv', 'Scripts', 'python.exe') }

/**
 * PDF 用的 Python 程序一律帶這些：`import paddle` 會在家目錄建 .cache/paddle、paddlex 預設寫 ~/.paddlex，
 * Windows 的 Python 從 USERPROFILE 取家目錄，指到環境資料夾裡，就不會在使用者資料夾留東西。
 */
function isolatedEnv(dir) {
  // 家目錄不存在時 Paddle 改寫系統暫存資料夾，所以先建好
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true })
  return { USERPROFILE: path.join(dir, 'home'), PADDLE_PDX_CACHE_HOME: path.join(dir, 'paddle-cache'),
    PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' }
}

function isReady(dir, variant = 'cpu') {
  try {
    return fs.readFileSync(path.join(dir, 'ready.json'), 'utf8') === stampOf(variant)
      && fs.statSync(pythonExe(dir)).isFile()
      && fs.existsSync(path.join(dir, 'python', `cpython-${PYTHON_VERSION}-windows-x86_64-none`, 'python.exe'))
  } catch { return false }
}

function run(exe, args, { dir, signal, env, stage, minutes = 45 }) {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let timedOut = false
    let stderr = ''
    child.stderr.on('data', data => { stderr = (stderr + data.toString('utf8')).slice(-8192) })
    const stop = () => {
      if (!child.pid) return
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.on('error', () => child.kill())
    }
    const timer = setTimeout(() => { timedOut = true; stop() }, minutes * 60_000)
    signal?.addEventListener('abort', stop, { once: true })
    child.on('error', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      reject(new Error(`${stage}無法啟動`))
    })
    child.on('close', code => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(new Error('下載已取消'))
      else if (timedOut) reject(new Error(`${stage}逾時，請重試`))
      else if (code !== 0) {
        const reason = /No solution found|requirements are unsatisfiable/i.test(stderr) ? '套件版本不相容'
          : /failed to download|error sending request|certificate|TLS/i.test(stderr) ? '下載連線失敗'
            : /ModuleNotFoundError|ImportError|DLL load failed/i.test(stderr) ? '套件載入失敗' : '程序失敗'
        // 只保存分類與結束碼，不記上游網址、回應內容或憑證。
        const failure = new Error(`${stage}失敗：${reason}（結束碼 ${code}）`)
        fsp.writeFile(path.join(dir, 'install-error.json'), JSON.stringify({ stage, code, reason }))
          .then(() => reject(failure), () => reject(failure))
      }
      else resolve()
    })
  })
}

/** 所有 Python、套件與快取都在這個模型資料夾，不改 PATH 或 Windows 登錄檔。 */
async function install({ dir, signal, onProgress = () => {}, variant = 'cpu' }) {
  const spec = VARIANTS[variant]
  if (!spec) throw new Error('未知的 PDF 執行環境')
  if (isReady(dir, variant)) return
  await fsp.mkdir(dir, { recursive: true })
  await fsp.rm(path.join(dir, 'ready.json'), { force: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(UV_|PYTHONHOME$|PYTHONPATH$|VIRTUAL_ENV$|CONDA_PREFIX$)/i.test(key)))
  Object.assign(env, { UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'),
    UV_CACHE_DIR: path.join(dir, 'cache'), UV_PYTHON_BIN_DIR: path.join(dir, 'bin'),
    PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', ...isolatedEnv(dir) })
  // 使用者既有 Python／uv 設定不參與這份隔離環境。
  const report = stage => onProgress({ stage, cancellable: true })
  const uv = path.join(dir, 'uv.exe')
  const zip = path.join(dir, 'uv.zip')
  report('下載 PDF 安裝工具…')
  await downloadFile({ url: `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-pc-windows-msvc.zip`,
    dest: zip, expectedBytes: 15722003,
    sha256: '088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c', signal,
    onProgress: ({ received, total }) => onProgress({ receivedBytes: received, totalBytes: total,
      stage: '下載 PDF 安裝工具…', cancellable: true }) })
  const quote = value => value.replace(/'/g, "''")
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command',
      `Expand-Archive -LiteralPath '${quote(zip)}' -DestinationPath '${quote(dir)}' -Force`],
    { dir, env, signal, stage: '解壓安裝工具' })
  await fsp.rm(zip, { force: true })
  report('安裝 PDF 專用 Python…')
  await run(uv, ['--no-config', 'python', 'install', PYTHON_VERSION, '--no-bin', '--no-registry'],
    { dir, env, signal, stage: '安裝 Python' })
  const basePython = path.join(dir, 'python', `cpython-${PYTHON_VERSION}-windows-x86_64-none`, 'python.exe')
  await run(uv, ['--no-config', 'venv', '--python', basePython, '--no-python-downloads',
    '--allow-existing', path.join(dir, 'venv')], { dir, env, signal, stage: '建立 Python 環境' })
  report('下載文件辨識引擎…')
  await downloadFile({ url: `https://paddle-whl.cdn.bcebos.com/stable/${spec.index}/${spec.wheel}`,
    dest: path.join(dir, 'wheelhouse', spec.wheel), expectedBytes: spec.bytes, sha256: spec.sha256, signal,
    onProgress: ({ received, total }) => onProgress({ receivedBytes: received, totalBytes: total,
      stage: '下載文件辨識引擎…', cancellable: true }) })
  report('挑選最快的套件下載點…')
  // uv 讀不到 asar 裡的檔案，鎖定清單先寫到環境資料夾
  const requirements = path.join(dir, 'requirements.txt')
  await fsp.writeFile(requirements, fs.readFileSync(path.join(__dirname, `requirements-${variant}.txt`)))
  let lastError
  for (const index of await rankedIndexes(signal)) {
    report(`安裝 PaddleOCR 與 PDF 套件（${new URL(index.simple).hostname}）…`)
    try {
      await run(uv, ['--no-config', 'pip', 'install', '--python', pythonExe(dir), '--require-hashes', '-r', requirements,
        '--default-index', index.simple, '--find-links', path.join(dir, 'wheelhouse'), '--only-binary', ':all:'],
      // GPU 版有 2.3 GB 的 CUDA 函式庫，慢速網路 45 分鐘不夠
      { dir, env, signal, stage: '安裝文件辨識套件', minutes: variant === 'gpu' ? 120 : 45 })
      lastError = null
      break
    } catch (error) {
      if (signal?.aborted) throw error
      lastError = error
    }
  }
  if (lastError) throw lastError
  report('檢查 PDF 執行環境…')
  // GPU 版要真的抓得到顯示卡；裝了但驅動不支援，等於白裝 5 GB，直接讓安裝失敗
  const gpuCheck = variant === 'gpu' ? '; assert paddle.device.cuda.device_count() > 0' : ''
  await run(pythonExe(dir), ['-I', '-c',
    'import paddle, pymupdf; from paddleocr import PaddleOCRVL; from importlib.metadata import version; '
      + `assert version('${spec.paddle}') == '3.3.1'; assert version('paddleocr') == '3.7.0'; assert version('pymupdf') == '1.28.2'`
      + gpuCheck],
    { dir, env, signal, stage: variant === 'gpu' ? '檢查顯示卡加速' : '檢查文件辨識套件' })
  signal?.throwIfAborted()
  await fsp.writeFile(path.join(dir, 'ready.json'), stampOf(variant))
  await prune(dir)
  report(variant === 'gpu' ? 'PDF GPU 加速已就緒' : 'PDF 執行環境已就緒')
}

/**
 * 裝好後安裝包與下載快取都用不到了（GPU 版約 800 MB）。uv 在 Windows 用硬連結把快取裝進 venv，
 * 刪快取只是少一個連結，venv 裡的檔案不受影響；要重裝會從鏡像重新下載。
 */
async function prune(dir) {
  // uv 只在安裝時用（重裝會重新下載），requirements.txt 是安裝時從 App 寫出來的
  for (const name of ['wheelhouse', 'cache', 'prefetch-wheels.js', 'requirements.txt', 'uv.exe', 'uvw.exe', 'uvx.exe']) {
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
  }
}

module.exports = { install, isReady, pythonExe, isolatedEnv, rankedIndexes, prune }
