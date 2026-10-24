import { applyAppearance, normalizeAppearance, themeColorsOf } from './term-themes.js'

let imageName = null
let imageUrl = ''
let revision = 0

/** Linux 的預設 shell 是 bash：提示字元換成 `~$`，不顯示 Windows 的 `PS C:\>`。 */
function linuxPrompt(host) {
  if (!/Linux/.test(navigator.userAgent) || /Windows/.test(navigator.userAgent)) return
  const text = host.querySelector('.term-preview-text')?.firstChild
  if (text && text.nodeType === Node.TEXT_NODE && text.nodeValue.startsWith('PS C:')) text.nodeValue = '~$ '
}

/** Same palette, wallpaper strength and font size as the terminal; no shell is started. */
export async function refreshTermAppearancePreview() {
  const host = document.getElementById('termAppearancePreview')
  if (!host || !host.closest('#set-appearance.active')) return
  linuxPrompt(host)
  const current = ++revision
  const status = document.getElementById('termPreviewStatus')
  try {
    const [image, fontSize] = await Promise.all([
      window.electronAPI.store.get('termBgImage', ''),
      window.electronAPI.store.get('termFontSize', 17)
    ])
    if (current !== revision) return
    const appearance = normalizeAppearance({
      theme: document.getElementById('termThemeSelect')?.value,
      opacity: document.getElementById('termBgOpacityInput')?.value,
      image
    })
    if (imageName !== appearance.image) {
      let nextUrl = ''
      if (appearance.image) {
        const result = await window.electronAPI.terminal.background(appearance.image)
        if (!result?.ok) throw new Error('background')
        if (current !== revision) return
        // 跟終端機頁一樣直接用 data:（img-src 允許；fetch 會被 connect-src 擋）
        nextUrl = result.data
      }
      imageUrl = nextUrl
      imageName = appearance.image
    }
    const colors = themeColorsOf(appearance.theme)
    applyAppearance(host, appearance, imageUrl)
    host.style.color = colors.foreground
    host.style.setProperty('--preview-cursor', colors.cursor)
    host.style.setProperty('--preview-selection', colors.selectionBackground)
    host.style.fontSize = `${Math.max(8, Math.min(40, Math.round(Number(fontSize) || 17)))}px`
    // 檔案不見了（userData 被清過）：退回純色底並說明，不是載入失敗
    status.textContent = appearance.image && !imageUrl ? '找不到背景圖檔，請重新選擇圖片。' : ''
  } catch {
    if (current === revision) status.textContent = '預覽載入失敗，重新進入外觀設定即可重試。'
  }
}
