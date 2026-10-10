'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { downloadFile } = require('../hfmodels/download')

const UV_VERSION = '0.13.0'
const PYTHON_VERSION = '3.12.12'
const PADDLE_WHEEL = 'paddlepaddle-3.3.1-cp312-cp312-win_amd64.whl'
const PACKAGES = Object.freeze(['paddlepaddle==3.3.1', 'paddleocr[doc-parser]==3.7.0', 'pymupdf==1.28.2'])
const STAMP = JSON.stringify({ python: PYTHON_VERSION, packages: PACKAGES })

function pythonExe(dir) { return path.join(dir, 'venv', 'Scripts', 'python.exe') }

function isReady(dir) {
  try {
    return fs.readFileSync(path.join(dir, 'ready.json'), 'utf8') === STAMP
      && fs.statSync(pythonExe(dir)).isFile()
      && fs.existsSync(path.join(dir, 'python', `cpython-${PYTHON_VERSION}-windows-x86_64-none`, 'python.exe'))
  } catch { return false }
}

function run(exe, args, { dir, signal, env, stage }) {
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
    const timer = setTimeout(() => { timedOut = true; stop() }, 45 * 60_000)
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
async function install({ dir, signal, onProgress = () => {} }) {
  if (isReady(dir)) return
  await fsp.mkdir(dir, { recursive: true })
  await fsp.rm(path.join(dir, 'ready.json'), { force: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(UV_|PYTHONHOME$|PYTHONPATH$|VIRTUAL_ENV$|CONDA_PREFIX$)/i.test(key)))
  Object.assign(env, { UV_PYTHON_INSTALL_DIR: path.join(dir, 'python'),
    UV_CACHE_DIR: path.join(dir, 'cache'), UV_PYTHON_BIN_DIR: path.join(dir, 'bin'),
    PYTHONUTF8: '1', PYTHONNOUSERSITE: '1', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True' })
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
  await downloadFile({ url: `https://paddle-whl.cdn.bcebos.com/stable/cpu/paddlepaddle/${PADDLE_WHEEL}`,
    dest: path.join(dir, 'wheelhouse', PADDLE_WHEEL), expectedBytes: 104794793,
    sha256: '324b5122cf3887dfbd15db17f36e2421ef923fd4569d26111bf1a21fe84d442b', signal,
    onProgress: ({ received, total }) => onProgress({ receivedBytes: received, totalBytes: total,
      stage: '下載文件辨識引擎…', cancellable: true }) })
  report('安裝 PaddleOCR 與 PDF 套件…')
  await run(uv, ['--no-config', 'pip', 'install', '--python', pythonExe(dir),
    '--default-index', 'https://pypi.org/simple', '--find-links', path.join(dir, 'wheelhouse'),
    '--only-binary', ':all:', ...PACKAGES],
    { dir, env, signal, stage: '安裝文件辨識套件' })
  report('檢查 PDF 執行環境…')
  await run(pythonExe(dir), ['-I', '-c',
    'import paddle, pymupdf; from paddleocr import PaddleOCRVL; from importlib.metadata import version; '
      + "assert version('paddlepaddle') == '3.3.1'; assert version('paddleocr') == '3.7.0'; assert version('pymupdf') == '1.28.2'"],
    { dir, env, signal, stage: '檢查文件辨識套件' })
  signal?.throwIfAborted()
  await fsp.writeFile(path.join(dir, 'ready.json'), STAMP)
  report('PDF 執行環境已就緒')
}

module.exports = { install, isReady, pythonExe }
