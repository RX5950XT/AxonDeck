/**
 * 系統監控總覽的右側目錄：點一下跳到該段，捲動時標出目前讀到哪一段。
 * 捲動的是外層 `.content`，所以位置都相對它算。
 */

/**
 * @param {HTMLElement} nav
 * @param {() => number} topInset 頂端被黏住的標題列占掉多高
 */
export function createSectionToc(nav, topInset) {
  const scroller = /** @type {HTMLElement} */ (nav.closest('.content'))
  /** @type {Array<{ el: HTMLElement, item: HTMLButtonElement }>} */
  let entries = []
  // 最後幾段捲不到頂端：點了之後要維持點的那段，直到使用者自己捲
  let locked = false
  let frame = 0

  function setActive(current) {
    for (const entry of entries) {
      entry.item.classList.toggle('active', entry === current)
      if (entry === current) entry.item.setAttribute('aria-current', 'location')
      else entry.item.removeAttribute('aria-current')
    }
  }

  function spy() {
    frame = 0
    if (locked || !entries.length || !nav.offsetWidth) return
    const line = scroller.getBoundingClientRect().top + topInset() + 8
    const atBottom = scroller.scrollTop > 0
      && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2
    let current = entries[0]
    if (atBottom) current = entries[entries.length - 1]
    else {
      for (const entry of entries) {
        if (entry.el.getBoundingClientRect().top <= line) current = entry
      }
    }
    setActive(current)
  }

  function jump(entry) {
    const offset = entry.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTo({ top: scroller.scrollTop + offset - topInset() - 8 })
    locked = true
    setActive(entry)
  }

  scroller.addEventListener('scroll', () => {
    if (!frame) frame = requestAnimationFrame(spy)
  }, { passive: true })
  for (const type of ['wheel', 'pointerdown', 'keydown']) {
    scroller.addEventListener(type, () => { locked = false }, { passive: true })
  }

  return {
    /** @param {Array<{ label: string, level: number, el: HTMLElement }>} list */
    set(list) {
      locked = false
      nav.textContent = ''
      entries = list.map(({ label, level, el }) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = level > 1 ? 'sysmon-toc-item is-sub' : 'sysmon-toc-item'
        item.textContent = label
        const entry = { el, item }
        item.addEventListener('click', () => jump(entry))
        nav.appendChild(item)
        return entry
      })
      spy()
    },
    spy
  }
}
