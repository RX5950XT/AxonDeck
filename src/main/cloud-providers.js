'use strict'

const { MODEL_TYPES } = require('../shared/cloud-model-types.mjs')
const KEY = 'cloudProviders'
const AGY_ID = 'builtin_antigravity'
const AGY_MODELS = ['gemini-3.8-flash-high', 'gemini-3.5-flash-lite']
const validId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(id) && id !== '__local'

function sanitize(raw) {
  if (!Array.isArray(raw) || raw.length > 30) throw new Error('供應商清單不正確或超過 30 組')
  const ids = new Set(), chatIds = new Set(), asrIds = new Set()
  return raw.map((p) => {
    if (!p || !validId(p.id) || ids.has(p.id)) throw new Error('供應商 ID 不正確或重複')
    ids.add(p.id)
    const chatId = validId(p.chatId) ? p.chatId : p.id
    const asrId = validId(p.asrId) ? p.asrId : p.id
    if (chatIds.has(chatId) || asrIds.has(asrId)) throw new Error('供應商對應 ID 重複')
    chatIds.add(chatId); asrIds.add(asrId)
    const apiUrl = typeof p.apiUrl === 'string' ? p.apiUrl.trim() : ''
    if (apiUrl) {
      let url
      try { url = new URL(apiUrl) } catch { throw new Error('API URL 格式不正確') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || apiUrl.length > 500) throw new Error('API URL 格式不正確')
    }
    if (!Array.isArray(p.models) || p.models.length > 120) throw new Error('每組最多 120 個模型')
    const seen = new Set()
    const models = p.models.map((m) => {
      if (!m || typeof m.id !== 'string' || !m.id.trim() || m.id.length > 200 || /[\u0000-\u001f]/.test(m.id)) throw new Error('模型 ID 不正確')
      const id = m.id.trim()
      if (seen.has(id)) throw new Error('模型 ID 重複')
      seen.add(id)
      return { id, type: Object.hasOwn(MODEL_TYPES, m.type) ? m.type : 'unknown' }
    })
    return { id: p.id, chatId, asrId, name: typeof p.name === 'string' ? p.name.trim().slice(0, 40) || '未命名供應商' : '未命名供應商',
      apiUrl, apiKey: typeof p.apiKey === 'string' ? p.apiKey.trim() : '', models }
  })
}

function read(store) {
  const saved = store.get(KEY)
  if (Array.isArray(saved)) return sanitize(saved)
  const chat = require('./chat').sanitizeProviders(store.get('chatProviders', []))
  const asr = require('./cloud-asr').sanitizeAsrClouds(store.get('asrClouds', []))
  const freeId = (base, used) => {
    let id = base, n = 0
    while (used(id)) id = `m${++n}_${base.slice(0, 32)}`
    return id
  }
  const list = chat.map((p) => ({ ...p, chatId: p.id, asrId: p.id,
    models: p.models.map((id) => ({ id, type: p.imageModels.includes(id) ? 'image' : 'chat' })) }))
  for (const p of asr) {
    const match = list.find((c) => c.apiUrl && c.apiUrl.replace(/\/+$/, '') === p.apiUrl.replace(/\/+$/, '')
      && c.apiKey === p.apiKey && !c.asrMerged && !c.models.some((m) => p.models.includes(m.id)))
    if (match) {
      match.asrId = p.id
      match.asrMerged = true
      match.models.push(...p.models.map((id) => ({ id, type: 'asr' })))
    } else {
      const id = freeId(p.id, (value) => list.some((c) => c.id === value || c.chatId === value))
      list.push({ ...p, id, chatId: id, asrId: p.id, asrMerged: true, models: p.models.map((id) => ({ id, type: 'asr' })) })
    }
  }
  // 各舊清單的 ID 可能撞名；未使用的對應 ID 另取一個，已選模型的 ID 保留。
  for (const p of list.filter((c) => !c.asrMerged)) {
    p.asrId = freeId(p.asrId, (value) => list.some((c) => c !== p && c.asrId === value))
  }
  if (!list.length && saved === undefined && !store.has('chatProviders') && !store.has('asrClouds')) list.push({ id: 'openrouter', name: 'OpenRouter', apiUrl: 'https://openrouter.ai/api/v1', apiKey: '', models: [] })
  return sanitize(list)
}

function write(store, raw) {
  const list = sanitize(raw)
  const project = (p, types, id) => ({ id, name: p.name, apiUrl: p.apiUrl, apiKey: p.apiKey,
    models: p.models.filter((m) => types.includes(m.type)).map((m) => m.id),
    imageModels: p.models.filter((m) => m.type === 'image').map((m) => m.id) })
  const chatProviders = list.map((p) => project(p, ['chat', 'image'], p.chatId)).filter((p) => p.models.length)
  const asrClouds = list.map((p) => project(p, ['asr'], p.asrId)).filter((p) => p.models.length)
  // 一次寫入，避免新用途已儲存、功能頁仍讀到舊清單。
  store.set({ [KEY]: list, chatProviders, asrClouds })
  return { list, chatProviders, asrClouds }
}

function syncAntigravity(store, endpoint) {
  if (!store || !endpoint?.running) return
  const list = read(store)
  const old = list.find((p) => p.id === AGY_ID)
  const entry = { ...(old || { id: AGY_ID, models: AGY_MODELS.map((id) => ({ id, type: 'chat' })) }),
    name: 'Antigravity', apiUrl: `${endpoint.baseUrl.replace(/\/+$/, '')}/v1`, apiKey: endpoint.apiKey }
  if (old && old.apiUrl === entry.apiUrl && old.apiKey === entry.apiKey) return
  write(store, old ? list.map((p) => p.id === AGY_ID ? entry : p) : [...list, entry])
}

module.exports = { KEY, read, write, sanitize, syncAntigravity }
