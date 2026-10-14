/**
 * 終端機分頁顯示的名字。使用者改過的一定留著。前景程式報的 OSC 標題有內容就用，
 * 但 `grok`／`claude` 這類全程不變的程式名要讓給對話標題，再退回工作階段自己的名字。
 */

const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●]/g
const GENERIC_OSC = /^(grok|claude|codex|opencode|agy|antigravity|powershell|windows powershell|pwsh|cmd(?:\.exe)?)$/i

/**
 * @param {{ renamed?: boolean, title?: string, osTitle?: string, agentTitle?: string } | null | undefined} item
 * @returns {string}
 */
export function terminalTabTitle(item) {
  if (!item) return ''
  if (item.renamed) return item.title || ''
  const osc = String(item.osTitle || '').replace(SPINNER, '').replace(/\s+/g, ' ').trim()
  if (osc && !GENERIC_OSC.test(osc)) return osc
  return item.agentTitle || item.title || ''
}

/**
 * 終端機分頁從開頭留字。檔案路徑仍走另一邊的尾端截斷。
 * @param {string} value
 * @param {number} [max]
 * @returns {string}
 */
export function terminalLabel(value, max = 28) {
  const text = String(value || '').trim() || '未命名'
  if (text.length <= max) return text
  return `${text.slice(0, max - 1)}…`
}
