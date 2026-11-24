'use strict'

const crypto = require('crypto')
const { CATALOG, CATEGORIES, catalogFor, categoryFor, iconSiteFor } = require('./catalog')
const { catalogLinux, sourceFor } = require('./linux-catalog')
const backend = require('./linux-backend')

function identityOf(row) {
  return `${row.source}:${row.id}`
}

function createLinuxInstaller({ notify = () => {}, detect: detectInfo, list, search, runCommand, spawnCommand } = {}) {
  const info = () => detectInfo || backend.detect()
  let installed = [], checkedAt = null, scan = null, jobs = [], scanError = '', batch = null, lastSearch = []
  const active = (job) => !['done', 'failed'].includes(job.phase)
  const busy = () => !!batch || jobs.some(active)
  const emit = () => notify(snapshot())

  function decorate(row) {
    const entry = catalogFor({ id: row.catalogId || '', name: row.name }) || CATALOG.find((item) => item.key === row.catalogKey)
    const available = row.available || ''
    return {
      name: row.name, id: row.id, version: row.version, source: row.source, architecture: row.architecture || '',
      scope: row.scope || '', key: row.key, catalogKey: entry?.key || row.catalogKey || '',
      site: entry ? iconSiteFor({ id: entry.id, name: entry.name }) : '', category: categoryFor({ id: row.id, name: row.name }),
      available, canUninstall: true, canCleanup: false, canUpgrade: !!available, note: row.note || ''
    }
  }

  function snapshot() {
    const current = info()
    const catalog = catalogLinux(current.native, current.flatpak).map((entry) => {
      const src = entry.linux
      const installedKeys = installed.filter((row) => row.catalogKey === entry.key || catalogFor({ id: '', name: row.name })?.key === entry.key).map((row) => row.key)
      return {
        key: entry.key, name: entry.name, group: entry.group, category: entry.group,
        note: src.note || entry.note || '',
        canInstall: !!src.package && installedKeys.length === 0,
        source: src.channel === 'flatpak' ? 'Flatpak' : src.channel ? src.channel : '官方網站',
        site: entry.site || '', latest: '', sourceError: '',
        installedKeys
      }
    })
    return {
      categories: CATEGORIES, checkedAt, scanning: !!scan, scanError, busy: busy(), iconsStamp: 0,
      batch: batch && { ...batch }, jobs: jobs.map((job) => ({ ...job })), installed: installed.map(decorate),
      catalog, unsupported: false,
      backend: { native: current.native || '', flatpak: !!current.flatpak, graphical: current.graphical || '', terminal: current.terminal || '' },
      search: lastSearch
    }
  }

  function matchCatalog(row) {
    const byId = CATALOG.find((entry) => {
      const src = sourceFor(entry, info().native, info().flatpak)
      return src.package && (src.package === row.id || src.package === row.name)
    })
    return byId || catalogFor(row)
  }

  async function refresh() {
    if (scan) { await scan; return snapshot() }
    scanError = ''
    scan = (async () => {
      const rows = await (list || backend.listInstalled)({ detect: info() })
      installed = rows.map((row) => {
        const entry = matchCatalog(row)
        return {
          ...row,
          catalogKey: entry?.key || '',
          catalogId: entry?.id || '',
          identity: identityOf(row),
          key: crypto.createHash('sha256').update(identityOf(row) + '\0' + (row.version || '')).digest('hex').slice(0, 24)
        }
      })
      checkedAt = Date.now()
    })()
    emit()
    try { await scan } catch (error) { scanError = error.userMessage || '無法取得程式清單，請稍後重新整理。'; throw error }
    finally { scan = null; emit() }
    return snapshot()
  }

  function assertIdle() {
    if (!checkedAt) throw Object.assign(new Error('NOT_READY'), { userMessage: '請先完成清單查詢。' })
  }

  function resolveTarget(request) {
    if (!request || typeof request.key !== 'string' || !['install', 'upgrade', 'uninstall', 'cleanup', 'search'].includes(request.action)) {
      throw Object.assign(new Error('INVALID'), { userMessage: '無效的程式操作。' })
    }
    if (request.action === 'search') return { query: String(request.query || request.key || '').trim() }
    assertIdle()
    if (request.action === 'cleanup') throw Object.assign(new Error('UNSUPPORTED'), { userMessage: 'Linux 沒有解除安裝登錄可清。' })
    if (request.action === 'install') {
      const entry = CATALOG.find((item) => item.key === request.key)
      if (!entry) throw Object.assign(new Error('NO_SOURCE'), { userMessage: '此程式尚無可驗證的自動安裝來源。' })
      const src = sourceFor(entry, info().native, info().flatpak)
      if (!src.package) throw Object.assign(new Error('NO_SOURCE'), { userMessage: src.note || '此程式尚無可驗證的自動安裝來源。' })
      if (installed.some((row) => row.catalogKey === entry.key)) {
        throw Object.assign(new Error('INSTALLED'), { userMessage: '此程式已安裝，請重新整理或使用更新。' })
      }
      return { entry, key: entry.key, name: entry.name, package: src.package, channel: src.channel }
    }
    const row = installed.find((item) => item.key === request.key)
    if (!row) throw Object.assign(new Error('NOT_FOUND'), { userMessage: '程式清單已變更，請重新整理。' })
    const state = decorate(row)
    if (request.action === 'uninstall' && !state.canUninstall) throw Object.assign(new Error('UNSUPPORTED'), { userMessage: '這筆程式目前無法執行此操作。' })
    if (request.action === 'upgrade' && !state.canUpgrade) throw Object.assign(new Error('UNSUPPORTED'), { userMessage: '這筆程式目前無法執行此操作。' })
    const entry = CATALOG.find((item) => item.key === row.catalogKey)
    const src = entry ? sourceFor(entry, info().native, info().flatpak) : { package: row.id, channel: row.source }
    return { ...row, entry, package: src.package || row.id, channel: src.channel || row.source }
  }

  async function execute(request, target, update) {
    try {
      if (request.action === 'search') {
        lastSearch = await (search || backend.search)(target.query, { detect: info() })
        update({ phase: 'done', progress: null, message: lastSearch.length ? `找到 ${lastSearch.length} 筆結果。` : '沒有符合的套件。' })
        emit()
        return
      }
      const channel = target.channel
      const pkg = target.package
      const [exe0, args0] = channel === 'flatpak'
        ? backend.flatpakArgs(request.action, pkg, true)
        : backend.nativeArgs(channel, request.action, pkg)
      const privileged = backend.privilegeCommand(exe0, args0, { detect: info() })
      backend.assertNotSilentSudo(privileged.exe, privileged.args)
      update({
        phase: 'running',
        progress: null,
        message: privileged.visibleSudo
          ? '已開啟終端機，請在視窗裡輸入 sudo 密碼以完成安裝。'
          : privileged.elevated
            ? '即將跳出系統密碼視窗（pkexec），不會使用靜默 sudo。'
            : '正在以使用者權限安裝 Flatpak…'
      })
      const runFn = privileged.visibleSudo
        ? (spawnCommand || backend.spawnDetached)
        : (runCommand || ((exe, args) => backend.run(exe, args)))
      const result = await runFn(privileged.exe, privileged.args)
      if (privileged.visibleSudo) {
        update({ phase: 'checking', progress: null, message: '已開啟終端機，請完成後按重新整理確認。' })
        update({ phase: 'done', progress: null, message: '已開啟終端機進行安裝；完成後請重新整理清單。' })
        return
      }
      if (result.code !== 0) {
        throw Object.assign(new Error('INSTALL_FAILED'), { userMessage: `操作未完成（代碼 ${result.code}）。${String(result.stderr || '').slice(0, 200)}` })
      }
      update({ phase: 'checking', progress: null, message: '操作已結束，正在重新確認安裝狀態…' })
      await refresh()
      const present = installed.some((row) => row.catalogKey === target.entry?.key || row.id === target.package)
      const verified = request.action === 'install' ? present : request.action === 'uninstall' ? !present : true
      update({
        phase: 'done',
        progress: null,
        message: verified ? '操作完成，清單已更新。' : '工具已結束，請稍後重新整理確認。'
      })
    } catch (error) {
      update({ phase: 'failed', progress: null, message: error.userMessage || '操作失敗，請重新整理後重試。' })
    }
  }

  function launch(request, target) {
    const job = {
      id: crypto.randomUUID(), key: request.key, catalogKey: target.entry?.key || '',
      name: target.name || target.query || '', action: request.action, phase: 'starting',
      message: '準備執行…', progress: null, startedAt: Date.now()
    }
    jobs = [...jobs.slice(-19), job]
    const update = (change) => {
      jobs = jobs.map((item) => item.id === job.id ? { ...item, ...change } : item)
      emit()
    }
    emit()
    return { job: { ...job }, done: execute(request, target, update) }
  }

  function start(request) {
    return launch(request, resolveTarget(request)).job
  }

  function upgradeAll() {
    assertIdle()
    if (batch) throw Object.assign(new Error('BUSY'), { userMessage: '全部更新正在進行中。' })
    const keys = installed.map(decorate).filter((row) => row.canUpgrade).map((row) => row.key)
    if (!keys.length) throw Object.assign(new Error('NONE'), { userMessage: '目前沒有可更新的程式。' })
    batch = { total: keys.length, done: 0, failed: 0 }
    void (async () => {
      for (const key of keys) {
        const row = installed.find((item) => item.key === key)
        let phase = 'failed'
        if (row && decorate(row).canUpgrade) {
          const { job, done } = launch({ action: 'upgrade', key }, resolveTarget({ action: 'upgrade', key }))
          await done
          phase = jobs.find((item) => item.id === job.id)?.phase
        }
        batch = { ...batch, done: batch.done + 1, failed: batch.failed + (phase === 'failed' ? 1 : 0) }
        emit()
      }
    })().finally(() => { batch = null; emit() })
    emit()
    return { count: keys.length }
  }

  return { snapshot, refresh, start, upgradeAll, busy, icons: async () => ({}) }
}

module.exports = { createLinuxInstaller }
