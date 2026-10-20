import { showToast } from './app.js'
import { askInput } from './app-dialog.js'
import { initCustomSelects } from './custom-select.js'
import { showMenu } from './ws-menu.js'

export function defaultWorktreeName(date = new Date()) {
  const two = (value) => String(value).padStart(2, '0')
  return `wt-${two(date.getMonth() + 1)}${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}

export function watchWorktreeSetup(terminal, id, notify = showToast) {
  let started = false
  const stop = terminal.onStatus((event) => {
    if (event.id !== id) return
    if (event.state === 'running') started = true
    if (event.state !== 'exited' && !(started && event.state === 'idle' && event.exitCode !== null && event.exitCode !== undefined)) return
    stop()
    if (event.state === 'exited' || event.exitCode !== 0) {
      notify('初始化腳本執行失敗或終端機已關閉；工作樹已保留', 'error')
    }
  })
  return stop
}

function field(body, title, control) {
  const label = document.createElement('label')
  label.className = 'setting-group'
  const text = document.createElement('span')
  text.className = 'setting-label'
  text.textContent = title
  control.className = control.tagName === 'SELECT' ? 'select' : 'input'
  control.setAttribute('aria-label', title)
  if (control.type === 'checkbox') {
    label.className += ' ws-worktree-setup'
    label.append(control, text)
  } else label.append(text, control)
  body.appendChild(label)
  return control
}

function dialogFields(body, branch, presets, setupScript) {
  const base = field(body, '基底分支', document.createElement('input'))
  base.value = branch || 'HEAD'
  base.required = true
  const name = field(body, '名稱（同時作為分支與資料夾名稱）', document.createElement('input'))
  name.value = defaultWorktreeName()
  name.required = true
  name.maxLength = 100
  const agent = field(body, '要開的 agent', document.createElement('select'))
  for (const item of [{ key: '', label: '不開' }, ...presets]) {
    const option = document.createElement('option')
    option.value = item.key
    option.textContent = item.label
    agent.appendChild(option)
  }
  const setup = document.createElement('input')
  setup.type = 'checkbox'
  setup.checked = Boolean(setupScript)
  if (setupScript) {
    field(body, '建好後執行初始化腳本', setup)
    setup.className = ''
    const note = document.createElement('p')
    note.className = 'dialog-desc'
    note.textContent = setupScript
    body.appendChild(note)
  }
  return { base, name, agent, setup }
}

export function askWorktree({ branch, presets, setupScript }) {
  const dialog = document.createElement('dialog')
  dialog.className = 'app-dialog app-dialog-compact ws-worktree-dialog'
  dialog.setAttribute('aria-label', '在新 worktree 開 agent')
  const form = document.createElement('form')
  form.method = 'dialog'
  const head = document.createElement('div')
  head.className = 'dialog-head'
  const title = document.createElement('h2')
  title.className = 'dialog-title'
  title.textContent = '在新 worktree 開 agent'
  head.appendChild(title)
  const body = document.createElement('div')
  body.className = 'simple-dialog-body'
  const fields = dialogFields(body, branch, presets, setupScript)
  const actions = dialogActions(dialog)
  form.append(head, body, actions)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    dialog.close('create')
  })
  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) event.preventDefault()
  })
  dialog.appendChild(form)
  document.body.appendChild(dialog)
  const done = new Promise((resolve) => dialog.addEventListener('close', () => {
    const result = dialog.returnValue === 'create' ? {
      name: fields.name.value.trim(), base: fields.base.value.trim(),
      preset: fields.agent.value, setup: fields.setup.checked
    } : null
    dialog.remove()
    resolve(result)
  }, { once: true }))
  initCustomSelects(dialog)
  dialog.showModal()
  fields.name.focus()
  fields.name.select()
  return done
}

function dialogActions(dialog) {
  const actions = document.createElement('div')
  actions.className = 'dialog-actions'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'btn btn-secondary btn-sm'
  cancel.textContent = '取消'
  cancel.addEventListener('click', () => dialog.close(''))
  const create = document.createElement('button')
  create.type = 'submit'
  create.className = 'btn btn-primary btn-sm'
  create.textContent = '建立'
  actions.append(cancel, create)
  return actions
}

function unwrap(result) {
  if (!result?.ok) throw new Error('WORKTREE_STEP_FAILED')
  return result.data
}

export function createWorktreeFlow(options) {
  const context = { choose: askWorktree, notify: showToast, input: askInput, ...options }
  return {
    add: () => addWorktree(context),
    configureSetup: (project) => configureSetup(context, project),
    rerunSetup: (project, tree) => rerunSetup(context, project, tree),
    mountMenu: (host, project, tree) => mountMenu(context, host, project, tree)
  }
}

function mountMenu(ctx, host, project, tree) {
  if (!host) return
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn-icon ws-worktree-menu'
  button.textContent = '⋯'
  button.title = tree ? '工作樹選單' : '初始化腳本設定'
  button.setAttribute('aria-label', button.title)
  const open = (event) => {
    event.preventDefault()
    event.stopPropagation()
    const source = typeof project === 'function' ? project() : project
    if (!source) return
    const rect = button.getBoundingClientRect()
    showMenu({ x: rect.left, y: rect.bottom }, tree ? [
      { label: '重新執行初始化腳本', onSelect: () => void rerunSetup(ctx, source, tree) }
    ] : [
      { label: '設定初始化腳本…', onSelect: () => void configureSetup(ctx, source) }
    ])
  }
  button.addEventListener('click', open)
  if (tree) host.addEventListener('contextmenu', open)
  host.appendChild(button)
}

async function addWorktree(ctx) {
  const source = ctx.currentProject()
  if (!source) return
  let stage = '讀取 worktree 設定失敗'
  try {
    const data = unwrap(await ctx.api.worktreeList(source.id))
    const presets = await ctx.getPresets()
    if (ctx.currentProject()?.id !== source.id) return
    const branch = data.trees.find((tree) => tree.current)?.branch || 'HEAD'
    const selection = await ctx.choose({ branch, presets, setupScript: source.setupScript })
    if (!selection || ctx.currentProject()?.id !== source.id) return
    stage = '建立 worktree 失敗'
    const made = unwrap(await ctx.api.worktreeAdd(source.id, selection.name, selection.base))
    await finishWorktree(ctx, source, made, selection)
  } catch {
    ctx.notify(stage, 'error')
  }
}

async function finishWorktree(ctx, source, made, selection) {
  let stage = 'worktree 已建立，但重新載入專案清單失敗；工作樹已保留'
  try {
    await ctx.reloadList()
    if (!made.projectId) throw new Error('NO_PROJECT')
    stage = 'worktree 已建立，但專案已切換；工作樹已保留'
    if (ctx.currentProject()?.id !== source.id) throw new Error('PROJECT_CHANGED')
    stage = 'worktree 已建立，但切換到新專案失敗；工作樹已保留'
    if (!await ctx.selectProject(made.projectId)) throw new Error('SWITCH_FAILED')
    if (selection.setup) {
      stage = 'worktree 已建立，但啟動初始化腳本失敗；工作樹已保留'
      if (!await ctx.runSetup(source.setupScript, { setupProjectId: made.projectId })) throw new Error('SETUP_FAILED')
    }
    if (selection.preset) {
      stage = 'worktree 已建立，但開啟 agent 終端機失敗；工作樹已保留'
      if (ctx.currentProject()?.id !== made.projectId || !await ctx.newAgent(selection.preset)) throw new Error('AGENT_FAILED')
    }
    ctx.notify(selection.setup ? 'worktree 已建立，初始化腳本已送到新終端機' : '已建立 worktree')
  } catch {
    ctx.notify(!made.projectId ? 'worktree 已建立，但加入專案清單失敗；工作樹已保留' : stage, 'error')
  }
}

async function configureSetup(ctx, project) {
  const rel = await ctx.input('設定 worktree 初始化腳本', {
    value: project.setupScript || '', placeholder: 'scripts/setup.ps1',
    desc: '填專案內的相對路徑，只接受 .ps1、.cmd、.bat。留空可清除設定。', confirmText: '儲存'
  })
  if (rel === null) return
  try {
    unwrap(await ctx.api.setSetupScript(project.id, rel.trim()))
    await ctx.reloadList()
    ctx.notify('已儲存初始化腳本設定')
  } catch {
    ctx.notify('儲存初始化腳本失敗，請確認檔案位於專案內且副檔名正確', 'error')
  }
}

async function rerunSetup(ctx, source, tree) {
  let stage = '加入 worktree 專案清單失敗；工作樹已保留'
  try {
    const target = tree.projectId ? tree : unwrap(await ctx.api.worktreeAdopt(source.id, tree.path))
    await ctx.reloadList()
    if (ctx.currentProject()?.id !== source.id) throw new Error('PROJECT_CHANGED')
    stage = '切換到 worktree 專案失敗；工作樹已保留'
    if (!await ctx.selectProject(target.projectId)) throw new Error('SWITCH_FAILED')
    stage = '啟動初始化腳本失敗；工作樹已保留'
    const script = ctx.currentProject()?.setupScript || source.setupScript
    if (!await ctx.runSetup(script, { setupProjectId: target.projectId })) throw new Error('SETUP_FAILED')
    ctx.notify('初始化腳本已送到 worktree 的新終端機')
  } catch {
    ctx.notify(stage, 'error')
  }
}
