/**
 * AxonDeck — 「以管理員身分執行」的用字。
 *
 * Windows 用原本的字（管理員／UAC），catalog 不帶 adminCopy；
 * Linux 的 catalog 帶 { menu, context, dialog, hint, badge }，叫 root，分頁上掛「root」標記。
 * terminal-page 讀到 catalog 後寫進來，ws-tabs（＋選單）與 workspace-page（專案右鍵）照著顯示。
 */

const DEFAULTS = Object.freeze({
  menu: '以系統管理員身分執行',
  context: '以管理員身分開啟終端機',
  dialog: '以系統管理員身分執行',
  hint: '',
  badge: '',
  supported: true
})

let current = { ...DEFAULTS }

/**
 * @param {{ adminCopy?: any, supportsAdmin?: boolean } | null | undefined} catalog
 */
export function setAdminCopy(catalog) {
  const copy = catalog?.adminCopy
  current = {
    ...DEFAULTS,
    ...(copy && typeof copy === 'object' ? {
      menu: String(copy.menu || DEFAULTS.menu),
      context: String(copy.context || DEFAULTS.context),
      dialog: String(copy.dialog || DEFAULTS.dialog),
      hint: String(copy.hint || ''),
      badge: String(copy.badge || '')
    } : {}),
    supported: catalog?.supportsAdmin !== false
  }
}

/** @returns {{ menu: string, context: string, dialog: string, hint: string, badge: string, supported: boolean }} */
export function adminCopy() {
  return current
}
