'use strict'

const crypto = require('crypto')
const { CATALOG, CATEGORIES, catalogFor, categoryFor, newerVersion, iconSiteFor } = require('./catalog')
const winget = require('./winget')
const direct = require('./direct')
const inventory = require('./inventory')
const appIcons = require('./icons')
const { cleanupRecord } = require('./cleanup')

const MISMATCH = 0x8A15008E, IN_PROGRESS = [0x8A150102, 1618], PARALLEL = 3, STALL_MS = 10 * 60 * 1000
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createInstaller({ cacheDir, notify = () => {}, list = winget.list, run = winget.runPty, install = direct.install, resolveSource = direct.resolveSource,
  records = list === winget.list ? inventory.readInventory : async () => [], iconPaths = appIcons.displayIcons, getFileIcon = appIcons.readIcon,
  runCommand = winget.run, cleanup = cleanupRecord }) {
  let installed = [], checkedAt = null, scan = null, jobs = [], sources = {}, scanError = '', batch = null, icons = {}, iconsStamp = 0
  const active = (job) => !['done', 'failed'].includes(job.phase)
  const busy = () => !!batch || jobs.some(active)
  const emit = () => notify(snapshot())
  const decorate = (row) => {
    const entry = catalogFor(row)
    const available = row.available || (entry?.direct && newerVersion(sources[entry.direct]?.version || '', row.version) ? sources[entry.direct].version : '')
    const duplicate = installed.filter((candidate) => candidate.id === row.id && candidate.version === row.version).length > 1
    const exact = !!(row.productCode || row.packageFullName) || !duplicate
    const note = row.missingUninstaller ? '解除安裝程式已遺失；可清除失效紀錄，程式檔案不會刪除。'
      : !exact ? '安裝紀錄缺少唯一識別，暫時無法操作。' : row.framework ? '共用執行環境；其他程式可能需要此元件。' : ''
    return { name: row.name, id: row.id, version: row.version, source: row.source, architecture: row.architecture, scope: row.scope,
      key: row.key, catalogKey: entry?.key, site: iconSiteFor(row), category: categoryFor(row), available,
      canUninstall: !row.truncated && exact && !row.missingUninstaller,
      canCleanup: !!(row.missingUninstaller && row.registryPath),
      canUpgrade: !!available && !row.truncated && !duplicate && !row.missingUninstaller, note }
  }
  function snapshot() {
    return { categories: CATEGORIES, checkedAt, scanning: !!scan, scanError, busy: busy(), iconsStamp, batch: batch && { ...batch }, jobs: jobs.map((job) => ({ ...job })), installed: installed.map(decorate),
      catalog: CATALOG.map((entry) => ({ key: entry.key, name: entry.name, group: entry.group, category: entry.group, note: entry.note || '',
        canInstall: !!(entry.id || entry.direct), source: entry.direct ? '官方下載' : entry.source === 'msstore' ? 'Microsoft Store' : entry.id ? 'WinGet' : '官方網站',
        site: entry.site || '', latest: sources[entry.direct]?.version || '', sourceError: sources[entry.direct]?.error || '',
        installedKeys: installed.filter((row) => catalogFor(row)?.key === entry.key).map((row) => row.key) })) }
  }
  async function refresh() {
    if (scan) return scan
    scanError = ''
    scan = (async () => {
      const [rows, entries, available] = await Promise.all([list(), records(), Promise.all([...new Set(CATALOG.map((entry) => entry.direct).filter(Boolean))].map(async (kind) => {
        try { return [kind, await resolveSource(kind)] } catch { return [kind, { error: '官方版本查詢失敗，可重新整理重試。' }] }
      }))])
      installed = inventory.mergeInventory(rows, entries).map((row) => ({ ...row, key: crypto.createHash('sha256').update(row.identity).digest('hex').slice(0, 24) }))
      sources = Object.fromEntries(available)
      checkedAt = Date.now()
      void loadIcons()
    })()
    emit()
    try { await scan } catch (error) { scanError = error.userMessage || '無法取得程式清單，請稍後重新整理。'; throw error }
    finally { scan = null; emit() }
    return snapshot()
  }
  // 圖示另走 icons()，不塞進每次進度通知；路徑與圖示都快取，失敗就留空用字母代替
  const iconCache = new Map()
  async function loadIcons() {
    const current = installed
    let iconFor
    try { iconFor = await iconPaths() } catch { return }
    const next = {}
    for (const row of current) {
      const candidates = iconFor(row)
      for (const file of Array.isArray(candidates) ? candidates : [candidates].filter(Boolean)) {
        if (!iconCache.has(file)) {
          try { const image = await getFileIcon(file); if (image && !image.isEmpty()) iconCache.set(file, image.toDataURL()) } catch { /* 下一個候選繼續找 */ }
        }
        if (iconCache.get(file)) { next[row.key] = iconCache.get(file); break }
      }
    }
    if (current !== installed) return
    icons = next
    iconsStamp += 1
    emit()
  }
  function assertIdle() {
    if (!checkedAt) throw winget.failure('NOT_READY', '請先完成清單查詢。')
  }
  function assertFree(target) {
    const keys = new Set([target.key, target.entry?.key].filter(Boolean))
    if (jobs.some((job) => active(job) && (keys.has(job.key) || keys.has(job.catalogKey)))) throw winget.failure('BUSY', '這個程式正在處理中，請等待完成。')
  }
  function resolveTarget(request) {
    if (!request || typeof request.key !== 'string' || !['install', 'upgrade', 'uninstall', 'cleanup'].includes(request.action)) throw winget.failure('INVALID', '無效的程式操作。')
    assertIdle()
    const entry = CATALOG.find((item) => item.key === request.key)
    if (request.action === 'install') {
      if (!entry || (!entry.id && !entry.direct)) throw winget.failure('NO_SOURCE', '此程式尚無可驗證的自動安裝來源。')
      if (installed.some((row) => catalogFor(row)?.key === entry.key)) throw winget.failure('INSTALLED', '此程式已安裝，請重新整理或使用更新。')
      const target = { entry, key: entry.key, name: entry.name, id: entry.id, source: entry.source || 'winget' }
      assertFree(target)
      return target
    }
    const row = installed.find((item) => item.key === request.key)
    if (!row) throw winget.failure('NOT_FOUND', '程式清單已變更，請重新整理。')
    const state = decorate(row)
    const allowed = { uninstall: state.canUninstall, upgrade: state.canUpgrade, cleanup: state.canCleanup }
    if (!allowed[request.action]) throw winget.failure('UNSUPPORTED', '這筆程式目前無法執行此操作。')
    const target = { ...row, entry: catalogFor(row) }
    assertFree(target)
    return target
  }
  function launch(request, target) {
    const job = { id: crypto.randomUUID(), key: request.key, catalogKey: target.entry?.key || '', name: target.name, action: request.action, phase: 'starting', message: '準備執行…', progress: null, startedAt: Date.now() }
    jobs = [...jobs.slice(-19), job]
    const update = (change) => {
      const current = jobs.find((item) => item.id === job.id)
      if (current && Object.keys(change).every((key) => current[key] === change[key])) return
      jobs = jobs.map((item) => item.id === job.id ? { ...item, ...change } : item)
      emit()
    }
    emit()
    return { job: { ...job }, done: execute(request, target, update) }
  }
  function start(request) {
    return launch(request, resolveTarget(request)).job
  }
  // 同時跑 PARALLEL 筆；每筆做完會重新整理，鍵值含版本，尚未更新的那幾筆仍對得上
  function upgradeAll() {
    assertIdle()
    if (batch) throw winget.failure('BUSY', '全部更新正在進行中。')
    const keys = installed.map(decorate).filter((row) => row.canUpgrade && !jobs.some((job) => active(job) && job.key === row.key)).map((row) => row.key)
    if (!keys.length) throw winget.failure('NONE', '目前沒有可更新的程式。')
    batch = { total: keys.length, done: 0, failed: 0 }
    const queue = [...keys]
    const worker = async () => {
      for (let key = queue.shift(); key; key = queue.shift()) {
        const row = installed.find((item) => item.key === key)
        let phase = 'failed'
        if (row && decorate(row).canUpgrade) {
          const { job, done } = launch({ action: 'upgrade', key }, { ...row, entry: catalogFor(row) })
          await done
          phase = jobs.find((item) => item.id === job.id)?.phase
        }
        batch = { ...batch, done: batch.done + 1, failed: batch.failed + (phase === 'failed' ? 1 : 0) }
        emit()
      }
    }
    void Promise.all(Array.from({ length: Math.min(PARALLEL, keys.length) }, worker)).finally(() => { batch = null; emit() })
    emit()
    return { count: keys.length }
  }
  // 安裝程式（尤其 MSI）同時只能跑一個；撞到就等一下再試
  async function wingetRun(action, target, update) {
    if (action === 'uninstall' && target.packageFullName) {
      if (!/^[A-Za-z0-9_.-]+$/.test(target.packageFullName)) throw winget.failure('INVALID', '套件識別資料無效。')
      return runCommand(winget.powershellPath(), ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Remove-AppxPackage -Package '${target.packageFullName}'`], { timeout: 0 })
    }
    for (let attempt = 0; ; attempt++) {
      const result = await run(winget.wingetPath(), winget.actionArgs(action, target), { stallMs: action === 'uninstall' ? 0 : STALL_MS,
        onProgress: ({ percent, size }) => update({ phase: 'running', progress: percent,
          message: action === 'uninstall' ? '正在解除安裝…' : size ? `正在下載 ${size}` : percent !== null ? '正在安裝…' : '正在下載／安裝；需要時 Windows 會要求授權。' }) })
      if (result.stalled) throw winget.failure('STALLED', '下載超過 10 分鐘沒有進度，已放棄；可稍後重新整理再試。')
      if (!IN_PROGRESS.includes(result.code) || attempt >= 30) return result
      update({ phase: 'waiting', progress: null, message: '另一個程式正在安裝，等待後自動重試…' })
      await sleep(10000)
    }
  }
  async function execute(request, target, update) {
    try {
      const result = request.action === 'cleanup' ? await cleanup(target, cacheDir)
        : target.entry?.direct && request.action !== 'uninstall'
        ? await install(target.entry.direct, cacheDir, update)
        : await wingetRun(request.action, target, update)
      if (result.code === MISMATCH && request.action === 'upgrade') return await reinstall(target, update)
      if (result.code === 0x800401F5) throw winget.failure('UNINSTALLER_MISSING', 'Windows 找不到解除安裝程式；請重新整理，確認是否為失效安裝紀錄。')
      if (![0, 3010, 1641].includes(result.code)) throw winget.failure('INSTALL_FAILED', `操作未完成（代碼 0x${result.code.toString(16).toUpperCase()}）。程式可能拒絕背景操作或仍在使用。`)
      update({ phase: 'checking', progress: null, message: '操作已結束，正在重新確認安裝狀態…' })
      await rescan()
      const remains = installed.some((row) => row.identity === target.identity && row.version === target.version)
      const present = installed.some((row) => catalogFor(row)?.key === target.entry?.key)
      const verified = request.action === 'install' ? present : !remains
      if (request.action === 'cleanup' && verified) {
        update({ phase: 'done', progress: null, message: '失效紀錄已清除，備份已保存；程式檔案未刪除。' })
        return
      }
      if (!verified && result.code === 0) throw winget.failure('NOT_CONFIRMED', '工具已結束，但安裝紀錄尚未變更；目前無法確認操作成功。請稍後重新整理。')
      update({ phase: 'done', progress: null, message: result.code ? '操作完成，需要重新啟動 Windows。' : verified ? '操作完成，清單已更新。' : '安裝工具已結束，系統清單尚未反映變更；請稍後重新整理。' })
    } catch (error) {
      update({ phase: 'failed', progress: null, message: error.userMessage || '操作失敗，請重新整理後重試。' })
    }
  }
  // 別的工作觸發的查詢可能早於這筆完成，等它結束再查一次
  async function rescan() {
    while (scan) await scan.catch(() => {})
    await refresh()
  }
  // 新版換了安裝技術（例如 Inno → MSI）時 WinGet 拒絕直接更新：先移除舊版再裝新版
  async function reinstall(target, update) {
    update({ phase: 'running', progress: null, message: '新版安裝方式不同，先移除舊版…' })
    const removed = await wingetRun('uninstall', target, update)
    if (![0, 3010, 1641].includes(removed.code)) throw winget.failure('INSTALL_FAILED', `新版安裝方式不同，需先移除舊版，但移除未完成（代碼 0x${removed.code.toString(16).toUpperCase()}）；舊版仍保留。`)
    const result = await wingetRun('install', target, update).catch((error) => {
      throw winget.failure('INSTALL_FAILED', `舊版已移除，但新版安裝未完成（${error.userMessage || '安裝工具異常'}）；請重新整理後到「常用程式」或用 WinGet 重新安裝。`)
    })
    if (![0, 3010, 1641].includes(result.code)) throw winget.failure('INSTALL_FAILED', `舊版已移除，但新版安裝未完成（代碼 0x${result.code.toString(16).toUpperCase()}）；請重新整理後到「常用程式」或用 WinGet 重新安裝。`)
    update({ phase: 'checking', progress: null, message: '操作已結束，正在重新確認安裝狀態…' })
    await rescan()
    update({ phase: 'done', progress: null, message: result.code ? '已改用新版安裝，需要重新啟動 Windows。' : '已移除舊版並安裝新版。' })
  }
  return { snapshot, refresh, start, upgradeAll, busy, icons: () => icons }
}

module.exports = { createInstaller }
