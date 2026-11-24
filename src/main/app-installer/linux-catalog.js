'use strict'

/**
 * 把「安裝」分頁的 WinGet 目錄對到 Linux 套件（發行版套件或 Flatpak）。
 * 沒有官方或常用套件的項目不列來源，介面顯示說明，不會亂對到不相干的程式。
 */

const { CATALOG } = require('./catalog')

/** @type {Record<string, { apt?: string, dnf?: string, zypper?: string, pacman?: string, flatpak?: string, note?: string }>} */
const LINUX_SOURCES = {
  discord: { apt: 'discord', dnf: 'discord', zypper: 'discord', pacman: 'discord', flatpak: 'com.discordapp.Discord' },
  steam: { apt: 'steam-installer', dnf: 'steam', zypper: 'steam', pacman: 'steam', flatpak: 'com.valvesoftware.Steam' },
  rustdesk: { apt: 'rustdesk', dnf: 'rustdesk', zypper: 'rustdesk', pacman: 'rustdesk', flatpak: 'com.rustdesk.RustDesk' },
  bambu: { flatpak: 'com.bambulab.BambuStudio' },
  'freecad-tw': {
    apt: 'freecad', dnf: 'freecad', zypper: 'freecad', pacman: 'freecad', flatpak: 'org.freecad.FreeCAD',
    note: '發行版或 Flatpak 的 FreeCAD，不是 Windows 專用的 FreeCAD-TW 套件。'
  },
  fdm: { flatpak: 'org.freedownloadmanager.Manager' }
}

const UNSUPPORTED_NOTES = {
  line: 'LINE 沒有官方 Linux 桌面版。',
  chatgpt: 'ChatGPT 桌面版沒有官方 Linux 套件，請用瀏覽器。',
  claude: 'Claude 桌面版沒有官方 Linux 套件，請用瀏覽器。',
  'grok-bot': 'Grok Bot 桌面版目前沒有官方 Linux 套件。',
  'google-app': 'Google 桌機搜尋沒有官方 Linux 套件。',
  epic: 'Epic Games Launcher 沒有官方 Linux 版。',
  ubisoft: 'Ubisoft Connect 沒有官方 Linux 版。',
  gog: 'GOG GALAXY 沒有官方 Linux 版。',
  rockstar: 'Rockstar Games Launcher 沒有官方 Linux 版。',
  'nvidia-broadcast': 'NVIDIA Broadcast 僅支援 Windows。',
  'nvidia-app': 'NVIDIA App 僅支援 Windows。',
  meta: 'Meta Horizon Link 沒有官方 Linux 版。',
  icue: 'Corsair iCUE 沒有官方 Linux 版。',
  'google-drive': 'Google Drive 桌面版沒有官方 Linux 套件。',
  winrar: 'WinRAR 沒有對應的 Linux 官方套件；可用發行版的解壓縮工具。',
  zlibrary: 'Z-Library 桌面版沒有官方 Linux 套件。'
}

/**
 * @param {'apt'|'dnf'|'zypper'|'pacman'|''} native
 * @param {boolean} flatpak
 */
function sourceFor(entry, native, flatpak) {
  const map = LINUX_SOURCES[entry.key]
  if (!map) return { package: '', channel: '', note: entry.note || UNSUPPORTED_NOTES[entry.key] || 'Linux 沒有可驗證的自動安裝來源。' }
  if (native && map[native]) return { package: map[native], channel: native, note: map.note || '' }
  if (flatpak && map.flatpak) return { package: map.flatpak, channel: 'flatpak', note: map.note || '' }
  if (map.flatpak && !flatpak) return { package: '', channel: '', note: (map.note ? map.note + ' ' : '') + '這台沒有 Flatpak，無法安裝此程式。' }
  return { package: '', channel: '', note: map.note || '目前的套件管理員沒有對應套件。' }
}

function catalogLinux(native, flatpak) {
  return CATALOG.map((entry) => {
    const src = sourceFor(entry, native, flatpak)
    return { ...entry, linux: src }
  })
}

module.exports = { LINUX_SOURCES, UNSUPPORTED_NOTES, sourceFor, catalogLinux }
