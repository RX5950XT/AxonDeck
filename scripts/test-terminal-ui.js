'use strict'
/**
 * 終端機那一頁的兩件純函式：輸出合併寫入、輸入法游標對位。
 *
 * 都是「跑起來看不出來、壞掉也不報錯」的那種：輸出沒合併只是比較卡，
 * 輸入法沒對位只是候選字視窗跑到螢幕角落——所以要在這裡釘住。
 *
 * 用法：node scripts/test-terminal-ui.js
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')

let passed = 0
function ok(label) {
  passed += 1
  console.log(`  PASS ${label}`)
}

/** 剝掉 import／export，讓整支檔案能在同一個 vm context 裡當普通程式碼跑 */
const readPlain = (rel) => fs.readFileSync(path.join(__dirname, '../src/renderer/scripts/', rel), 'utf8')
  .replace(/^import [\s\S]*?from '[^']*'$/gm, '')
  .replace(/^export /gm, '')

// 對位那一段搬到 `term-ime.js` 了，接在前面一起載（`syncImeCaret` 從那裡來）
const source = `${readPlain('term-ime.js')}\n${readPlain('terminal-page.js')}`

function load(extra = {}) {
  const context = {
    ...extra,
    console,
    document: { hidden: false, getElementById: () => null },
    requestAnimationFrame: () => 0,
    window: { setTimeout, clearTimeout },
    // 被剝掉的 import 裡，只有這兩支在模組載入當下就會被呼叫（外觀預設值）
    normalizeAppearance: () => ({ theme: 'black', image: '', opacity: 20 }),
    applyAppearance: () => ({ theme: {}, allowTransparency: false })
  }
  vm.createContext(context)
  vm.runInContext(`${source}\nthis.api = { drainOutput, syncImeCaret, fitAndSync }`, context)
  return context.api
}

/** @param {string[]} writes */
function fakeTerm(writes) {
  return { write(data, done) { writes.push(data); done() } }
}

async function main() {
  // xterm 的 custom handler 回 false 不會取消瀏覽器的原生貼上。
  {
    const page = readPlain('terminal-page.js')
    const handler = page.slice(page.indexOf('  term.attachCustomKeyEventHandler('), page.indexOf('  // 輸入法的候選字視窗'))
    const pasted = []
    let onKey
    const scrolled = []
    vm.runInNewContext(handler, {
      term: { attachCustomKeyEventHandler: (fn) => { onKey = fn } },
      id: 'paste-test', handleCopyKey: () => false, cliMouse: () => false, nativeMouse: false,
      items: [{ id: 'paste-test', preset: 'claude' }],
      scrollAiViewport: (term, event, preset) => { scrolled.push(preset); return event.key === 'PageUp' },
      pasteFromClipboard: () => { pasted.push('paste') }
    })
    for (const modifiers of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { altKey: true }]) {
      pasted.length = 0
      const event = {
        type: 'keydown', key: 'v', ...modifiers,
        preventDefault() { this.defaultPrevented = true }
      }
      assert.equal(onKey(event), false)
      assert.equal(event.defaultPrevented, true, '貼上鍵要取消原生貼上，否則 main 與 xterm 各貼一次')
      onKey({ ...event, repeat: true })
      onKey({ ...event, type: 'keyup' })
      assert.equal(pasted.length, 1, '長按與 keyup 不可重複貼上')
      onKey({ ...event, defaultPrevented: false })
      assert.equal(pasted.length, 2, '再次按下仍可貼同樣內容')
    }
    scrolled.length = 0
    const pageUp = { type: 'keydown', key: 'PageUp', ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, preventDefault() {} }
    assert.equal(onKey(pageUp), false, '五家 AI 的翻頁鍵要吞掉，不能再送進 CLI')
    assert.deepEqual(scrolled, ['claude'])
    ok('三種貼上鍵取消原生貼上、忽略長按，仍可連續貼上')
  }

  // 五家 AI：PageUp／PageDown 翻頁，End 回最底。全螢幕與純 shell 不收。
  {
    const context = {}
    vm.createContext(context)
    vm.runInContext(`${readPlain('term-scrollbar.js')}\nthis.api = { scrollAiViewport }`, context)
    const { scrollAiViewport } = context.api
    /** @param {string} key @param {string} [preset] @param {Record<string, unknown>} [extra] */
    function press(key, preset = 'claude', extra = {}) {
      const calls = []
      const event = {
        type: 'keydown', key, repeat: false,
        ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false,
        preventDefault() { this.defaultPrevented = true },
        ...extra
      }
      const term = {
        buffer: { active: { type: extra.bufferType || 'normal', viewportY: extra.viewportY ?? 10, baseY: extra.baseY ?? 40 } },
        scrollPages(n) { calls.push(['pages', n]) },
        scrollToBottom() { calls.push(['bottom']) }
      }
      const consumed = scrollAiViewport(term, event, preset)
      return { consumed, calls, prevented: event.defaultPrevented === true }
    }
    for (const preset of ['claude', 'codex', 'opencode', 'agy', 'grok']) {
      const up = press('PageUp', preset)
      assert.equal(up.consumed, true, preset)
      assert.deepEqual(up.calls, [['pages', -1]])
      assert.equal(up.prevented, true)
      const down = press('PageDown', preset)
      assert.deepEqual(down.calls, [['pages', 1]])
    }
    const ended = press('End')
    assert.equal(ended.consumed, true)
    assert.deepEqual(ended.calls, [['bottom']])
    const stay = press('End', 'claude', { viewportY: 40, baseY: 40 })
    assert.equal(stay.consumed, false, '已經在最底的 End 要交給 CLI，游標才移得到行尾')
    assert.deepEqual(stay.calls, [])
    const held = press('End', 'claude', { viewportY: 40, baseY: 40, repeat: true })
    assert.equal(held.consumed, true, '按住 End 跳底之後不可以連送行尾')
    assert.deepEqual(held.calls, [])
    const keyup = press('PageUp', 'claude', { type: 'keyup' })
    assert.equal(keyup.consumed, true)
    assert.deepEqual(keyup.calls, [], 'keyup 不再翻一頁')
    assert.equal(press('PageUp', 'shell').consumed, false)
    assert.equal(press('End', 'shell', { viewportY: 0, baseY: 20 }).consumed, false)
    assert.equal(press('PageUp', 'opencode', { bufferType: 'alternate' }).consumed, false, '全螢幕仍交給 CLI')
    assert.equal(press('PageDown', 'claude', { shiftKey: true }).consumed, false)
    assert.equal(press('End', 'agy', { ctrlKey: true, viewportY: 0, baseY: 20 }).consumed, false)
    ok('五家 AI 的 PageUp／PageDown 翻頁、End 回最底；全螢幕、純 shell 與修飾鍵不收')
  }
  // ── 排隊的輸出要接成一段再寫 ──
  {
    const api = load()
    const writes = []
    const entry = { ready: true, writing: false, seq: 0, queue: [], term: fakeTerm(writes) }
    // AI CLI 串流：一秒上百個小封包
    let expected = ''
    for (let i = 1; i <= 40; i += 1) {
      entry.queue.push({ seq: i, data: `${i};` })
      expected += `${i};`
    }
    await api.drainOutput(entry)
    assert.equal(writes.length, 1, `排隊的片段要接成一段再寫（實際寫了 ${writes.length} 次）`)
    assert.equal(writes[0], expected, '順序與內容一個位元組都不能變')
    assert.equal(entry.seq, 40, 'seq 要推到最後一段')
    ok('40 個片段合併成 1 次 write，內容與順序不變')
  }

  // ── 快照重疊的片段要丟掉，不可以重播 ──
  {
    const api = load()
    const writes = []
    const entry = {
      ready: true,
      writing: false,
      seq: 10,
      queue: [{ seq: 8, data: '舊' }, { seq: 9, data: '舊' }, { seq: 11, data: '新' }],
      term: fakeTerm(writes)
    }
    await api.drainOutput(entry)
    assert.equal(writes.join(''), '新', '快照已含的片段（seq ≤ 目前）不可以再寫一次')
    assert.equal(entry.seq, 11)
    ok('快照重疊的片段被丟掉')
  }

  // ── 寫入期間又進來的片段也要收 ──
  {
    const api = load()
    const writes = []
    const entry = { ready: true, writing: false, seq: 0, queue: [{ seq: 1, data: 'A' }], term: null }
    entry.term = {
      write(data, done) {
        writes.push(data)
        if (writes.length === 1) entry.queue.push({ seq: 2, data: 'B' })
        done()
      }
    }
    await api.drainOutput(entry)
    assert.equal(writes.join(''), 'AB', '寫入期間進來的片段不可以留在佇列裡')
    assert.equal(entry.queue.length, 0)
    assert.equal(entry.seq, 2)
    ok('寫入期間進來的片段接著收')
  }

  // 補舊紀錄會暫停畫面寫入；正在到達的新輸出不能插進保存紀錄中。
  {
    const api = load(), writes = []
    const entry = { ready: true, writing: false, seq: 0, queue: [{ seq: 1, data: 'A' }] }
    entry.term = { write(data, done) {
      writes.push(data)
      if (data === 'A') { entry.ready = false; entry.queue.push({ seq: 2, data: 'B' }, { seq: 3, data: 'C' }) }
      done()
    } }
    await api.drainOutput(entry)
    assert.equal(writes.join(''), 'A', '補紀錄期間新輸出必須留在佇列')
    entry.seq = 2 // 接回的 PTY 快照已經包含 B。
    entry.ready = true
    await api.drainOutput(entry)
    assert.equal(writes.join(''), 'AC', '恢復後只接尚未顯示的 C，不重播快照中的 B')
    assert.equal(entry.seq, 3)
    ok('補回歷史時暫停輸出，接回快照後順序不亂也不重複')
  }

  // ── 快照還沒回來就不寫 ──
  {
    const api = load()
    const entry = {
      ready: false,
      writing: false,
      seq: 0,
      queue: [{ seq: 1, data: 'x' }],
      term: { write() { throw new Error('快照還沒回來就不該寫') } }
    }
    await api.drainOutput(entry)
    assert.equal(entry.queue.length, 1, '快照還沒回來前要留在佇列裡')
    ok('快照還沒回來就不寫')
  }

  // ── 輸入法游標對位：把隱形 textarea 挪到游標那一格 ──
  {
    const api = load()
    const style = {}
    const term = {
      cols: 80,
      rows: 24,
      textarea: { style },
      element: { querySelector: () => ({ clientWidth: 800, clientHeight: 480 }) },
      buffer: { active: { cursorX: 10, cursorY: 5 } }
    }
    api.syncImeCaret(term)
    assert.equal(style.left, '100px', '第 10 欄 × 10px = 100px')
    assert.equal(style.top, '100px', '第 5 列 × 20px = 100px')
    assert.equal(style.width, '10px')
    assert.equal(style.height, '20px')
    ok('輸入法游標對到正確的那一格')

    // 換行前 xterm 會讓 cursorX 等於 cols，要夾回最後一欄
    term.buffer.active.cursorX = 80
    api.syncImeCaret(term)
    assert.equal(style.left, '790px', '游標超出最後一欄要夾回最後一欄')
    ok('游標在行尾也夾得回來')

    // 量不到尺寸（分頁還藏著）時什麼都不要動，不然會寫出 NaN
    const before = { ...style }
    term.element.querySelector = () => ({ clientWidth: 0, clientHeight: 0 })
    api.syncImeCaret(term)
    assert.deepEqual({ ...style }, before, '量不到尺寸就不要動（寫 NaN 進去反而更糟）')
    term.element.querySelector = () => null
    api.syncImeCaret(term)
    assert.deepEqual({ ...style }, before, '還沒 open 的終端機也不要動')
    ok('量不到尺寸時不亂寫')
  }

  // ── 切回一格終端機時，欄列數變了一定要通知 ConPTY ──
  {
    const calls = []
    const api = load({ electronAPI: { terminal: { resize: (...args) => calls.push(args) } } })

    // 藏起來的期間側欄被拉寬了：這一量欄數就變了
    const refreshes = []
    const entry = {
      term: { cols: 80, rows: 24, refresh: (...args) => refreshes.push(args) },
      webgl: { clearTextureAtlas: () => refreshes.push('atlas') }, fit: null
    }
    entry.fit = { fit() { entry.term.cols = 100 } }
    api.fitAndSync('t1', entry)
    assert.deepEqual(calls, [['t1', 100, 24]], '欄數變了就要往 main 送 resize')
    ok('切回來時量到的新尺寸有送給 ConPTY')

    // 沒變就不要送（拖側欄時 ResizeObserver 一秒幾十發）
    calls.length = 0
    refreshes.length = 0
    entry.fit = { fit() { /* 尺寸沒變 */ } }
    api.fitAndSync('t1', entry)
    assert.deepEqual(calls, [], '欄列數沒變不可以送 resize')
    assert.deepEqual(refreshes, [[0, 23]], '切回同尺寸仍要重畫，不然空白畫布不會恢復')
    ok('尺寸沒變就不吵 ConPTY')
  }

  // ===== 背景圖強度：0 不可以留下來 =====
  {
    // `term-themes.js` 沒有 DOM 相依，直接在 vm 裡跑就好
    const context = { getComputedStyle: () => ({ getPropertyValue: () => '' }), document: {} }
    vm.createContext(context)
    const exposed = 'this.api = { normalizeAppearance, MIN_TERM_BG_OPACITY, DEFAULT_TERM_BG_OPACITY }'
    vm.runInContext(readPlain('term-themes.js') + '\n' + exposed, context)
    const { normalizeAppearance, MIN_TERM_BG_OPACITY, DEFAULT_TERM_BG_OPACITY } = context.api

    // 使用者把滑桿拉到 0 之後回報「選了背景圖卻什麼都沒有」：
    // 圖還在，只是 `opacity: 0` 整張沒畫出來。
    assert.equal(normalizeAppearance({ image: 'bg-1.png', opacity: 0 }).opacity, DEFAULT_TERM_BG_OPACITY,
      '舊設定裡的 0 要當成「沒設定過」，不然圖整張不畫')
    assert.ok(MIN_TERM_BG_OPACITY > 0, '下限不可以是 0')
    assert.equal(normalizeAppearance({ image: 'bg-1.png', opacity: MIN_TERM_BG_OPACITY }).opacity,
      MIN_TERM_BG_OPACITY, '到得了下限的值要照收')
    ok('背景圖強度 0 回預設（圖不會整張不見）')

    assert.equal(normalizeAppearance({ image: 'bg-1.png' }).opacity, DEFAULT_TERM_BG_OPACITY)
    assert.ok(DEFAULT_TERM_BG_OPACITY >= 40, '預設太低疊在全黑上等於看不到')
    ok('沒設定過用預設強度，而且看得出來')

    assert.equal(normalizeAppearance({ image: 'bg-1.png', opacity: 500 }).opacity, 100, '上限仍然是 100')
    ok('上限照舊夾在 100')
  }

  console.log(`\n${passed} passed, 0 failed`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
