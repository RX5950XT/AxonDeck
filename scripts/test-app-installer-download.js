'use strict'
const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { tempDir } = require('./lib/test-temp')
const { download, resolveSource } = require('../src/main/app-installer/direct')
const originalFetch = global.fetch
async function main() {
  const dir = tempDir('installer-download-')
  const content = Buffer.from('fixture installer bytes, never executed')
  const sha512 = crypto.createHash('sha512').update(content).digest('base64')
  global.fetch = async (url) => {
    const response = new Response(content, { headers: { 'content-length': String(content.length) } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  await download({ url: 'https://example.test/app.exe', sha512 }, path.join(dir, 'good.exe'), () => {})
  assert.deepEqual(fs.readFileSync(path.join(dir, 'good.exe')), content)
  await assert.rejects(download({ url: 'https://example.test/app.exe', sha256: '0'.repeat(64) }, path.join(dir, 'bad.exe'), () => {}), /校驗/)
  // 分段：伺服器支援 Range 時切段並行，壞節點自動跳過，組回來的內容要一致。
  const big = crypto.randomBytes(20 * 1024 * 1024)
  const sha256 = crypto.createHash('sha256').update(big).digest('hex')
  let ranged = 0, flaky = true
  global.fetch = async (url, options = {}) => {
    if (url.includes('down.test')) throw new TypeError('fetch failed')
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '') || []
    if (start === String(8 * 1024 * 1024) && flaky) { flaky = false; throw new TypeError('connection reset') }
    const body = start ? big.subarray(+start, +end + 1) : big
    if (start) ranged++
    const response = new Response(body, { status: start ? 206 : 200, headers: start ? { 'content-range': `bytes ${start}-${end}/${big.length}` } : {} })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  await download({ url: 'https://down.test/app.exe', mirrors: ['https://ok.test/app.exe'], sha256 }, path.join(dir, 'big.exe'), () => {})
  assert.deepEqual(fs.readFileSync(path.join(dir, 'big.exe')), big)
  assert.equal(ranged, 1 + 3) // 測速 1 次＋三塊 8/8/4 MB（重試那次在送出前就失敗）
  global.fetch = async (url) => new Response(url.includes('/eapi/')
    ? JSON.stringify({ service: { desktopApps: { windows: 'https://evil.test/latest.yml' } } }) : '')
  await assert.rejects(resolveSource('zlibrary'), /來源已變更/)
  global.fetch = async (url) => new Response(url.includes('/eapi/')
    ? JSON.stringify({ service: { desktopApps: { windows: 'https://dln1.ncdn.ec/general-files/soft/desktop/latest.yml' } } })
    : `version: 3.2.1\npath: Z-Library-latest.exe\nsha512: ${sha512}\n`)
  const source = await resolveSource('zlibrary')
  assert.equal(source.version, '3.2.1')
  assert.equal(source.sha512, sha512)
  assert.equal(source.url, 'https://dln1.ncdn.ec/general-files/soft/desktop/Z-Library-latest.exe')
  assert.deepEqual(source.args, ['/S'])
  console.log('PASS app-installer download: SHA512, 8 MB chunks with retry and dead-node failover, corrupt download rejected, official CDN allowlist, update metadata')
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = originalFetch })
