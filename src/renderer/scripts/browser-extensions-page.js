const api = window.browserExtensionsAPI
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get('theme') || 'dark'
let selected = params.get('extension') || '', rows = [], busy = false, removing = ''
const list = document.getElementById('extensionList'), detail = document.getElementById('detail'), status = document.getElementById('status')
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
async function run(id, action, value) {
  if (busy) return
  busy = true; paint(); message('正在處理…')
  try {
    const result = await api.change(id, action, value)
    if (!result.ok) throw new Error(result.error?.message || '操作失敗')
    removing = ''; await refresh(); message('已完成；重新整理網頁後套用變更')
  } catch (error) { message(error.message, true) }
  finally { busy = false; paint() }
}
function paint() {
  document.querySelectorAll('.header-actions button').forEach((el) => { el.disabled = busy })
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
  switches.append(switchControl('啟用套件', row.enabled, (value) => void run(row.id, 'enabled', value)))
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
document.getElementById('openStore').addEventListener('click', () => { void api.store().then((result) => { if (!result.ok) message('商店開啟失敗', true) }) })
document.getElementById('installLocal').addEventListener('click', async () => {
  if (busy) return
  busy = true; paint(); message('請選擇套件資料夾…')
  try { const result = await api.installLocal(); if (!result.ok) throw new Error(result.error?.message || '安裝失敗'); if (result.data) selected = result.data.id; await refresh(); message(result.data ? '已安裝；重新整理網頁後生效' : '已取消安裝') }
  catch (error) { message(error.message, true) }
  finally { busy = false; paint() }
})
void refresh().then(() => message('選擇套件可查看詳細設定')).catch((error) => message(error.message, true))
