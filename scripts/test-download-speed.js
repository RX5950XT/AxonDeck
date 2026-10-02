'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { tempDir, removeTree } = require('./lib/test-temp')
const { downloadFile } = require('../src/main/hfmodels/download')

async function main() {
  const dir = tempDir('vi-download-speed-')
  const bytes = Buffer.alloc(33 * 1024 * 1024, 37)
  let active = 0, peak = 0, ranges = 0
  const fetchImpl = async (_url, init) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.range || '')
    if (!match) return new Response(bytes, { headers: {
      'content-length': String(bytes.length), 'accept-ranges': 'bytes', etag: '"fixed"'
    } })
    ranges++; active++; peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active--
    const start = Number(match[1]), end = Number(match[2])
    assert.equal(init.headers['if-range'], '"fixed"')
    return new Response(bytes.subarray(start, end + 1), { status: 206, headers: {
      'content-range': `bytes ${start}-${end}/${bytes.length}`, etag: '"fixed"'
    } })
  }
  try {
    const dest = path.join(dir, 'parallel.bin')
    await downloadFile({ url: 'https://download.test/file', dest, fetchImpl, parallel: true })
    assert(peak > 1 && peak <= 4, `應並行下載，實際 ${peak}`)
    assert(ranges > 1)
    assert(fs.readFileSync(dest).equals(bytes))
    console.log('PASS 四連線分段下載且位元組一致')
    const auto = path.join(dir, 'auto.bin')
    const realNow = Date.now
    let clock = 0
    const beforeRanges = ranges
    try {
      Date.now = () => { clock += 200; return clock }
      await downloadFile({ url: 'https://download.test/file', dest: auto, fetchImpl: async (url, init) => {
        if (init.headers.range) return fetchImpl(url, init)
        let offset = 0
        return new Response(new ReadableStream({ pull(controller) {
          if (offset === bytes.length) { controller.close(); return }
          const end = Math.min(offset + 1024 * 1024, bytes.length)
          controller.enqueue(bytes.subarray(offset, end)); offset = end
        } }), { headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes', etag: '"fixed"' } })
      } })
    } finally { Date.now = realNow }
    assert(ranges > beforeRanges, '慢速單連線應切換分段')
    assert(fs.readFileSync(auto).equals(bytes))
    console.log('PASS 慢速連線自動切分段，接合內容一致')
    const controller = new AbortController()
    const cancelled = path.join(dir, 'cancelled.bin')
    await assert.rejects(downloadFile({ url: 'https://download.test/file', dest: cancelled,
      signal: controller.signal, parallel: true, fetchImpl: async (url, init) => {
        if (init.headers.range) { controller.abort(); throw new DOMException('cancelled', 'AbortError') }
        return fetchImpl(url, init)
      } }))
    assert(!fs.existsSync(cancelled))
    assert.equal(require('node:events').getEventListeners(controller.signal, 'abort').length, 0)
    console.log('PASS 分段取消不產生正式檔案且移除監聽')
    const resume = path.join(dir, 'resume.bin')
    fs.writeFileSync(`${resume}.part`, bytes.subarray(0, 1024))
    await downloadFile({ url: 'https://download.test/file', dest: resume, expectedBytes: bytes.length, parallel: true,
      fetchImpl: async (url, init) => {
        const range = /^bytes=(\d+)-$/.exec(init.headers.range || '')
        if (!range) return fetchImpl(url, init)
        const start = Number(range[1])
        return new Response(bytes.subarray(start), { status: 206, headers: {
          'content-length': String(bytes.length - start), 'accept-ranges': 'bytes', etag: '"fixed"'
        } })
      } })
    assert(fs.readFileSync(resume).equals(bytes))
    console.log('PASS 分段續傳保留已有前段')
    const fallback = path.join(dir, 'fallback.bin')
    await downloadFile({ url: 'https://download.test/file', dest: fallback, parallel: true,
      fetchImpl: async (_url, init) => new Response(bytes, { headers: {
        'content-length': String(bytes.length), 'accept-ranges': 'bytes', etag: '"fixed"'
      } }) })
    assert(fs.readFileSync(fallback).equals(bytes))
    console.log('PASS 上游忽略分段時自動回單連線')
    await assert.rejects(downloadFile({ url: 'https://download.test/file',
      dest: path.join(dir, 'too-big'), maxBytes: 12,
      fetchImpl: async () => new Response('123456789012345') }), /大小/)
    assert(!fs.existsSync(path.join(dir, 'too-big')))
    console.log('PASS 未知大小仍遵守下載上限')
    const { rankDownloadUrls } = require('../src/main/update-mirrors')
    const urls = ['https://slow.test/file', 'https://fast.test/file', 'https://official.test/file'].map(u => new URL(u))
    const ranked = await rankDownloadUrls(urls, { fetchImpl: async url => {
      await new Promise(resolve => setTimeout(resolve, url.includes('slow') ? 30 : 1))
      return new Response(Buffer.alloc(262144))
    } })
    assert.equal(ranked[0].hostname, 'fast.test')
    assert.equal(ranked[2].hostname, 'official.test')
    console.log('PASS 實測較快鏡像優先，官方保留退路')
    const originalFetch = global.fetch
    const canonical = 'https://github.com/test/repo/releases/download/v1/file.zip'
    const good = Buffer.from('official-good'), bad = Buffer.alloc(good.length)
    let mirrorDownloads = 0
    try {
      global.fetch = async (url, init) => {
        if (String(url).startsWith('https://api.github.com/')) return Response.json({ assets: [{
          name: 'file.zip', browser_download_url: canonical, size: good.length,
          digest: `sha256:${createHash('sha256').update(good).digest('hex')}`
        }] })
        const mirror = String(url).startsWith('https://gh')
        if (mirror && !init.headers.range) mirrorDownloads++
        const data = mirror ? bad : good
        return new Response(data, { headers: { 'content-length': String(data.length) } })
      }
      const verified = path.join(dir, 'verified.zip')
      await downloadFile({ url: canonical, dest: verified })
      assert.equal(mirrorDownloads, 2)
      assert(fs.readFileSync(verified).equals(good))
      console.log('PASS 鏡像大小相同但 SHA-256 錯誤時改官方，壞檔不留下')
    } finally { global.fetch = originalFetch }
  } finally { removeTree(dir) }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
