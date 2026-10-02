'use strict'
/**
 * 檔案轉錄的雲端片段：429／逾時／5xx／斷線要等一下再送，
 * 重試仍失敗時保留已經轉好的文字，取消則整份作廢。
 *
 * 跑法：node scripts/test-cloud-asr-retry.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const vm = require('node:vm')
const cloud = require('../src/main/cloud-asr')

function transient(code, message, retryAfterMs) {
  const err = new Error(message)
  err.code = code
  if (retryAfterMs) err.retryAfterMs = retryAfterMs
  return err
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume()
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => new Promise((done) => server.close(done))
    }))
  })
}

function legacyStore(url) {
  return {
    get: (key, fallback) => ({
      asrApiUrl: url,
      asrApiKey: 'sk-local-user-key',
      asrModelId: 'openai/whisper-1'
    }[key] ?? fallback)
  }
}

/** 把 transcribeFileCloud 放進沙箱，ffmpeg 與雲端都換成假的 */
function loadCloudJob(cloudAsr, files = ['seg_000.mp3']) {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/file-transcribe.js'), 'utf8')
  const start = source.indexOf('async function transcribeFileCloud(')
  const context = {
    path,
    os: { tmpdir: () => 'unused' },
    process,
    randomBytes: () => 'test',
    activeJob: null,
    jobGen: 0,
    MAX_DURATION_SEC: 14400,
    CLOUD_CHUNK_SECONDS: 50,
    CLOUD_CHUNK_TIMEOUT_MS: 90000,
    cancel() { context.activeJob?.kill(); context.activeJob = null },
    validateFilePath: () => ({ size: 1 }),
    resolveFfmpegPath: () => 'unused',
    parseDurationSec: () => 1,
    formatDuration: () => '1 秒',
    runFfmpeg: async () => ({ code: 0, stderr: '' }),
    fsp: {
      mkdir: async () => {},
      readdir: async () => files,
      readFile: async () => Buffer.from('audio'),
      rm: async () => {}
    },
    cloudAsr
  }
  vm.createContext(context)
  vm.runInContext(source.slice(start, source.indexOf('\n}', start) + 2), context)
  return context
}

async function testDelayMath() {
  assert.equal(cloud.isTransientCloudAsrError(transient('RATE_LIMIT', 'x')), true)
  assert.equal(cloud.isTransientCloudAsrError(transient('TIMEOUT', 'x')), true)
  assert.equal(cloud.isTransientCloudAsrError(transient('UPSTREAM', 'x')), true)
  assert.equal(cloud.isTransientCloudAsrError(transient('NETWORK', 'x')), true)
  assert.equal(cloud.isTransientCloudAsrError(new Error('雲端語音辨識認證失敗，請檢查 API Key')), false)
  assert.equal(cloud.isTransientCloudAsrError(null), false)

  assert.equal(cloud.parseRetryAfterMs('2'), 2000)
  assert.equal(cloud.parseRetryAfterMs('0'), 0)
  assert.equal(cloud.parseRetryAfterMs('nope'), 0)
  assert.equal(cloud.parseRetryAfterMs(''), 0)
  assert.equal(cloud.parseRetryAfterMs('120'), 60000)
  const soon = new Date(Date.now() + 2500).toUTCString()
  const fromDate = cloud.parseRetryAfterMs(soon)
  assert.ok(fromDate >= 1000 && fromDate <= 3000, `HTTP-date 應落在 1–3 秒，實際 ${fromDate}`)

  assert.equal(cloud.cloudRetryDelayMs({ retryAfterMs: 4000 }, 1), 4000)
  assert.equal(cloud.cloudRetryDelayMs({ retryAfterMs: 0 }, 1), 3000)
  assert.equal(cloud.cloudRetryDelayMs({}, 1), 3000)
  assert.equal(cloud.cloudRetryDelayMs({}, 2), 6000)
  assert.equal(cloud.cloudRetryDelayMs({}, 3), 12000)
  assert.equal(cloud.cloudRetryDelayMs({ retryAfterMs: 999999 }, 1), 60000)
  console.log('PASS 暫時性錯誤與等待時間')
}

async function testRetryLoop() {
  const sleeps = []
  let calls = 0
  const waits = []
  const result = await cloud.retryTransient(async () => {
    calls += 1
    if (calls < 3) throw transient('RATE_LIMIT', '雲端語音辨識請求過於頻繁，請稍後再試', 4000)
    return '第三段成功'
  }, {
    sleep: async (ms) => { sleeps.push(ms); return true },
    onWait: (info) => waits.push(info)
  })
  assert.equal(result.text, '第三段成功')
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [4000, 4000])
  assert.equal(result.paceMs, 4000)
  assert.equal(waits.length, 2)
  assert.equal(waits[0].attempt, 1)
  assert.equal(waits[0].limit, 5)
  assert.equal(waits[0].code, 'RATE_LIMIT')
  assert.equal(waits[1].attempt, 2)
  assert.ok(result.lastAt > 0)

  let timeouts = 0
  await assert.rejects(
    () => cloud.retryTransient(async () => {
      timeouts += 1
      throw transient('TIMEOUT', '雲端 ASR 逾時，請稍後再試或縮短音訊')
    }, { sleep: async () => true }),
    /逾時/
  )
  assert.equal(timeouts, 3, '逾時最多試 3 次，不要每一段卡到整份超時')

  let authCalls = 0
  await assert.rejects(
    () => cloud.retryTransient(async () => {
      authCalls += 1
      throw new Error('雲端語音辨識認證失敗，請檢查 API Key')
    }, { sleep: async () => true }),
    /API Key/
  )
  assert.equal(authCalls, 1, '認證失敗不可重試')

  let rateCalls = 0
  await assert.rejects(
    () => cloud.retryTransient(async () => {
      rateCalls += 1
      throw transient('RATE_LIMIT', '雲端語音辨識請求過於頻繁，請稍後再試')
    }, { sleep: async () => true }),
    /過於頻繁/
  )
  assert.equal(rateCalls, 5)

  await assert.rejects(
    () => cloud.retryTransient(async () => {
      throw transient('RATE_LIMIT', '雲端語音辨識請求過於頻繁，請稍後再試')
    }, { sleep: async () => false }),
    /轉錄已取消/
  )

  await assert.rejects(
    () => cloud.retryTransient(async () => '晚到的成功', {
      isStopped: () => true,
      sleep: async () => true
    }),
    /轉錄已取消/
  )
  console.log('PASS 同一段重試、認證失敗不重試、取消會停')
}

async function testLiveHttp() {
  let hits = 0
  const up = await startServer((req, res) => {
    hits += 1
    if (hits < 3) {
      res.writeHead(429, { 'retry-after': '2', 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'sk-LEAKED-abcdef123456' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ text: '重試後的逐字稿' }))
  })
  try {
    const store = legacyStore(up.url)
    let direct = null
    try {
      await cloud.transcribeAudio({
        buffer: cloud.float32ToWav(new Float32Array(1600), 16000),
        format: 'wav',
        store
      })
    } catch (error) {
      direct = error
    }
    assert.equal(direct?.code, 'RATE_LIMIT')
    assert.equal(direct?.retryAfterMs, 2000)
    assert.equal(direct?.message.includes('sk-LEAKED'), false)

    const done = await cloud.retryTransient(
      () => cloud.transcribeAudio({
        buffer: cloud.float32ToWav(new Float32Array(1600), 16000),
        format: 'wav',
        store
      }),
      { sleep: async () => true }
    )
    assert.equal(done.text, '重試後的逐字稿')
    assert.equal(hits, 3)
  } finally {
    await up.close()
  }

  const hung = await startServer(() => {})
  try {
    await assert.rejects(
      () => cloud.transcribeAudio({
        buffer: Buffer.from('audio'),
        format: 'mp3',
        store: legacyStore(hung.url),
        timeoutMs: 1000
      }),
      (error) => error?.code === 'TIMEOUT' && /逾時/.test(error.message)
    )
  } finally {
    await hung.close()
  }
  console.log('PASS 真 HTTP：429 帶 Retry-After 會再送，逾時有代碼')
}

async function testFileJobKeepsFinishedChunks() {
  const job = loadCloudJob({
    retryTransient: async () => {
      job.calls += 1
      if (job.calls === 1) return { text: '第一段', paceMs: 0, lastAt: 0 }
      throw transient('RATE_LIMIT', '雲端語音辨識請求過於頻繁，請稍後再試')
    }
  }, ['seg_000.mp3', 'seg_001.mp3'])
  job.calls = 0
  const result = await job.transcribeFileCloud({ filePath: 'test.mp3', store: {} })
  assert.equal(result.text, '第一段')
  assert.match(result.warning, /第 2\/2 段/)
  assert.match(result.warning, /過於頻繁/)
  assert.equal(result.warning.includes('sk-'), false)
  assert.equal(job.activeJob, null)

  let release
  let entered
  const started = new Promise((resolve) => { entered = resolve })
  let calls = 0
  const cancelJob = loadCloudJob({
    retryTransient: () => {
      calls += 1
      if (calls === 1) return { text: '已完成', paceMs: 0, lastAt: 0 }
      entered()
      return new Promise((resolve) => { release = resolve })
    }
  }, ['seg_000.mp3', 'seg_001.mp3'])
  const pending = cancelJob.transcribeFileCloud({ filePath: 'test.mp3', store: {} })
  const rejected = assert.rejects(pending, /轉錄已取消/)
  await started
  cancelJob.cancel()
  release({ text: '不該留下', paceMs: 0, lastAt: 0 })
  await rejected
  assert.equal(cancelJob.activeJob, null)
  console.log('PASS 重試盡了保留已完成的段；取消不把半成品當成成功')
}

async function main() {
  await testDelayMath()
  await testRetryLoop()
  await testLiveHttp()
  await testFileJobKeepsFinishedChunks()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
