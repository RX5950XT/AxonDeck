'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const { failure, run, powershellPath } = require('./winget')

const NVIDIA = {
  nvidia: { page: 'https://www.nvidia.com/en-us/software/nvidia-app/', pattern: /https:\/\/us\.download\.nvidia\.com\/nvapp\/client\/([\d.]+)\/NVIDIA_app_v[\d.]+\.exe/ },
  broadcast: { page: 'https://www.nvidia.com/en-us/geforce/broadcasting/broadcast-app/', pattern: /https:\/\/international\.download\.nvidia\.com\/Windows\/broadcast\/([\d.]+)\/NVIDIA_Broadcast_v[\d.]+\.exe/ }
}

async function metadata(url) {
  const headers = { 'User-Agent': 'AxonDeck-App-Installer', Accept: 'application/json,text/html' }
  let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers })
  // 部分官方入口先設定 cookie，再導回同一個網址；只允許這種同址重送一次。
  if ([302, 307].includes(response.status) && response.headers.get('location') === url) {
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ')
    await response.body?.cancel()
    response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(20000), headers: { ...headers, Cookie: cookies } })
  }
  if (!response.ok) throw failure('SOURCE_UNAVAILABLE', '官方下載來源暫時無法使用，請稍後重試。')
  const reader = response.body.getReader()
  let body = '', bytes = 0
  const decoder = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > 4 * 1024 * 1024) { await reader.cancel(); throw failure('SOURCE_INVALID', '官方下載資料過大。') }
    body += decoder.decode(value, { stream: true })
  }
  return body + decoder.decode()
}

async function resolveSource(kind) {
  if (kind === 'zlibrary') return resolveZlibrary()
  if (kind === 'freecad') return {
    version: 'tw-20260904-0408', args: ['/S'], elevate: true,
    url: 'https://github.com/RX5950XT/FreeCAD/releases/download/tw-20260904-0408/FreeCAD-TW_20260904-0408-Windows-x86_64-installer.exe',
    sha256: '25dd9866dedbdf89ba85b35638b50a529009f870aedf9dd8dead2006ae4835e7'
  }
  if (NVIDIA[kind]) {
    const config = NVIDIA[kind]
    const match = (await metadata(config.page)).match(config.pattern)
    if (!match) throw failure('SOURCE_CHANGED', 'NVIDIA 下載頁已變更，目前無法取得安裝檔。')
    const mirrors = ['us', 'international', 'uk'].map((host) => match[0].replace(/^https:\/\/[a-z]+\.download/, `https://${host}.download`))
    return { version: match[1], url: match[0], mirrors, publisher: 'NVIDIA Corporation', args: ['-s', '-noreboot'], elevate: true }
  }
  if (kind === 'rustdesk') {
    const release = JSON.parse(await metadata('https://api.github.com/repos/rustdesk/rustdesk/releases/latest'))
    const asset = release.assets?.find((item) => /^rustdesk-[\d.]+-x86_64\.exe$/.test(item.name))
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !/^https:\/\/github\.com\/rustdesk\/rustdesk\/releases\/download\//.test(asset.browser_download_url)) {
      throw failure('SOURCE_CHANGED', 'RustDesk 官方安裝檔或校驗資料不完整。')
    }
    return { version: String(release.tag_name).replace(/^v/, ''), url: asset.browser_download_url, sha256: asset.digest.slice(7), args: ['--silent-install'], elevate: true }
  }
  if (kind === 'google-app') return {
    // 桌機版 Google App 不在 WinGet；官方固定短網址永遠給最新版（安裝參數由伺服器下發時寫進檔內）。
    // 內嵌 needsadmin=False（使用者層級、免 UAC）；/silent 由安裝檔內字串確認支援；裝完由 Omaha 自己更新，故不追版本號。
    version: '', args: ['/silent'], elevate: false, publisher: 'Google LLC',
    url: 'https://dl.google.com/tag/s/appguid%3D%7B06A8089E-0B65-445D-B5C4-10B0D1B540F2%7D%26appname%3DGoogle%2520App%26needsadmin%3DFalse%26ap%3Dga%26referral%3Dgoogle.search%26lang%3Den/windows-google-app/GoogleAppInstaller.exe'
  }
  throw failure('NO_SOURCE', '此程式尚無可驗證的自動安裝來源。')
}

// 沿用官方桌面版的 /eapi/info/service 更新來源；不執行網頁的驗證腳本。
async function resolveZlibrary() {
  const service = JSON.parse(await metadata('https://z-lib.fm/eapi/info/service'))
  const feed = new URL(service.service?.desktopApps?.windows)
  if (feed.protocol !== 'https:' || !['dln1.ncdn.ec', 's3proxy.cdn-zlib.sk'].includes(feed.hostname) || feed.username || feed.password) {
    throw failure('SOURCE_CHANGED', 'Z-Library 官方下載來源已變更，暫停自動安裝。')
  }
  const base = new URL('.', feed)
  const text = await metadata(new URL('latest.yml', base).href)
  const version = text.match(/^version: *['"]?([\d.]+)['"]?\s*$/m)?.[1]
  const sha512 = text.match(/^sha512: *([A-Za-z0-9+/]{86}==)\s*$/m)?.[1]
  const file = text.match(/^path: *([\w.-]+\.exe)\s*$/m)?.[1]
  if (!version || !sha512 || !file) throw failure('SOURCE_CHANGED', 'Z-Library 更新校驗資料不完整。')
  return { version, sha512, url: new URL(file, base).href,
    mirrors: [`https://s3proxy.cdn-zlib.sk/te_public_files/soft/desktop/${file}`], args: ['/S'], elevate: false }
}

const MAX_SIZE = 2 * 1024 ** 3, PROBE = 1024 ** 2, SEGMENT_MIN = 16 * 1024 ** 2, CHUNK = 8 * 1024 ** 2, WORKERS = 16, CHUNK_ATTEMPTS = 3

async function download(source, filename, progress) {
  const nodes = await rankNodes([...new Set([source.url, ...(source.mirrors || [])])])
  for (let i = 0; i < nodes.length; i++) {
    try {
      const node = nodes[i]
      if (node.total > SEGMENT_MIN) await downloadSegments(node, filename, progress)
      else await downloadOne(node.url, filename, progress)
      await verifyChecksum(filename, source)
      if (source.publisher) await verifyPublisher(filename, source.publisher)
      return
    } catch (error) {
      if (i === nodes.length - 1 || error.code === 'EEXIST') throw error
      await fs.promises.unlink(filename).catch((err) => { if (err.code !== 'ENOENT') throw err })
    }
  }
}

// 每個節點同時抓開頭 1 MB 測速，最快的先用；測不到的排最後當備援。
async function rankNodes(urls) {
  const probes = await Promise.all(urls.map(async (url) => {
    const started = Date.now()
    try {
      const response = await fetch(url, { headers: { Range: `bytes=0-${PROBE - 1}` }, signal: AbortSignal.timeout(8000) })
      if (!response.ok || !response.url.startsWith('https:')) { await response.body?.cancel(); return { url, speed: -1 } }
      const total = response.status === 206 ? Number(response.headers.get('content-range')?.match(/\/(\d+)$/)?.[1]) || 0 : 0
      let bytes = 0
      for await (const chunk of response.body) { bytes += chunk.length; if (bytes >= PROBE) break }
      return { url, final: response.url, total, speed: bytes / Math.max(1, Date.now() - started) }
    } catch { return { url, speed: -1 } }
  }))
  return probes.sort((a, b) => b.speed - a.speed)
}

// 支援分段的伺服器：切成 8 MB 小塊，最多 16 條連線輪流領取；單塊失敗重抓，不拖累整體（GitHub 這類單線限速的來源可快數倍）。
async function downloadSegments(node, filename, progress) {
  const { final: url, total } = node
  if (total > MAX_SIZE) throw failure('DOWNLOAD_LIMIT', '安裝檔超過下載大小上限。')
  const chunks = []
  for (let start = 0; start < total; start += CHUNK) chunks.push([start, Math.min(total, start + CHUNK) - 1])
  const controller = new AbortController(), file = await fs.promises.open(filename, 'wx')
  const state = { received: 0, last: 0, total, progress }
  let firstError
  const worker = async () => {
    while (chunks.length && !firstError) {
      const [start, end] = chunks.shift()
      for (let attempt = 1; ; attempt++) {
        try { await fetchChunk(url, start, end, file, state, controller.signal); break }
        catch (error) {
          if (attempt >= CHUNK_ATTEMPTS || controller.signal.aborted) { firstError ??= error; controller.abort(); return }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, worker))
  await file.close()
  if (firstError) throw firstError
}

async function fetchChunk(url, start, end, file, state, abort) {
  const signal = AbortSignal.any([abort, AbortSignal.timeout(10 * 60 * 1000)])
  const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal })
  if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${state.total}`) {
    await response.body?.cancel()
    throw failure('DOWNLOAD_FAILED', '安裝檔下載失敗，請稍後重試。')
  }
  let position = start
  try {
    for await (const chunk of response.body) {
      if (position + chunk.length > end + 1) throw failure('DOWNLOAD_FAILED', '安裝檔下載失敗，請稍後重試。')
      await file.write(chunk, 0, chunk.length, position)
      position += chunk.length
      state.received += chunk.length
      if (Date.now() - state.last > 400) { state.progress(Math.min(99, Math.floor(state.received / state.total * 100))); state.last = Date.now() }
    }
    if (position !== end + 1) throw failure('DOWNLOAD_FAILED', '安裝檔下載不完整，請稍後重試。')
  } catch (error) {
    state.received -= position - start // 重抓時進度不重複計算
    throw error
  }
}

async function downloadOne(url, filename, progress) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok || !response.url.startsWith('https:')) throw failure('DOWNLOAD_FAILED', '安裝檔下載失敗，請稍後重試。')
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0, last = 0
  const meter = new Transform({ transform(chunk, _encoding, done) {
    received += chunk.length
    if (received > MAX_SIZE) return done(failure('DOWNLOAD_LIMIT', '安裝檔超過下載大小上限。'))
    if (Date.now() - last > 400) { progress(total ? Math.min(99, Math.floor(received / total * 100)) : null); last = Date.now() }
    done(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(filename, { flags: 'wx' }))
}

async function verifyChecksum(filename, source) {
  const expected = source.sha512 || source.sha256
  if (!expected) return
  const hash = crypto.createHash(source.sha512 ? 'sha512' : 'sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  if (hash.digest(source.sha512 ? 'base64' : 'hex') !== expected) throw failure('CHECKSUM', '安裝檔校驗失敗，未執行安裝。請重新下載。')
}

async function verifyPublisher(filename, publisher) {
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:AXON_INSTALL_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch ('(^|, )CN='+[regex]::Escape($env:AXON_INSTALL_PUBLISHER)+'(,|$)')) {exit 1}"
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    // 不繼承 pwsh 7 的 PSModulePath，否則 Windows PowerShell 載不到 Get-AuthenticodeSignature。
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH')), AXON_INSTALL_FILE: filename, AXON_INSTALL_PUBLISHER: publisher }
  })
  if (result.code !== 0) throw failure('SIGNATURE', '安裝檔的官方數位簽章無法驗證，未執行安裝。')
}

async function install(kind, cacheDir, update) {
  const source = await resolveSource(kind)
  await fs.promises.mkdir(cacheDir, { recursive: true })
  const filename = path.join(cacheDir, `${crypto.randomUUID()}.exe`)
  try {
    update({ phase: 'downloading', message: '正在下載官方安裝檔…', progress: null })
    await download(source, filename, (progress) => update({ progress }))
    update({ phase: 'installing', message: '正在安裝；若 Windows 要求授權，請確認系統提示。', progress: null })
    // 所有參數來自固定 source；用環境變數帶路徑，不拼接外部命令文字。
    const elevation = source.elevate ? '-Verb RunAs' : ''
    const script = `$ErrorActionPreference='Stop'; try {$a=ConvertFrom-Json $env:AXON_INSTALL_ARGS; $p=Start-Process -FilePath $env:AXON_INSTALL_FILE -ArgumentList $a ${elevation} -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode} catch {exit 1}`
    const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeout: 0, env: { ...process.env, AXON_INSTALL_FILE: filename, AXON_INSTALL_ARGS: JSON.stringify(source.args) }
    })
    return { ...result, version: source.version }
  } finally {
    await fs.promises.unlink(filename).catch((error) => { if (error.code !== 'ENOENT') console.warn('[app-installer] installer cache cleanup failed') })
  }
}

// 有內建更新程式、WinGet 卻更新不了的軟體，改用它自己的更新程式。
// iCUE：WinGet 安裝檔在已安裝時不支援靜默更新（會直接當掉），改用 cuepkg；一次 UAC 跑完 update＋upgrade。
const ICUE_SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
  $dir = $env:AXON_APP_DIR
  $pkg = Get-ChildItem -LiteralPath $dir -Directory -Filter 'cuepkg*' | ForEach-Object { Join-Path $_.FullName 'cuepkg.exe' } | Where-Object { Test-Path -LiteralPath $_ } | Sort-Object { (Get-Item -LiteralPath $_).LastWriteTime } | Select-Object -Last 1
  if (!$pkg) { exit 2 }
  $q = { param($s) "'" + $s.Replace("'", "''") + "'" }
  $base = "& $(& $q $pkg) --installdir $(& $q $dir)"
  $inner = "$base update" + '; if ($LASTEXITCODE) { exit $LASTEXITCODE }; ' + "$base upgrade --locked-files-action terminate" + '; exit $LASTEXITCODE'
  $running = Get-Process iCUE -ErrorAction SilentlyContinue
  $p = Start-Process powershell.exe -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand',([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))) -Verb RunAs -WindowStyle Hidden -Wait -PassThru
  if ($p.ExitCode -eq 0 -and $running -and !(Get-Process iCUE -ErrorAction SilentlyContinue)) { Start-Process -FilePath (Join-Path $dir 'iCUE.exe') -ArgumentList '--autorun' }
  exit $p.ExitCode
} catch { exit 1 }`

// Google Cloud SDK：安裝紀錄沒有版本號，WinGet 永遠回「沒有適用的更新」；改用 gcloud components update。
const GCLOUD_SCRIPT = String.raw`$ErrorActionPreference='Stop'
try {
  $exe = Join-Path $env:AXON_APP_DIR 'google-cloud-sdk\bin\gcloud.cmd'
  if (!(Test-Path -LiteralPath $exe)) { exit 2 }
  $env:CLOUDSDK_CORE_DISABLE_PROMPTS = '1'
  # 官方規定：非互動更新不能用正在用的內建 Python，先複製一份到暫存區再更新
  $py = & $exe components copy-bundled-python | Select-Object -Last 1
  if ($LASTEXITCODE) { exit $LASTEXITCODE }
  if ($py) { $env:CLOUDSDK_PYTHON = $py.Trim() }
  & $exe components update --quiet
  exit $LASTEXITCODE
} catch { exit 1 }`

const SELF_UPDATERS = {
  'Corsair.iCUE.5': { name: 'iCUE', script: ICUE_SCRIPT, dir: () => path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Corsair', 'Corsair iCUE5 Software') },
  'Google.CloudSDK': { name: 'Google Cloud SDK', script: GCLOUD_SCRIPT, dir: () => path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK') }
}

async function selfUpgrade(target, update) {
  const updater = SELF_UPDATERS[target.id]
  const dir = String(target.location || '').replace(/^"|"$/g, '') || updater.dir()
  if (!/^[a-z]:\\/i.test(dir)) throw failure('INVALID', `${updater.name} 安裝位置無效。`)
  update({ phase: 'installing', message: `正在用 ${updater.name} 內建更新程式更新；若 Windows 要求授權，請確認系統提示。`, progress: null })
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(updater.script, 'utf16le').toString('base64')], {
    timeout: 0, env: { ...process.env, AXON_APP_DIR: dir }
  })
  if (result.code === 2) throw failure('INSTALL_FAILED', `找不到 ${updater.name} 內建更新程式，請在程式裡手動更新。`)
  return result
}

module.exports = { resolveSource, download, install, selfUpgrade, SELF_UPDATERS }
