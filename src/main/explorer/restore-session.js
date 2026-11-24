'use strict'

/**
 * 檔案總管啟動時，把已消失或空白的分頁路徑安靜改回首頁。
 * 存在性檢查走非同步（isDirSoon），避免睡著的網路磁碟卡住啟動。
 * store.sanitizeTab 刻意不探路（離線 NAS 還要留著路徑），這層才在開 App 時補上。
 */

const paths = require('./paths')
const drives = require('./drives')
const recycle = require('./recycle')

/**
 * @param {object[]} listed
 * @param {object[]} disks
 * @param {string} lastResort
 * @returns {string}
 */
function sessionFallback(listed, disks, lastResort) {
  return listed[0] ? listed[0].path : (disks[0] ? disks[0].path : lastResort)
}

/**
 * @param {unknown} dirPath
 * @param {string} fallback
 * @param {(full: string) => Promise<boolean>} [isDir]
 * @returns {Promise<string>}
 */
async function restoreExistingDir(dirPath, fallback, isDir = (full) => drives.isDirSoon(full)) {
  const cwd = typeof dirPath === 'string' ? dirPath.trim() : ''
  if (!cwd) return fallback
  if (recycle.isRecyclePath(cwd) || drives.isThisPc(cwd)) return cwd
  const reachable = await Promise.resolve(isDir(cwd)).catch(() => false)
  if (!reachable) return fallback
  try {
    return paths.resolveAbs(cwd)
  } catch {
    // 路徑已確認存在；resolveAbs 在 Windows 才正規化，Linux 測試／移植仍保留原路徑
    return cwd
  }
}

/**
 * 同步 lastPath 與每個分頁的 cwd。缺路徑時改寫目前歷史那一格，較早的紀錄不動。
 * @param {{ lastPath?: string, tabs?: object[], activeTabId?: string }} state
 * @param {{ fallback: string, isDir?: (full: string) => Promise<boolean> }} opts
 */
async function restoreBrowseSession(state, { fallback, isDir }) {
  const tabsIn = Array.isArray(state.tabs) ? state.tabs : []
  const tabs = await Promise.all(tabsIn.map(async (tab) => {
    const cwd = await restoreExistingDir(tab.cwd, fallback, isDir)
    if (cwd === tab.cwd) return tab
    const history = Array.isArray(tab.history) ? tab.history.slice() : []
    const nextHistory = history.length ? history : [tab.cwd || cwd]
    let histIndex = Number(tab.histIndex)
    if (!Number.isFinite(histIndex) || histIndex < 0) histIndex = 0
    if (histIndex >= nextHistory.length) histIndex = nextHistory.length - 1
    nextHistory[Math.max(0, histIndex)] = cwd
    return { ...tab, cwd, history: nextHistory, histIndex: Math.max(0, histIndex) }
  }))
  const active = tabs.find((tab) => tab.id === state.activeTabId) || tabs[0]
  const lastPath = active
    ? active.cwd
    : await restoreExistingDir(state.lastPath, fallback, isDir)
  return { lastPath, tabs }
}

module.exports = { sessionFallback, restoreExistingDir, restoreBrowseSession }
