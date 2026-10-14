/**
 * 文字轉語音頁共用的波形畫法與描邊圖示（lucide，ISC）。
 */

const ICONS = {
  play: '<path d="M6 3l14 9-14 9V3z"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  mic: '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>',
  upload: '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  redo: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  subtitles: '<rect width="18" height="14" x="3" y="5" rx="2"/><path d="M7 15h4"/><path d="M15 15h2"/><path d="M7 11h2"/><path d="M13 11h4"/>',
  book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20"/>'
}

export function svgIcon(name) {
  return `<svg class="speech-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
}

/**
 * 畫波形：range 是選取範圍（0～1），progress 是播放位置（0～1），marks 是分句邊界（0～1）。
 * 依 CSS 變數上色，深淺主題都跟著走。
 */
export function drawWave(canvas, peaks, { range = null, progress = -1, marks = [], active = null } = {}) {
  const width = canvas.clientWidth
  const height = canvas.clientHeight || canvas.height
  if (!width || !height) return
  const ratio = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio)
  }
  const ctx = canvas.getContext('2d')
  const style = getComputedStyle(canvas)
  const color = (name) => style.getPropertyValue(name).trim()
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
  ctx.clearRect(0, 0, width, height)
  if (active) {
    ctx.fillStyle = color('--speech-wave-active')
    ctx.fillRect(active[0] * width, 0, (active[1] - active[0]) * width, height)
  }
  if (range) {
    ctx.fillStyle = color('--speech-wave-selection')
    ctx.fillRect(range[0] * width, 0, (range[1] - range[0]) * width, height)
  }
  const bars = Math.max(1, Math.floor(width / 3))
  const list = peaks?.length ? peaks : [0]
  const mid = height / 2
  for (let i = 0; i < bars; i++) {
    const from = Math.floor((i / bars) * list.length)
    const to = Math.max(from + 1, Math.floor(((i + 1) / bars) * list.length))
    let peak = 0
    for (let j = from; j < to; j++) peak = Math.max(peak, list[j] || 0)
    const x = i * 3
    const position = (x + 1) / width
    const played = progress >= 0 && position <= progress
    const selected = range && position >= range[0] && position <= range[1]
    ctx.fillStyle = color(played || selected ? '--speech-wave-played' : '--speech-wave-bar')
    ctx.globalAlpha = played || selected ? 1 : 0.55
    const h = Math.max(2, Math.sqrt(peak) * (height - 6))
    ctx.fillRect(x, mid - h / 2, 2, h)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = color('--speech-wave-mark')
  for (const mark of marks) ctx.fillRect(Math.round(mark * width), 0, 1, height)
  if (progress >= 0) {
    ctx.fillStyle = color('--speech-wave-head')
    ctx.fillRect(Math.round(progress * width) - 1, 0, 2, height)
  }
}
