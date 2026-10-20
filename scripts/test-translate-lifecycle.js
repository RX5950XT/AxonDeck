'use strict'
/** 真正 renderer 的分段工作與引擎生命週期；只有 IPC 與畫面換成測試替身。 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const tick = () => new Promise(resolve => setImmediate(resolve))
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/translate-page.js'), 'utf8')
  .replace(/^import [\s\S]*?from '[^']*'$/gm, '').replace(/^export /gm, '')

function harness({ held = true, cloud = false, loading = false } = {}) {
  const calls = [], releases = [], states = [], warnings = []
  // 功能頁各自一個 renderer：切走後 CSS active 仍在，必須看原生 visibility。
  const page = { active: true, classList: { contains: () => true } }
  const text = 'A sentence to translate.\n'.repeat(220)
  let finishLoad, acquisitions = 0
  const context = { console, states, showToast: message => warnings.push(message), cleanIpcError: error => error.message,
    getSettings: async () => ({ translator: cloud ? 'cloud' : 'local' }), refreshPdfTranslate: async () => {},
    document: { get hidden() { return !page.active }, getElementById: id => id === 'page-translate' ? page : null },
    electronAPI: {
      engine: { acquire: async () => { acquisitions++; if (loading) await new Promise(resolve => { finishLoad = resolve }); return { ok: true } }, release: async owner => releases.push(owner) },
      tts: { cancel: async () => {} },
      translate: (input, target, options) => new Promise((resolve, reject) => calls.push({ input, target, options, resolve, reject }))
    }
  }
  vm.createContext(context)
  vm.runInContext(`${source}
    el = { input: { value: ${JSON.stringify(text)} }, output: { value: '' }, runBtn: { disabled: false },
      sourceLang: { value: 'auto' }, targetLang: { value: 'zh-TW' }, status: {} };
    prewarmed = engineAcquired = ${held && !cloud};
    refreshUiState = async () => {}; setError = () => {}; updateSpeakOutputEnabled = () => {};
    stopSpeak = () => {}; setOutputState = (state) => states.push(state);
    this.api = { runTranslate, cooldownTranslatePage, prewarmTranslatePage, syncEngineForSettings,
      state: () => ({ requestId: el._translateRequestId, isTranslating, engineAcquired, output: el.output.value }) }`,
  context)
  return { api: context.api, calls, releases, states, warnings, page, text,
    load: () => finishLoad(), acquisitions: () => acquisitions }
}

async function finish(h) {
  for (let i = 0; i < 20; i++) {
    await tick()
    if (!h.api.state().isTranslating) return
    const call = h.calls[i]
    assert(call, `第 ${i + 1} 段沒有送出`)
    call.resolve(`譯文${i + 1}`)
  }
  throw new Error('翻譯沒有結束')
}

async function main() {
  {
    const h = harness(), work = h.api.runTranslate()
    await tick()
    const requestId = h.api.state().requestId
    h.page.active = false
    await h.api.cooldownTranslatePage()
    assert.equal(h.api.state().requestId, requestId, '切頁不能取消運行中的翻譯')
    assert.equal(h.releases.length, 0, '分段工作未結束不可釋放模型')
    await h.api.syncEngineForSettings()
    assert.equal(h.releases.length, 0, '背景設定同步也不可釋放工作中的模型')
    await finish(h); await work
    assert(h.calls.length > 1, '確實分多段翻譯')
    assert.equal(h.calls.map(call => call.input).join('').replace(/\s/g, ''), h.text.replace(/\s/g, ''), '所有原文字句都送出，沒有漏段')
    assert(h.api.state().output.includes('譯文1') && h.api.state().output.endsWith(`譯文${h.calls.length}`), '首尾分段譯文完整保留')
    assert.equal(h.states.at(-1), 'done')
    assert.deepEqual(h.releases, ['translate'], '背景工作完成後才釋放一次')
    console.log('PASS 長文切頁與設定同步不中斷，背景完成後釋放模型')
  }
  {
    const h = harness({ held: false, loading: true }), work = h.api.runTranslate()
    await tick()
    h.page.active = false
    await h.api.cooldownTranslatePage()
    h.load(); await tick()
    assert.equal(h.api.state().engineAcquired, true, '載入中切頁仍須把模型交給工作')
    h.page.active = true
    await h.api.prewarmTranslatePage()
    assert.equal(h.acquisitions(), 1, '切回不重載工作中的模型')
    await finish(h); await work
    assert.equal(h.releases.length, 0, '完成時仍在翻譯頁，保留原有預熱行為')
    h.page.active = false
    await h.api.cooldownTranslatePage()
    assert.deepEqual(h.releases, ['translate'])
    console.log('PASS 載入中切頁、切回不重載與待機釋放')
  }
  {
    const h = harness(), work = h.api.runTranslate()
    await tick(); h.page.active = false
    await h.api.cooldownTranslatePage()
    await h.api.runTranslate()
    h.calls[0].resolve('停止後晚到的譯文'); await work
    assert.equal(h.calls.length, 1, '停止後不再送下一段')
    assert.equal(h.states.at(-1), 'stale')
    assert.deepEqual(h.releases, ['translate'])
    console.log('PASS 明確停止仍生效，待當段結束後釋放')
  }
  {
    const h = harness(), work = h.api.runTranslate()
    await tick(); h.page.active = false
    await h.api.cooldownTranslatePage()
    h.calls[0].reject(new Error('test failure')); await work
    assert.equal(h.warnings.length, 1)
    assert.deepEqual(h.releases, ['translate'], '背景失敗也要清理模型')
    console.log('PASS 背景失敗釋放模型並顯示錯誤')
  }
  {
    const h = harness({ cloud: true }), work = h.api.runTranslate()
    await tick(); h.page.active = false
    await h.api.cooldownTranslatePage()
    await finish(h); await work
    assert.equal(h.calls.length, 1)
    assert.equal(h.api.state().output, '譯文1', '雲端切頁也不能丟掉晚到的結果')
    assert.equal(h.acquisitions(), 0)
    assert.equal(h.releases.length, 0)
    console.log('PASS 雲端翻譯切頁繼續且不載入本地模型')
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
