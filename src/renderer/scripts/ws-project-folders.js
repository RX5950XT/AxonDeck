import { electronAPI } from './app.js'
import { askInput } from './app-dialog.js'
import { editInline } from './inline-edit.js'
import { openChatMenu } from './chat-menu.js'
import { createListReorder } from './list-reorder.js'

/** 專案分類沿用 Chat 的資料夾樣式；不碰專案檔案或終端機。 */
export function createProjectFolders({ getList, getProjects, call, reload }) {
  let folders = []
  let justDragged = false
  const api = electronAPI.workspace
  const reorder = createListReorder({
    getList,
    itemSelector: '.proj-folder',
    ignoreSelector: '.chat-list-btn, .chat-list-rename, .chat-folder-body',
    onCommit: () => {
      justDragged = true
      setTimeout(() => { justDragged = false }, 0)
      const ids = [...getList().querySelectorAll('.proj-folder')].map((el) => el.dataset.id)
      void change(api.reorderFolders(ids))
    }
  })

  async function change(promise) {
    try {
      await call(promise, '分類沒有存起來')
      await reload()
    } catch {
      // call 已顯示錯誤；重讀還原可能已被拖動的畫面。
      await reload().catch(() => {})
    }
  }

  async function create(project) {
    const name = await askInput('新資料夾', { placeholder: '資料夾名稱', confirmText: '建立' })
    if (name === null) return
    try {
      const folder = await call(api.createFolder(name), '建立資料夾失敗')
      if (project) await call(move(project, folder.id), '移入資料夾失敗')
      await reload()
    } catch {
      await reload().catch(() => {})
    }
  }

  async function rename(folder, nameEl) {
    const name = await editInline(nameEl, { value: folder.name, label: '資料夾名稱' })
    if (name) await change(api.updateFolder(folder.id, { name }))
    else await reload().catch(() => {})
  }

  function folderMenu(anchor, folder, nameEl, point) {
    openChatMenu(anchor, [
      { label: '重新命名', onSelect: () => void rename(folder, nameEl) },
      { label: '刪除資料夾（專案移回未分類）', danger: true, onSelect: () => void change(api.removeFolder(folder.id)) }
    ], point)
  }

  function buildFolder(folder, inside, buildRow) {
    const wrap = document.createElement('div')
    wrap.className = `chat-folder proj-folder${folder.collapsed ? ' is-collapsed' : ''}`
    wrap.dataset.id = folder.id
    wrap.dataset.folderId = folder.id
    wrap.addEventListener('pointerdown', reorder.onPointerDown)
    wrap.addEventListener('keydown', (event) => {
      if (!event.target.closest('.chat-folder-body')) reorder.onKeydown(event)
    })
    const head = document.createElement('div')
    head.className = 'chat-folder-head'
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'chat-folder-toggle'
    toggle.setAttribute('aria-expanded', String(!folder.collapsed))
    const chevron = icon('M9 6l6 6-6 6')
    chevron.className = 'chat-folder-chevron'
    const name = document.createElement('span')
    name.className = 'chat-folder-name'
    name.textContent = folder.name
    const count = document.createElement('span')
    count.className = 'chat-folder-count'
    count.textContent = String(inside.length)
    toggle.append(chevron, name, count)
    toggle.addEventListener('click', () => {
      if (!justDragged) void change(api.updateFolder(folder.id, { collapsed: !folder.collapsed }))
    })
    const menu = document.createElement('button')
    menu.type = 'button'
    menu.className = 'chat-list-btn proj-folder-btn'
    menu.setAttribute('aria-label', `${folder.name}：資料夾選單`)
    menu.setAttribute('aria-haspopup', 'menu')
    menu.append(icon('M5 12h.01M12 12h.01M19 12h.01'))
    menu.addEventListener('click', () => folderMenu(menu, folder, name))
    head.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      folderMenu(menu, folder, name, { x: event.clientX, y: event.clientY })
    })
    head.append(toggle, menu)
    const body = document.createElement('div')
    body.className = 'chat-folder-body'
    body.hidden = folder.collapsed
    if (!folder.collapsed) body.append(...inside.map(buildRow))
    wrap.append(head, body)
    return wrap
  }

  function render(projects, buildRow) {
    if (!folders.length) return projects.map(buildRow)
    const nodes = folders.map((f) => buildFolder(f, projects.filter((p) => p.folderId === f.id), buildRow))
    const root = document.createElement('div')
    root.className = 'chat-root'
    const head = document.createElement('div')
    head.className = 'chat-root-head'
    head.textContent = '未分類'
    const body = document.createElement('div')
    body.className = 'chat-root-body'
    body.append(...projects.filter((p) => !p.folderId).map(buildRow))
    root.append(head, body)
    return [...nodes, root]
  }

  function moveMenu(anchor, project, point) {
    openChatMenu(anchor, [
      { label: '未分類', checked: !project.folderId, onSelect: () => void change(move(project, '')) },
      ...folders.map((f) => ({ label: f.name, checked: project.folderId === f.id, onSelect: () => void change(move(project, f.id)) })),
      { label: '新資料夾並移入…', onSelect: () => void create(project) }
    ], point)
  }

  function move(project, folderId) {
    return api.reorderProjects(getProjects().map((p) => p.id === project.id ? { id: p.id, folderId } : p.id))
  }

  return {
    load: async () => { folders = await call(api.listFolders(), '讀不到專案分類') },
    render,
    create,
    moveMenu
  }
}

function icon(d) {
  const span = document.createElement('span')
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', d)
  svg.append(path)
  span.append(svg)
  return span
}
