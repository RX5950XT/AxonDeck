import { electronAPI, showToast } from './app.js'
import { askConfirm } from './app-dialog.js'

/**
 * 反向代理設定頁的共用骨架（AGY、Grok 共用，樣式一律 agy-*）。
 *
 * 狀態全由 main 給（electronAPI[api].*）：renderer 沒有憑證、上游 URL，
 * API key 只拿來顯示與複製。全程 createElement，維持零 innerHTML。
 * 元素 id 一律是 `<prefix>Xxx`（例如 agyStatusDot、grokStatusDot），
 * 各頁只提供憑證指引與模型型錄的長相。
 */

const POLL_INTERVAL_MS = 5000
const LOG_LIMIT = 200
const PROTOCOL_LABELS = { openai: 'OpenAI', anthropic: 'Anthropic', responses: 'Responses' }
const RANGE_LABELS = { '6h': '近 6 小時', '24h': '近 24 小時', '7d': '近 7 天', '30d': '近 30 天', all: '全部時間' }
/** 需要導向 CLI 重新登入的錯誤代碼 */
const CREDENTIAL_CODES = new Set(['NO_CREDENTIAL', 'TOKEN_EXPIRED', 'CREDENTIAL_ERROR'])
const COPY_LABELS = { apiKey: 'API Key', baseUrl: 'Base URL', anthropicBaseUrl: 'ANTHROPIC_BASE_URL' }

export function createElement(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** @param {string} id */
export async function copyModelId(id) {
  try {
    await navigator.clipboard.writeText(id)
    showToast(`已複製 ${id}`, 'success')
  } catch {
    showToast('複製失敗', 'error')
  }
}

/** 重置時間 → 「11/26 14:00」；解析不了回空字串 */
export function formatReset(iso) {
  const ms = Date.parse(iso || '')
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
}

/** 剩餘百分比：10% 以下多留一位小數 */
export function formatPercent(percent) {
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`
}

function formatNumber(value) {
  const n = Number(value) || 0
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(0)}K`
  return n.toLocaleString('zh-TW')
}

function formatDuration(ms) {
  const n = Number(ms) || 0
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`
}

/** 日誌可以留到 30 天前，只給時分秒分不出是哪一天，所以帶上月／日 */
function formatTime(ts) {
  const date = new Date(Number(ts) || 0)
  if (!Number.isFinite(date.getTime())) return '—'
  return date.toLocaleString('zh-TW', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

/** 桶起點 → 長條下方的短標籤（小時桶只印時、天桶印月/日） */
function bucketLabel(start, bucket) {
  const date = new Date(Number(start) || 0)
  if (!Number.isFinite(date.getTime())) return ''
  return bucket === 'day'
    ? `${date.getMonth() + 1}/${date.getDate()}`
    : String(date.getHours()).padStart(2, '0')
}

function bucketTitle(start, bucket) {
  const date = new Date(Number(start) || 0)
  if (!Number.isFinite(date.getTime())) return ''
  const day = `${date.getMonth() + 1}/${date.getDate()}`
  if (bucket === 'day') return day
  return `${day} ${String(date.getHours()).padStart(2, '0')}:00`
}

function statCard(label, value, hint) {
  const card = createElement('div', 'agy-stat-card')
  card.append(
    createElement('span', 'agy-stat-label', label),
    createElement('strong', 'agy-stat-value', value)
  )
  if (hint) card.append(createElement('span', 'agy-stat-hint', hint))
  return card
}

/**
 * @param {{
 *   prefix: string,
 *   api: string,
 *   defaultPort: number,
 *   credentialLabel: string,
 *   credentialGuidance: (info: object) => { title: string, steps: Array<{ text: string, code?: string, tail?: string, link?: string }> },
 *   credentialSummary?: (info: object) => { text: string, ok: boolean },
 *   modelsMeta: (data: object) => string,
 *   renderModels: (data: object) => HTMLElement[],
 *   bindExtra?: (page: { renderModelCatalog: () => void }) => void
 * }} config
 */
export function createProxyPage(config) {
  const { prefix } = config
  const byId = (name) => document.getElementById(`${prefix}${name}`)
  const rangeAttr = `data-${prefix}-range`
  const rangeKey = `${prefix}Range`
  const copyKey = `${prefix}Copy`

  let initialized = false
  let pollTimer = null
  let pageGen = 0
  let statusGen = 0
  let busy = false
  let keyVisible = false
  let status = null
  /**
   * 憑證指引的另一個來源：模型查詢失敗。
   * 狀態面板的憑證檢查只在服務執行中才做，但「可用模型」不需要服務跑著也能查——
   * 服務停止時憑證壞掉，不記下來頁面上一個字都不會提。
   * @type {{ code: string, sources: object } | null}
   */
  let credentialHint = null
  /** 統計時間範圍。只是個 key，實際的小時數與分桶由 main 的白名單決定 */
  let statsRange = '24h'
  /** 上游型錄；null 表示還沒查過（進頁不自動打上游） */
  let modelsData = null

  function showError(message) {
    const node = byId('Error')
    if (!node) return
    node.textContent = message || ''
    node.classList.toggle('hidden', !message)
  }

  /** 所有呼叫的統一出入口：錯誤只顯示代碼對應的中文訊息 */
  async function call(action, ...args) {
    const api = electronAPI?.[config.api]
    if (!api || typeof api[action] !== 'function') return null
    try {
      const result = await api[action](...args)
      if (!result?.ok) {
        showError(result?.error?.message || '反向代理操作失敗')
        return null
      }
      return result.data
    } catch {
      showError('無法與主程序通訊')
      return null
    }
  }

  function setText(name, text) {
    const node = byId(name)
    if (node) node.textContent = text
  }

  // ===== 渲染 =====

  function renderStatus() {
    const running = status?.running === true
    const dot = byId('StatusDot')
    if (dot) dot.className = `agy-dot ${running ? 'is-running' : 'is-stopped'}`
    setText('StatusText', running
      ? `執行中 · ${status.host}:${status.port}${status.activeRequests ? ` · ${status.activeRequests} 個進行中` : ''}`
      : '已停止')
    const toggle = byId('ToggleBtn')
    if (toggle) {
      toggle.textContent = running ? '停止服務' : '啟動服務'
      toggle.classList.toggle('btn-danger', running)
      toggle.disabled = busy
    }

    setText('BaseUrl', status?.baseUrl || '尚未啟動')
    setText('OpenaiUrl', status?.baseUrl || '尚未啟動')
    setText('AnthropicUrl', status?.anthropicBaseUrl || '尚未啟動')

    const apiKey = byId('ApiKey')
    if (apiKey) {
      const key = status?.apiKey || ''
      apiKey.textContent = key ? (keyVisible ? key : '•'.repeat(Math.min(key.length, 32))) : '尚未產生'
      apiKey.classList.toggle('agy-secret', !keyVisible)
    }
    const keyToggle = byId('KeyToggleBtn')
    if (keyToggle) {
      keyToggle.textContent = keyVisible ? '隱藏' : '顯示'
      keyToggle.setAttribute('aria-pressed', String(keyVisible))
    }

    const credential = byId('Credential')
    if (credential) {
      const info = status?.credential
      const summary = running && info ? config.credentialSummary?.(info) : null
      if (!running) {
        credential.textContent = '服務停止中'
        credential.className = 'agy-credential'
      } else if (summary) {
        credential.textContent = summary.text
        credential.className = `agy-credential ${summary.ok ? 'is-ok' : 'is-bad'}`
      } else if (info?.connected) {
        credential.textContent = info.tier ? `已連線 · ${info.tier}` : '已連線'
        credential.className = 'agy-credential is-ok'
      } else {
        credential.textContent = info?.message || config.credentialLabel
        credential.className = 'agy-credential is-bad'
      }
    }

    // 憑證一旦真的連上就清掉舊提示，否則使用者照做修好了指引還賴在畫面上
    if (running && status?.credential?.connected) credentialHint = null
    // 指引裡的來源（有沒有裝 CLI）要用這一輪的，不是出錯當下拍的照：裝好了再按重新整理要看得出來
    renderCredentialHelp(credentialHint
      ? { ...credentialHint, sources: status?.credential?.sources ?? credentialHint.sources }
      : (running ? status?.credential : null))

    const dbHealth = status?.db
    if (dbHealth && !dbHealth.ready) showError('日誌資料庫無法開啟，流量記錄暫時停用。')
  }

  function renderCredentialHelp(info) {
    const box = byId('CredentialHelp')
    const title = byId('CredentialHelpTitle')
    const list = byId('CredentialHelpSteps')
    if (!box || !title || !list) return

    if (!info || info.connected) {
      box.hidden = true
      list.replaceChildren()
      title.textContent = ''
      return
    }

    const guidance = config.credentialGuidance(info)
    title.textContent = guidance.title
    list.replaceChildren(...guidance.steps.map((step) => {
      const li = createElement('li', '', step.text)
      if (step.code) li.appendChild(createElement('code', 'agy-code-inline', step.code))
      if (step.link) {
        const anchor = createElement('a', '', step.link)
        anchor.href = step.link
        anchor.target = '_blank'
        anchor.rel = 'noopener'
        li.appendChild(anchor)
      }
      if (step.tail) li.appendChild(document.createTextNode(step.tail))
      return li
    }))
    box.hidden = false
  }

  function noteCredentialError(code) {
    if (!CREDENTIAL_CODES.has(code)) return false
    credentialHint = { code, sources: status?.credential?.sources }
    renderCredentialHelp(credentialHint)
    return true
  }

  function renderSettingsInputs() {
    const port = byId('PortInput')
    const logBodies = byId('LogBodiesInput')
    // 使用者正在輸入時不要覆寫掉他打到一半的值
    if (port && document.activeElement !== port) port.value = String(status?.port ?? config.defaultPort)
    if (logBodies) logBodies.checked = status?.logBodies === true
  }

  function renderStats(stats) {
    const cards = byId('StatCards')
    if (cards) {
      const summary = stats?.summary || {}
      const requests = Number(summary.requests) || 0
      const success = Number(summary.success) || 0
      const rate = requests ? `${((success / requests) * 100).toFixed(1)}%` : '—'
      cards.replaceChildren(
        statCard('請求', formatNumber(requests), `${formatNumber(summary.errors || 0)} 次失敗`),
        statCard('成功率', rate, requests ? `${formatNumber(success)} 次成功` : '尚無資料'),
        statCard('輸入 tokens', formatNumber(summary.input), summary.cached ? `快取 ${formatNumber(summary.cached)}` : ''),
        statCard('輸出 tokens', formatNumber(summary.output), summary.thought ? `思考 ${formatNumber(summary.thought)}` : '')
      )
    }
    renderTrend(stats?.series || [], stats?.bucket === 'day' ? 'day' : 'hour')
    renderUsageByModel(stats?.models || [])
  }

  /** 游標跟著長條走的浮動數值（原本只有原生 title，慢、又看不到 token） */
  function showChartTip(column, lines) {
    const tip = byId('ChartTip')
    const wrap = tip?.parentElement
    if (!tip || !wrap) return
    tip.replaceChildren(...lines.map((line, index) => (
      createElement('span', index ? 'agy-tip-sub' : 'agy-tip-main', line)
    )))
    tip.hidden = false
    // 先顯示才量得到寬度；夾在容器內，免得最邊緣那根把提示推出面板
    const wrapBox = wrap.getBoundingClientRect()
    const colBox = column.getBoundingClientRect()
    const center = colBox.left - wrapBox.left + colBox.width / 2
    const half = tip.offsetWidth / 2
    tip.style.left = `${Math.min(Math.max(center, half + 4), Math.max(half + 4, wrapBox.width - half - 4))}px`
  }

  function hideChartTip() {
    const tip = byId('ChartTip')
    if (tip) tip.hidden = true
  }

  /** 純 CSS 長條：專案不引進圖表套件 */
  function renderTrend(series, bucket) {
    const chart = byId('HourlyChart')
    const meta = byId('TrendMeta')
    if (!chart) return
    hideChartTip()
    const rangeLabel = RANGE_LABELS[statsRange] || ''

    if (!series.length) {
      chart.replaceChildren(createElement('p', 'agy-empty-inline', `${rangeLabel}沒有請求`))
      chart.setAttribute('aria-label', '所選範圍內沒有請求')
      if (meta) meta.textContent = ''
      return
    }

    const peak = Math.max(...series.map((row) => Number(row.requests) || 0), 1)
    const total = series.reduce((sum, row) => sum + (Number(row.requests) || 0), 0)
    chart.replaceChildren(...series.map((row) => {
      const count = Number(row.requests) || 0
      const tokens = Number(row.tokens) || 0
      const column = createElement('div', count ? 'agy-bar-col' : 'agy-bar-col is-empty')
      const fill = createElement('span', 'agy-bar-fill')
      fill.style.height = count ? `${Math.max(6, Math.round((count / peak) * 100))}%` : '2px'
      column.append(fill, createElement('span', 'agy-bar-label', bucketLabel(row.start, bucket)))
      const lines = [`${count} 次請求`, bucketTitle(row.start, bucket)]
      if (tokens) lines.push(`${formatNumber(tokens)} tokens`)
      column.addEventListener('pointerenter', () => showChartTip(column, lines))
      column.addEventListener('pointerleave', hideChartTip)
      return column
    }))
    // 圖表對讀螢幕軟體只是圖，補一句摘要
    chart.setAttribute('aria-label', `${rangeLabel}共 ${total} 次請求，尖峰單一區間 ${peak} 次`)
    if (meta) meta.textContent = `${rangeLabel} · 共 ${formatNumber(total)} 次 · 尖峰 ${peak}`
  }

  function renderUsageByModel(models) {
    const chart = byId('ModelChart')
    const meta = byId('ModelMeta')
    if (!chart) return
    if (!models.length) {
      chart.replaceChildren(createElement('p', 'agy-empty-inline', '尚無模型使用記錄'))
      chart.setAttribute('aria-label', '尚無模型使用記錄')
      if (meta) meta.textContent = ''
      return
    }

    const peak = Math.max(...models.map((row) => Number(row.requests) || 0), 1)
    chart.replaceChildren(...models.map((row) => {
      const count = Number(row.requests) || 0
      const item = createElement('div', 'agy-dist-row')
      const head = createElement('div', 'agy-model-head')
      head.append(
        createElement('span', 'agy-model-name', row.model || '未知'),
        createElement('span', 'agy-model-count', `${count}`)
      )
      const track = createElement('div', 'agy-model-track')
      const fill = createElement('span', 'agy-model-fill')
      fill.style.width = `${Math.max(2, Math.round((count / peak) * 100))}%`
      track.append(fill)
      item.append(head, track)
      item.title = `${row.model || '未知'}：${count} 次 · 輸入 ${formatNumber(row.input)} / 輸出 ${formatNumber(row.output)} tokens`
      return item
    }))
    chart.setAttribute('aria-label', `共 ${models.length} 個模型，使用最多的是 ${models[0].model}`)
    if (meta) meta.textContent = `${models.length} 個模型`
  }

  function renderRangeButtons() {
    document.querySelectorAll(`[${rangeAttr}]`).forEach((button) => {
      const active = button.dataset[rangeKey] === statsRange
      button.classList.toggle('is-active', active)
      button.setAttribute('aria-pressed', active ? 'true' : 'false')
    })
  }

  function renderLogs(payload) {
    const tbody = byId('LogRows')
    const empty = byId('LogEmpty')
    if (!tbody) return

    const rows = Array.isArray(payload?.logs) ? payload.logs : []
    if (empty) {
      empty.classList.toggle('hidden', rows.length > 0)
      // 有篩選時沒結果是「沒有符合的」，不是「還沒有流量」
      const filtered = Boolean(byId('ProtocolFilter')?.value) || byId('ErrorsOnly')?.checked === true
      empty.textContent = filtered
        ? '沒有符合篩選的記錄。'
        : '尚無流量記錄。啟動服務並讓客戶端送出第一個請求後就會出現。'
    }

    tbody.replaceChildren(...rows.map((log) => {
      const failed = log.status >= 400
      const tr = createElement('tr', failed ? 'is-error' : '')
      tr.append(createElement('td', 'agy-cell-time', formatTime(log.ts)))
      tr.append(createElement('td', '', PROTOCOL_LABELS[log.protocol] || log.protocol))

      const model = createElement('td', 'agy-cell-model')
      model.append(createElement('span', 'agy-model-src', log.model || '—'))
      if (log.mappedModel && log.mappedModel !== log.model) {
        model.append(
          createElement('span', 'agy-model-arrow', '→'),
          createElement('span', 'agy-model-dst', log.mappedModel)
        )
      }
      tr.append(model)

      const statusCell = createElement('td', 'agy-cell-status')
      statusCell.append(createElement('span', `agy-badge ${failed ? 'is-error' : 'is-ok'}`, String(log.status)))
      if (log.errorCode) statusCell.append(createElement('span', 'agy-error-code', log.errorCode))
      tr.append(statusCell)

      tr.append(createElement('td', 'agy-cell-num', formatDuration(log.durationMs)))
      tr.append(createElement('td', 'agy-cell-num',
        log.inputTokens || log.outputTokens
          ? `${formatNumber(log.inputTokens)} / ${formatNumber(log.outputTokens)}`
          : '—'))
      return tr
    }))
  }

  // ===== 資料更新 =====

  async function refreshStatus() {
    const gen = ++statusGen
    const nextStatus = await call('status')
    if (!nextStatus || gen !== statusGen) return false
    status = nextStatus
    renderStatus()
    return true
  }

  async function refreshAll() {
    showError('')
    if (!await refreshStatus()) return
    renderSettingsInputs()
    await refreshData()
  }

  async function refreshData() {
    const protocol = byId('ProtocolFilter')?.value || ''
    const onlyErrors = byId('ErrorsOnly')?.checked === true
    const [logs, stats] = await Promise.all([
      call('logs', { limit: LOG_LIMIT, protocol, onlyErrors }),
      call('stats', { range: statsRange })
    ])
    if (logs) renderLogs(logs)
    if (stats) renderStats(stats)
  }

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(() => {
      // 視窗縮到系統匣時 document.hidden 為 true。狀態查詢可能開 PowerShell 讀憑證，
      // 常駐背景後不擋的話就是 5 秒一次、開著整天。
      if (busy || document.hidden) return
      void (async () => {
        // 不在這裡清錯誤：操作失敗（埠被占用、欄位驗證）的訊息要留到使用者下一次操作
        if (!await refreshStatus()) return
        await refreshData()
      })()
    }, POLL_INTERVAL_MS)
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
  }

  // ===== 可用模型 =====

  /**
   * 向上游查即時型錄。進頁不自動查：這是一次真實的上游往返，按了才打。
   * @param {boolean} force 略過 main 端的 10 分鐘快取
   */
  async function loadModels(force = false) {
    const button = byId('ModelsRefreshBtn')
    const meta = byId('ModelsMeta')
    if (button) {
      button.disabled = true
      button.textContent = '查詢中…'
    }
    try {
      const result = await electronAPI[config.api].models(force)
      if (!result?.ok) {
        // 憑證問題有明確下一步：把狀態區那份指引叫出來，光丟一句失敗訊息等於叫使用者自己猜
        if (noteCredentialError(result?.error?.code || '')) {
          if (meta) meta.textContent = `${config.credentialLabel}，請看上方指引`
          showToast(result?.error?.message || config.credentialLabel, 'error')
          byId('CredentialHelp')?.scrollIntoView({ block: 'nearest' })
          return
        }
        if (meta) meta.textContent = '查詢失敗，請稍後再試'
        showToast(result?.error?.message || '模型清單查詢失敗', 'error')
        return
      }
      credentialHint = null
      modelsData = result.data || {}
      if (meta) meta.textContent = `${config.modelsMeta(modelsData)}・${modelsData.cached ? '快取' : '剛更新'}`
      renderModelCatalog()
    } catch {
      if (meta) meta.textContent = '查詢失敗'
      showToast('模型清單查詢失敗', 'error')
    } finally {
      if (button) {
        button.disabled = false
        button.textContent = '重新查詢'
      }
    }
  }

  function renderModelCatalog() {
    const list = byId('ModelsList')
    if (!list) return
    if (!modelsData) {
      list.replaceChildren(createElement('p', 'agy-models-empty', '按「重新查詢」向上游取得目前可用的模型。'))
      return
    }
    const nodes = config.renderModels(modelsData)
    list.replaceChildren(...(nodes.length ? nodes : [createElement('p', 'agy-models-empty', '沒有可顯示的模型。')]))
  }

  // ===== 連線測試 =====

  /**
   * 按下「測試連線」：main 會自動挑一個模型、從本機閘道真的送一則訊息。
   * 成功就把模型回的字直接秀出來——「有沒有回應」用看的最快。
   */
  async function runSelfTest() {
    const button = byId('TestBtn')
    const box = byId('TestResult')
    const show = (state, text) => {
      if (!box) return
      box.hidden = false
      box.className = `agy-test-result ${state}`
      box.textContent = text
    }
    if (button) {
      button.disabled = true
      button.textContent = '測試中…'
    }
    show('is-busy', '正在挑選模型並送出測試訊息…')
    try {
      const result = await electronAPI[config.api].test()
      if (!result?.ok) {
        noteCredentialError(result?.error?.code || '')
        show('is-bad', result?.error?.message || '測試失敗')
        showToast('連線測試失敗', 'error')
        return
      }
      const data = result.data || {}
      show(data.ok ? 'is-ok' : 'is-bad', data.ok
        ? `連線正常 · ${data.model} · ${formatDuration(data.durationMs)} · 回覆「${data.reply || '（空白）'}」`
        : `${data.message || '測試失敗'}${data.model ? ` · ${data.model}` : ''}${data.code ? ` · ${data.code}` : ''}`)
      showToast(data.ok ? '連線測試通過' : '連線測試失敗', data.ok ? 'success' : 'error')
      // 測試本身也是一筆流量，讓日誌與統計立刻反映出來
      await refreshData()
    } catch {
      show('is-bad', '無法與主程序通訊')
      showToast('連線測試失敗', 'error')
    } finally {
      if (button) {
        button.disabled = false
        button.textContent = '測試連線'
      }
    }
  }

  // ===== 操作 =====

  async function withBusy(action) {
    if (busy) return
    busy = true
    showError('')
    renderStatus()
    try {
      await action()
    } finally {
      const errorNode = byId('Error')
      const actionError = errorNode?.classList.contains('hidden') ? '' : errorNode?.textContent || ''
      busy = false
      await refreshAll()
      if (actionError) showError(actionError)
    }
  }

  async function toggleService() {
    const running = status?.running === true
    await withBusy(async () => {
      const next = await call(running ? 'stop' : 'start')
      if (!next) return
      if (!running && next.running === false) {
        showError(next.error === 'PORT_IN_USE'
          ? `連接埠 ${status?.port} 已被占用，請換一個。`
          : '服務啟動失敗。')
        return
      }
      showToast(running ? '反向代理已停止' : '反向代理已啟動', 'success')
    })
  }

  async function copyValue(kind) {
    const value = COPY_LABELS[kind] ? status?.[kind] : ''
    if (!value) {
      showToast('尚無可複製的內容', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(value)
      showToast(`${COPY_LABELS[kind]} 已複製`, 'success')
    } catch {
      showToast('複製失敗', 'error')
    }
  }

  async function regenerateKey() {
    // 換金鑰會讓所有已接上的客戶端立刻失效，先確認
    const yes = await askConfirm('要換一把新的 API Key 嗎？', {
      desc: '現有客戶端會全部立刻失效，得重新填一次。',
      confirmText: '重新產生'
    })
    if (!yes) return
    await withBusy(async () => {
      const next = await call('regenerateKey')
      if (next) showToast('已產生新的 API Key', 'success')
    })
  }

  async function saveSettings() {
    const port = Number(byId('PortInput')?.value)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      showError('監聽埠必須是 1024–65535 的整數。')
      return
    }
    const wasRunning = status?.running === true
    await withBusy(async () => {
      const next = await call('saveSettings', {
        port,
        logBodies: byId('LogBodiesInput')?.checked === true
      })
      if (!next) return
      // 跑著的服務改埠會重啟；新埠被占用時服務會停掉，不能說成功
      if (wasRunning && next.running === false) showError(`設定已儲存，但連接埠 ${port} 無法使用，服務已停止。`)
      else showToast('設定已儲存', 'success')
    })
  }

  async function clearLogs() {
    const yes = await askConfirm('清空所有流量日誌？', { desc: '此動作無法復原。', confirmText: '清空', danger: true })
    if (!yes) return
    await withBusy(async () => {
      const result = await call('clearLogs')
      if (result?.ok) showToast('流量日誌已清空', 'success')
    })
  }

  function refreshFiltered() {
    showError('')
    void refreshData()
  }

  function bindEvents() {
    byId('ToggleBtn')?.addEventListener('click', () => void toggleService())
    byId('RefreshBtn')?.addEventListener('click', () => void refreshAll())
    byId('TestBtn')?.addEventListener('click', () => void runSelfTest())
    byId('RegenerateBtn')?.addEventListener('click', () => void regenerateKey())
    // 跟設定頁其他區一樣改完就存；數字欄的 change 在離開欄位或按 Enter 才發，打字中不會一直重啟服務
    for (const name of ['PortInput', 'LogBodiesInput']) {
      byId(name)?.addEventListener('change', () => void saveSettings())
    }
    byId('ClearLogsBtn')?.addEventListener('click', () => void clearLogs())
    byId('KeyToggleBtn')?.addEventListener('click', () => {
      keyVisible = !keyVisible
      renderStatus()
    })
    document.querySelectorAll(`[data-${prefix}-copy]`).forEach((button) => {
      button.addEventListener('click', () => void copyValue(button.dataset[copyKey]))
    })
    byId('ProtocolFilter')?.addEventListener('change', refreshFiltered)
    byId('ErrorsOnly')?.addEventListener('change', refreshFiltered)
    byId('RangeGroup')?.addEventListener('click', (event) => {
      const button = event.target.closest(`[${rangeAttr}]`)
      if (!button || button.dataset[rangeKey] === statsRange) return
      statsRange = button.dataset[rangeKey]
      renderRangeButtons()
      refreshFiltered()
    })
    byId('ModelsRefreshBtn')?.addEventListener('click', () => void loadModels(true))
    config.bindExtra?.({ renderModelCatalog })
    renderRangeButtons()
    renderModelCatalog()
  }

  function refresh() {
    const gen = ++pageGen
    void (async () => {
      if (!initialized) {
        initialized = true
        bindEvents()
      }
      await refreshAll()
      if (gen !== pageGen) return
      // 只有設定頁的這一區看得到時才輪詢
      if (!document.getElementById('page-settings')?.classList.contains('active')) return
      if (!document.getElementById(`set-${prefix}`)?.classList.contains('active')) return
      startPolling()
    })()
  }

  /** 離開頁面就停止輪詢，別讓背景一直查 DB */
  function cooldown() {
    pageGen += 1
    statusGen += 1
    stopPolling()
    keyVisible = false
  }

  return { refresh, cooldown }
}
