'use strict'

const crypto = require('crypto')
const { CATALOG, CATEGORIES, catalogFor, categoryFor, newerVersion } = require('./catalog')
const winget = require('./winget')
const direct = require('./direct')

function createInstaller({ cacheDir, notify = () => {}, list = winget.list, run = winget.run, install = direct.install, resolveSource = direct.resolveSource }) {
  let installed = [], checkedAt = null, scan = null, jobs = [], sources = {}, scanError = '', batch = false
  const busy = () => batch || jobs.some((job) => !['done', 'failed'].includes(job.phase))
  const emit = () => notify(snapshot())
  const decorate = (row) => {
    const entry = catalogFor(row)
    const available = row.available || (entry?.direct && newerVersion(sources[entry.direct]?.version || '', row.version) ? sources[entry.direct].version : '')
    const duplicate = installed.filter((candidate) => candidate.id === row.id).length > 1
    return { ...row, key: row.key, catalogKey: entry?.key, category: categoryFor(row), available, canUninstall: !row.truncated && !duplicate,
      canUpgrade: !!available && !row.truncated && !duplicate, note: duplicate ? '同一套件有多筆安裝紀錄，無法安全選定；請使用 Windows 管理。' : '' }
  }
  function snapshot() {
    return { categories: CATEGORIES, checkedAt, scanning: !!scan, scanError, busy: busy(), jobs: jobs.map((job) => ({ ...job })), installed: installed.map(decorate),
      catalog: CATALOG.map((entry) => ({ key: entry.key, name: entry.name, group: entry.group, category: entry.group, note: entry.note || '',
        canInstall: !!(entry.id || entry.direct), source: entry.direct ? '官方下載' : entry.source === 'msstore' ? 'Microsoft Store' : entry.id ? 'WinGet' : '官方網站',
        latest: sources[entry.direct]?.version || '', sourceError: sources[entry.direct]?.error || '',
        installedKeys: installed.filter((row) => catalogFor(row)?.key === entry.key).map((row) => row.key) })) }
  }
  async function refresh() {
    if (scan) return scan
    scanError = ''
    scan = (async () => {
      const [rows, available] = await Promise.all([list(), Promise.all([...new Set(CATALOG.map((entry) => entry.direct).filter(Boolean))].map(async (kind) => {
        try { return [kind, await resolveSource(kind)] } catch { return [kind, { error: '官方版本查詢失敗，可重新整理重試。' }] }
      }))])
      installed = rows.map((row) => ({ ...row, key: crypto.createHash('sha256').update(`${row.id}\0${row.version}\0${row.name}`).digest('hex').slice(0, 24) }))
      sources = Object.fromEntries(available)
      checkedAt = Date.now()
    })()
    emit()
    try { await scan } catch (error) { scanError = error.userMessage || '無法取得程式清單，請稍後重新整理。'; throw error }
    finally { scan = null; emit() }
    return snapshot()
  }
  function assertIdle() {
    if (!checkedAt || scan) throw winget.failure('NOT_READY', '請先完成清單查詢。')
    if (busy()) throw winget.failure('BUSY', '另一個安裝工作進行中，請等待完成。')
  }
  function resolveTarget(request) {
    if (!request || typeof request.key !== 'string' || !['install', 'upgrade', 'uninstall'].includes(request.action)) throw winget.failure('INVALID', '無效的程式操作。')
    assertIdle()
    const entry = CATALOG.find((item) => item.key === request.key)
    if (request.action === 'install') {
      if (!entry || (!entry.id && !entry.direct)) throw winget.failure('NO_SOURCE', '此程式尚無可驗證的自動安裝來源。')
      if (installed.some((row) => catalogFor(row)?.key === entry.key)) throw winget.failure('INSTALLED', '此程式已安裝，請重新整理或使用更新。')
      return { entry, name: entry.name, id: entry.id, source: entry.source || 'winget' }
    }
    const row = installed.find((item) => item.key === request.key)
    if (!row) throw winget.failure('NOT_FOUND', '程式清單已變更，請重新整理。')
    const state = decorate(row)
    if (request.action === 'uninstall' ? !state.canUninstall : !state.canUpgrade) throw winget.failure('UNSUPPORTED', '這筆程式目前無法執行此操作。')
    return { ...row, entry: catalogFor(row) }
  }
  function launch(request, target) {
    const job = { id: crypto.randomUUID(), key: request.key, name: target.name, action: request.action, phase: 'starting', message: '準備執行…', progress: null, startedAt: Date.now() }
    jobs = [...jobs.slice(-19), job]
    const update = (change) => { jobs = jobs.map((item) => item.id === job.id ? { ...item, ...change } : item); emit() }
    emit()
    return { job: { ...job }, done: execute(request, target, update) }
  }
  function start(request) {
    return launch(request, resolveTarget(request)).job
  }
  // 逐一更新；每筆做完會重新整理，鍵值含版本，尚未更新的那幾筆仍對得上
  function upgradeAll() {
    assertIdle()
    const keys = installed.map(decorate).filter((row) => row.canUpgrade).map((row) => row.key)
    if (!keys.length) throw winget.failure('NONE', '目前沒有可更新的程式。')
    batch = true
    void (async () => {
      try {
        for (const key of keys) {
          const row = installed.find((item) => item.key === key)
          if (row && decorate(row).canUpgrade) await launch({ action: 'upgrade', key }, { ...row, entry: catalogFor(row) }).done
        }
      } finally { batch = false; emit() }
    })()
    return { count: keys.length }
  }
  async function execute(request, target, update) {
    try {
      const result = target.entry?.direct && request.action !== 'uninstall'
        ? await install(target.entry.direct, cacheDir, update)
        : await run(winget.wingetPath(), winget.actionArgs(request.action, target), { timeout: 0,
          onOutput: (text) => {
            const match = [...text.matchAll(/(\d{1,3})(?:\.\d+)?\s*%/g)].at(-1)
            update({ phase: 'running', message: request.action === 'uninstall' ? '正在解除安裝…' : '正在下載／安裝；需要時 Windows 會要求授權。', progress: match ? Math.min(100, Number(match[1])) : null })
          } })
      if (![0, 3010, 1641].includes(result.code)) throw winget.failure('INSTALL_FAILED', `操作未完成（代碼 0x${result.code.toString(16).toUpperCase()}）。可能未支援靜默操作、需要授權或程式仍在使用；請重新整理後再試。`)
      update({ phase: 'checking', progress: null, message: '操作已結束，正在重新確認安裝狀態…' })
      await refresh()
      const remains = installed.some((row) => row.id === target.id && row.version === target.version)
      const present = installed.some((row) => catalogFor(row)?.key === target.entry?.key)
      const verified = request.action === 'uninstall' ? !remains : request.action === 'install' ? present : !remains
      update({ phase: 'done', progress: null, message: result.code ? '操作完成，需要重新啟動 Windows。' : verified ? '操作完成，清單已更新。' : '安裝工具已結束，系統清單尚未反映變更；請稍後重新整理。' })
    } catch (error) {
      update({ phase: 'failed', progress: null, message: error.userMessage || '操作失敗，請重新整理後重試。' })
    }
  }
  return { snapshot, refresh, start, upgradeAll, busy }
}

module.exports = { createInstaller }
