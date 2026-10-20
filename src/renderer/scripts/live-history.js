/**
 * AxonDeck - 語音轉文字頁的兩份紀錄：即時字幕（每一場）與檔案轉錄（每一份）
 *
 * 字幕寫入在 `live-caption.js`：每次字幕 upsert 就 append 一行到 main 的 `live-transcripts/`。
 * 轉錄寫入在 `transcribe.js`：轉完存一份到 `file-transcripts/`。
 * 兩份清單長得一樣：列出、展開看全文、複製／下載／刪除。
 */

import { showToast, electronAPI, cleanIpcError } from './app.js'

/**
 * @typedef {{ id: string, startedAt: number, endedAt?: number, count: number, preview: string, name?: string }} Session
 * @typedef {{ listId: string, label: string, empty: string, list: () => Promise<any>, read: (id: string) => Promise<any>,
 *   remove: (id: string) => Promise<any>, meta: (s: Session) => string, fileName: (s: Session) => string,
 *   bound?: boolean, sessions?: Session[] }} Kind
 */

const api = () => electronAPI.sttArchive
/** @type {Record<'live'|'file', Kind>} */
const KINDS = {
  live: {
    listId: 'liveHistoryList',
    label: '字幕紀錄',
    empty: '還沒有字幕紀錄',
    list: () => api().transcripts(),
    read: (id) => api().readTranscript(id),
    remove: (id) => api().deleteTranscript(id),
    meta: (s) => `${formatDuration((s.endedAt || s.startedAt) - s.startedAt)} · ${s.count} 句`,
    fileName: (s) => `字幕_${stamp(s.startedAt)}.txt`
  },
  file: {
    listId: 'txHistoryList',
    label: '轉錄紀錄',
    empty: '還沒有轉錄',
    list: () => api().fileTranscripts(),
    read: (id) => api().readFileTranscript(id),
    remove: (id) => api().deleteFileTranscript(id),
    meta: (s) => s.name || `${s.count} 字`,
    fileName: (s) => `${s.name || `轉錄_${stamp(s.startedAt)}`}_逐字稿.txt`
  }
}

const $ = (id) => document.getElementById(id)

/**
 * @param {Promise<{ ok: boolean, data?: any, error?: { message: string } }>} p
 */
async function call(p) {
  const res = await p
  if (!res?.ok) throw new Error(res?.error?.message || '操作失敗')
  return res.data
}

/**
 * 這一場字幕的 id（開始字幕時產生）；main 只收 `live-<13 位毫秒>`
 * @returns {string}
 */
export function newTranscriptId() {
  return `live-${Date.now()}`
}

/**
 * 寫一筆字幕（同一個 key 之後的 upsert 會蓋掉前面的）。失敗只記 log：字幕本身不能因為存檔卡住
 * @param {string} transcriptId
 * @param {string} key
 * @param {string} source
 * @param {string} translation
 */
export function logTranscript(transcriptId, key, source, translation) {
  if (!transcriptId || !electronAPI.sttArchive) return
  electronAPI.sttArchive.appendTranscript(transcriptId, { key, source, translation })
    .then((res) => { if (!res?.ok) console.warn('[字幕紀錄] 寫入失敗:', res?.error?.message) })
    .catch((e) => console.warn('[字幕紀錄] 寫入失敗:', e))
}

/** 正在錄的來源（錄音機、即時字幕）；任一個在錄，導覽列的「語音轉文字」就亮紅點 */
const recording = new Set()
const RECORDING_LABEL = { recorder: '錄音機錄音中', live: '即時字幕擷取中' }

/**
 * 切到別頁也照樣在錄：紅點掛在導覽列上，不會忘了它還開著
 * @param {'recorder'|'live'} source
 * @param {boolean} on
 */
export function markSttRecording(source, on) {
  if (on) recording.add(source)
  else recording.delete(source)
  const nav = document.querySelector('.nav-tab[data-page="stt"]')
  if (!nav) return
  nav.classList.toggle('is-recording', recording.size > 0)
  nav.title = recording.size ? `語音轉文字（${[...recording].map((k) => RECORDING_LABEL[k]).join('、')}）` : '語音轉文字'
}

export const refreshLiveHistory = () => refreshHistory(KINDS.live)
/** @param {string} [openId] 剛存好的那份，直接展開 */
export const refreshFileHistory = (openId) => refreshHistory(KINDS.file, openId)

/**
 * @param {Kind} kind
 * @param {string} [openId]
 */
async function refreshHistory(kind, openId) {
  const list = $(kind.listId)
  if (!list || !electronAPI.sttArchive) return
  if (!kind.bound) {
    kind.bound = true
    list.addEventListener('click', (e) => onClick(kind, e))
  }
  try {
    kind.sessions = await call(kind.list())
  } catch (error) {
    kind.sessions = []
    showToast(`讀不到${kind.label}：${cleanIpcError(error)}`, 'error')
  }
  if (kind.sessions.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'dict-empty'
    empty.textContent = kind.empty
    list.replaceChildren(empty)
    return
  }
  list.replaceChildren(...kind.sessions.map((s) => renderSession(kind, s)))
  if (openId) list.querySelector(`.rec-item[data-id="${openId}"] button[data-act="view"]`)?.click()
}

/** @param {number} ms */
function stamp(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/** @param {number} ms */
function formatDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  return min < 1 ? '不到 1 分鐘' : min < 60 ? `${min} 分鐘` : `${Math.floor(min / 60)} 小時 ${min % 60} 分`
}

/**
 * @param {Kind} kind
 * @param {Session} s
 */
function renderSession(kind, s) {
  const row = document.createElement('div')
  row.className = 'dict-record rec-item'
  row.dataset.id = s.id

  const head = document.createElement('div')
  head.className = 'dict-record-head'
  const label = document.createElement('div')
  label.className = 'rec-item-label'
  const title = document.createElement('span')
  title.className = 'rec-item-title'
  title.textContent = new Date(s.startedAt).toLocaleString()
  const meta = document.createElement('span')
  meta.className = 'dict-record-time'
  meta.textContent = kind.meta(s)
  label.append(title, meta)

  const actions = document.createElement('div')
  actions.className = 'rec-item-actions'
  for (const [act, text] of [['view', '查看'], ['copy', '複製'], ['save', '下載'], ['delete', '刪除']]) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-secondary btn-sm'
    btn.dataset.act = act
    btn.textContent = text
    actions.append(btn)
  }
  head.append(label, actions)

  const preview = document.createElement('p')
  preview.className = 'dict-record-raw'
  preview.textContent = s.preview
  row.append(head, preview)
  return row
}

/** @param {{ source: string, translation: string }[]} rows */
function toText(rows) {
  return rows.map((r) => (r.translation ? `${r.source}\n${r.translation}` : r.source)).join('\n\n')
}

/**
 * @param {Kind} kind
 * @param {MouseEvent} e
 */
async function onClick(kind, e) {
  const btn = /** @type {HTMLElement} */ (e.target).closest('button[data-act]')
  const row = btn?.closest('.rec-item')
  const s = kind.sessions?.find((x) => x.id === row?.dataset.id)
  if (!btn || !row || !s) return
  try {
    const act = btn.dataset.act
    if (act === 'delete') {
      await call(kind.remove(s.id))
      return await refreshHistory(kind)
    }
    if (act === 'view' && row.querySelector('.live-history-body')) {
      row.querySelector('.live-history-body').remove()
      btn.textContent = '查看'
      return
    }
    const rows = await call(kind.read(s.id))
    if (act === 'view') {
      row.append(renderBody(rows))
      btn.textContent = '收起'
    }
    if (act === 'copy') {
      await navigator.clipboard.writeText(toText(rows))
      showToast('已複製逐字稿')
    }
    if (act === 'save') download(kind.fileName(s), toText(rows))
  } catch (error) {
    showToast(cleanIpcError(error), 'error')
  }
}

/** @param {{ source: string, translation: string }[]} rows */
function renderBody(rows) {
  const body = document.createElement('div')
  body.className = 'live-history-body'
  for (const r of rows) {
    const line = document.createElement('p')
    line.className = 'dict-record-text'
    line.textContent = r.source
    body.append(line)
    if (r.translation) {
      const tr = document.createElement('p')
      tr.className = 'dict-record-raw live-history-tr'
      tr.textContent = r.translation
      body.append(tr)
    }
  }
  return body
}

/**
 * @param {string} name
 * @param {string} text
 */
function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
