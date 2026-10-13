'use strict'

// 安裝來源只由 main 維護；renderer 只能送清單 key，不能指定網址或參數。
const CATALOG = [
  { key: 'nvidia-broadcast', site: 'nvidia.com', name: 'NVIDIA Broadcast', group: '影音與硬體', match: '^NVIDIA Broadcast(?: |$)', direct: 'broadcast', note: '需要支援的 NVIDIA RTX 顯示卡。' },
  { key: 'nvidia-app', site: 'nvidia.com', name: 'NVIDIA App', group: '影音與硬體', match: '^NVIDIA App(?: |$)', direct: 'nvidia' },
  { key: 'epic', site: 'epicgames.com', name: 'Epic Games Launcher', group: '遊戲', id: 'EpicGames.EpicGamesLauncher' },
  { key: 'ubisoft', site: 'ubisoft.com', name: 'Ubisoft Connect', group: '遊戲', id: 'Ubisoft.Connect' },
  { key: 'gog', site: 'gog.com', name: 'GOG GALAXY', group: '遊戲', id: 'GOG.Galaxy' },
  { key: 'rockstar', site: 'rockstargames.com', name: 'Rockstar Games Launcher', group: '遊戲', id: 'RockstarGames.Launcher' },
  { key: 'steam', site: 'steampowered.com', name: 'Steam', group: '遊戲', id: 'Valve.Steam' },
  { key: 'line', site: 'line.me', name: 'LINE', group: '通訊與 AI', id: 'XPFCC4CD725961', source: 'msstore', match: '^LINE(?: Desktop)?$' },
  { key: 'discord', site: 'discord.com', name: 'Discord', group: '通訊與 AI', id: 'Discord.Discord', match: '^Discord$' },
  { key: 'chatgpt', site: 'chatgpt.com', name: 'ChatGPT', group: '通訊與 AI', id: '9PLM9XGG6VKS', source: 'msstore', match: '^ChatGPT$' },
  { key: 'claude', site: 'claude.ai', name: 'Claude', group: '通訊與 AI', id: 'Anthropic.Claude' },
  { key: 'grok-bot', site: 'grok.com', name: 'Grok Bot', group: '通訊與 AI', id: 'xAI.GrokBot', match: '^Grok Bot(?: |$)' },
  { key: 'rustdesk', site: 'rustdesk.com', name: 'RustDesk', group: '網路與遠端', match: '^RustDesk$', direct: 'rustdesk' },
  { key: 'bambu', site: 'bambulab.com', name: 'Bambu Studio', group: '設計與工具', id: 'Bambulab.Bambustudio' },
  { key: 'zlibrary', site: 'z-lib.fm', name: 'Z-Library', group: '辦公與閱讀', match: '^Z-Library(?: |$)', direct: 'zlibrary' },
  { key: 'meta', site: 'meta.com', name: 'Meta Horizon Link', group: '影音與硬體', id: 'Meta.Oculus', match: '^(Meta Horizon Link|Oculus)$' },
  { key: 'google-drive', site: 'drive.google.com', name: 'Google Drive', group: '網路與遠端', id: 'Google.GoogleDrive' },
  { key: 'freecad-tw', site: 'freecad.org', name: 'FreeCAD-TW', group: '設計與工具', match: '^FreeCAD-TW(?: |$)', direct: 'freecad', note: '指定版本 tw-20260904-0408，含 AgentCAD。' }
]

function catalogFor(row) {
  return CATALOG.find((entry) => entry.id === row.id || (entry.match && new RegExp(entry.match, 'i').test(row.name)))
}

// 依名稱＋套件 ID 的關鍵字自動分類；順序有意義（先比對的優先，例如 WebView2 Runtime 歸執行環境而非瀏覽器）
const CATEGORY_RULES = [
  ['遊戲', /steam|epic ?games|ubisoft|\bgog\b|rockstar|battle\.net|blizzard|\bea app\b|electronic ?arts|riot|valorant|league of legends|minecraft|xbox|\bgame|遊戲|hoyoverse|mihoyo|genshin|playnite/i],
  ['通訊與 AI', /discord|\bline\b|telegram|slack|\bteams\b|zoom|skype|whatsapp|wechat|messenger|signal|chatgpt|claude|grok|copilot|gemini|ollama|lm ?studio|anthropic|openai|\bai\b/i],
  ['開發工具', /visual studio|vs ?code|vscode|\bgit\b|github|node\.?js|python|\bjava\b|\bjdk\b|openjdk|rust(?!desk)|golang|docker|\bwsl\b|cmake|llvm|android studio|jetbrains|intellij|pycharm|postman|powershell|terminal|\bsdk\b|cuda|cursor|neovim|notepad\+\+|\bsql\b|mysql|postgres|\bnpm\b|\buv\b|msys|mingw|cygwin|platformio|arduino/i],
  ['影音與硬體', /nvidia|amd software|radeon|realtek|logitech|razer|corsair|steelseries|\basus\b|\bmsi\b|gigabyte|elgato|\bobs\b|vlc|\bmpv\b|spotify|audio|video|media|player|camera|oculus|meta horizon|codec|k-lite|potplayer|davinci|premiere|photoshop|lightroom|gimp|blender|krita|audacity|handbrake|ffmpeg|音訊|影音/i],
  ['系統與執行環境', /runtime|redistributable|visual c\+\+|\.net|directx|webview|framework|windows|driver|chipset|\bintel\b|firmware|bios|update|驅動|microsoft/i],
  ['網路與遠端', /chrome|firefox|\bedge\b|brave|opera|vivaldi|\bvpn\b|tailscale|wireguard|rustdesk|anydesk|teamviewer|parsec|google drive|onedrive|dropbox|qbittorrent|torrent|download manager|\bssh\b|putty|winscp|filezilla/i],
  ['辦公與閱讀', /office|\bword\b|excel|powerpoint|outlook|onenote|acrobat|\bpdf\b|libreoffice|notion|obsidian|evernote|\bwps\b|zotero|calibre|kindle|z-library|reader|筆記/i],
  ['設計與工具', /freecad|bambu|cura|prusa|orca ?slicer|autocad|fusion|solidworks|kicad|inkscape|figma|7-zip|winrar|bandizip|everything|powertoys|sharex|snipaste|autohotkey/i]
]
const CATEGORIES = [...CATEGORY_RULES.map(([name]) => name), '其他']

function categoryFor(row) {
  const entry = catalogFor(row)
  if (entry) return entry.group
  const text = `${row.name} ${row.id}`
  return CATEGORY_RULES.find(([, pattern]) => pattern.test(text))?.[0] || '其他'
}

function newerVersion(available, installed) {
  if (!/^\d+(?:\.\d+)*$/.test(available) || !/^\d+(?:\.\d+)*$/.test(installed)) return false
  const a = available.split('.').map(Number), b = installed.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0)
  }
  return false
}

module.exports = { CATALOG, CATEGORIES, catalogFor, categoryFor, newerVersion }
