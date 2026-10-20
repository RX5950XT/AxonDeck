import { showToast } from './app.js'
import { scorePath } from './ws-quickopen.js'

export function isCommandShortcut(event) {
  return !event.isComposing && event.keyCode !== 229 && event.ctrlKey && event.shiftKey &&
    !event.altKey && !event.metaKey && event.key.toLowerCase() === 'p'
}

export function rankCommands(rawQuery, commands) {
  const query = rawQuery.trim().replace(/\\/g, '/').toLowerCase()
  if (!query) return [...commands]
  return commands.map((command) => {
    const label = command.label.replace(/\\/g, '/').toLowerCase()
    return { command, score: scorePath(query, label, label) }
  }).filter((item) => item.score !== null)
    .sort((a, b) => a.score - b.score || a.command.label.localeCompare(b.command.label))
    .map((item) => item.command)
}

export function workspaceCommandItems({ projects, project, sessions, presets,
  selectProject, focusSession, newAgent, addWorktree, setPanel, setFilesView, quickOpen }) {
  const commands = projects.map((item) => ({ id: `project:${item.id}`,
    label: `切換專案：${item.name}`, run: () => selectProject(item.id) }))
  if (!project) return commands
  commands.push(...sessions.filter((item) => item.projectId === project.id).map((item) => ({
    id: `terminal:${item.id}`, label: `切換終端機：${item.title}`, run: () => focusSession(item)
  })))
  commands.push(...presets.map((preset) => ({ id: `new:${preset.key}`,
    label: `新增 ${preset.label} 終端機`, run: () => newAgent(preset.key) })))
  commands.push({ id: 'worktree', label: '在新 worktree 開 agent', run: addWorktree },
    ...[['git', '開 Git 面板'], ['agents', '開 AI 記錄'], ['files', '開檔案樹']]
      .map(([name, label]) => ({ id: name, label, run: () => {
        if (name === 'files') setFilesView?.('tree')
        setPanel(name)
      } })),
    { id: 'quick-open', label: '快速開啟檔案', run: () => quickOpen(project) })
  return commands
}

class WorkspaceCommands {
  constructor(getCommands, isActive) {
    this.getCommands = getCommands
    this.isActive = isActive
    this.ui = null
    this.commands = []
    this.shown = []
    this.cursor = 0
    this.previousFocus = null
    this.openSeq = 0
    document.addEventListener('keydown', (event) => {
      if (!isCommandShortcut(event) || !this.isActive()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (this.ui && !this.ui.host.hidden) this.close()
      else void this.open()
    }, true)
  }

  ensureUi() {
    if (this.ui) return this.ui
    const host = document.createElement('div')
    host.className = 'ws-qo ws-commands'
    host.hidden = true
    const box = document.createElement('div')
    box.className = 'ws-qo-box'
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    box.setAttribute('aria-label', '工作區指令面板')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'input input-sm ws-qo-input'
    input.placeholder = '搜尋專案、終端機或操作…'
    input.setAttribute('aria-label', '搜尋工作區指令')
    input.setAttribute('role', 'combobox')
    input.setAttribute('aria-autocomplete', 'list')
    input.setAttribute('aria-controls', 'ws-command-list')
    input.setAttribute('aria-expanded', 'false')
    const list = document.createElement('div')
    list.id = 'ws-command-list'
    list.className = 'ws-qo-list'
    list.setAttribute('role', 'listbox')
    list.setAttribute('aria-label', '工作區指令')
    box.append(input, list)
    host.appendChild(box)
    host.addEventListener('mousedown', (event) => {
      if (event.target === host) this.close()
    })
    host.addEventListener('keydown', (event) => this.onKeydown(event))
    input.addEventListener('input', () => this.paint())
    document.body.appendChild(host)
    this.ui = { host, input, list }
    return this.ui
  }

  async open() {
    const seq = ++this.openSeq
    if (!this.isActive()) return
    try {
      const commands = await this.getCommands()
      if (seq !== this.openSeq || !this.isActive()) return
      this.commands = commands
    } catch {
      if (seq === this.openSeq && this.isActive()) showToast('讀不到工作區指令，請稍後再試', 'error')
      return
    }
    const ui = this.ensureUi()
    if (ui.host.hidden) this.previousFocus = document.activeElement
    ui.host.hidden = false
    ui.input.value = ''
    ui.input.setAttribute('aria-expanded', 'true')
    this.paint()
    ui.input.focus()
  }

  close() {
    this.openSeq += 1
    if (!this.ui || this.ui.host.hidden) return
    this.ui.host.hidden = true
    this.ui.input.setAttribute('aria-expanded', 'false')
    this.ui.input.removeAttribute('aria-activedescendant')
    this.ui.list.replaceChildren()
    this.commands = []
    this.shown = []
    if (this.previousFocus?.isConnected) this.previousFocus.focus()
    this.previousFocus = null
  }

  paint() {
    this.shown = rankCommands(this.ui.input.value, this.commands)
    this.cursor = 0
    this.ui.list.replaceChildren()
    this.ui.input.removeAttribute('aria-activedescendant')
    if (!this.shown.length) {
      const empty = document.createElement('p')
      empty.className = 'ws-qo-empty'
      empty.textContent = '沒有符合的指令'
      empty.setAttribute('role', 'status')
      this.ui.list.appendChild(empty)
      return
    }
    this.shown.forEach((command, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      row.tabIndex = -1
      row.id = `ws-command-${index}`
      row.className = 'ws-qo-row'
      row.textContent = command.label
      row.setAttribute('role', 'option')
      row.addEventListener('mousedown', (event) => event.preventDefault())
      row.addEventListener('click', () => this.pick(command))
      this.ui.list.appendChild(row)
    })
    this.paintCursor()
  }

  paintCursor() {
    Array.from(this.ui.list.children).forEach((row, index) => {
      const active = index === this.cursor
      row.classList.toggle('is-active', active)
      row.setAttribute('aria-selected', String(active))
      if (!active) return
      this.ui.input.setAttribute('aria-activedescendant', row.id)
      row.scrollIntoView({ block: 'nearest' })
    })
  }

  onKeydown(event) {
    if (event.isComposing || event.keyCode === 229) return
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape', 'Tab'].includes(event.key)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') this.close()
    else if (event.key === 'Enter') this.pick(this.shown[this.cursor])
    else if (event.key === 'Tab') this.ui.input.focus()
    else if (this.shown.length) {
      const delta = event.key === 'ArrowDown' ? 1 : -1
      this.cursor = Math.max(0, Math.min(this.shown.length - 1, this.cursor + delta))
      this.paintCursor()
    }
  }

  async pick(command) {
    if (!command) return
    this.close()
    try {
      await command.run()
    } catch {
      showToast('指令執行失敗，請稍後再試', 'error')
    }
  }
}

export function createWorkspaceCommands({ getCommands, isActive }) {
  const panel = new WorkspaceCommands(getCommands, isActive)
  return { open: () => panel.open(), close: () => panel.close() }
}
