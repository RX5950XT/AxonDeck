'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { tempDir, removeTree } = require('./lib/test-temp')
const moduleRoot = process.env.VOICEINK_EXE
  ? path.join(path.dirname(path.resolve(process.env.VOICEINK_EXE)), 'resources', 'app.asar')
  : path.join(__dirname, '..')
const { downloadFile } = require(path.join(moduleRoot, 'src/main/hfmodels/download'))
const SAMPLE = 32 * 1024 * 1024
const urls = {
  HF: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf',
  llama: 'https://github.com/ggml-org/llama.cpp/releases/download/b10666/llama-b10666-bin-win-vulkan-x64.zip',
  CUDA: 'https://developer.download.nvidia.com/compute/cuda/13.3.1/local_installers/cuda_13.3.1_windows.exe'
}
async function main() {
  const dir = tempDir('vi-speed-probe-')
  try {
    for (const [name, url] of Object.entries(urls)) {
      if (name === 'llama') {
        let officialBytes = 0
        const started = Date.now()
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
          assert(response.ok)
          for await (const chunk of response.body) officialBytes += chunk.length
        } catch (error) { if (!['TimeoutError', 'AbortError'].includes(error.name)) throw error }
        const officialSeconds = (Date.now() - started) / 1000
        const fastStarted = Date.now()
        const result = await downloadFile({ url, dest: path.join(dir, 'runtime.zip'), signal: AbortSignal.timeout(60000) })
        const seconds = (Date.now() - fastStarted) / 1000
        console.log(JSON.stringify({ name, officialBytes, officialSeconds,
          acceleratedBytes: result.bytes, acceleratedSeconds: seconds,
          MBps: Number((result.bytes / 1048576 / seconds).toFixed(2)), sha256Verified: true }))
        continue
      }
      const rows = []
      for (const parallel of [false, true]) {
        const dest = path.join(dir, `${name}-${parallel}`)
        const started = Date.now()
        let requests = 0
        // 真流量只取檔案前 32MB；標頭總長度縮成取樣長度，其他行為走產品 downloader。
        await downloadFile({ url, dest, expectedBytes: SAMPLE, parallel: parallel ? undefined : false,
          signal: AbortSignal.timeout(120000), fetchImpl: async (href, init) => {
            requests++
            const range = init.headers.range || `bytes=0-${SAMPLE - 1}`
            const response = await fetch(href, { ...init, headers: { ...init.headers, range } })
            assert.equal(response.status, 206)
            const headers = new Headers(response.headers)
            const contentRange = headers.get('content-range')
            headers.set('content-range', contentRange.replace(/\/\d+$/, `/${SAMPLE}`))
            return new Response(response.body, { status: 206, headers })
          } })
        rows.push({ mode: parallel ? 'auto' : 'single', seconds: (Date.now() - started) / 1000,
          requests, sha256: createHash('sha256').update(fs.readFileSync(dest)).digest('hex') })
      }
      assert.equal(rows[0].sha256, rows[1].sha256)
      console.log(JSON.stringify({ name, sampleMB: 32, rows,
        speedup: Number((rows[0].seconds / rows[1].seconds).toFixed(2)) }))
    }
  } finally { removeTree(dir) }
}
if (process.versions.electron) {
  const { app } = require('electron')
  app.setPath('userData', tempDir('speed-user-'))
  app.whenReady().then(main).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
} else {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
