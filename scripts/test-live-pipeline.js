'use strict'
/**
 * 即時字幕流程自檢（node 直跑，只換掉模型，邏輯是真的）
 *   node scripts/test-live-pipeline.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/live-pipeline.js'), 'utf8')
  .replace(/^export /gm, '')
const sandbox = { console, setTimeout, Date, Float32Array, String, Math }
vm.createContext(sandbox)
vm.runInContext(`${source}\nglobalThis.mod = { createCaptionPipeline, cleanTranscript, needsTranslation }`, sandbox)
const { createCaptionPipeline, cleanTranscript, needsTranslation } = sandbox.mod

const SR = 16000
const HANGOVER = 7680
const tick = () => new Promise((resolve) => setImmediate(resolve))
async function settle() { for (let i = 0; i < 20; i++) await tick() }

/** 可控的 Promise：測「模型還沒回來」的狀態 */
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function harness(overrides = {}) {
  const log = { asr: [], translate: [], shown: [], logged: [], errors: [], fatal: 0 }
  let clock = 1000
  const pipeline = createCaptionPipeline({
    asrEngine: 'local', llmEngine: 'local', targetLanguage: 'zh-TW', hangoverSamples: HANGOVER,
    transcribe: async (req) => { log.asr.push(req); return `heard take ${log.asr.length} of this speech` },
    translate: async (text) => { log.translate.push(text); return `譯:${text}` },
    show: (payload) => log.shown.push(payload),
    log: (key, s, t) => log.logged.push({ key, s, t }),
    onError: (m) => { if (m) log.errors.push(m) },
    onFatal: () => { log.fatal++ },
    errorText: (e) => e.message,
    now: () => clock,
    ...overrides
  })
  const speech = (seconds) => {
    const samples = new Float32Array(Math.floor(seconds * SR)).fill(0.5)
    return { speaking: true, bufferedSamples: samples.length, snapshot: () => samples.slice() }
  }
  return { pipeline, log, speech, advance: (ms) => { clock += ms } }
}
const audio = (seconds) => new Float32Array(Math.floor(seconds * SR)).fill(0.5)
const last = (list) => list[list.length - 1]

const tests = {
  async '還沒講完就顯示，定稿前不寫逐字稿'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.equal(h.log.asr.length, 1)
    assert.equal(last(h.log.shown).interim, true)
    assert.ok(last(h.log.shown).source)
    assert.equal(h.log.logged.length, 0)
  },

  async '太短不辨識；新音訊不夠多不重複辨識'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(0.5))
    await settle()
    assert.equal(h.log.asr.length, 0, '0.5 秒還不該辨識')
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.advance(600)
    h.pipeline.onSpeech(h.speech(1.2))
    await settle()
    assert.equal(h.log.asr.length, 1, '只多 0.2 秒不值得再跑')
    h.pipeline.onSpeech(h.speech(1.6))
    await settle()
    assert.equal(h.log.asr.length, 2)
  },

  async '同一句越聽越長時是同一行在更新'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.advance(600)
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    const ids = new Set(h.log.shown.map((p) => p.id))
    assert.equal(ids.size, 1)
    assert.ok(h.log.shown.length >= 2)
    assert.notEqual(h.log.shown[0].source, last(h.log.shown).source)
  },

  async '辨識一次只跑一個'() {
    const gate = deferred()
    let calls = 0
    const h = harness({ transcribe: () => { calls++; return gate.promise } })
    h.pipeline.onSpeech(h.speech(1))
    h.advance(600)
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    assert.equal(calls, 1)
    gate.resolve('好的內容文字')
    await settle()
  },

  async '辨識比間隔慢就跟著放慢'() {
    const clock = { now: 1000 }
    let calls = 0
    const h = harness({
      now: () => clock.now,
      transcribe: async () => { calls++; clock.now += 3000; return '這是一段內容' }
    })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    clock.now += 1000
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    assert.equal(calls, 1, '上次跑了 3 秒，1 秒後不該再跑')
    clock.now += 3000
    h.pipeline.onSpeech(h.speech(3))
    await settle()
    assert.equal(calls, 2)
  },

  async '句尾只多靜音：沿用中途結果，不再送一次辨識'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    const asked = h.log.asr.length
    h.pipeline.pushUtterance(audio(1 + HANGOVER / SR), false)
    await settle()
    assert.equal(h.log.asr.length, asked, '不該多一次辨識')
    assert.equal(h.log.logged[0].s, last(h.log.shown).source)
    assert.equal(h.log.shown.some((p) => p.interim === false), true)
  },

  async '句尾還有沒聽過的音訊：定稿重新辨識'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.pipeline.pushUtterance(audio(3), false)
    await settle()
    assert.equal(h.log.asr.length, 2)
  },

  async '太長被切開的句子一定重新辨識（中途結果可能含切點之後的字）'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(10))
    await settle()
    h.pipeline.pushUtterance(audio(9.9), true)
    await settle()
    assert.equal(h.log.asr.length, 2)
    h.advance(600)
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.equal(new Set(h.log.shown.map((p) => p.id)).size, 2, '切點之後是新的一行')
  },

  async '定稿優先：有定稿在排隊就不做中途結果'() {
    const gate = deferred()
    const calls = []
    const h = harness({ transcribe: (req) => { calls.push(req.timeoutMs ?? 'final'); return gate.promise } })
    h.pipeline.pushUtterance(audio(2), false)
    h.pipeline.pushUtterance(audio(2), false)
    h.advance(10000)
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    assert.equal(calls.length, 1)
    gate.resolve('第一句內容')
    await settle()
    assert.equal(calls.length, 2, '接著是第二句定稿，不是中途結果')
  },

  async '辨識語言讓模型自己聽，目標語言只拿來轉繁體'() {
    const h = harness({ targetLanguage: 'zh-TW' })
    h.pipeline.pushUtterance(audio(2), false)
    await settle()
    assert.equal(h.log.asr[0].autoDetect, true)
    assert.equal(h.log.asr[0].lang, 'zh-TW')
  },

  async '雲端才送前文，內容是定稿過的原文'() {
    const cloud = harness({ asrEngine: 'cloud', targetLanguage: 'auto' })
    cloud.pipeline.pushUtterance(audio(2), false)
    await settle()
    assert.equal(cloud.log.asr[0].prompt, undefined, '第一句沒有前文')
    cloud.pipeline.pushUtterance(audio(2), false)
    await settle()
    assert.equal(cloud.log.asr[1].prompt, "heard take 1 of this speech")

    const local = harness({ targetLanguage: 'auto' })
    local.pipeline.pushUtterance(audio(2), false)
    await settle()
    local.pipeline.pushUtterance(audio(2), false)
    await settle()
    assert.equal(local.log.asr[1].prompt, undefined, '本地模型實測吃不進前文')
  },

  async '雲端中途結果有逾時，定稿沒有（不能佔著唯一的名額）'() {
    const h = harness({ asrEngine: 'cloud' })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.ok(h.log.asr[0].timeoutMs > 0)
    h.pipeline.pushUtterance(audio(5), false)
    await settle()
    assert.equal(h.log.asr[1].timeoutMs, undefined)
  },

  async '中途結果失敗不算錯、也不算進連續失敗；拉長間隔'() {
    const clock = { now: 1000 }
    let calls = 0
    const h = harness({
      now: () => clock.now,
      asrEngine: 'cloud',
      transcribe: async () => { calls++; throw new Error('429') }
    })
    for (let i = 0; i < 5; i++) {
      h.pipeline.onSpeech(h.speech(1 + i))
      await settle()
      clock.now += 1600
    }
    assert.ok(calls < 5, `失敗後要退避，實際打了 ${calls} 次`)
    assert.equal(h.log.errors.length, 0)
    assert.equal(h.log.fatal, 0)
  },

  async '定稿失敗保留已聽到的字；連續三次才停'() {
    const h = harness({
      transcribe: async (req) => {
        if (req.samples.length < SR * 1.5) return '已經聽到的內容'
        throw new Error('掛了')
      }
    })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.pipeline.pushUtterance(audio(3), false)
    await settle()
    assert.equal(h.log.logged[0].s, '已經聽到的內容')
    assert.equal(h.log.errors[0], '掛了')
    assert.equal(h.log.fatal, 0)
    h.pipeline.pushUtterance(audio(3), false)
    await settle()
    h.pipeline.pushUtterance(audio(3), false)
    await settle()
    assert.equal(h.log.fatal, 1)
  },

  async '還在聽就先翻一版，定稿再翻最後一版'() {
    const h = harness()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.equal(h.log.translate.length, 1)
    assert.ok(last(h.log.shown).translation.startsWith('譯:'))
    assert.equal(last(h.log.shown).interim, true)
    h.advance(600)
    h.pipeline.pushUtterance(audio(5), false)
    await settle()
    assert.equal(h.log.translate.length, 2)
    assert.equal(last(h.log.logged).t, last(h.log.shown).translation)
    assert.equal(last(h.log.shown).interim, false)
  },

  async '定稿文字跟先翻的一樣就不再翻'() {
    const h = harness({ transcribe: async () => "The very same sentence" })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.pipeline.pushUtterance(audio(1 + HANGOVER / SR), false)
    await settle()
    assert.equal(h.log.translate.length, 1)
    assert.equal(last(h.log.logged).t, '譯:The very same sentence')
  },

  async '中途翻譯失敗不跳錯誤，定稿翻譯失敗才跳'() {
    const h = harness({ translate: async () => { throw new Error('額度用完') } })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.equal(h.log.errors.length, 0)
    h.pipeline.pushUtterance(audio(5), false)
    await settle()
    assert.match(last(h.log.errors), /翻譯失敗，顯示原文：額度用完/)
    assert.ok(last(h.log.logged).s, '原文還是要留')
  },

  async '已是目標語不翻譯'() {
    const h = harness({ transcribe: async () => '這是一句繁體中文的內容' })
    h.pipeline.pushUtterance(audio(2), false)
    await settle()
    assert.equal(h.log.translate.length, 0)
    assert.equal(h.log.logged[0].t, '')
  },

  async '翻譯前文只有定稿，不含還在聽的那句'() {
    const contexts = []
    const h = harness({
      transcribe: async (req) => (req.samples.length > SR * 1.5 ? 'A final sentence here' : 'An interim piece'),
      translate: async (text, _lang, opts) => { contexts.push({ text, prev: opts.previousSource }); return `譯:${text}` }
    })
    h.pipeline.pushUtterance(audio(2), false)
    await settle()
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    assert.equal(contexts[0].prev, '')
    assert.equal(contexts[1].text, 'An interim piece')
    assert.equal(contexts[1].prev, 'A final sentence here')
  },

  async '停止：沒定稿的字留進逐字稿，晚回的結果不再寫也不再翻'() {
    const gate = deferred()
    let first = true
    const h = harness({
      transcribe: (req) => {
        if (first) { first = false; return Promise.resolve('還沒講完的一句話') }
        return gate.promise
      }
    })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.advance(600)
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    const translated = h.log.translate.length
    const stopping = h.pipeline.stop()
    await tick()
    assert.equal(h.log.logged[0].s, '還沒講完的一句話')
    gate.resolve('晚到的結果')
    await stopping
    await settle()
    assert.equal(h.log.logged.length, 1)
    assert.equal(h.log.translate.length, translated)
    h.pipeline.pushUtterance(audio(2), false)
    h.pipeline.onSpeech(h.speech(2))
    await settle()
    assert.equal(h.log.logged.length, 1, '停止後再餵也不動')
  },

  async '停止要等進行中的辨識結束（之後才能卸載模型）'() {
    const gate = deferred()
    const h = harness({ transcribe: () => gate.promise })
    h.pipeline.pushUtterance(audio(2), false)
    await settle()
    let done = false
    const stopping = h.pipeline.stop().then(() => { done = true })
    await settle()
    assert.equal(done, false)
    gate.resolve('')
    await stopping
    assert.equal(done, true)
  },

  async '定稿跟不上：超過上限的用已聽到的字收掉，不丟字'() {
    const gate = deferred()
    let first = true
    const h = harness({
      targetLanguage: 'auto',
      transcribe: () => (first ? (first = false, Promise.resolve('第一句聽到的內容')) : gate.promise)
    })
    h.pipeline.onSpeech(h.speech(1))
    await settle()
    h.pipeline.pushUtterance(audio(12), true)
    h.pipeline.pushUtterance(audio(12), true)
    h.pipeline.pushUtterance(audio(12), true)
    h.pipeline.pushUtterance(audio(12), true)
    await settle()
    gate.resolve('')
    await settle()
    assert.equal(h.log.logged[0].s, '第一句聽到的內容')
  },

  async 'cleanTranscript：擋幻聽、複誦、非語言內容，留正常句子'() {
    assert.equal(cleanTranscript('  ♪♪♪ '), '')
    assert.equal(cleanTranscript('啊'), '')
    assert.equal(cleanTranscript('字幕由 Amara.org 社群提供'), '')
    assert.equal(cleanTranscript('請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目'), '')
    assert.equal(cleanTranscript('對對對對對對對對對對對對'), '')
    const long = '我們今天開會討論下個月的上市時程'
    assert.equal(cleanTranscript(long, `前一句。${long}`), '', '照抄前文')
    assert.equal(cleanTranscript('謝謝大家', '謝謝大家'), '謝謝大家', '短句可能真的講兩次')
    assert.equal(cleanTranscript('今天天氣很好'), '今天天氣很好')
    const talk = '今天我們來聊聊字幕由誰負責這件事，還有為什麼片尾常常出現這些字，以及它跟語音辨識模型的訓練資料有什麼關係'
    assert.equal(cleanTranscript(talk), talk, '長句真的在講這些字要留著')
  },

  async 'needsTranslation：跟舊版判斷一致'() {
    assert.equal(needsTranslation('Hello there', 'zh-TW'), true)
    assert.equal(needsTranslation('今天天氣很好', 'zh-TW'), false)
    assert.equal(needsTranslation('本日の会議です', 'zh-TW'), true)
    assert.equal(needsTranslation('Hello', 'auto'), false)
    assert.equal(needsTranslation('Hello', 'en'), false)
    assert.equal(needsTranslation('今天天氣很好', 'en'), true)
  }
}

async function main() {
  let failed = 0
  const realError = console.error
  console.error = () => {}
  for (const [name, fn] of Object.entries(tests)) {
    try {
      await fn()
      console.log(`  PASS  ${name}`)
    } catch (error) {
      failed++
      console.log(`  FAIL  ${name}\n        ${error.message}`)
    }
  }
  console.error = realError
  console.log(`\n${failed ? 'FAILED' : 'ALL PASS'}  ${Object.keys(tests).length - failed} passed, ${failed} failed\n`)
  process.exit(failed ? 1 : 0)
}
main()
