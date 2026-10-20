const states = new Map()
const REASONS = {
  START: '啟動失敗', INITIALIZE_TIMEOUT: '逾時於 initialize', TOOLS_TIMEOUT: '逾時於 tools/list',
  AUTH: '需要登入（401/403）', FORMAT: '回應格式不對', UNSUPPORTED: '暫不支援測試', CANCELLED: '測試已停止'
}

function node(tag, className, text = '') {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function paintResult(box, result) {
  box.replaceChildren()
  if (!result) return
  if (!result.ok) {
    box.textContent = REASONS[result.code] || REASONS.START
    return
  }
  const details = node('details', 'cc-mcp-tools')
  details.append(node('summary', '', `可用 · ${result.count} 個工具`))
  const list = node('ul', 'cc-mcp-tool-list')
  for (const tool of result.tools) {
    const item = node('li', '')
    item.append(node('strong', '', tool.name))
    if (tool.description) item.append(node('p', '', tool.description))
    list.append(item)
  }
  details.append(list)
  box.append(details)
}

export function forgetMcpCheck(home, id) {
  states.delete(JSON.stringify([home, id]))
}

export function mountMcpCheck(main, actions, home, id) {
  const key = JSON.stringify([home, id])
  if (!states.has(key)) states.set(key, { pending: null, result: null })
  const state = states.get(key)
  const button = node('button', 'btn btn-secondary btn-sm', '測試')
  button.type = 'button'
  button.setAttribute('aria-label', `測試 ${id} 的 MCP 連線`)
  const box = node('div', 'cc-mcp-check')
  box.setAttribute('aria-live', 'polite')
  const paint = () => {
    if (states.get(key) !== state) return
    button.disabled = Boolean(state.pending)
    button.textContent = state.pending ? '測試中…' : '測試'
    box.setAttribute('aria-busy', String(Boolean(state.pending)))
    paintResult(box, state.result)
    if (state.pending) box.textContent = '正在測試連線…'
  }
  button.addEventListener('click', async () => {
    if (state.pending) return
    state.result = null
    state.pending = Promise.resolve().then(() => window.electronAPI.ccswitch.testMcp({ home, id }))
      .then(reply => { state.result = reply?.ok ? reply.data : { ok: false, code: 'START' } })
      .catch(() => { state.result = { ok: false, code: 'START' } })
      .finally(() => { state.pending = null })
    paint()
    await state.pending
    paint()
  })
  actions.prepend(button)
  main.append(box)
  paint()
  if (state.pending) void state.pending.then(paint)
}
