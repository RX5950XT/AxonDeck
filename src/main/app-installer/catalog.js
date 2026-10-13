'use strict'

// 安裝來源只由 main 維護；renderer 只能送清單 key，不能指定網址或參數。
const CATALOG = [
  { key: 'line', site: 'line.me', name: 'LINE', group: '通訊與 AI', id: 'XPFCC4CD725961', source: 'msstore', match: '^LINE(?: Desktop)?$' },
  { key: 'discord', site: 'discord.com', name: 'Discord', group: '通訊與 AI', id: 'Discord.Discord', match: '^Discord$' },
  { key: 'chatgpt', site: 'chatgpt.com', name: 'ChatGPT', group: '通訊與 AI', id: '9PLM9XGG6VKS', source: 'msstore', match: '^ChatGPT$' },
  { key: 'claude', site: 'claude.ai', name: 'Claude', group: '通訊與 AI', id: 'Anthropic.Claude' },
  { key: 'grok-bot', site: 'grok.com', name: 'Grok Bot', group: '通訊與 AI', id: 'xAI.GrokBot', match: '^Grok Bot(?: |$)' },
  { key: 'google-app', site: 'google.com', name: 'Google App', group: '通訊與 AI', match: '^Google App(?: |$)', direct: 'google-app', note: '桌機 AI 搜尋（Alt+Space）；裝完由 Google 自己更新。' },
  { key: 'epic', site: 'epicgames.com', name: 'Epic Games Launcher', group: '遊戲', id: 'EpicGames.EpicGamesLauncher' },
  { key: 'ubisoft', site: 'ubisoft.com', name: 'Ubisoft Connect', group: '遊戲', id: 'Ubisoft.Connect' },
  { key: 'gog', site: 'gog.com', name: 'GOG GALAXY', group: '遊戲', id: 'GOG.Galaxy' },
  { key: 'rockstar', site: 'rockstargames.com', name: 'Rockstar Games Launcher', group: '遊戲', id: 'RockstarGames.Launcher' },
  { key: 'steam', site: 'steampowered.com', name: 'Steam', group: '遊戲', id: 'Valve.Steam' },
  { key: 'nvidia-broadcast', site: 'nvidia.com', name: 'NVIDIA Broadcast', group: '影音與硬體', match: '^NVIDIA Broadcast(?: |$)', direct: 'broadcast', note: '需要支援的 NVIDIA RTX 顯示卡。' },
  { key: 'nvidia-app', site: 'nvidia.com', name: 'NVIDIA App', group: '影音與硬體', match: '^NVIDIA App(?: |$)', direct: 'nvidia' },
  { key: 'meta', site: 'meta.com', name: 'Meta Horizon Link', group: '影音與硬體', id: 'Meta.Oculus', match: '^(Meta Horizon Link|Oculus)$' },
  { key: 'icue', site: 'corsair.com', name: 'Corsair iCUE', group: '影音與硬體', id: 'Corsair.iCUE.5', match: '^Corsair iCUE' },
  { key: 'rustdesk', site: 'rustdesk.com', name: 'RustDesk', group: '網路與遠端', match: '^RustDesk$', direct: 'rustdesk' },
  { key: 'fdm', site: 'freedownloadmanager.org', name: 'Free Download Manager', group: '網路與遠端', id: 'SoftDeluxe.FreeDownloadManager' },
  { key: 'google-drive', site: 'drive.google.com', name: 'Google Drive', group: '網路與遠端', id: 'Google.GoogleDrive' },
  { key: 'bambu', site: 'bambulab.com', name: 'Bambu Studio', group: '設計與工具', id: 'Bambulab.Bambustudio' },
  { key: 'winrar', site: 'win-rar.com', name: 'WinRAR', group: '設計與工具', id: 'RARLab.WinRAR' },
  { key: 'freecad-tw', site: 'freecad.org', name: 'FreeCAD-TW', group: '設計與工具', match: '^FreeCAD-TW(?: |$)', direct: 'freecad', note: '指定版本 tw-20260904-0408，含 AgentCAD。' },
  { key: 'zlibrary', site: 'z-lib.fm', name: 'Z-Library', group: '辦公與閱讀', match: '^Z-Library(?: |$)', direct: 'zlibrary' }
]

function catalogFor(row) {
  return CATALOG.find((entry) => entry.id === row.id || (entry.match && new RegExp(entry.match, 'i').test(row.name)))
}

// 沒有內嵌圖示的 CLI／共用元件，沿用發行者官網標誌。
const ICON_SITES = [
  [/^LLVM\b/i, 'llvm.org'], [/^Pandoc\b/i, 'pandoc.org'], [/^Rustup\b/i, 'rust-lang.org'],
  [/^Python Launcher$/i, 'python.org'], [/^Android SDK/i, 'developer.android.com'], [/^FFmpeg$/i, 'ffmpeg.org'],
  [/^(?:GitHub CLI|actionlint|Gitleaks)$/i, 'github.com'], [/^cosign$/i, 'sigstore.dev'], [/^jq$/i, 'jqlang.org'],
  [/^obs-backgroundremoval/i, 'obsproject.com'], [/^PawnIO$/i, 'pawnio.eu'],
  [/兆豐銀行/, 'megabank.com.tw'], [/玉山銀行/, 'esunbank.com'], [/雷電模擬器/, 'ldplayer.net'],
  [/^(?:Microsoft|Windows|Office|PowerToys|Local AI Manager for Microsoft|vs_CoreEditorFonts|X64 Debuggers|Handle\b)/i, 'microsoft.com']
]
function iconSiteFor(row) {
  return catalogFor(row)?.site || ICON_SITES.find(([pattern]) => pattern.test(row.name))?.[1] || ''
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

module.exports = { CATALOG, CATEGORIES, catalogFor, categoryFor, newerVersion, iconSiteFor }
