/**
 * Linux 的殼層右鍵結果與「內容」視窗（Windows 走原生殼層，不會進來這裡）。
 *
 * - `handleLinuxShellResult`：main 的 shell-linux.invoke 回來的東西——錯誤吐司、
 *   「解壓縮到這裡」同名確認（askConfirm → linuxShellConfirm）、壓縮／解壓縮完成後重讀資料夾、
 *   「內容」開 App 內的 Linux 內容視窗。
 * - `openLinuxProperties`：名稱、類型／MIME、大小（資料夾遞迴、可取消）、位置、建立／修改／存取時間、
 *   擁有者／群組、權限（可改，chmod）、符號連結目標。
 *
 * 全程 createElement + textContent，零 innerHTML（檔名、連結目標都是外部輸入）。
 */

import { askConfirm } from './app-dialog.js'

const PERM_WHO = [['擁有者', 6], ['群組', 3], ['其他人', 0]]
const PERM_BITS = [['讀取', 4], ['寫入', 2], ['執行', 1]]

/** @param {number} n */
export function formatSize(n) {
  const bytes = Number(n) || 0
  if (bytes < 1024) return `${bytes} 位元組`
  const units = ['KB', 'MB', 'GB', 'TB', 'PB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return `${value.toFixed(value < 10 ? 2 : value < 100 ? 1 : 0)} ${units[unit]}（${bytes.toLocaleString('zh-TW')} 位元組）`
}

/** @param {string} iso */
export function formatTime(iso) {
  if (!iso) return '不提供'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '不提供'
  return date.toLocaleString('zh-TW', { hour12: false })
}

/** 0o755 → 'rwxr-xr-x'（跟 main 的 modeString 一樣，給勾選框即時預覽） */
export function modeText(mode) {
  let out = ''
  for (let i = 8; i >= 0; i--) out += (mode & (1 << i)) ? 'rwx'[(8 - i) % 3] : '-'
  return out
}

/** '0755'／'755' → 0o755；不合法回 -1 */
export function parseOctal(text) {
  const s = String(text || '').trim()
  return /^[0-7]{3,4}$/.test(s) ? parseInt(s, 8) : -1
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function row(grid, label, value) {
  grid.append(el('div', 'lx-props-label', label))
  const cell = el('div', 'lx-props-value', value)
  cell.title = value
  grid.append(cell)
  return cell
}

/**
 * 是不是 Linux 殼層右鍵（shell-linux.js）帶回來、需要 renderer 接手的結果。
 * Windows 的 invoke 只回 `{ invoked }`，不會符合，行為不變。
 * @param {any} res
 */
export function isLinuxShellResult(res) {
  const data = res && res.ok && res.data
  return Boolean(data && (data.error || data.confirm || data.operation || data.linuxProperties))
}

/** 等某個操作跑完（explorer:operation 的 finished） */
function waitOperation(api, id) {
  return new Promise((resolve) => {
    if (!id || typeof api.onOperation !== 'function') { resolve(null); return }
    const off = api.onOperation((event) => {
      if (!event || event.id !== id || event.type !== 'finished') return
      off()
      resolve(event.result || event)
    })
  })
}

/**
 * @param {any} res IPC 回來的 `{ ok, data }`
 * @param {{ api: any, toast: (msg: string, kind?: string) => void, refresh: () => void | Promise<void> }} ctx
 */
export async function handleLinuxShellResult(res, ctx) {
  if (!res || res.ok === false) {
    if (res && res.error) ctx.toast(res.error.userMessage || res.error.message || '操作失敗', 'error')
    return
  }
  const data = res.data || {}
  if (data.error) { ctx.toast(data.error, 'error'); return }
  if (data.confirm) {
    const yes = await askConfirm(data.confirm.title, { desc: data.confirm.desc, confirmText: data.confirm.confirmText || '取代', danger: true })
    const next = await ctx.api.linuxShellConfirm(data.confirm.id, yes)
    if (yes) await handleLinuxShellResult(next, ctx)
    return
  }
  if (data.linuxProperties) { void openLinuxProperties(data.linuxProperties.paths, ctx); return }
  if (data.operation) {
    const result = await waitOperation(ctx.api, data.operation)
    if (result && result.status === 'completed') ctx.toast(result.mode === 'compress' ? '壓縮完成' : '解壓縮完成')
    await ctx.refresh()
  }
}

function permissionSection(item, ctx, onChanged) {
  const box = el('div', 'lx-props-perms')
  box.append(el('div', 'lx-props-section', '權限'))
  const grid = el('div', 'lx-perm-grid')
  grid.append(el('div', ''))
  for (const [label] of PERM_BITS) grid.append(el('div', 'lx-perm-head', label))
  const checks = []
  for (const [who, shift] of PERM_WHO) {
    grid.append(el('div', 'lx-perm-who', who))
    for (const [label, bit] of PERM_BITS) {
      const input = /** @type {HTMLInputElement} */ (el('input'))
      input.type = 'checkbox'
      input.dataset.bit = String(bit << shift)
      input.setAttribute('aria-label', `${who}${label}`)
      input.disabled = !item.canChmod
      grid.append(input)
      checks.push(input)
    }
  }
  box.append(grid)
  const line = el('div', 'lx-perm-line')
  const octal = /** @type {HTMLInputElement} */ (el('input', 'input lx-perm-octal'))
  octal.setAttribute('aria-label', '八進位權限')
  octal.spellcheck = false
  octal.disabled = !item.canChmod
  const preview = el('code', 'lx-perm-preview')
  const apply = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-secondary btn-sm', '套用權限'))
  apply.type = 'button'
  apply.disabled = true
  line.append(octal, preview, apply)
  box.append(line)
  let current = item.mode
  const special = () => current & 0o7000
  const paint = (mode) => {
    for (const input of checks) input.checked = Boolean(mode & Number(input.dataset.bit))
    octal.value = mode.toString(8).padStart(4, '0')
    preview.textContent = modeText(mode)
  }
  const pending = () => parseOctal(octal.value)
  const sync = () => { const m = pending(); apply.disabled = !item.canChmod || m < 0 || m === current }
  for (const input of checks) {
    input.addEventListener('change', () => {
      let mode = special()
      for (const c of checks) if (c.checked) mode |= Number(c.dataset.bit)
      paint(mode)
      sync()
    })
  }
  octal.addEventListener('input', () => {
    const mode = pending()
    if (mode >= 0) { for (const input of checks) input.checked = Boolean(mode & Number(input.dataset.bit)); preview.textContent = modeText(mode) }
    sync()
  })
  apply.addEventListener('click', async () => {
    const mode = pending()
    if (mode < 0) return
    apply.disabled = true
    const res = await ctx.api.linuxChmod(item.path, octal.value.trim())
    if (res && res.ok && res.data) {
      current = res.data.mode
      paint(current)
      ctx.toast(`權限已改成 ${res.data.modeText}`)
      onChanged()
    } else {
      ctx.toast(res?.error?.userMessage || '改不了權限', 'error')
      paint(current)
    }
    sync()
  })
  paint(current)
  if (!item.canChmod) box.append(el('p', 'lx-props-note', item.isLink ? '符號連結的權限由目標決定' : '不是你的檔案，不能改權限'))
  return box
}

function sizeRow(grid, items, ctx, cleanups) {
  const files = items.filter((i) => !i.isDir)
  if (!items.some((i) => i.isDir)) {
    row(grid, '大小', formatSize(files.reduce((sum, i) => sum + (Number(i.size) || 0), 0)))
    return
  }
  const cell = row(grid, '大小', '計算中…')
  const token = `lxp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const cancel = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-secondary btn-sm lx-size-cancel', '停止'))
  cancel.type = 'button'
  const text = el('span', '', '計算中…')
  cell.replaceChildren(text, cancel)
  const show = (p, done) => {
    const counts = `${p.files.toLocaleString('zh-TW')} 個檔案、${Math.max(0, p.dirs - items.filter((i) => i.isDir).length).toLocaleString('zh-TW')} 個資料夾`
    text.textContent = `${formatSize(p.bytes)}，${counts}${done ? '' : '…'}`
  }
  const off = typeof ctx.api.onLinuxPropertiesSize === 'function'
    ? ctx.api.onLinuxPropertiesSize((p) => { if (p && p.token === token && !p.done) show(p, false) })
    : () => {}
  cleanups.push(() => { off(); void ctx.api.linuxPropertiesCancel(token) })
  cancel.addEventListener('click', () => void ctx.api.linuxPropertiesCancel(token))
  void ctx.api.linuxPropertiesSize(items.map((i) => i.path), token).then((res) => {
    off()
    cancel.remove()
    if (!res || !res.ok || !res.data) { text.textContent = '算不出來'; return }
    show(res.data, true)
    if (res.data.cancelled) text.textContent += '（已停止，未算完）'
    else if (res.data.skipped) text.textContent += `（${res.data.skipped} 個項目讀不到）`
  })
}

function fillBody(body, items, ctx, cleanups, refresh) {
  const single = items.length === 1 ? items[0] : null
  const grid = el('div', 'lx-props-grid')
  if (single) {
    row(grid, '名稱', single.name)
    // 主要文字是說明（純文字文件），MIME 放次要樣式；沒有說明才直接顯示 MIME
    const typeCell = row(grid, '類型', single.description || single.mime)
    if (single.description && single.mime) {
      typeCell.title = `${single.description}（${single.mime}）`
      typeCell.append(el('span', 'lx-props-secondary', single.mime))
    }
    if (single.isLink) row(grid, '連結目標', single.linkBroken ? `${single.linkTarget}（找不到目標）` : single.linkTarget)
  } else {
    row(grid, '項目', `${items.length} 個（${items.filter((i) => i.isDir).length} 個資料夾）`)
  }
  const locations = [...new Set(items.map((i) => i.location))]
  row(grid, '位置', locations.length === 1 ? locations[0] : '多個位置')
  sizeRow(grid, items, ctx, cleanups)
  if (single) {
    row(grid, '建立時間', formatTime(single.created))
    row(grid, '修改時間', formatTime(single.modified))
    row(grid, '存取時間', formatTime(single.accessed))
    row(grid, '擁有者', `${single.owner}（uid ${single.uid}）`)
    row(grid, '群組', `${single.group}（gid ${single.gid}）`)
  }
  body.append(grid)
  if (single) body.append(permissionSection(single, ctx, refresh))
}

/**
 * App 內的 Linux「內容」視窗。
 * @param {string[]} list
 * @param {{ api: any, toast: (msg: string, kind?: string) => void, refresh: () => void | Promise<void> }} ctx
 */
export async function openLinuxProperties(list, ctx) {
  const res = await ctx.api.linuxProperties(list)
  if (!res || !res.ok || !res.data || !res.data.items?.length) {
    ctx.toast(res?.error?.userMessage || '叫不出內容', 'error')
    return null
  }
  const items = res.data.items
  const dialog = /** @type {HTMLDialogElement} */ (el('dialog', 'app-dialog lx-props-dialog'))
  const title = items.length === 1 ? `「${items[0].name}」的內容` : `${items.length} 個項目的內容`
  dialog.setAttribute('aria-label', title)
  const head = el('div', 'dialog-head')
  head.append(el('h2', 'dialog-title', title))
  const body = el('div', 'simple-dialog-body lx-props-body')
  const cleanups = []
  let changed = false
  fillBody(body, items, ctx, cleanups, () => { changed = true })
  const actions = el('div', 'dialog-actions')
  const close = /** @type {HTMLButtonElement} */ (el('button', 'btn btn-primary btn-sm', '關閉'))
  close.type = 'button'
  close.addEventListener('click', () => dialog.close())
  actions.append(close)
  dialog.append(head, body, actions)
  document.body.append(dialog)
  dialog.addEventListener('close', () => {
    for (const fn of cleanups) { try { fn() } catch { /* 已關 */ } }
    dialog.remove()
    if (changed) void ctx.refresh()
  }, { once: true })
  dialog.showModal()
  close.focus()
  return dialog
}
