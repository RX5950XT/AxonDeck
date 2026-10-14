import { electronAPI, showToast } from './app.js'

const params = new URLSearchParams(location.search)
export const isPageHost = params.get('host') === '1'
export const pageOwner = window.electronAPI?.pages ? (isPageHost ? 'host' : params.get('page') || '') : ''
const settings = new BroadcastChannel('axondeck-page-settings')

export function notifyPageSettings() { settings.postMessage('changed') }

export async function navigateToPage(request, detach = false) {
  try {
    const result = await electronAPI.pages.navigate(request, detach)
    if (!result.ok) throw new Error(result.error?.message || '無法開啟功能頁')
    return result.data
  } catch {
    showToast('功能視窗開啟失敗，請稍後再試', 'error')
    return false
  }
}

export function initPageWindows({ switchPage, openSettingsPage, openInFilesPage, openFolderInWorkspace, openUrlInApp, cooldown, settingsChanged }) {
  if (!pageOwner) return
  document.body.classList.toggle('page-host', isPageHost)
  if (isPageHost) {
    for (const button of document.querySelectorAll('.nav-tab')) {
      button.classList.remove('active')
      button.removeAttribute('aria-current')
    }
    const message = document.createElement('p')
    message.className = 'page-host-message'
    message.textContent = '點上方按鈕開啟功能；右鍵可開獨立視窗，最小化即可收回。'
    document.querySelector('.content').appendChild(message)
  }
  settings.onmessage = (event) => { if (event.data === 'changed') settingsChanged() }
  electronAPI.pages.onState(({ detached, floating, current = '', pending = '' }) => {
    if (isPageHost) {
      document.body.dataset.mainPage = current
      document.body.dataset.pendingPage = pending
    }
    document.body.classList.toggle('page-floating', floating)
    for (const button of document.querySelectorAll('.nav-tab')) {
      button.classList.toggle('is-detached', detached.includes(button.dataset.page))
      button.classList.toggle('is-owner', button.dataset.page === pageOwner)
    }
    for (const id of ['winMin', 'winClose']) {
      const button = document.getElementById(id)
      const label = floating ? '收回主視窗' : id === 'winMin' ? '最小化' : '關閉'
      button.title = label
      button.setAttribute('aria-label', label)
    }
  })
  electronAPI.pages.onVisibility((visible) => { if (visible) switchPage(pageOwner); else cooldown() })
  electronAPI.pages.onNavigate(async ({ page, subtab, action, full, kind, project, target }) => {
    if (page !== pageOwner) return
    try {
      if (action === 'files') await openInFilesPage(full, kind)
      else if (action === 'project') await openFolderInWorkspace(full)
      else if (action === 'browser') await openUrlInApp(full, project, target)
      else if (page === 'settings' && subtab) openSettingsPage(subtab)
      else if (subtab) switchPage(page, subtab)
    } catch { showToast('無法開啟指定內容', 'error') }
  })
}
