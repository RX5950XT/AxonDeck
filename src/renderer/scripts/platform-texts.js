/**
 * Linux 版：把 index.html 裡寫死、只對 Windows 成立的說明換成 Linux 的實際行為。
 * Windows（以及 vm 測試沒有 navigator 時）什麼都不做。
 */
const IS_LINUX = typeof navigator !== 'undefined'
  && /Linux/.test(navigator.userAgent) && !/Windows/.test(navigator.userAgent)

export const LINUX_PROC_NOTE =
  'Linux 版目前不提供各程序的 VRAM 用量，VRAM 欄會顯示「—」。'
  + '整張卡的用量請看總覽頁的 GPU 讀數：NVIDIA 來自 nvidia-smi，AMD 來自 amdgpu 驅動的 sysfs；其他顯示卡讀不到。'

export function applyPlatformTexts(doc = typeof document !== 'undefined' ? document : null) {
  if (!IS_LINUX || !doc) return
  const note = doc.getElementById('sysmonProcNote')
  if (note) note.textContent = LINUX_PROC_NOTE
  // 「安裝」分頁在 Linux 不支援（會顯示說明），底下這段 WinGet 授權說明不適用
  const hint = doc.getElementById('installFootHint')
  if (hint) hint.hidden = true
}
