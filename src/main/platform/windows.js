'use strict'

/**
 * Windows 平台小工具（Explorer 路徑／磁碟／回收筒的細節仍在 explorer/*）。
 */

function fallbackRoot() {
  const drive = String(process.env.SystemDrive || 'C:').replace(/\\+$/, '')
  return /^[A-Za-z]:$/.test(drive) ? `${drive}\\` : 'C:\\'
}

function looksAbsolute(raw) {
  if (typeof raw !== 'string' || !raw) return false
  if (raw.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(raw)
}

module.exports = {
  id: 'windows',
  fallbackRoot,
  looksAbsolute
}
