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
    return { version: match[1], url: match[0], publisher: 'NVIDIA Corporation', args: ['-s', '-noreboot'], elevate: true }
  }
  if (kind === 'rustdesk') {
    const release = JSON.parse(await metadata('https://api.github.com/repos/rustdesk/rustdesk/releases/latest'))
    const asset = release.assets?.find((item) => /^rustdesk-[\d.]+-x86_64\.exe$/.test(item.name))
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !/^https:\/\/github\.com\/rustdesk\/rustdesk\/releases\/download\//.test(asset.browser_download_url)) {
      throw failure('SOURCE_CHANGED', 'RustDesk 官方安裝檔或校驗資料不完整。')
    }
    return { version: String(release.tag_name).replace(/^v/, ''), url: asset.browser_download_url, sha256: asset.digest.slice(7), args: ['--silent-install'], elevate: true }
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

async function download(source, filename, progress) {
  const urls = [...new Set([source.url, ...(source.mirrors || [])])]
  for (let i = 0; i < urls.length; i++) {
    try { return await downloadOne({ ...source, url: urls[i] }, filename, progress) }
    catch (error) {
      if (i === urls.length - 1 || error.code === 'EEXIST') throw error
      await fs.promises.unlink(filename).catch((err) => { if (err.code !== 'ENOENT') throw err })
    }
  }
}

async function downloadOne(source, filename, progress) {
  const response = await fetch(source.url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
  if (!response.ok || !response.url.startsWith('https:')) throw failure('DOWNLOAD_FAILED', '安裝檔下載失敗，請稍後重試。')
  const total = Number(response.headers.get('content-length')) || 0
  let received = 0, last = 0
  const hash = crypto.createHash(source.sha512 ? 'sha512' : 'sha256')
  const meter = new Transform({ transform(chunk, _encoding, done) {
    received += chunk.length
    if (received > 2 * 1024 ** 3) return done(failure('DOWNLOAD_LIMIT', '安裝檔超過下載大小上限。'))
    hash.update(chunk)
    if (Date.now() - last > 400) { progress(total ? Math.min(99, Math.floor(received / total * 100)) : null); last = Date.now() }
    done(null, chunk)
  } })
  await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(filename, { flags: 'wx' }))
  const expected = source.sha512 || source.sha256
  if (expected && hash.digest(source.sha512 ? 'base64' : 'hex') !== expected) throw failure('CHECKSUM', '安裝檔校驗失敗，未執行安裝。請重新下載。')
  if (source.publisher) await verifyPublisher(filename, source.publisher)
}

async function verifyPublisher(filename, publisher) {
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:AXON_INSTALL_FILE; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch ('(^|, )CN='+[regex]::Escape($env:AXON_INSTALL_PUBLISHER)+'(,|$)')) {exit 1}"
  const result = await run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, AXON_INSTALL_FILE: filename, AXON_INSTALL_PUBLISHER: publisher }
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

module.exports = { resolveSource, download, install }
