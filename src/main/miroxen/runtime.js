'use strict'

/**
 * Miroxen 引擎（圖片／影音生成）的安裝與更新。
 *
 * 不 pin 版本：跟著 RX5950XT/Miroxen 的 latest release 走，Miroxen 發版 App 就能直接更新。
 * 完整性靠 GitHub API 給的資產 digest（`downloadFile` 走鏡像後仍驗 SHA-256）。
 * 兩個資產：引擎本體（exe＋web，常變）與 deps（cuBLAS／VC runtime／ffmpeg，很少變）；
 * deps 的 digest 跟已安裝的一樣就不重下。
 */

const fs = require('fs')
const fsp = require('fs/promises')
const path = require('path')
const { downloadFile } = require('../hfmodels/download')
const { removeTreeSync } = require('../safe-rm')

const REPO = 'RX5950XT/Miroxen'
const ENGINE = 'miroxen-win-x64.zip'
const DEPS = 'miroxen-deps-win-x64.zip'
const ENGINE_FILES = ['miroxen.exe', 'web/index.html']
const DEPS_FILES = ['cublas64_13.dll', 'cublasLt64_13.dll', 'ffmpeg.exe', 'ffprobe.exe']
const CHECK_TTL_MS = 30 * 60 * 1000
const TAG = /^v\d+\.\d+\.\d+$/

/** @type {{ at: number, release: { tag: string, assets: Record<string, { url: string, size: number, sha256: string }> } } | null} */
let cached = null

/** @param {string} dir */
function readManifest(dir) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
    return TAG.test(manifest?.tag) ? manifest : null
  } catch { return null }
}

/** @param {string} dir @param {string[]} files */
const hasAll = (dir, files) => files.every((file) => fs.existsSync(path.join(dir, file)))

/** @param {string} dir */
function isReady(dir) {
  return !!readManifest(dir) && hasAll(dir, [...ENGINE_FILES, ...DEPS_FILES])
}

/** @param {string} dir @returns {string} 已安裝的 tag；沒裝回空字串 */
function installedVersion(dir) {
  return isReady(dir) ? readManifest(dir).tag : ''
}

/** a 比 b 新？ @param {string} a @param {string} b */
function isNewer(a, b) {
  if (!TAG.test(a)) return false
  if (!TAG.test(b)) return true
  const pa = a.slice(1).split('.').map(Number)
  const pb = b.slice(1).split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] > pb[i]
  return false
}

/** GitHub API 回應是外部輸入：tag、網址前綴、大小、digest 全部驗過才用 */
function parseRelease(json) {
  const tag = json?.tag_name
  if (typeof tag !== 'string' || !TAG.test(tag)) throw new Error('Miroxen 發行資訊格式不正確')
  const prefix = `https://github.com/${REPO}/releases/download/`
  const assets = {}
  for (const name of [ENGINE, DEPS]) {
    const asset = Array.isArray(json.assets) ? json.assets.find((item) => item?.name === name) : null
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || typeof asset.browser_download_url !== 'string'
      || !asset.browser_download_url.startsWith(prefix) || !Number.isSafeInteger(asset.size) || asset.size <= 0) {
      throw new Error(`Miroxen ${tag} 缺少 ${name}`)
    }
    assets[name] = { url: asset.browser_download_url, size: asset.size, sha256: asset.digest.slice(7) }
  }
  return { tag, assets }
}

/**
 * @param {{ force?: boolean, signal?: AbortSignal }} [options]
 */
async function latestRelease({ force = false, signal } = {}) {
  if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) return cached.release
  const timeout = AbortSignal.timeout(10000)
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' }, redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(response.status === 404 ? 'Miroxen 還沒有發行版本' : `讀不到 Miroxen 發行資訊（HTTP ${response.status}）`)
  }
  const release = parseRelease(await response.json())
  cached = { at: Date.now(), release }
  return release
}

/**
 * 裝最新版（已是最新就不動）。呼叫端要先停掉引擎：執行中的 exe 蓋不過去。
 * @param {{ dir: string, signal: AbortSignal, expand: (zip: string, dest: string) => Promise<void>,
 *   onProgress: (p: { receivedBytes: number, totalBytes: number, stage?: string }) => void }} options
 */
async function install({ dir, signal, expand, onProgress }) {
  const release = await latestRelease({ force: true, signal })
  const manifest = readManifest(dir)
  if (manifest?.tag === release.tag && isReady(dir)) return
  const depsOk = manifest?.assets?.[DEPS] === release.assets[DEPS].sha256 && hasAll(dir, DEPS_FILES)
  const names = depsOk ? [ENGINE] : [ENGINE, DEPS]
  const total = names.reduce((sum, name) => sum + release.assets[name].size, 0)
  const staging = path.join(dir, '.download')
  await fsp.mkdir(staging, { recursive: true })
  let done = 0
  for (const name of names) {
    const asset = release.assets[name]
    await downloadFile({ url: asset.url, dest: path.join(staging, name), expectedBytes: asset.size, sha256: asset.sha256, signal,
      onProgress: ({ received }) => onProgress({ receivedBytes: done + received, totalBytes: total }) })
    done += asset.size
  }
  onProgress({ receivedBytes: total, totalBytes: total, stage: '解壓中…' })
  // 解到一半失敗就不能算裝好；舊版刪掉的網頁檔也不留著
  await fsp.rm(path.join(dir, 'manifest.json'), { force: true })
  removeTreeSync(path.join(dir, 'web'))
  for (const name of names) await expand(path.join(staging, name), dir)
  removeTreeSync(staging)
  const assets = { [ENGINE]: release.assets[ENGINE].sha256, [DEPS]: release.assets[DEPS].sha256 }
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ tag: release.tag, assets }))
  if (!isReady(dir)) throw new Error('解壓完成但缺少必要檔案')
}

module.exports = { isReady, installedVersion, isNewer, latestRelease, parseRelease, install, REPO }
