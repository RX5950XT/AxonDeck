import { readFileSync, writeFileSync } from 'node:fs'
import { BoxRenderable, ScrollBoxRenderable } from '@opentui/core'

export const id = 'axondeck-navigation'
export default { id, tui }

// 使用訊息 ID 對應原生畫面，不靠相似文字或模擬滾輪猜位置。
function transcript(root, ids) {
  for (const child of root.getChildren()) {
    if (child.id?.startsWith('axondeck-nav')) continue
    if (child instanceof ScrollBoxRenderable && child.getChildren().some(item => ids.has(item.id))) return child
    const found = transcript(child, ids)
    if (found) return found
  }
}

function entries(api, sessionID) {
  const result = []
  for (const message of api.state.session.messages(sessionID)) {
    const text = api.state.part(message.id).filter(part => part.type === 'text' && !part.synthetic && !part.ignored)
      .map(part => part.text).join('\n').trim()
    if (!text || !['user', 'assistant'].includes(message.role)) continue
    const pending = message.role === 'assistant' && !message.time?.completed
    // 已完成的工具回合不是最後回答；還沒寫完的文字要留著，清單才跟得上最新一句。
    if (!pending && message.role === 'assistant' && (message.summary || message.finish === 'tool-calls')) continue
    result.push({ id: message.id, parentID: message.parentID, role: message.role, text,
      title: `${message.role === 'user' ? '你' : 'AI'}：${text.replace(/\s+/g, ' ').slice(0, 160)}` })
  }
  return result
}

function findById(node, id) {
  if (!node || node.id === id) return node
  for (const child of node.getChildren?.() || []) {
    const found = findById(child, id)
    if (found) return found
  }
}

function firstLine(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
}

function hasLine(node, line) {
  if (!node || !line) return false
  const own = `${node.plainText || ''}\n${typeof node.content === 'string' ? node.content : ''}`
  if (own.includes(line)) return true
  for (const child of node.getChildren?.() || []) if (hasLine(child, line)) return true
  return false
}

function targetFor(api, scroll, sessionID, messageID) {
  const tagged = findById(scroll, messageID)
  if (tagged && tagged !== scroll) return tagged
  const messages = api.state.session.messages(sessionID)
  const message = messages.find(item => item.id === messageID)
  if (message?.role !== 'assistant' || !scroll) return
  const line = firstLine(api.state.part(messageID).filter(part => part.type === 'text' && part.text?.trim()).map(part => part.text).join('\n'))
  if (!line) return
  const children = scroll.getChildren()
  const start = children.findIndex(item => findById(item, message.parentID))
  const userIDs = new Set(messages.filter(item => item.role === 'user').map(item => item.id))
  const end = start < 0 ? -1 : children.findIndex((item, index) => index > start && userIDs.has(item.id))
  // shortcut: OpenCode 1.18.35 的回答沒有節點 ID。同一提問內只接受第一行唯一吻合的區塊；官方標上 ID 後這段退場。
  const window = start < 0 ? children : children.slice(start + 1, end < 0 ? undefined : end)
  const hits = window.filter(item => hasLine(item, line))
  if (hits.length === 1) return hits[0]
}

const needleOf = text => (String(text || '').split(/\r?\n/).map(line => line.replace(/[`*_#]/g, '').replace(/\s+/g, '')).find(Boolean) || '').slice(0, 80)

function sameText(left, right) {
  const needle = needleOf(left), value = needleOf(right)
  if (!needle || !value) return false
  return needle.length < 12 ? value === needle : value.startsWith(needle)
}

function place(scroll, target) {
  if (!scroll || !target || typeof scroll.scrollTo !== 'function') return false
  const view = scroll.viewport || scroll
  const max = Math.max(0, (scroll.scrollHeight || 0) - (view.height || 0))
  const next = (Number(scroll.scrollTop) || 0) + target.y - (view.y || 0) - 1
  scroll.scrollTo(Math.max(0, Math.min(max, next)))
  return true
}

/** 側欄點列寫進這個檔。對上文字與第幾次出現後，停在該則，不把捲軸送到底。 */
function consumeJump(file, api, scroll, sessionID, seen) {
  if (!file || !scroll || !sessionID) return seen
  let req
  try { req = JSON.parse(readFileSync(file, 'utf8')) } catch { return seen }
  if (!req || typeof req.nonce !== 'string' || req.ok != null || req.nonce === seen) return seen
  const role = req.role === 'prompt' ? 'user' : req.role === 'answer' ? 'assistant' : ''
  const rows = entries(api, sessionID).filter(row => row.role === role && sameText(req.text, row.text))
  const ok = Boolean(rows[req.index] && place(scroll, targetFor(api, scroll, sessionID, rows[req.index].id)))
  try { writeFileSync(file, JSON.stringify({ ...req, ok })) } catch { return seen }
  return req.nonce
}

function dragTo(scroll, event) {
  if (!scroll) return
  if (event.button != null && event.button !== 0 && event.type !== 'drag') return
  const view = scroll.viewport || scroll
  const max = Math.max(0, (scroll.scrollHeight || 0) - (view.height || 0))
  const span = Math.max(1, (view.height || scroll.height || 1) - 1)
  const ratio = Math.min(1, Math.max(0, ((event.y || 0) - (view.y || 0)) / span))
  scroll.scrollTo(Math.round(ratio * max))
  event.stopPropagation?.()
}

export async function tui(api) {
  const renderer = api.renderer
  let currentSession = '', scroll, seenJump = ''
  const bars = new Map()
  const jump = messageID => {
    if (!place(scroll, targetFor(api, scroll, currentSession, messageID))) {
      api.ui.toast({ message: '這則訊息尚未出現在終端機畫面。', variant: 'warning' })
    }
  }
  const track = new BoxRenderable(renderer, {
    id: 'axondeck-scroll', position: 'absolute', right: 0, top: 1, width: 2, height: 1,
    zIndex: 980, backgroundColor: api.theme.current.backgroundPanel, visible: false,
    onMouseDown: event => dragTo(scroll, event),
    onMouseDrag: event => dragTo(scroll, event),
    onMouseUp: event => dragTo(scroll, event),
  })
  renderer.root.add(track)
  const unregister = api.command.register(() => [{
    title: '對話紀錄', value: 'axondeck.navigation', category: 'Session',
    onSelect: () => {
      if (!currentSession || !scroll) return
      api.ui.dialog.replace(() => api.ui.DialogSelect({ title: '對話紀錄',
        options: entries(api, currentSession).map(row => ({ title: row.title, value: row.id })),
        onSelect: option => { jump(option.value); api.ui.dialog.clear() },
      }))
    },
  }])
  const sync = () => {
    for (const view of bars.keys()) if (view.isDestroyed) bars.delete(view)
    const route = api.route.current
    const sessionID = route.name === 'session' ? route.params.sessionID : ''
    currentSession = sessionID
    scroll = sessionID ? transcript(renderer.root, new Set(api.state.session.messages(sessionID).map(item => item.id))) : undefined
    track.visible = Boolean(scroll && !api.ui.dialog.open)
    if (track.visible) track.height = Math.max(1, renderer.height - 1)
    seenJump = consumeJump(process.env.AXONDECK_NAV_JUMP, api, scroll, currentSession, seenJump)
    if (scroll && !bars.has(scroll)) {
      bars.set(scroll, scroll.verticalScrollBar.visible)
      scroll.verticalScrollBar.visible = true
    }
  }
  const timer = setInterval(sync, 250)
  api.lifecycle.onDispose(() => {
    clearInterval(timer); unregister(); track.destroyRecursively()
    for (const [view, visible] of bars) if (!view.isDestroyed) view.verticalScrollBar.visible = visible
  })
}
