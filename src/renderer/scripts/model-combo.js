/**
 * 可搜尋的模型輸入框：點進去列出全部（依 AI lab 分組），打字即時篩選，點一下就填入。
 * 清單外的 id 照樣可以直接打——輸入框本身就是值，不需要「手動輸入」模式。
 *
 * 選單沿用 custom-select 的外觀與定位規矩（`.app-dialog` 的 backdrop-filter 會偷走
 * position: fixed 的基準，所以掛進 dialog 再量原點回推）。
 */

/**
 * @typedef {{ label: string, models: string[] }} ModelGroup
 */

let openCombo = null

/**
 * @param {HTMLInputElement} input
 * @param {() => ModelGroup[]} getGroups
 */
export function attachModelCombo(input, getGroups) {
  const menu = document.createElement('div')
  menu.className = 'custom-select-menu cc-model-menu'
  menu.id = `${input.id}Menu`
  menu.setAttribute('role', 'listbox')
  menu.hidden = true
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', menu.id)
  input.autocomplete = 'off'

  /** @type {HTMLElement[]} */
  let items = []
  let highlighted = -1

  const render = (query) => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    menu.replaceChildren()
    items = []
    for (const group of getGroups()) {
      const hits = group.models.filter((id) => tokens.every((t) => id.toLowerCase().includes(t)))
      if (!hits.length) continue
      const box = document.createElement('div')
      box.className = 'custom-select-group'
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', group.label)
      const heading = document.createElement('div')
      heading.className = 'custom-select-group-label'
      heading.textContent = group.label
      box.append(heading)
      for (const id of hits) {
        const item = document.createElement('div')
        item.className = 'custom-select-option'
        item.id = `${menu.id}-${items.length}`
        item.setAttribute('role', 'option')
        item.setAttribute('aria-selected', id === input.value ? 'true' : 'false')
        item.dataset.value = id
        item.textContent = id
        // pointerdown 擋掉預設：不然輸入框先失焦、選單先收，click 永遠到不了
        item.addEventListener('pointerdown', (event) => event.preventDefault())
        item.addEventListener('click', () => choose(id))
        box.append(item)
        items.push(item)
      }
      menu.append(box)
    }
    highlighted = -1
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'cc-model-menu-empty'
      empty.textContent = tokens.length ? '清單裡沒有符合的模型，可直接用輸入的 id' : '還沒有模型清單，按「從 API 載入模型」'
      menu.append(empty)
    }
  }

  const highlight = (index) => {
    items[highlighted]?.removeAttribute('data-highlighted')
    highlighted = index
    const item = items[index]
    if (!item) return input.removeAttribute('aria-activedescendant')
    item.setAttribute('data-highlighted', 'true')
    input.setAttribute('aria-activedescendant', item.id)
    item.scrollIntoView({ block: 'nearest' })
  }

  const place = () => {
    const rect = input.getBoundingClientRect()
    const edge = 8
    const width = Math.min(Math.max(rect.width, 260), window.innerWidth - edge * 2)
    menu.style.width = `${Math.round(width)}px`
    const height = menu.getBoundingClientRect().height
    const below = rect.bottom + 6
    const top = below + height <= window.innerHeight - edge || rect.top - 6 - height < edge
      ? Math.min(below, window.innerHeight - edge - height)
      : rect.top - 6 - height
    const left = Math.min(Math.max(edge, rect.left), window.innerWidth - edge - width)
    menu.style.left = '0px'
    menu.style.top = '0px'
    const origin = menu.getBoundingClientRect()
    menu.style.left = `${Math.round(left - origin.left)}px`
    menu.style.top = `${Math.round(Math.max(edge, top) - origin.top)}px`
  }

  let lastQuery = ''
  const open = (query) => {
    if (openCombo && openCombo !== api) openCombo.close()
    openCombo = api
    lastQuery = query
    render(query)
    const host = input.closest('dialog[open]') || document.body
    host.classList.toggle('custom-select-portal-open', host !== document.body)
    host.append(menu)
    menu.hidden = false
    input.setAttribute('aria-expanded', 'true')
    place()
    menu.classList.add('is-open')
    // 剛打開時捲到目前選的那顆
    const current = items.findIndex((item) => item.dataset.value === input.value)
    if (current >= 0 && !query) highlight(current)
  }

  const close = () => {
    if (menu.hidden) return
    menu.classList.remove('is-open')
    menu.hidden = true
    menu.parentElement?.classList.remove('custom-select-portal-open')
    menu.remove()
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    if (openCombo === api) openCombo = null
  }

  const choose = (id) => {
    input.value = id
    close()
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }

  // 點進去先列全部（目前的值是完整 id，拿它篩只會剩自己）；開始打字才篩
  input.addEventListener('focus', () => open(''))
  input.addEventListener('click', () => { if (menu.hidden) open('') })
  input.addEventListener('input', () => open(input.value.trim()))
  input.addEventListener('blur', close)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (menu.hidden) open('')
      if (!items.length) return
      const step = event.key === 'ArrowDown' ? 1 : -1
      highlight(highlighted < 0 ? (step > 0 ? 0 : items.length - 1) : (highlighted + step + items.length) % items.length)
    } else if (event.key === 'Enter' && !menu.hidden && highlighted >= 0) {
      event.preventDefault()
      choose(items[highlighted].dataset.value || '')
    } else if (event.key === 'Escape' && !menu.hidden) {
      // 只收選單，不要讓 Esc 連整個彈窗一起關掉
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab') {
      close()
    }
  })
  window.addEventListener('resize', () => { if (!menu.hidden) place() })
  window.addEventListener('scroll', () => { if (!menu.hidden) place() }, true)

  const api = { close, refresh: () => { if (!menu.hidden) open(lastQuery) } }
  return api
}
