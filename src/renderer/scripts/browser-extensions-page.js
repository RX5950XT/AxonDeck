const api = window.browserExtensionsAPI
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'dark'
let selected = params.get('extension') || '', rows = [], busy = false, removing = ''
let view = params.get('view') === 'shortcuts' ? 'shortcuts' : 'list', recording = null
const list = document.getElementById('extensionList'), detail = document.getElementById('detail'), status = document.getElementById('status')
const listView = document.getElementById('listView'), shortcutView = document.getElementById('shortcutView')
function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error) }
function button(text, action, disabled = false) {
  const el = document.createElement('button'); el.type = 'button'; el.textContent = text; el.disabled = disabled || busy
  el.addEventListener('click', action); return el
}
function switchControl(text, checked, onChange, disabled = false) {
  const label = document.createElement('label'), input = document.createElement('input')
  input.type = 'checkbox'; input.checked = checked; input.disabled = disabled || busy
  input.addEventListener('change', () => onChange(input.checked)); label.append(input, document.createTextNode(text)); return label
}
async function run(id, action, value, done = '已完成；重新整理網頁後套用變更') {
  if (busy) return
  busy = true; paint(); message('正在處理…')
  try {
    const result = await api.change(id, action, value)
    if (!result.ok) throw new Error(result.error?.message || '操作失敗')
    removing = ''; await refresh(); message(done)
  } catch (error) { message(error.message, true) }
  finally { busy = false; paint() }
}
// 鍵盤快速鍵：按下按鍵欄位開始錄，按 Esc 取消；組合由 main 照 Chrome 規則檢查
const MODIFIERS = new Set(['Control', 'Alt', 'Shift', 'Meta'])
function shortcutRow(row, command) {
  const line = document.createElement('div'); line.className = 'shortcut-row'
  const name = document.createElement('span'); name.className = 'shortcut-name'; name.textContent = command.description
  const mine = recording?.id === row.id && recording.name === command.name
  const key = button(mine ? (recording.partial || '請按下快速鍵…') : (command.key || '未設定'), () => {
    recording = { id: row.id, name: command.name, partial: '' }; paint()
    shortcutView.querySelector('.shortcut-key.recording')?.focus()
    message('按下想要的組合（Ctrl 或 Alt，可再加 Shift，再加一個鍵）；Esc 取消')
  })
  key.className = 'shortcut-key'; key.dataset.label = command.key || '未設定'; key.classList.toggle('recording', mine); key.classList.toggle('empty', !command.key && !mine)
  key.setAttribute('aria-label', `變更「${command.description}」的快速鍵，目前${command.key || '未設定'}`)
  const clear = button('清除', () => void run(row.id, 'shortcut', { name: command.name, clear: true }, '已清除快速鍵'), !command.key)
  clear.className = 'shortcut-clear'
  const scope = document.createElement('select'); scope.disabled = busy || !command.key
  scope.setAttribute('aria-label', `「${command.description}」的作用範圍`)
  for (const [value, text] of [['local', '在 AxonDeck 中'], ['global', '全域']]) scope.add(new Option(text, value, false, command.global === (value === 'global')))
  scope.addEventListener('change', () => void run(row.id, 'shortcut', { name: command.name, global: scope.value === 'global' }, '已更新作用範圍'))
  line.append(name, key, clear, scope); return line
}
function paintShortcuts() {
  shortcutView.replaceChildren()
  const withCommands = rows.filter((row) => row.shortcuts.length)
  if (!withCommands.length) { shortcutView.textContent = '已安裝的擴充功能都沒有提供快速鍵'; return }
  for (const row of withCommands) {
    const card = document.createElement('article'); card.className = 'shortcut-card'
    const title = document.createElement('h2'); title.textContent = `${row.name}${row.enabled ? '' : '（已停用）'}`
    card.append(title, ...row.shortcuts.map((command) => shortcutRow(row, command)))
    shortcutView.append(card)
  }
}
document.addEventListener('keydown', (event) => {
  if (!recording) return
  event.preventDefault(); event.stopPropagation()
  if (event.key === 'Escape') { recording = null; paint(); message('已取消'); return }
  if (MODIFIERS.has(event.key)) {
    recording.partial = [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean).join('+') + '+'
    const field = shortcutView.querySelector('.shortcut-key.recording')
    if (field) field.textContent = recording.partial
    return
  }
  const { id, name } = recording; recording = null
  void run(id, 'shortcut', { name, input: { code: event.code, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey } }, '快速鍵已更新，立即生效')
}, true)
// 錄的時候點別的地方＝取消
document.addEventListener('pointerdown', (event) => {
  // 只改字不重畫：重畫會把正要按的按鈕換掉，這一下 click 就丟了
  const field = shortcutView.querySelector('.shortcut-key.recording')
  if (!recording || event.target.closest?.('.shortcut-key.recording')) return
  recording = null
  if (field) { field.textContent = field.dataset.label; field.classList.remove('recording'); field.classList.toggle('empty', field.dataset.label === '未設定') }
}, true)
function paint() {
  document.querySelectorAll('.header-actions button').forEach((el) => { el.disabled = busy })
  listView.hidden = view !== 'list'; shortcutView.hidden = view !== 'shortcuts'
  document.querySelectorAll('[data-view]').forEach((el) => el.setAttribute('aria-selected', String(el.dataset.view === view)))
  if (view === 'shortcuts') { paintShortcuts(); return }
  list.replaceChildren()
  for (const row of rows) {
    const el = button(`${row.name}${row.enabled ? '' : '（已停用）'}`, () => { selected = row.id; removing = ''; paint() })
    el.dataset.extension = row.id; el.setAttribute('aria-current', String(row.id === selected)); list.append(el)
  }
  detail.replaceChildren()
  const row = rows.find((r) => r.id === selected)
  if (!row) { detail.textContent = '尚未安裝擴充功能'; return }
  const title = document.createElement('h2'), description = document.createElement('p')
  title.textContent = row.name; description.textContent = row.description; description.className = 'description'
  const switches = document.createElement('div'); switches.className = 'switches'
  switches.append(switchControl('啟用套件', row.enabled, (value) => void run(row.id, 'enabled', value)),
    switchControl('釘選到工具列', row.pinned, (value) => void run(row.id, 'pinned', value, value ? '已釘選到工具列' : '已從工具列取消釘選'), !row.enabled))
  if (row.permissions.includes('userScripts')) switches.append(switchControl('允許使用者指令碼', row.userScripts,
    (value) => void run(row.id, 'userScripts', value), !row.enabled))
  const actions = document.createElement('div'); actions.className = 'actions'
  actions.append(button(row.options ? '開啟完整設定' : (row.newtab ? '開啟套件頁面與設定' : '開啟套件介面與設定'), () => void run(row.id, 'options'), !(row.options || row.newtab || row.popup || row.sidepanel) || !row.enabled),
    button('重新載入', () => void run(row.id, 'reload'), !row.enabled))
  if (row.source === 'store') actions.append(button('更新套件', () => void run(row.id, 'update')))
  const remove = button(removing === row.id ? '確定移除' : '移除', () => {
    if (removing === row.id) void run(row.id, 'remove')
    else { removing = row.id; paint(); message('再次按下「確定移除」即可移除套件') }
  }); remove.className = 'danger'; actions.append(remove)
  const data = document.createElement('dl')
  for (const [name, value] of [['版本', row.version], ['ID', row.id], ['來源', row.source === 'store' ? 'Chrome 線上應用程式商店' : '本機資料夾'],
    ['檔案位置', row.sourcePath || row.path], ['使用權限', row.permissions.join('、') || '無'], ['網站範圍', row.hostPermissions.join('\n') || '未申請']]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = value; data.append(dt, dd)
  }
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = (row.options ? '使用套件自己的完整設定頁。' : (row.newtab ? '這個套件的設定放在它的頁面裡。' : ((row.popup || row.sidepanel) ? '這個套件的設定放在它的介面裡。' : '這個套件未提供獨立設定介面。'))) + '停用不會刪除套件設定或腳本。移除本機套件不會刪除原始資料夾。'
  detail.append(title, description, switches, actions, data, hint)
}
async function refresh() {
  const result = await api.list()
  if (!result.ok) throw new Error(result.error?.message || '讀取失敗')
  rows = result.data; if (!rows.some((row) => row.id === selected)) selected = rows[0]?.id || ''
  paint()
}
document.getElementById('checkUpdates').addEventListener('click', async () => {
  if (busy) return
  busy = true; paint(); message('正在檢查商店更新…')
  try { const result = await api.updates(); if (!result.ok) throw new Error(result.error?.message || '更新失敗'); await refresh(); message(result.data.length ? `已更新：${result.data.join('、')}` : '已是最新版本') }
  catch (error) { message(error.message, true) }
  finally { busy = false; paint() }
})
document.querySelectorAll('[data-view]').forEach((el) => el.addEventListener('click', () => {
  view = el.dataset.view; recording = null; paint()
  message(view === 'shortcuts' ? '按下按鍵欄位即可改快速鍵' : '選擇套件可查看詳細設定')
}))
document.getElementById('openStore').addEventListener('click', () => { void api.store().then((result) => { if (!result.ok) message('商店開啟失敗', true) }) })
document.getElementById('installLocal').addEventListener('click', async () => {
  if (busy) return
  busy = true; paint(); message('請選擇套件資料夾…')
  try { const result = await api.installLocal(); if (!result.ok) throw new Error(result.error?.message || '安裝失敗'); if (result.data) selected = result.data.id; await refresh(); message(result.data ? '已安裝；重新整理網頁後生效' : '已取消安裝') }
  catch (error) { message(error.message, true) }
  finally { busy = false; paint() }
})
void refresh().then(() => message(view === 'shortcuts' ? '按下按鍵欄位即可改快速鍵' : '選擇套件可查看詳細設定')).catch((error) => message(error.message, true))
