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
  console.log('PASS app-installer download: SHA512, corrupt download rejected, official CDN allowlist, update metadata')
}
main().catch((error) => { console.error(error); process.exitCode = 1 }).finally(() => { global.fetch = originalFetch })
