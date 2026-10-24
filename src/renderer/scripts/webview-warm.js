/**
 * 瀏覽器分頁一個分頁一顆 webview，切分頁＝只留目前那顆看得見。
 *
 * 剛切走的幾顆不用 display:none：那會讓 Chromium 丟掉畫好的圖塊，切回來整頁重畫
 * （毛玻璃多的網站實測最長一幀 150–230ms，Edge 約 20ms）。改成原尺寸疊在底下、透明、
 * 點不到（`.webview-warm`）：切回來 7ms；沒畫上畫面的 webview 收不到 rAF，背景 CPU 跟藏起來一樣。
 * 圖塊會佔顯示記憶體，所以只留最近幾顆，更舊的照樣 display:none 釋放。
 *
 * 休眠：1 小時沒看的背景分頁整顆 webview 拿掉、放掉那個網頁程序的記憶體（比照 Edge 的休眠分頁）。
 * 分頁資料（網址）留著，點回去由呼叫端的 ensureGuest 重建、重新載入。正在出聲的不收。
 */
const WARM = 2
export const SLEEP_AFTER_MS = 60 * 60 * 1000
const SWEEP_MS = 5 * 60 * 1000

/** @type {WeakMap<Element, HTMLElement[]>} 每個容器最近顯示過的 webview，新的在前 */
const recent = new WeakMap()
/** @type {WeakMap<HTMLElement, number>} 最後一次被看的時間 */
const seenAt = new WeakMap()
/** @type {Set<Element>} */
const frames = new Set()
/** @type {ReturnType<typeof setInterval> | null} */
let sweeper = null

/** @param {HTMLElement} node */
const isShown = (node) => !node.hidden && !node.classList.contains('webview-warm')

/**
 * @param {Element | null | undefined} frame
 * @param {HTMLElement | null} guest 要顯示的那顆；null＝全部藏起來
 */
export function showGuest(frame, guest) {
  if (!frame) return
  const now = Date.now()
  const list = [guest, ...(recent.get(frame) || []).filter((node) => node !== guest && node.isConnected)]
    .filter((node) => node !== null)
    .slice(0, WARM + 1)
  recent.set(frame, list)
  for (const node of /** @type {NodeListOf<HTMLElement>} */ (frame.querySelectorAll('webview'))) {
    if (node === guest || isShown(node)) seenAt.set(node, now) // 剛被看的、正要被切走的
    const warm = node !== guest && list.includes(node)
    node.hidden = node !== guest && !warm
    node.classList.toggle('webview-warm', warm)
    node.inert = warm
  }
  frames.add(frame)
  if (!sweeper) sweeper = setInterval(() => sleepIdle(Date.now()), SWEEP_MS)
}

/** @param {HTMLElement} node */
function audible(node) {
  try {
    return Boolean(/** @type {any} */ (node).isCurrentlyAudible?.())
  } catch {
    return false // 還沒 attach
  }
}

/**
 * 收掉太久沒看的背景分頁，回傳收了幾顆。
 * @param {number} now
 */
export function sleepIdle(now) {
  let slept = 0
  for (const frame of [...frames]) {
    if (!frame.isConnected) { frames.delete(frame); continue }
    for (const node of /** @type {NodeListOf<HTMLElement>} */ (frame.querySelectorAll('webview'))) {
      if (!seenAt.has(node)) seenAt.set(node, now) // 沒經過 showGuest 的（停放回來前就在的）從現在起算
      if (isShown(node) || audible(node) || now - /** @type {number} */ (seenAt.get(node)) < SLEEP_AFTER_MS) continue
      node.remove()
      slept++
    }
  }
  return slept
}
