'use strict'

/**
 * 媒體縮圖：影片與音樂封面用內建 mpv，殼層做不出的圖片（大 TIFF、PSD、RAW…）用內建 magick，
 * 結果存進 `<userData>/thumb-cache`，之後不用再開程序。
 *
 * 影片不先問殼層：沒裝編碼器的格式（FLV、部分 HEVC）殼層只會給類型圖示；mpv 什麼都解得開，
 * 從 10% 處取一格也比較不會抓到片頭黑畫面。圖片仍先問殼層，一般照片它更快。
 *
 * 找不到 mpv／magick（沒跑 `build:media`）回 null，呼叫端照舊走殼層。
 */

const crypto = require('crypto')
const path = require('path')
const { app } = require('electron')
const fsp = require('../raw-fs').promises
const { runProcess } = require('../proc-broker')
const { resolveProbeExe } = require('../native-probe')
const { mediaKind } = require('../media-player')

const MAX_RUNNING = 3
const MAX_QUEUE = 256
/** magick 自己限 30 秒（policy.xml），這裡只是保底 */
const TIMEOUT_MS = 45_000
const MAX_CACHE_BYTES = 512 * 1024 * 1024
/** mpv 通常半秒內做完：等一下直接回圖，不用等 renderer 下一次重試 */
const QUICK_WAIT_MS = 2500
const OUTPUT_EXT = { image: 'webp', video: 'jpg', audio: 'jpg' }
const MIME = { webp: 'image/webp', jpg: 'image/jpeg' }

/** @type {Map<string, { file: string, kind: string, edge: number, key: string }>} */
const queued = new Map()
const running = new Set()
/** 鍵 → 等它做完的人 @type {Map<string, Set<() => void>>} */
const waiters = new Map()
/** 逾時或開不起來：可能只是磁碟睡著，這次執行不再試，但不寫進磁碟 */
const failedThisRun = new Set()
let trimScheduled = false

const cacheDir = () => path.join(app.getPath('userData'), 'thumb-cache')
const edgeOf = (size) => (Number(size) > 256 ? 512 : 256)
const toolDir = () => path.dirname(resolveProbeExe({ folder: 'media', name: 'mpv.exe' }) || '.')

function keyOf(file, stat, edge) {
  return crypto.createHash('sha1').update(`${file.toLowerCase()}|${stat.size}|${stat.mtimeMs}|${edge}`).digest('hex')
}

function exists(file) {
  return fsp.access(file).then(() => true, () => false)
}

/** @param {string} kind @param {string} file @param {number} edge @param {string} outDir */
function mpvArgs(kind, file, edge, outDir) {
  return [
    '--no-config', '--no-terminal', '--load-scripts=no', '--cover-art-auto=no', '--audio-file-auto=no', '--sub-auto=no',
    '--audio=no', '--sub=no', '--hwdec=no', '--hr-seek=no', '--vd-lavc-threads=2', '--priority=belownormal',
    kind === 'audio' ? '--image-display-duration=0' : '--start=10%',
    '--frames=1', '--vo=image', '--vo-image-format=jpg', '--vo-image-jpeg-quality=85', `--vo-image-outdir=${outDir}`,
    `--vf=lavfi=[scale=${edge}:${edge}:force_original_aspect_ratio=decrease]`, '--', file
  ]
}

/** 資源上限跟播放器的 `engine.rs` 同一組。@param {string} file @param {number} edge @param {string} out */
function magickArgs(file, edge, out) {
  const ext = path.extname(file).slice(1).toLowerCase()
  return [
    '-limit', 'memory', '256MiB', '-limit', 'map', '512MiB', '-limit', 'disk', '1GiB', '-limit', 'time', '30', '-limit', 'thread', '2',
    // JPEG 解碼時就縮小，一億畫素也不到一秒
    ...(['jpg', 'jpeg', 'jpe', 'jfif'].includes(ext) ? ['-define', `jpeg:size=${edge * 2}x${edge * 2}`] : []),
    `${ext === 'svg' || ext === 'svgz' ? 'MSVG:' : ''}${file}[0]`,
    '-auto-orient', '-thumbnail', `${edge}x${edge}>`, '-strip', '-quality', '80', `WEBP:${out}`
  ]
}

/** 暫存資料夾只有這一層：逐檔刪再 rmdir，不用遞迴刪除。 */
async function dropDir(dir) {
  const names = await fsp.readdir(dir).catch(() => [])
  await Promise.all(names.map((name) => fsp.unlink(path.join(dir, name)).catch(() => {})))
  await fsp.rmdir(dir).catch(() => {})
}

/** @param {{ file: string, kind: string, edge: number, key: string }} job */
async function produce(job) {
  const dir = cacheDir()
  const work = path.join(dir, `tmp-${job.key}`)
  const ext = OUTPUT_EXT[job.kind]
  await fsp.mkdir(work, { recursive: true })
  try {
    const video = job.kind !== 'image'
    const exe = path.join(toolDir(), video ? 'mpv.exe' : 'magick.exe')
    const out = path.join(work, 'out.webp')
    const result = await runProcess({
      file: exe,
      args: video ? mpvArgs(job.kind, job.file, job.edge, work) : magickArgs(job.file, job.edge, out),
      env: video ? {} : { MAGICK_CONFIGURE_PATH: toolDir(), MAGICK_TEMPORARY_PATH: work },
      maxChars: 65536,
      timeoutMs: TIMEOUT_MS
    })
    if (result.error) {
      failedThisRun.add(job.key)
      return
    }
    const made = video ? path.join(work, '00000001.jpg') : out
    if (result.code === 0 && await exists(made)) await fsp.rename(made, path.join(dir, `${job.key}.${ext}`))
    // 解不開或沒有畫面（沒封面的音樂）：記下來，下次不用再開程序
    else await fsp.writeFile(path.join(dir, `${job.key}.none`), '')
  } finally {
    await dropDir(work)
  }
}

function pump() {
  while (running.size < MAX_RUNNING && queued.size) {
    // 後進先出：使用者現在看的是最後要求的那幾張
    const key = [...queued.keys()].pop()
    const job = queued.get(key)
    queued.delete(key)
    running.add(key)
    void produce(job).catch((error) => {
      failedThisRun.add(key)
      console.error('[explorer] 產生媒體縮圖失敗:', error?.code || 'UNKNOWN')
    }).finally(() => {
      running.delete(key)
      for (const wake of waiters.get(key) || []) wake()
      waiters.delete(key)
      pump()
    })
  }
}

/** 超過上限從最舊的刪起（檔案改過之後舊鍵不會再被用到）。 */
async function trimCache() {
  const dir = cacheDir()
  const names = await fsp.readdir(dir).catch(() => [])
  // App 中途關掉留下的暫存：沒有在做的就收掉
  const stale = names.filter((name) => name.startsWith('tmp-') && !running.has(name.slice(4)))
  await Promise.all(stale.map((name) => dropDir(path.join(dir, name))))
  const entries = (await Promise.all(names.filter((name) => !name.startsWith('tmp-')).map(async (name) => {
    const stat = await fsp.stat(path.join(dir, name)).catch(() => null)
    return stat ? { name, size: stat.size, at: stat.mtimeMs } : null
  }))).filter(Boolean).sort((a, b) => a.at - b.at)
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  for (const entry of entries) {
    if (total <= MAX_CACHE_BYTES) break
    await fsp.unlink(path.join(dir, entry.name)).catch(() => {})
    total -= entry.size
  }
}

function scheduleTrim() {
  if (trimScheduled) return
  trimScheduled = true
  const timer = setTimeout(() => {
    trimCache().catch((error) => console.error('[explorer] 整理縮圖快取失敗:', error?.code || 'UNKNOWN'))
  }, 60_000)
  timer.unref?.()
}

/** 這個檔案要不要由這裡處理；工具不在回 null。 */
async function describe(file, size) {
  const kind = mediaKind(file)
  if (!OUTPUT_EXT[kind]) return null
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile()) return null
  const edge = edgeOf(size)
  return { file, kind, edge, key: keyOf(file, stat, edge) }
}

function enqueue(job) {
  const tool = job.kind === 'image' ? 'magick.exe' : 'mpv.exe'
  if (!resolveProbeExe({ folder: 'media', name: tool })) return null
  queued.delete(job.key)
  queued.set(job.key, job)
  if (queued.size > MAX_QUEUE) queued.delete(queued.keys().next().value)
  scheduleTrim()
  pump()
  return { working: true }
}

/** 磁碟快取或進行中的狀態。@param {{ kind: string, key: string }} job */
async function peek(job) {
  const dir = cacheDir()
  const ext = OUTPUT_EXT[job.kind]
  const bytes = await fsp.readFile(path.join(dir, `${job.key}.${ext}`)).catch(() => null)
  if (bytes) return { url: `data:${MIME[ext]};base64,${bytes.toString('base64')}` }
  if (failedThisRun.has(job.key) || await exists(path.join(dir, `${job.key}.none`))) return { none: true }
  if (running.has(job.key) || queued.has(job.key)) return { working: true }
  return null
}

/** 等這個工作做完，最多 QUICK_WAIT_MS。 */
function waitBriefly(key) {
  return new Promise((resolve) => {
    const list = waiters.get(key) || new Set()
    waiters.set(key, list)
    const wake = () => {
      clearTimeout(timer)
      list.delete(wake)
      if (!list.size && waiters.get(key) === list) waiters.delete(key)
      resolve()
    }
    const timer = setTimeout(wake, QUICK_WAIT_MS)
    list.add(wake)
  })
}

/**
 * 先看快取；影片與音樂沒有就直接排隊，並等一小段讓結果跟這次回覆一起回去。
 * @returns {Promise<{ url: string } | { none: true } | { working: true } | null>} null＝這裡不處理，問殼層
 */
async function find(file, size) {
  const job = await describe(file, size)
  if (!job) return null
  const known = await peek(job)
  if (known && !known.working) return known
  if (job.kind === 'image') return known
  if (!known && !enqueue(job)) return null
  await waitBriefly(job.key)
  return await peek(job) || { working: true }
}

/** 殼層給不出真縮圖時才叫：目前只有圖片會走到這裡。 */
async function generate(file, size) {
  const job = await describe(file, size)
  return job ? enqueue(job) : null
}

module.exports = { find, generate, edgeOf }
