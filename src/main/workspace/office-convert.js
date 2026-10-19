'use strict'

/**
 * Office 文件轉檔（給工作區的「版面檢視」）：本機有 Microsoft Office 就用它（COM），
 * 不然找 LibreOffice（soffice --headless）。兩個都沒有就回 `NO_CONVERTER`，
 * renderer 退回內建的簡易預覽（`ws-office.js`）。
 *
 * - `pdf`：照原檔版面（字型、圖表、投影片位置）畫，舊格式 doc／xls／ppt 與 ODF 也吃。
 * - `xlsx`：試算表給內建表格用——xls／ods 轉成 xlsx，公式也順便重算出值。
 *
 * 轉出來的檔案放在 userData 底下的快取，檔名是「路徑＋大小＋修改時間」的雜湊：
 * 原檔一改就換新檔名，舊的 7 天後清掉。
 */

const crypto = require('crypto')
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { execFile } = require('child_process')

/** 能轉的副檔名 → Office 的哪一支程式 */
const APP_OF = {
  doc: 'word', docx: 'word', docm: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', ods: 'excel',
  ppt: 'powerpoint', pptx: 'powerpoint', pptm: 'powerpoint', odp: 'powerpoint'
}
const TARGETS = new Set(['pdf', 'xlsx'])
const TIMEOUT_MS = 120_000
const KEEP_MS = 7 * 24 * 3600_000

let cacheRoot = ''
/** 快取資料夾；測試可以先 `setCacheDir` 指到暫存 */
function cacheDir() {
  if (!cacheRoot) cacheRoot = path.join(require('electron').app.getPath('userData'), 'office-preview')
  return cacheRoot
}
function setCacheDir(dir) {
  cacheRoot = dir
}

/** 快取檔名只會長這樣；`vi-media://` 那條拿它擋掉其他路徑 */
const CACHE_NAME = /^[0-9a-f]{40}\.(pdf|xlsx)$/

const winDir = () => process.env.SystemRoot || 'C:\\Windows'
const powershell = () => path.join(winDir(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function run(exe, args, env) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: TIMEOUT_MS, env: { ...process.env, ...env }, encoding: 'utf8' },
      (error, stdout, stderr) => (error ? reject(Object.assign(error, { stderr })) : resolve(stdout)))
  })
}

/** @type {Promise<{ office: Set<string>, soffice: string }> | null} */
let detected = null
/** 找轉檔程式（結果記住，這輩子只查一次） */
function detect() {
  if (!detected) {
    detected = (async () => {
      const office = new Set()
      for (const app of ['word', 'excel', 'powerpoint']) {
        const progId = `${app[0].toUpperCase()}${app.slice(1)}.Application`.replace('Powerpoint', 'PowerPoint')
        try {
          await run(path.join(winDir(), 'System32', 'reg.exe'), ['query', `HKCR\\${progId}\\CLSID`])
          office.add(app)
        } catch { /* 沒裝這一支 */ }
      }
      const soffice = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
        .filter(Boolean)
        .map((dir) => path.join(/** @type {string} */ (dir), 'LibreOffice', 'program', 'soffice.exe'))
        .find((exe) => fs.existsSync(exe)) || ''
      return { office, soffice }
    })()
  }
  return detected
}

/**
 * Office COM 轉檔。路徑走環境變數（不拼進指令字串，免跳脫）。
 * PowerPoint／Word 可能接到使用者已經開著的那一個程式：開之前沒有文件才 Quit，免得把人家的檔案關掉。
 * 密碼保護的檔案給一個假密碼，讓它直接失敗而不是跳出看不到的密碼框卡住。
 */
const COM_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$src = $env:AXON_SRC; $dst = $env:AXON_DST; $kind = $env:AXON_KIND; $target = $env:AXON_TARGET
$pw = 'axondeck-no-password'
if ($kind -eq 'word') {
  $app = New-Object -ComObject Word.Application
  $before = $app.Documents.Count
  try {
    $app.DisplayAlerts = 0
    $doc = $app.Documents.Open($src, $false, $true, $false, $pw)
    try { $doc.ExportAsFixedFormat($dst, 17) } finally { $doc.Close(0) }
  } finally { if ($before -eq 0) { $app.Quit() } }
} elseif ($kind -eq 'excel') {
  $app = New-Object -ComObject Excel.Application
  $before = $app.Workbooks.Count
  try {
    $app.DisplayAlerts = $false
    $app.AskToUpdateLinks = $false
    $book = $app.Workbooks.Open($src, 0, $true, [Type]::Missing, $pw)
    try {
      $app.CalculateFull()
      if ($target -eq 'pdf') { $book.ExportAsFixedFormat(0, $dst) } else { $book.SaveAs($dst, 51) }
    } finally { $book.Close($false) }
  } finally { if ($before -eq 0) { $app.Quit() } }
} else {
  $app = New-Object -ComObject PowerPoint.Application
  $before = $app.Presentations.Count
  try {
    $deck = $app.Presentations.Open("$src::$pw::", -1, 0, 0)
    try { $deck.SaveAs($dst, 32) } finally { $deck.Close() }
  } finally { if ($before -eq 0) { $app.Quit() } }
}
`

async function convertWithOffice(kind, src, dst, target) {
  const encoded = Buffer.from(COM_SCRIPT, 'utf16le').toString('base64')
  await run(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { AXON_SRC: src, AXON_DST: dst, AXON_KIND: kind, AXON_TARGET: target })
}

async function convertWithLibreOffice(soffice, src, dst, target, work) {
  const profile = `file:///${path.join(cacheDir(), 'lo-profile').replace(/\\/g, '/')}`
  await run(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', target, '--outdir', work, src])
  const produced = path.join(work, `${path.parse(src).name}.${target}`)
  await fsp.rename(produced, dst)
}

/** 一次只轉一份：Office COM 同時開好幾份很容易互卡 */
let queue = Promise.resolve()
/** 同一份檔案同時被要兩次就共用同一趟 @type {Map<string, Promise<string>>} */
const inflight = new Map()

/**
 * @param {string} full 原檔絕對路徑（呼叫端已經驗過在專案內）
 * @param {unknown} target 'pdf' | 'xlsx'
 * @returns {Promise<string>} 轉好的快取檔名（不含資料夾）
 */
async function convert(full, target) {
  if (typeof target !== 'string' || !TARGETS.has(target)) throw fail('BAD_TARGET', '不支援的轉檔格式')
  const ext = path.extname(full).slice(1).toLowerCase()
  const kind = APP_OF[ext]
  if (!kind || (target === 'xlsx' && kind !== 'excel')) throw fail('BAD_TARGET', '這種檔案不能這樣轉')
  const stat = await fsp.stat(full)
  const name = `${crypto.createHash('sha1').update(`${full}|${stat.size}|${stat.mtimeMs}|${target}`).digest('hex')}.${target}`
  const dst = path.join(cacheDir(), name)
  if (fs.existsSync(dst)) return name
  const pending = inflight.get(name)
  if (pending) return pending
  const job = queue.then(async () => {
    const tools = await detect()
    if (!tools.office.has(kind) && !tools.soffice) throw fail('NO_CONVERTER', '需要 Microsoft Office 或 LibreOffice 才能顯示原始版面')
    await fsp.mkdir(cacheDir(), { recursive: true })
    void prune()
    const work = await fsp.mkdtemp(path.join(cacheDir(), 'job-'))
    const out = path.join(work, `out.${target}`)
    try {
      if (tools.office.has(kind)) await convertWithOffice(kind, full, out, target)
      else await convertWithLibreOffice(tools.soffice, full, out, target, work)
      await fsp.rename(out, dst)
      return name
    } catch (error) {
      console.warn('[workspace] Office 轉檔失敗', String(error?.stderr || error?.message || error).slice(0, 300))
      throw fail('CONVERT_FAILED', '轉檔失敗（檔案可能有密碼或已損壞）')
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {})
    }
  })
  queue = job.catch(() => {})
  inflight.set(name, job)
  try {
    return await job
  } finally {
    inflight.delete(name)
  }
}

/** 清掉 7 天沒動過的轉檔結果與殘留的工作資料夾 */
async function prune() {
  try {
    const now = Date.now()
    for (const entry of await fsp.readdir(cacheDir(), { withFileTypes: true })) {
      const target = path.join(cacheDir(), entry.name)
      const old = now - (await fsp.stat(target)).mtimeMs > (entry.isDirectory() ? 3600_000 : KEEP_MS)
      if (!old) continue
      if (entry.isFile() && CACHE_NAME.test(entry.name)) await fsp.unlink(target)
      else if (entry.isDirectory() && entry.name.startsWith('job-')) await fsp.rm(target, { recursive: true, force: true })
    }
  } catch (error) {
    console.warn('[workspace] 清 Office 預覽快取失敗', error?.code || 'ERROR')
  }
}

/** `vi-media://…/~office/<name>` 收到的檔名 → 快取裡的絕對路徑（其他名字一律拒絕） */
function cachedPath(name) {
  if (!CACHE_NAME.test(String(name))) throw fail('NOT_FOUND', '找不到')
  return path.join(cacheDir(), name)
}

function fail(code, message) {
  return Object.assign(new Error(code), { code, userMessage: message })
}

module.exports = { APP_OF, convert, cachedPath, setCacheDir, detect }
