'use strict'

/**
 * 背景的 AI CLI 做完或等人回答時跳 Windows 通知（參考 t3code `ThreadNotificationCoordinator`）。
 *
 * 什麼時候該通知由 renderer 決定（它才知道人在不在看那一格、合併後的狀態）；
 * main 只驗形狀、出通知、管工作列：點通知 → `reveal(id)` 切回那個終端機；
 * App 任何一扇窗拿到焦點 → 收掉所有通知與工作列上的數字。
 */

const KINDS = Object.freeze({ done: '終端機完成了', waiting: '終端機等你回答' })
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const MAX_TITLE = 120

/**
 * renderer 給的東西一律不可信。
 * @param {unknown} id @param {unknown} kind @param {unknown} title
 * @returns {{ id: string, kind: 'done' | 'waiting', title: string } | null}
 */
function sanitize(id, kind, title) {
  if (typeof id !== 'string' || !ID_RE.test(id) || !Object.hasOwn(KINDS, kind)) return null
  const text = String(typeof title === 'string' ? title : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return { id, kind: /** @type {'done' | 'waiting'} */ (kind), title: text.slice(0, MAX_TITLE) || '終端機' }
}

// 3×5 點陣數字與「+」，放大兩倍畫在 16×16 紅點上（主程序沒有 canvas）
const GLYPHS = {
  0: '111101101101111', 1: '010110010010111', 2: '111001111100111', 3: '111001111001111',
  4: '101101111001001', 5: '111100111001111', 6: '111100111101111', 7: '111001001001001',
  8: '111101111101111', 9: '111101111001111', '+': '000010111010000'
}
const SIZE = 16

/**
 * 工作列 overlay：16×16 BGRA，紅圓底白字；10 以上畫「9+」。
 * @param {number} count
 * @returns {Buffer}
 */
function badgeBitmap(count) {
  const buf = Buffer.alloc(SIZE * SIZE * 4)
  const put = (x, y, [b, g, r]) => { const i = (y * SIZE + x) * 4; buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255 }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 64) put(x, y, [0x4d, 0x48, 0xe5])
    }
  }
  const text = count > 9 ? '9+' : String(Math.max(1, Math.floor(count)))
  const left = text.length === 1 ? 5 : 1
  ;[...text].forEach((ch, n) => {
    GLYPHS[ch].split('').forEach((bit, k) => {
      if (bit !== '1') return
      const x = left + n * 7 + (k % 3) * 2
      const y = 3 + Math.floor(k / 3) * 2
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) put(x + dx, y + dy, [255, 255, 255])
    })
  })
  return buf
}

/**
 * @param {{ icon: string, reveal: (id: string) => void | Promise<void> }} deps
 */
function createAgentNotifier({ icon, reveal }) {
  const { app, BrowserWindow, Notification, nativeImage } = require('electron')
  /** 留著參照：Notification 被 GC 掉就收不到 click */
  const pending = new Map()

  function paintBadge() {
    const focused = Boolean(BrowserWindow.getFocusedWindow())
    const count = focused ? 0 : pending.size
    const image = count ? nativeImage.createFromBitmap(badgeBitmap(count), { width: SIZE, height: SIZE }) : null
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.setOverlayIcon(image, count ? `${count} 個終端機有新動態` : '')
      if (count) win.flashFrame(true)
    }
  }

  function clearAll() {
    for (const note of pending.values()) note.close()
    pending.clear()
    paintBadge()
  }

  app.on('browser-window-focus', clearAll)

  /** @returns {boolean} 有沒有真的跳出來 */
  function notify(id, kind, title) {
    const req = sanitize(id, kind, title)
    if (!req) throw Object.assign(new Error('INVALID'), { userMessage: '通知內容不正確' })
    if (!Notification.isSupported()) return false
    pending.get(req.id)?.close()
    const note = new Notification({ title: KINDS[req.kind], body: req.title, icon })
    note.on('click', () => {
      pending.delete(req.id)
      paintBadge()
      Promise.resolve(reveal(req.id)).catch(() => console.warn('[agent-notify] reveal failed'))
    })
    // 不聽 close：Windows 通知逾時收進通知中心也會發，刪掉參照之後從那裡點就沒反應
    pending.set(req.id, note)
    note.show()
    paintBadge()
    return true
  }

  return { notify, clearAll }
}

module.exports = { createAgentNotifier, sanitize, badgeBitmap }
