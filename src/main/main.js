const {
  app, BrowserWindow, ipcMain, session, desktopCapturer, screen, shell, dialog,
  Menu, Tray, nativeImage, protocol, webContents, net
} = require('electron')
const path = require('path')
const fs = require('fs')

/**
 * 管理員終端機的提權宿主模式。
 *
 * 這支執行檔被自己以 `Start-Process -Verb RunAs` 再開一份時會帶這個旗標：
 * 不建視窗、不搶 single instance lock、不註冊任何 IPC，只負責在管理員權限下
 * 開 pty 並透過具名管道轉發（見 `terminal/admin.js`）。所以要擋在所有東西之前。
 */
const ADMIN_HOST_FLAG = '--terminal-admin-host='
const adminHostArg = process.argv.find((a) => a.startsWith(ADMIN_HOST_FLAG))
if (adminHostArg) {
  app.disableHardwareAcceleration()
  // 提權程序寫進去的檔案擁有者會變成管理員，不要碰主程序那份 userData
  app.setPath('userData', path.join(app.getPath('temp'), 'axondeck-admin-host'))
  require('./terminal/admin-host').run(adminHostArg.slice(ADMIN_HOST_FLAG.length))
  return
}

const models = require('./models')
const chat = require('./chat')
const modelScope = require('./model-scope')
const glossary = require('./glossary')
const chatStore = require('./chat-store')
const scriptLaunch = require('./script-launch')
const chatParams = require('./chat-params')
const { sanitizeTtsVoices, DEFAULT_TTS_VOICES, VOICES_BY_LANG, listVoices } = require('./tts-voices')

/** 設定頁試聽用的範例句（main 的固定表，renderer 不送文字） */
const TTS_PREVIEW_TEXT = Object.freeze({
  'zh-TW': '你好，這是語音試聽，聽起來還可以嗎？',
  'zh-CN': '你好，这是语音试听，听起来还可以吗？',
  en: 'Hi there, this is a voice preview. How does it sound?',
  ja: 'こんにちは。これは音声のプレビューです。',
  ko: '안녕하세요. 이것은 음성 미리 듣기입니다.'
})
const { registerUsageIpc } = require('./usage/ipc')
const { registerAgyIpc } = require('./agy/ipc')
const { registerTerminalIpc } = require('./terminal/ipc')
// 只用來驗 store 裡的桌布檔名（不碰 node-pty，載進來不影響啟動時間）
const termBackground = require('./terminal/background')
const { registerWorkspaceIpc } = require('./workspace/ipc')
// 工作區的圖片／PDF／影音串流（只載 files.js，不碰工作區其餘模組）
const workspaceMedia = require('./workspace/media')
const extensionManager = require('./browser-extension-manager')
// 自訂協定的權限只能在 app ready 之前宣告
protocol.registerSchemesAsPrivileged([workspaceMedia.PRIVILEGES, extensionManager.PRIVILEGES])
const { registerSysmonIpc } = require('./sysmon/ipc')
const { registerHfModelsIpc } = require('./hfmodels/ipc')
const { registerCloudTtsIpc } = require('./cloud-tts/ipc')
const { registerAppInstallerIpc } = require('./app-installer/ipc')
const { registerBreezeIpc } = require('./breeze-tts/ipc')
const { registerMiroxenIpc } = require('./miroxen/ipc')
const { registerPdfTranslateIpc } = require('./pdf-translate/ipc')
const { registerScreenTranslateIpc } = require('./screen-translate/ipc')
const { registerCcSwitchIpc } = require('./ccswitch/ipc')
const { registerCodeUsageIpc } = require('./codeusage/ipc')
const { registerDictationIpc } = require('./dictation/ipc')
const sttArchive = require('./stt-archive')
const { registerScreentimeIpc } = require('./screentime/ipc')
const { registerExplorerIpc } = require('./explorer/ipc')
const dictationHud = require('./dictation/hud')
const updater = require('./updater')

const bootStartedAt = Date.now()
function bootLog(step) {
  console.log(`[boot] ${Date.now() - bootStartedAt}ms ${step}`)
}

/**
 * 啟動只載聊天需要的模組。ASR／LLM／額度／AGY／CUDA 第一次用到才 require，
 * 避免 400MB+ 的 unpacked native 與巨大 JS 圖擋住第一扇窗。
 * @param {string} id
 * @returns {() => object}
 */
function lazyLoad(id) {
  let mod
  return () => {
    if (!mod) {
      mod = require(id)
      if (store && typeof mod.setStore === 'function') mod.setStore(store)
    }
    return mod
  }
}

/** 本地 ASR 門面：依各頁自己的 ASR 選擇分流 sherpa（CPU）／llama-server（GPU） */
const loadLocalAsr = lazyLoad('./asr-select')
const loadLocalLlm = lazyLoad('./local-llm')
const loadEngine = lazyLoad('./engine')
const loadFileTranscribe = lazyLoad('./file-transcribe')
const loadEdgeTts = lazyLoad('./edge-tts')
const loadCloudAsr = lazyLoad('./cloud-asr')
const loadCloudTts = lazyLoad('./cloud-tts')
const loadChatModels = lazyLoad('./chat-models')
const loadChatImages = lazyLoad('./chat-images')
const loadUsage = lazyLoad('./usage')
const loadGpu = lazyLoad('./gpu-capability')
const loadCudaEnv = lazyLoad('./cuda-env')

let agyMod = null
let dictationMod = null
let terminalMod = null
let workspaceMod = null
let explorerMod = null
let breezeMod = null
/** 生圖服務：第一次進生成頁才 require */
let miroxenMod = null
const loadMiroxen = () => {
  miroxenMod ||= require('./miroxen')
  if (store) miroxenMod.setStore(store)
  return miroxenMod
}
let pdfTranslateMod = null
let screenTranslateMod = null

async function loadScreenTranslate() {
  if (!store) await initStore()
  screenTranslateMod ||= require('./screen-translate')
  screenTranslateMod.init({ store, isDev, preload: path.join(__dirname, '../preload/preload.js'), send: sendToPages })
  return screenTranslateMod
}

function assertModelWorkIdle() {
  pdfTranslateMod?.assertIdle()
  screenTranslateMod?.assertIdle()
}

async function loadPdfTranslate() {
  if (!store) await initStore()
  if (!pdfTranslateMod) pdfTranslateMod = require('./pdf-translate')
  pdfTranslateMod.init({ store, send: (channel, payload) => {
    sendToPages(channel, payload)
  } })
  return pdfTranslateMod
}

function loadBreeze() {
  if (!breezeMod) {
    breezeMod = require('./breeze-tts')
    breezeMod.init({ send: (channel, payload) => {
      sendToPages(channel, payload)
    } })
  }
  return breezeMod
}
let sysmonMod = null
let screentimeMod = null
let ccSwitchMod = null
let codeUsageMod = null
let hfModelsMod = null
let backgroundStarted = false
/** @type {Promise<object>|null} */
let storeReady = null

// 主視窗
let mainWindow = null
let pageWindows = null

function sendToPages(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  pageWindows?.broadcast(channel, payload)
}
// 字幕視窗
let subtitleWindow = null
// 系統匣圖示（第一次縮到背景才建立）
let tray = null
// 設定儲存實例（延遲初始化）
let store = null
const mediaPlayer = require('./media-player')
mediaPlayer.setThemeGetter(() => store?.get('theme') || 'dark')
const editorWindow = require('./editor-window')
const browserWindow = require('./browser-window')
mediaPlayer.setEditorOpener((file) => editorWindow.open(file))
editorWindow.registerIpc()
/** 正在執行 before-quit 卸載 */
let isQuitting = false
/** Windows 正在關機／重新開機／登出 */
let sessionEnding = false

// 開發模式判斷
const isDev = !app.isPackaged

dictationHud.configure({ isDev, preload: path.join(__dirname, '../preload/preload.js') })

// 開機自啟動時帶的旗標：靜靜地縮在系統匣，不要跳一扇窗出來
const HIDDEN_FLAG = '--hidden'
// Windows 檔案關聯（點兩下 .md／.json…）：`AxonDeck.exe "--open-file=<路徑>"`，只開編輯視窗、主視窗留在系統匣
const OPEN_FILE_FLAG = '--open-file='
const openFileArg = (argv) => argv.find((a) => typeof a === 'string' && a.startsWith(OPEN_FILE_FLAG))?.slice(OPEN_FILE_FLAG.length) || ''
const startupFile = openFileArg(process.argv)
// 原生播放器「在檔案頁顯示」叫起來的：用檔案頁開那個位置（只在第一次開主視窗時用一次）
const REVEAL_FLAG = '--reveal='
const revealArg = (argv) => argv.find((a) => typeof a === 'string' && a.startsWith(REVEAL_FLAG))?.slice(REVEAL_FLAG.length) || ''
let startupReveal = revealArg(process.argv)
const startHidden = process.argv.includes(HIDDEN_FLAG) || Boolean(startupFile)

// 預覽／CDP 會帶 --user-data-dir。Chromium 有時還沒套到 app.getPath('userData')
// 就先跑到 requestSingleInstanceLock，會跟安裝版搶同一把鎖、視窗直接自己關掉。
const userDataArg = process.argv.find((a) => typeof a === 'string' && a.startsWith('--user-data-dir='))
const userDataDir = (
  (userDataArg ? userDataArg.slice('--user-data-dir='.length) : '')
  || app.commandLine.getSwitchValue('user-data-dir')
  // 專案腳本用 BROWSER 叫起來的（只帶網址、不能帶參數）：交給啟動腳本的那一份
  || (scriptLaunch.urlArg(process.argv) && process.env[scriptLaunch.USER_DATA_ENV])
  || ''
).replace(/^["']|["']$/g, '')
if (userDataDir) app.setPath('userData', userDataDir)
else {
  // 改名 AxonDeck 前的資料夾：設定裡存著指向裡面的絕對路徑，搬了會斷，有就照舊用
  const legacyUserData = path.join(app.getPath('appData'), 'voiceink')
  if (fs.existsSync(legacyUserData)) app.setPath('userData', legacyUserData)
}

/**
 * Windows 的「這扇窗屬於誰」。必須跟 package.json 的 `build.appId` 一字不差——
 * NSIS 產生的捷徑（開始選單／釘選到工作列）上寫的就是這個字串。
 *
 * 不設的話 Windows 會自己從執行檔路徑推一個出來，跟捷徑上的對不起來，工作列就把
 * 「釘選的那顆」和「跑起來的那扇窗」當成兩個程式 → 更新後（安裝程式重開 App，
 * 不是從捷徑點的）會看到兩顆 AxonDeck，而且新長出來那顆沒有圖示（frameless 視窗
 * 沒有自己的 HICON）就是一片白。
 *
 * 排在搶鎖之前：第一扇窗開出去時就得帶著正確的身分。
 */
app.setAppUserModelId('com.voiceink.app')

/**
 * 只准跑一份。
 *
 * 常駐背景之後這不是「保險」而是必要條件：視窗藏起來時再點一次捷徑，
 * 第二份會用同一個埠 autoStart 反代（EADDRINUSE），還會跟第一份搶
 * chats.json／usage.json／agy-logs.db。第二份改成把既有視窗叫出來就好。
 */
// 專案腳本裡的 `start <網址>` 會帶 --axondeck-start 叫一份 AxonDeck 起來（script-launch.js）：
// 不是網址回 3、App 沒在跑回 4，腳本都會改照原樣 start；是網址就照下面交給第一份
const scriptStart = process.argv.includes(scriptLaunch.START_FLAG)
const scriptUrl = scriptLaunch.urlArg(process.argv)
const gotInstanceLock = scriptStart && !scriptUrl
  ? false
  : app.requestSingleInstanceLock({ project: process.env[scriptLaunch.PROJECT_ENV] || '', scriptRun: process.env[scriptLaunch.RUN_ENV] || '' })
const hasInstanceLock = gotInstanceLock && !scriptStart
if (scriptStart && (!scriptUrl || gotInstanceLock)) app.exit(scriptUrl ? 4 : 3)
// 用 app.quit() 而不是 app.exit()：exit 是立刻砍掉自己，會來不及讓「我來過了」這個
// 通知送達第一份，症狀是藏在系統匣時再點捷徑有時叫不出視窗（實測時好時壞）。
else if (!hasInstanceLock) app.quit()
app.on('second-instance', (_event, argv, _cwd, data) => {
  // 專案腳本（BROWSER 或 start）開的網址：開成那個專案的瀏覽器分頁
  const url = scriptLaunch.forwardedUrl(argv.slice(1))
  if (url) return void scriptLaunch.openScriptUrl(url, typeof data?.project === 'string' ? data.project : '',
    typeof data?.scriptRun === 'string' ? data.scriptRun : '')
  const reveal = revealArg(argv)
  if (reveal) return void revealInFiles(reveal)
  const file = openFileArg(argv)
  if (!file) return showMainWindow()
  openFromShell(file)
})

/** 命令列帶來的檔案：編輯器不接的格式（或開失敗）退回叫出主視窗，不吞掉這次點擊 */
function openFromShell(file) {
  if (!app.isReady()) return
  editorWindow.open(file)
    .then((opened) => { if (!opened) showMainWindow() })
    .catch((err) => { console.warn('[editor] open failed:', err?.code || 'OPEN_FAILED'); showMainWindow() })
}

/** 用檔案頁開一個本機位置（新分頁，檔案就選起來）並叫出那扇視窗；路徑不存在就只叫出主視窗 */
async function revealInFiles(raw) {
  if (!app.isReady()) return
  const hit = await require('./terminal/links').resolveCandidate('', raw, { allowUnc: true }).catch(() => null)
  if (!hit || !pageWindows) return showMainWindow()
  try {
    await pageWindows.navigate({ page: 'explorer', action: 'files', full: hit.full, kind: hit.kind })
  } catch { console.warn('[pages] reveal failed') }
  showPageWindow('explorer')
}

/** electron-store 允許的 key（防任意讀寫／XSS 後改 apiUrl 外洩 key） */
const STORE_ALLOWLIST = new Set([
  'translator',
  'translateGlossary',
  'translateGlossaryBuiltin',
  // 文字轉語音的讀音字典：[{ word, sound }]
  'speechPronunciations',
  'captionDisplayMode',
  'screenTranslateDisplayMode',
  'asrEngine',
  'asrApiUrl',
  'asrApiKey',
  'asrModelId',
  // 雲端 ASR 多組設定（可切換）；asrApiUrl／asrApiKey／asrModelId 是搬移前的舊 key，
  // readConfig 的保底還會讀，所以不刪
  'asrClouds',
  'asrCloudId',
  'theme',
  'closeToTray',
  'autoUpdate',
  // Telegram 頁多開的每一格停在哪（網址），renderer 那邊不存 localStorage：
  // 結束走 app.exit()，localStorage 最後幾秒的寫入會掉
  'telegramPanes',
  'subtitleFontScale',
  'subtitleOpacity',
  'subtitleWindowBounds',
  'ttsVoices',
  'ttsRate',
  'localTranslateModel',
  'asrModelKey',
  'chatProviders',
  'cloudProviders',
  'chatProviderId',
  'chatModelId',
  'translateProviderId',
  'translateModelId',
  'chatPrompts',
  'chatPromptId',
  'chatThinking',
  'chatImageOptions',
  // 新對話的取樣參數預設值（每個對話自己那份存在 chats.json）
  'chatParams',
  'sysmonInterval',
  'sysmonSort',
  'sysmonSensors',
  'dictationEnabled',
  'dictationLang',
  // HF模型：資料夾可自選（大模型放不進 C 碟）、同時載入幾顆、開 App 要不要自動起 router。
  // **`hfToken` 刻意不在這裡**：它是機密，只走 `hfmodels:setToken`，renderer 讀不到
  'hfModelsDir',
  'hfModelsMax',
  'hfAutoStart',
  // 轉錄與即時字幕共用 file*／live*（寫任何一邊都會抄到另一邊）。語音輸入各自存
  'fileAsr',
  'fileLlm',
  'liveAsr',
  'liveLlm',
  // 轉錄與即時字幕共用的目標語言。auto＝不翻譯
  'sttLanguage',
  // 字幕音源：system／mic／both，非法值維持原本預設 system。
  'liveAudioSource',
  'recAudioSource',
  'dictationAsr',
  'dictationLlm',
  // 終端機外觀：配色 key、桌布檔名（**檔名不是路徑**，圖片本體在 <userData>/terminal-bg/）、
  // 桌布壓暗程度。色表本身在 renderer 的 `term-themes.js`，這裡只認 key。
  'termTheme',
  'termBgImage',
  'termBgOpacity',
  // 終端機字級（Ctrl+滾輪／Ctrl+加減調的那個）
  'termFontSize'
])

const TRANSLATOR_VALUES = new Set(['cloud', 'local'])
const ASR_ENGINE_VALUES = new Set(['local', 'cloud'])
const THEME_VALUES = new Set(['dark', 'light'])
/** 終端機配色。**要跟 renderer 的 `term-themes.js` 對齊**（那邊才有實際色碼） */
const TERM_THEME_VALUES = new Set(['black', 'app', 'dracula', 'solarized'])

const TRANSLATE_TARGET_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
/** 本地一次送進 8192 ctx 的上限：約 2000 字原文，輸出另留空間 */
const MAX_TRANSLATE_CHARS = 2000
const MAX_CLOUD_TRANSLATE_CHARS = 200000
const DEFAULT_LLM_KEY = 'linguaforge08q4'
const DEFAULT_ASR_MODEL_KEY = 'qwen3asr'
/** 已下架的模型 key → 接替者（讀到舊值就當成新值，不必寫回）；表在 models.js */
const RETIRED_MODEL_KEYS = models.RETIRED_MODEL_KEYS

/** 語音輸入的整理語言（跟翻譯的目標語言同一組） */
const DICTATION_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko'])
/** 轉錄與即時字幕共用。auto＝辨識完不翻譯 */
const STT_LANGS = new Set(['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'auto'])

/**
 * 某一頁的 LLM 選擇：''（不使用）／`local:<llm key>`／`cloud:<供應商 id>:<模型 id>`。
 *
 * 跟聊天／翻譯同一個規矩——只認「目前真的存在」的供應商與模型，
 * 不然刪掉一組供應商之後，這裡還會拿舊的 id 去打別人的端點。
 * @param {import('./model-scope').Scope} scope
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeScopedLlm(scope, raw) {
  // `allProviders` 才看得到「本機模型」那一筆（router 跑著時才有）：
  // 用 `sanitizeProviders` 的話，三個子分頁選了本機模型會在下一次收斂時被清掉
  return modelScope.sanitizeLlm(
    raw,
    chat.allProviders(),
    modelScope.LLM_OPTIONAL[scope]
  )
}

/**
 * @param {unknown} val
 * @returns {number}
 */
function sanitizeTtsRate(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return 0
  return Math.max(-50, Math.min(100, Math.round(n)))
}

/**
 * 終端機桌布壓多暗：0（看不到圖）～100（原圖）。預設 20——桌布是氣氛，
 * 字才是主角，太亮的話一般文字就讀不出來了。
 * @param {unknown} val
 * @returns {number}
 */
function sanitizeBgOpacity(val) {
  // 下限 10 不是 0：0 ＝圖還在卻 `opacity: 0` 整張不畫，看起來就是功能壞掉。
  // 低於下限當成「沒設定過」回預設（值要跟 `term-themes.js` 的
  // MIN_TERM_BG_OPACITY／DEFAULT_TERM_BG_OPACITY 對齊）。
  const n = Math.round(Number(val))
  if (!Number.isFinite(n) || n < 10) return 45
  return Math.min(100, n)
}

/**
 * 終端機字級。太小看不到、太大一行塞不下幾個字，兩邊都夾住。
 * @param {unknown} val
 * @returns {number}
 */
function sanitizeFontSize(val) {
  const n = Number(val)
  if (!Number.isFinite(n)) return 17
  return Math.max(8, Math.min(40, Math.round(n)))
}

/**
 * 只為第一扇窗底色讀 theme，不載 electron-store。
 * @returns {'dark'|'light'}
 */
function peekTheme() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'))
    return raw?.theme === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * 第一次用到 AGY 才載模組並開 SQLite。
 * @returns {Promise<object>}
 */
async function loadAgy() {
  await initStore()
  if (!agyMod) {
    agyMod = require('./agy')
    agyMod.configure({ userDataPath: app.getPath('userData'), store })
  }
  return agyMod
}

/**
 * 語音辨識的共用入口。scope 決定讀哪一頁的選擇（三頁各存一份），
 * 本地再由 `asr-select` 依那一頁選的模型分流。scope 由呼叫點決定，
 * **不接受 renderer 傳進來**。
 * @param {import('./model-scope').Scope} scope
 * @param {{ samples: unknown, sampleRate?: number, lang?: string }} req
 * @returns {Promise<string>}
 */
async function transcribeSamples(scope, req) {
  if (!store) await initStore()
  if (modelScope.readAsr(store, scope).engine === 'cloud') {
    return loadCloudAsr().transcribeSamples(req || {}, store, scope)
  }
  return loadLocalAsr().transcribe(scope, req)
}

/**
 * 第一次用到語音輸入才載模組（會 require 低階鍵盤 hook 的原生模組）。
 * @returns {Promise<object>}
 */
async function loadDictation() {
  await initStore()
  if (!dictationMod) {
    dictationMod = require('./dictation')
    dictationMod.setStore(store)
    dictationMod.configure({
      emit: (payload) => {
        sendToPages('dictation:event', payload)
      },
      transcribe: (req) => transcribeSamples('dictation', req)
    })
  }
  return dictationMod
}

/**
 * 第一次用到終端機才載模組（node-pty 是原生模組，不該擋啟動）。
 * @returns {object}
 */
function loadTerminal() {
  if (!terminalMod) {
    terminalMod = require('./terminal/service')
    terminalMod.setEmitter((channel, payload) => {
      sendToPages(channel, payload)
    })
    terminalMod.setNotifier(notifyAgent)
  }
  return terminalMod
}

/**
 * 第一次進工作區才載模組（會讀使用者的專案資料夾與 agent 記錄，不該擋啟動）。
 * @returns {object}
 */
function loadWorkspace() {
  if (!workspaceMod) workspaceMod = require('./workspace')
  return workspaceMod
}

/**
 * 整機檔案總管。第一次進「檔案」頁才載（會掃磁碟與找 UFFS）。
 * @returns {object}
 */
function loadExplorer() {
  if (!explorerMod) {
    explorerMod = require('./explorer')
    explorerMod.configure({
      userDataPath: app.getPath('userData'),
      send: (channel, payload) => {
        sendToPages(channel, payload)
      }
    })
  }
  return explorerMod
}

/**
 * 第一次進 Claude Code 頁才載模組（會讀使用者家目錄的設定檔，不該擋啟動）。
 * @returns {object}
 */
function loadCcSwitch() {
  if (!ccSwitchMod) {
    ccSwitchMod = require('./ccswitch')
    ccSwitchMod.configure({
      userDataPath: app.getPath('userData'),
      // OAuth 登入要把使用者帶去系統瀏覽器；只放行我們自己組出來的 https 授權網址
      openExternal: (url) => {
        if (typeof url === 'string' && url.startsWith('https://')) void shell.openExternal(url)
      },
      // AGY 反代可以當成一家供應商：切過去時要讀它的位址／金鑰、必要時把它開起來
      getAgy: () => loadAgy()
    })
  }
  return ccSwitchMod
}

/**
 * 第一次看用量統計才載模組（會掃 GB 等級的本機 session 記錄，不該擋啟動）。
 * @returns {object}
 */
function loadCodeUsage() {
  if (!codeUsageMod) {
    codeUsageMod = require('./codeusage')
    codeUsageMod.configure({ userDataPath: app.getPath('userData') })
  }
  return codeUsageMod
}

/**
 * 使用時長：開機就導入 Tai 資料並開始記，不必等使用者點開系統監控頁。
 * @returns {object}
 */
function loadScreentime() {
  if (!screentimeMod) {
    screentimeMod = require('./screentime').createScreentimeService({
      userDataPath: app.getPath('userData')
    })
  }
  return screentimeMod
}

/**
 * 系統監控：開機就載（取樣器常駐，進頁才有現成讀數）。
 * @returns {object}
 */
function loadSysmon() {
  if (!sysmonMod) {
    sysmonMod = require('./sysmon').createSysmonService()
    sysmonMod.setEmitter((payload) => {
      sendToPages('sysmon:event', payload)
    })
  }
  // 每次都重帶：風扇設定要 store，而 loadSysmon 可能比 initStore 早發生
  sysmonMod.configure({
    store: store || undefined,
    userDataPath: app.getPath('userData'),
    packaged: app.isPackaged
  })
  return sysmonMod
}

/**
 * 「HF模型」服務。第一次用到才 require——它會拉進 llama.cpp router 那一整串。
 * @returns {object}
 */
function loadHfModels() {
  if (!hfModelsMod) {
    hfModelsMod = require('./hfmodels')
    hfModelsMod.init({
      userDataPath: app.getPath('userData'),
      store: store || undefined,
      onEvent: (payload) => {
        sendToPages('hfmodels:event', payload)
      }
    })
  }
  // store 可能比第一次呼叫還晚好（IPC 進得來的時間點不保證）
  if (store) hfModelsMod.setStore(store)
  return hfModelsMod
}

/**
 * 讓聊天看得到「本機模型」。
 *
 * **只在 router 已經跑著時才回東西**：`localSource` 不可以自己去啟動 router，
 * 那會讓「打開聊天頁」變成「載入一顆 20GB 的模型」。真的要用時
 * `chat.send` 會走 `ensureLocalModel` 把它叫起來。
 */
function wireChatLocalProvider() {
  chat.setLocalSource(
    () => {
      if (!hfModelsMod) return null
      const endpoint = hfModelsMod.endpoint()
      if (!endpoint) return null
      return { ...endpoint, models: hfLocalModelIds }
    },
    async (modelId) => {
      try {
        await loadHfModels().ensureRuntime()
        return await loadHfModels().loadModel(modelId)
      } catch {
        return false
      }
    }
  )
}

/**
 * router 現在有哪幾顆模型可以用（含還沒載入的——選了才載）。
 * 用快取而不是每次去問：`chat.readConfig` 是同步的，而問 router 要走 HTTP。
 * @type {string[]}
 */
let hfLocalModelIds = []

/**
 * @returns {Promise<string[]>}
 */
async function refreshHfLocalModels() {
  if (!hfModelsMod || !hfModelsMod.runtimeStatus().running) {
    hfLocalModelIds = []
    return hfLocalModelIds
  }
  try {
    const rows = await hfModelsMod.refreshModels()
    hfLocalModelIds = rows.map((row) => String(row?.id || '')).filter(Boolean)
  } catch {
    hfLocalModelIds = []
  }
  return hfLocalModelIds
}

/**
 * 第一幀出來之後才自動接續反代，不跟開窗搶磁碟。
 */
function scheduleBackgroundServices() {
  if (backgroundStarted) return
  backgroundStarted = true
  initStore()
    .then(() => {
      // 語音輸入的熱鍵要在背景也活著（使用者多半是在別的程式裡按右 Alt）
      if (store.get('dictationEnabled') === true) {
        loadDictation()
          .then((d) => {
            // refresh 是 async（原生熱鍵 sidecar 要等它回 READY），失敗只記錄不影響其他功能
            void d.refresh().catch((err) => console.warn('[dictation] refresh failed:', err?.message || err))
            // 指示器視窗先建好（維持隱藏）：第一次按右 Alt 才不會先看到一扇空白視窗
            dictationHud.warm()
          })
          .catch((err) => console.warn('[dictation] autoStart failed:', err?.message || err))
      }
      // 閘道沒有手動開關了：目前那家要經閘道就跟著 App 一起開，不然 Claude Code 連不上
      void loadCcSwitch().autoStartGateway()
        .catch((err) => console.warn('[ccswitch] gateway autoStart failed:', err?.code || err?.message))
      if (store.get('agyEnabled') !== true) return { ok: false, error: 'DISABLED' }
      return loadAgy().then((service) => service.autoStart())
    })
    .then((result) => {
      if (result && !result.ok && result.error !== 'DISABLED') {
        console.warn('[agy] autoStart failed:', result.error)
      }
    })
    .catch((err) => console.warn('[agy] autoStart error:', err?.code || err?.message))
}

/**
 * 字幕視窗位置／大小。
 * 這個值直接餵進 `new BrowserWindow()`，來源有兩個——renderer 的 `store:set`，
 * 以及使用者可以手改的設定檔——所以寫入與讀取兩邊都要過這裡：
 * 非有限數（NaN／字串／null）會讓 Electron 建出看不見或超大的視窗。
 * x／y 保留 undefined 代表「交給系統置中」。
 * @param {unknown} raw
 * @returns {{ width: number, height: number, x: number|undefined, y: number|undefined }}
 */
function sanitizeSubtitleBounds(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const clamp = (value, fallback, min, max) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.round(n)))
  }
  const coord = (value) => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.round(n) : undefined
  }
  return {
    width: clamp(src.width, 800, 200, 8000),
    height: clamp(src.height, 200, 80, 8000),
    x: coord(src.x),
    y: coord(src.y)
  }
}

/**
 * 初始化 electron-store（ESM 模組需要動態 import）
 */
async function initStore() {
  if (store) return store
  if (!storeReady) {
    storeReady = (async () => {
      const Store = (await import('electron-store')).default
      store = new Store()
      if (!store.has('cloudProviders') && !store.has('chatProviders') && !store.has('asrClouds')
        && !['chatApiUrl', 'chatApiKey', 'chatModels', 'asrApiUrl', 'asrApiKey', 'asrModelId', 'apiUrl', 'apiKey', 'modelId'].some((key) => store.has(key))) {
        require('./cloud-providers').write(store, require('./cloud-providers').read(store))
      }
      migrateChatSystemPrompt()
      migrateChatProviders()
      chat.setStore(store)
      wireChatLocalProvider()
      migrateTranslateProvider()
      migrateAsrClouds(await loadCloudAsr())
      // 三個子分頁各自的模型選擇：舊版只有一組全域設定，第一次啟動時拿它當起點
      modelScope.seedFromLegacy(store)
      // 語音辨識執行緒的選項已移除（一律「自動」）：舊值留著會讓 sherpa 永遠鎖在
      // 使用者當年隨手選的數字，而且畫面上再也沒有地方看得到
      if (store.has('asrThreads')) store.delete('asrThreads')
      bootLog('store ready')
      return store
    })()
  }
  return storeReady
}

/**
 * 一次性搬移：舊版單一 `chatSystemPrompt` → 多組 `chatPrompts` 的第一筆。
 * 搬完刪掉舊 key，之後只讀 chatPrompts / chatPromptId。
 */
function migrateChatSystemPrompt() {
  const legacy = String(store.get('chatSystemPrompt', '') || '').trim()
  if (!legacy) {
    if (store.has('chatSystemPrompt')) store.delete('chatSystemPrompt')
    return
  }
  const existing = chat.sanitizePrompts(store.get('chatPrompts', []))
  if (!existing.length) {
    const prompt = { id: 'p_legacy', name: '預設提示', content: legacy }
    store.set('chatPrompts', [prompt])
    store.set('chatPromptId', prompt.id)
    console.log('[chat] 已將舊的 chatSystemPrompt 搬移為系統提示 preset')
  }
  store.delete('chatSystemPrompt')
}

/**
 * 一次性搬移：舊版單組 `chatApiUrl`／`chatApiKey`／`chatModels` → `chatProviders` 的第一筆。
 * 寫入成功才刪舊 key，中途失敗不會兩邊都沒有。
 */
function migrateChatProviders() {
  const legacyKeys = ['chatApiUrl', 'chatApiKey', 'chatModels']
  const hasLegacy = legacyKeys.some((key) => store.has(key))
  if (!hasLegacy) return

  const existing = chat.sanitizeProviders(store.get('chatProviders', []))
  if (!existing.length) {
    const provider = chat.providerFromLegacy(
      store.get('chatApiUrl', ''),
      store.get('chatApiKey', ''),
      store.get('chatModels', [])
    )
    if (provider) {
      store.set('chatProviders', [provider])
      store.set('chatProviderId', provider.id)
      const currentModel = String(store.get('chatModelId', '') || '')
      if (!provider.models.includes(currentModel)) store.set('chatModelId', provider.models[0] || '')
      console.log('[chat] 已將舊的單組聊天設定搬移為供應商')
    }
  }
  for (const key of legacyKeys) if (store.has(key)) store.delete(key)
}

/**
 * 一次性搬移：舊版獨立的雲端翻譯設定（`apiUrl`／`apiKey`／`modelId`）
 * → `chatProviders` 裡的一組。翻譯與聊天都是 OpenAI 相容的 chat completions，
 * 沒有理由讓同一組網址與金鑰在設定頁出現兩次。
 *
 * 網址與金鑰都一樣的供應商已經存在就直接沿用，不重複建一組。
 */
function migrateTranslateProvider() {
  const legacyKeys = ['apiUrl', 'apiKey', 'modelId']
  if (!legacyKeys.some((key) => store.has(key))) return

  const apiUrl = String(store.get('apiUrl', '') || '').trim()
  const apiKey = String(store.get('apiKey', '') || '').trim()
  const modelId = String(store.get('modelId', '') || '').trim()

  if (apiKey && /^https?:\/\//i.test(apiUrl)) {
    const providers = chat.sanitizeProviders(store.get('chatProviders', []))
    let target = providers.find((p) => p.apiUrl === apiUrl && p.apiKey === apiKey)
    if (!target) {
      target = { id: 'p_legacy_tr', name: '翻譯', apiUrl, apiKey, models: [], imageModels: [] }
      providers.push(target)
    }
    if (modelId && !target.models.includes(modelId)) target.models.push(modelId)
    const list = chat.sanitizeProviders(providers)
    store.set('chatProviders', list)
    const saved = list.find((p) => p.id === target.id) || list[0]
    if (saved) {
      store.set('translateProviderId', saved.id)
      store.set('translateModelId', saved.models.includes(modelId) ? modelId : (saved.models[0] || ''))
    }
    console.log('[translate] 已將舊的雲端翻譯設定併入聊天供應商清單')
  }
  for (const key of legacyKeys) if (store.has(key)) store.delete(key)
}

/**
 * 雲端 ASR 多組設定的起點：還沒有 `asrClouds` 時才搬舊的單組設定。
 * 已存在的空清單代表使用者刪光了，不可再搬回舊 Key。
 */
function migrateAsrClouds(asrCloudMod) {
  const existing = asrCloudMod.sanitizeAsrClouds(store.get('asrClouds', []))
  if (store.has('asrClouds')) {
    // 已經有清單了，但可能還是舊形狀（單一 `modelId`）。sanitize 會把它讀成只有一顆的
    // `models` 陣列，這裡寫回去——不寫的話 renderer 直接讀 store 會看到沒有 models 的列，
    // 功能頁的雲端選項就整個不見了（實測踩過）
    store.set('asrClouds', existing)
    return
  }
  const seed = asrCloudMod.asrCloudsFromLegacy(
    store.get('asrApiUrl', ''),
    store.get('asrApiKey', ''),
    store.get('asrModelId', '')
  )
  if (!seed.length) return
  store.set('asrClouds', seed)
  store.set('asrCloudId', seed[0].id)
}

/**
 * 目前翻譯供應商的模型清單（`translateProviderId` 失效時退回第一組）
 * @returns {string[]}
 */
function translateProviderModels() {
  const list = chat.textProviders()
  const wanted = String(store.get('translateProviderId', '') || '')
  return (list.find((p) => p.id === wanted) || list[0])?.models || []
}

/**
 * 供應商清單變動後把「選了哪一組／哪一顆」收斂回合法值
 * @param {Array<{ id: string, models: string[] }>} list
 * @param {string} providerKey
 * @param {string} modelKey
 */
function reconcileProviderSelection(list, providerKey, modelKey) {
  const wanted = String(store.get(providerKey, '') || '')
  // 選著「本機模型」的時候不要動它：那一筆只有 router 跑著才在清單裡，
  // 收斂掉的話「編輯任何一組雲端供應商」就會順手把使用者的本機模型選擇改掉
  if (wanted === chat.LOCAL_PROVIDER_ID) return
  const active = list.find((p) => p.id === wanted) || list[0] || null
  store.set(providerKey, active?.id || '')
  const model = String(store.get(modelKey, '') || '')
  if (!active?.models.includes(model)) store.set(modelKey, active?.models[0] || '')
}

/**
 * 依主題決定視窗底色（frameless 避免淺色主題閃黑）
 * @returns {string}
 */
function mainBackgroundColor() {
  const theme = store ? store.get('theme', 'dark') : peekTheme()
  return theme === 'light' ? '#f5f5f5' : '#1a1a1a'
}

/**
 * 僅允許主視窗呼叫的 window 控制
 * @param {Electron.IpcMainInvokeEvent} event
 */
function assertMainWindowSender(event) {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return (event.sender === mainWindow.webContents || pageWindows?.owns(event.sender))
    && event.senderFrame === event.sender.mainFrame
}

/** 關視窗要不要留在背景（反代不中斷）。預設開，隨時可在設定關掉。 */
function closeToTrayEnabled() {
  return store ? store.get('closeToTray', true) === true : true
}

/** 把主視窗叫回前景；被關掉過就重建 */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/** App 圖示（系統匣、工作列、Alt+Tab 共用一份） */
const APP_ICON = path.join(__dirname, '../../assets/icon.ico')

/**
 * 系統匣圖示。第一次縮到背景才建立——沒有常駐需求時不該多一顆圖示。
 * 視窗藏起來後，這是唯一能叫回來或真的結束的入口，所以兩個項目都必須有。
 */
function ensureTray() {
  if (tray) return
  const icon = nativeImage.createFromPath(APP_ICON)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('AxonDeck（背景執行中）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示 AxonDeck', click: showMainWindow },
    { type: 'separator' },
    { label: '結束 AxonDeck', click: () => app.quit() }
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
}

/**
 * 建立主視窗（frameless：標題列合併進 app header）
 */
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    title: 'AxonDeck',
    // frameless 視窗沒有系統框，Windows 拿不到視窗圖示 → 工作列／Alt+Tab 會是一片白
    icon: APP_ICON,
    // Windows：保留 thickFrame 以支援邊緣縮放與陰影（勿關）
    thickFrame: true,
    hasShadow: true,
    transparent: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 工作區的內建瀏覽器用 <webview>（比照 Orca）。**只開在主視窗**：
      // 字幕視窗與 HUD 用不到，少一扇視窗多吃一個能力。
      webviewTag: true,
      spellcheck: false,
      preload: path.join(__dirname, '../preload/preload.js')
    },
    backgroundColor: mainBackgroundColor(),
    autoHideMenuBar: true,
    show: !startHidden
  })
  if (startHidden) ensureTray()

  // 隱藏 File/Edit/View… 系統選單列
  mainWindow.setMenu(null)
  pageWindows = require('./page-windows').createPageWindows({
    main: mainWindow, isDev, icon: APP_ICON, background: mainBackgroundColor,
    secure: attachWindowSecurity, hidden: startHidden
  })

  mainWindow.once('ready-to-show', () => {
    bootLog('ready-to-show')
    scheduleBackgroundServices()
  })
  mainWindow.webContents.once('did-finish-load', () => {
    bootLog('did-finish-load')
    scheduleBackgroundServices()
    pageWindows.navigate({ page: 'chat' }).catch(() => console.error('[pages] 初始頁面載入失敗')).then(() => {
      // 要排在第一頁之後：功能頁切換以最後一次為準，先導過去會被這裡的 chat 蓋掉
      if (startupReveal) void revealInFiles(startupReveal)
      startupReveal = ''
    })
  })

  // 載入頁面（先掛事件，避免 loadFile 太快把 ready-to-show 漏掉）
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173/?host=1')
    if (!startHidden) mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { host: '1' } })
  }

  const sendMaximized = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  attachWindowSecurity(mainWindow)

  // 插拔隨身碟／手機：Windows 把 WM_DEVICECHANGE 廣播給所有頂層視窗（藏起來的也收得到），
  // 不用輪詢。一次插拔會連來好幾則，等 1.5 秒安靜了（手機的 MTP 也掛好了）再通知檔案頁。
  let deviceTimer = null
  mainWindow.hookWindowMessage(0x0219, () => {
    clearTimeout(deviceTimer)
    deviceTimer = setTimeout(() => {
      sendToPages('explorer:devicesChanged')
    }, 1500)
  })

  // 關視窗 ≠ 結束：藏起來讓 AGY 反代繼續服務，真正的結束走系統匣選單。
  // isQuitting 這條一定要留——before-quit 會走到 app.exit()，但 app.quit() 途中
  // 若還攔著關窗，就變成永遠關不掉。
  mainWindow.on('close', (event) => {
    if (isQuitting || !closeToTrayEnabled()) return
    event.preventDefault()
    ensureTray()
    mainWindow.hide()
  })

  // Windows 關機／登出：結束流程照走，但不要順手開安裝程式（會被砍在半路，見 updater.installOnQuit）
  mainWindow.on('query-session-end', () => { sessionEnding = true })
  mainWindow.on('session-end', () => { sessionEnding = true })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (subtitleWindow) {
      subtitleWindow.close()
    }
    // 錄音在主視窗那一側，主視窗沒了就不可能還在錄——指示器留著只會浮在桌面上
    dictationHud.close()
  })
}

/**
 * 外連留在 App 裡：交給 chat 頁開成專案瀏覽器分頁（放哪個專案由 renderer 決定），
 * 把那個視窗叫到前面。功能頁還沒建好或開不起來才退回系統瀏覽器。
 * @param {string} url 已確認是 http(s)
 * @param {string} [project] 要開在哪個專案（專案腳本開的網址）；空字串＝目前的專案
 * @param {'' | 'browser'} [target] 'browser'＝從 AI 頁以外點的（Telegram 等），開在 Browser 模式
 */
function openInProjectBrowser(url, project = '', target = '', sourceGuestId = 0) {
  const outside = () => {
    if (project) {
      void dialog.showMessageBox({ type: 'error', title: '專案瀏覽器', message: '專案瀏覽器開啟失敗，請回到專案後再試一次' })
      return
    }
    shell.openExternal(url).catch(() => {})
  }
  if (!pageWindows) return outside()
  return pageWindows.navigate({ page: 'chat', action: 'browser', full: url, project, target, sourceGuestId })
    .then(() => showPageWindow('chat')).catch(outside)
}

/** 把某個功能頁所在的那扇視窗（主視窗或它彈出去的獨立視窗）叫到前面 */
function showPageWindow(page) {
  const win = pageWindows?.host(pageWindows.contents(page))
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}
scriptLaunch.setOpenUrl(openInProjectBrowser)

/**
 * 在哪裡點就開在哪裡：AI 頁自己（含裡面的 webview）交給它依主區決定，其他頁一律開在 Browser 模式
 * @param {Electron.WebContents} contents
 * @returns {'' | 'browser'}
 */
function linkTarget(contents) {
  const chat = pageWindows?.contents('chat')
  return chat && (contents === chat || contents.hostWebContents === chat) ? '' : 'browser'
}

/** @param {string} url */
function isWebUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch { return false }
}

/**
 * 禁止任意導覽／開窗；外連改開專案瀏覽器分頁
 * @param {BrowserWindow} win
 */
function attachWindowSecurity(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) openInProjectBrowser(url, '', linkTarget(win.webContents))
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    try {
      const target = new URL(url)
      const current = new URL(win.webContents.getURL())
      if (isDev && target.origin === 'http://localhost:5173') return
      // 只有同一份 App 頁面能保留 preload；任意本機 HTML 也不可信。
      if (target.protocol === 'file:' && target.origin === current.origin
        && target.host === current.host && target.pathname === current.pathname) return
    } catch { /* 無效導覽一律拒絕 */ }
    event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event, preferences, params) => {
    // 不接受 renderer 自帶的 preload 或關閉沙箱選項。
    delete preferences.preload
    delete preferences.preloadURL
    Object.assign(preferences, { nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false })
    try {
      const url = new URL(params.src)
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.href === 'about:blank') return
      // 插件頁與管理頁只開在瀏覽器分區；renderer 仍不得自行掛 preload。
      if (params.partition === 'persist:wsbrowser' && (require('../shared/browser-url.mjs').isExtensionManagerUrl(url.href)
        || (url.protocol === 'chrome-extension:' && session.fromPartition(params.partition).extensions.getExtension(url.hostname)))) return
    } catch { /* 無效網址一律拒絕 */ }
    event.preventDefault()
  })
}

/**
 * 儲存的視窗位置是否仍落在某個螢幕的可視範圍內（外接螢幕拔除後座標會失效）
 */
function isBoundsOnScreen(bounds) {
  if (bounds.x === undefined || bounds.y === undefined) return true
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea
    return (
      bounds.x < wa.x + wa.width &&
      bounds.x + bounds.width > wa.x &&
      bounds.y < wa.y + wa.height &&
      bounds.y + bounds.height > wa.y
    )
  })
}

/**
 * 建立懸浮字幕視窗
 */
function createSubtitleWindow() {
  // 取得儲存的位置
  // 設定檔可能是舊版寫的或被手改壞，讀取時同樣要過一次校驗
  const bounds = sanitizeSubtitleBounds(store ? store.get('subtitleWindowBounds', null) : null)

  // 座標已不在任何螢幕內（拔掉外接螢幕）→ 回到置中，避免視窗開在看不見的地方
  if (!isBoundsOnScreen(bounds)) {
    bounds.x = undefined
    bounds.y = undefined
  }

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a1a',
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, '../preload/preload.js')
    }
  })
  subtitleWindow = win

  // 強制移除選單，避免出現白色選單列
  subtitleWindow.setMenu(null)
  attachWindowSecurity(subtitleWindow)

  if (isDev) {
    subtitleWindow.loadURL('http://localhost:5173/pages/subtitle.html')
  } else {
    subtitleWindow.loadFile(path.join(__dirname, '../renderer/pages/subtitle.html'))
  }

  // 儲存視窗位置
  subtitleWindow.on('moved', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  subtitleWindow.on('resized', () => {
    if (store && subtitleWindow) {
      const bounds = subtitleWindow.getBounds()
      store.set('subtitleWindowBounds', bounds)
    }
  })

  win.on('closed', () => {
    // subtitle:close 會先同步把 subtitleWindow 設 null；此處仍 === win 代表是 OS 層關閉
    // （Alt+F4／主視窗連帶關閉），需通知 renderer 停止擷取，否則管線在無視窗下空轉
    if (subtitleWindow !== win) return
    subtitleWindow = null
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToPages('subtitle:closed')
    }
  })
}

// ===== IPC 處理器 =====

// 設定相關
ipcMain.handle('store:get', async (event, key, defaultValue) => {
  if (typeof key !== 'string' || !STORE_ALLOWLIST.has(key)) {
    throw new Error(`不允許的設定鍵: ${key}`)
  }
  if (!store) await initStore()
  if (key === 'cloudProviders') return require('./cloud-providers').read(store)
  const val = store.get(key, defaultValue)
  if (key === 'ttsVoices') return sanitizeTtsVoices(val)
  if (key === 'ttsRate') return sanitizeTtsRate(val)
  if (key === glossary.KEY) return glossary.read(store)
  if (key === glossary.BUILTIN_KEY) return val !== false
  if (key === 'translator') {
    return TRANSLATOR_VALUES.has(val) ? val : (TRANSLATOR_VALUES.has(defaultValue) ? defaultValue : 'local')
  }
  if (key === 'asrEngine') {
    return ASR_ENGINE_VALUES.has(val) ? val : (ASR_ENGINE_VALUES.has(defaultValue) ? defaultValue : 'local')
  }
  if (key === 'localTranslateModel') {
    const migrated = RETIRED_MODEL_KEYS[val] || val
    return models.isLlmKey(migrated)
      ? migrated
      : (models.isLlmKey(defaultValue) ? defaultValue : DEFAULT_LLM_KEY)
  }
  if (key === 'asrModelKey') {
    return models.isAsrKey(val) ? val : DEFAULT_ASR_MODEL_KEY
  }
  if (key === 'autoUpdate') {
    return val !== false
  }
  if (key === 'theme') {
    return THEME_VALUES.has(val) ? val : (THEME_VALUES.has(defaultValue) ? defaultValue : 'dark')
  }
  if (key === 'chatProviders') return chat.sanitizeProviders(val)
  if (key === 'chatProviderId') {
    // 「本機模型」永遠算合法：它只有在 router 跑著時才出現在清單裡，
    // 用清單判斷的話「關掉 router → 選擇被改成別家 → 重開也回不來」
    if (val === chat.LOCAL_PROVIDER_ID) return val
    const list = chat.sanitizeProviders(store.get('chatProviders', []))
    return list.some((p) => p.id === val) ? val : (list[0]?.id || '')
  }
  if (key === 'chatModelId') {
    // 只認「目前這個供應商」的清單——跨供應商沿用會拿 A 的模型名打 B 的端點
    const models = chat.readProvider()?.models || []
    return models.includes(val) ? val : (models[0] || '')
  }
  if (key === 'translateProviderId') {
    if (val === chat.LOCAL_PROVIDER_ID) return val
    const list = chat.textProviders()
    return list.some((p) => p.id === val) ? val : (list[0]?.id || '')
  }
  if (key === 'translateModelId') {
    const models = translateProviderModels()
    return models.includes(val) ? val : (models[0] || '')
  }
  if (key === 'chatPrompts') return chat.sanitizePrompts(val)
  if (key === 'chatPromptId') {
    const list = chat.sanitizePrompts(store.get('chatPrompts', []))
    return list.some((p) => p.id === val) ? val : ''
  }
  if (key === 'termTheme') return TERM_THEME_VALUES.has(val) ? val : 'black'
  if (key === 'termBgImage') return termBackground.sanitizeName(val)
  if (key === 'termBgOpacity') return sanitizeBgOpacity(val)
  if (key === 'termFontSize') return sanitizeFontSize(val)
  if (key === 'chatThinking') return chatParams.sanitizeThinking(val)
  if (key === 'chatImageOptions') return chatParams.sanitizeImageOptions(val)
  if (key === 'chatParams') return chatParams.sanitize(val)
  if (key === 'dictationEnabled') return val === true
  if (key === 'dictationLang') return DICTATION_LANGS.has(val) ? val : 'zh-TW'
  if (key === 'liveAudioSource') return ['mic', 'both'].includes(val) ? val : 'system'
  if (key === 'recAudioSource') return ['system', 'both'].includes(val) ? val : 'mic'
  if (key === 'sttLanguage') return STT_LANGS.has(val) ? val : 'zh-TW'
  if (key === 'fileAsr' || key === 'liveAsr' || key === 'dictationAsr') {
    // 帶著雲端 ASR 設定清單去驗：不帶的話 `cloud:<設定>:<模型>` 會被當成不認得而降級
    return modelScope.sanitizeAsr(val, modelScope.cloudsOf(store))
  }
  if (key === 'fileLlm') return sanitizeScopedLlm('file', val)
  if (key === 'liveLlm') return sanitizeScopedLlm('live', val)
  if (key === 'dictationLlm') return sanitizeScopedLlm('dictation', val)
  // closeToTray 預設開：使用者要的就是「關掉視窗反代不斷」，沒設定過時不該退回關閉
  if (key === 'closeToTray') return val !== false
  return val
})

ipcMain.handle('store:set', async (event, key, value) => {
  if (typeof key !== 'string' || !STORE_ALLOWLIST.has(key)) {
    throw new Error(`不允許的設定鍵: ${key}`)
  }
  if (!store) await initStore()
  if (key === 'cloudProviders') {
    const { chatProviders, asrClouds } = require('./cloud-providers').write(store, value)
    reconcileProviderSelection(chatProviders, 'chatProviderId', 'chatModelId')
    reconcileProviderSelection(chat.textProviders(chatProviders), 'translateProviderId', 'translateModelId')
    const activeAsr = store.get('asrCloudId', '')
    store.set('asrCloudId', asrClouds.some((p) => p.id === activeAsr) ? activeAsr : (asrClouds[0]?.id || ''))
    modelScope.reconcileAll(store)
    return true
  }
  // ttsVoices 深度校驗（五語 + allowlist shortName）
  if (key === 'ttsVoices') {
    store.set(key, sanitizeTtsVoices(value))
    return true
  }
  if (key === 'speechPronunciations') {
    const clean = (v) => typeof v === 'string' ? v.trim().slice(0, 50) : ''
    const list = Array.isArray(value) ? value.slice(0, 200).map((item) => ({ word: clean(item?.word), sound: clean(item?.sound) })) : []
    store.set(key, list.filter((item) => item.word && item.sound))
    return true
  }
  if (key === 'ttsRate') {
    store.set(key, sanitizeTtsRate(value))
    return true
  }
  if (key === glossary.KEY) {
    // null＝恢復內建清單
    const text = glossary.sanitize(value)
    if (text === null) store.delete(key)
    else store.set(key, text)
    return true
  }
  if (key === glossary.BUILTIN_KEY) {
    store.set(key, value !== false)
    return true
  }
  if (key === 'translator') {
    const t = TRANSLATOR_VALUES.has(value) ? value : 'local'
    store.set(key, t)
    return true
  }
  if (key === 'asrEngine') {
    const e = ASR_ENGINE_VALUES.has(value) ? value : 'local'
    store.set(key, e)
    return true
  }
  if (key === 'localTranslateModel') {
    const migrated = RETIRED_MODEL_KEYS[value] || value
    store.set(key, models.isLlmKey(migrated) ? migrated : DEFAULT_LLM_KEY)
    return true
  }
  if (key === 'asrModelKey') {
    store.set(key, models.isAsrKey(value) ? value : DEFAULT_ASR_MODEL_KEY)
    return true
  }
  if (key === 'theme') {
    const t = THEME_VALUES.has(value) ? value : 'dark'
    store.set(key, t)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setBackgroundColor(t === 'light' ? '#f5f5f5' : '#1a1a1a')
    }
    return true
  }
  if (key === 'termTheme') {
    store.set(key, TERM_THEME_VALUES.has(value) ? value : 'black')
    return true
  }
  if (key === 'termBgImage') {
    // renderer 只送得回 `terminal:pickBackground` 給它的檔名；別的一律變成「沒有桌布」
    store.set(key, termBackground.sanitizeName(value))
    return true
  }
  if (key === 'termBgOpacity') {
    store.set(key, sanitizeBgOpacity(value))
    return true
  }
  if (key === 'termFontSize') {
    store.set(key, sanitizeFontSize(value))
    return true
  }
  if (key === 'asrApiUrl') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'asrModelId') {
    store.set(key, typeof value === 'string' ? value.trim() : value)
    return true
  }
  if (key === 'autoUpdate') {
    const on = value === true
    store.set(key, on)
    updater.configure({ autoUpdate: on })
    return true
  }
  if (key === 'asrClouds') {
    const cloudAsr = await loadCloudAsr()
    const list = cloudAsr.sanitizeAsrClouds(value)
    store.set(key, list)
    // 清單變動後當前選用可能已被刪掉 → 收斂，否則 readConfig 會退回第一筆而 UI 不知道
    const cur = String(store.get('asrCloudId', '') || '')
    store.set('asrCloudId', list.some((c) => c.id === cur) ? cur : (list[0]?.id || ''))
    // 三個子分頁各自選的「哪一組設定的哪一顆模型」也要跟著收斂（同 chatProviders 那條）
    modelScope.reconcileAll(store)
    return true
  }
  if (key === 'asrCloudId') {
    const cloudAsr = await loadCloudAsr()
    const list = cloudAsr.sanitizeAsrClouds(store.get('asrClouds', []))
    const active = list.find((c) => c.id === value) || list[0] || null
    store.set(key, active?.id || '')
    return true
  }
  if (key === 'chatProviders') {
    const list = chat.sanitizeProviders(value)
    store.set(key, list)
    // 供應商可能被刪掉或改名 → 選取與模型都要跟著收斂，否則聊天請求會被自己的驗證擋下。
    // 翻譯用的是同一份清單，所以兩組選擇都要收
    reconcileProviderSelection(list, 'chatProviderId', 'chatModelId')
    reconcileProviderSelection(chat.textProviders(list), 'translateProviderId', 'translateModelId')
    // 三個子分頁的 LLM 選擇都是「供應商 id + 模型 id」的字串，同樣可能指到已刪掉的那一組
    modelScope.reconcileAll(store)
    return true
  }
  if (key === 'chatProviderId' || key === 'translateProviderId') {
    const list = key === 'translateProviderId' ? chat.textProviders() : chat.allProviders()
    const active = list.find((p) => p.id === value) || list[0] || null
    store.set(key, active?.id || '')
    // 換供應商就換模型池，舊選擇不再有效
    const modelKey = key === 'chatProviderId' ? 'chatModelId' : 'translateModelId'
    const model = String(store.get(modelKey, '') || '')
    if (!active?.models.includes(model)) store.set(modelKey, active?.models[0] || '')
    return true
  }
  if (key === 'chatModelId') {
    const models = chat.readProvider()?.models || []
    store.set(key, models.includes(value) ? value : (models[0] || ''))
    return true
  }
  if (key === 'translateModelId') {
    const models = translateProviderModels()
    store.set(key, models.includes(value) ? value : (models[0] || ''))
    return true
  }
  if (key === 'chatPrompts') {
    const list = chat.sanitizePrompts(value)
    store.set(key, list)
    // 清單變動後選用的提示可能已被刪掉 → 收斂成「不使用」
    if (!list.some((p) => p.id === store.get('chatPromptId', ''))) store.set('chatPromptId', '')
    return true
  }
  if (key === 'chatPromptId') {
    const list = chat.sanitizePrompts(store.get('chatPrompts', []))
    store.set(key, list.some((p) => p.id === value) ? value : '')
    return true
  }
  if (key === 'chatThinking') {
    store.set(key, chatParams.sanitizeThinking(value))
    return true
  }
  if (key === 'chatImageOptions') {
    store.set(key, chatParams.sanitizeImageOptions(value))
    return true
  }
  if (key === 'chatParams') {
    store.set(key, chatParams.sanitize(value))
    return true
  }
  if (key === 'dictationEnabled') {
    store.set(key, value === true)
    // 全域鍵盤 hook 的開關就是這個 key，寫完立刻套用（不必再按儲存）
    loadDictation().then(async (d) => {
      await d.refresh()
      // 開著就順手把指示器視窗建起來（隱藏著），省掉第一次按下時的載入空窗
      if (value === true) dictationHud.warm()
      else dictationHud.close()
    }).catch((err) => {
      console.error('[dictation] refresh failed:', err?.message || err)
    })
    return true
  }
  if (key === 'dictationLang') {
    store.set(key, DICTATION_LANGS.has(value) ? value : 'zh-TW')
    return true
  }
  if (key === 'liveAudioSource') {
    store.set(key, ['mic', 'both'].includes(value) ? value : 'system')
    return true
  }
  if (key === 'recAudioSource') {
    store.set(key, ['system', 'both'].includes(value) ? value : 'mic')
    return true
  }
  if (key === 'sttLanguage') {
    store.set(key, STT_LANGS.has(value) ? value : 'zh-TW')
    return true
  }
  if (key === 'fileAsr' || key === 'liveAsr' || key === 'dictationAsr') {
    const clean = modelScope.sanitizeAsr(value, modelScope.cloudsOf(store))
    if (key === 'dictationAsr') store.set(key, clean)
    else {
      store.set('fileAsr', clean)
      store.set('liveAsr', clean)
    }
    return true
  }
  if (key === 'fileLlm' || key === 'liveLlm' || key === 'dictationLlm') {
    if (key === 'dictationLlm') store.set(key, sanitizeScopedLlm('dictation', value))
    else {
      const clean = sanitizeScopedLlm('file', value)
      store.set('fileLlm', clean)
      store.set('liveLlm', clean)
    }
    return true
  }
  if (key === 'closeToTray') {
    store.set(key, value === true)
    return true
  }
  if (key === 'subtitleWindowBounds') {
    store.set(key, sanitizeSubtitleBounds(value))
    return true
  }
  if (key === 'hfModelsDir') {
    // 正常只有系統對話框會寫（e2e 也借這條）；擋掉相對路徑與 UNC，免得模型庫被指到任意位置
    if (typeof value !== 'string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value)) {
      throw new Error('模型資料夾路徑無效')
    }
    store.set(key, value)
    return true
  }
  if (key === 'telegramPanes') {
    const list = Array.isArray(value) ? value : []
    store.set(key, list.filter((url) => typeof url === 'string' && url.length <= 2048
      && url.startsWith('https://web.telegram.org/a/')).slice(0, 4))
    return true
  }
  store.set(key, value)
  return true
})

// ===== 主視窗控制（frameless）=====
ipcMain.handle('window:minimize', (event) => {
  if (!assertMainWindowSender(event)) return false
  if (pageWindows?.dock(event.sender)) return true
  mainWindow.minimize()
  return true
})

ipcMain.handle('window:toggleMaximize', (event) => {
  if (!assertMainWindowSender(event)) return false
  const win = pageWindows.host(event.sender)
  if (win.isMaximized()) win.unmaximize()
  else win.maximize()
  return win.isMaximized()
})

ipcMain.handle('window:close', (event) => {
  if (!assertMainWindowSender(event)) return false
  if (pageWindows?.dock(event.sender)) return true
  mainWindow.close()
  return true
})

ipcMain.handle('window:isMaximized', (event) => {
  if (!assertMainWindowSender(event)) return false
  return pageWindows.host(event.sender).isMaximized()
})

ipcMain.handle('pages:ready', (event) => assertMainWindowSender(event) && pageWindows.ready(event.sender))
ipcMain.handle('pages:history', (event, delta) => {
  if (!assertMainWindowSender(event) || ![-1, 1].includes(delta)) return false
  return pageWindows.history(delta)
})
ipcMain.handle('pages:navigate', async (event, request, detach) => {
  if (!assertMainWindowSender(event)) return { ok: false, error: { message: '無法操作功能視窗' } }
  try {
    return { ok: true, data: await pageWindows.navigate(request, detach === true) }
  } catch {
    return { ok: false, error: { message: '功能視窗開啟失敗，請稍後再試' } }
  }
})

// ===== 開機自啟動 =====
// 真相在 OS（HKCU\...\Run），不進 electron-store：使用者可能在工作管理員的
// 「開機」分頁直接停用，存一份自己的布林值只會跟系統對不上、UI 說謊。
// 開發模式不註冊：那會把 node_modules 裡的 electron.exe 排進使用者的開機清單。
const LOGIN_ITEM_OPTIONS = { args: [HIDDEN_FLAG] }

/**
 * 開機自啟動的登錄檔搬遷。
 *
 * `setLoginItemSettings` 寫進 `HKCU\...\Run` 的**值名稱**就是 AppUserModelID，
 * 而 `getLoginItemSettings` 沒有 `name` 參數、只認現在這個 AUMID。所以設了
 * `com.voiceink.app` 之後，舊版留下的 `electron.app.VoiceInk`（Electron 的預設名）
 * 就變成孤兒：開機照樣自己啟動，但設定頁顯示「未開啟」而且關不掉。
 *
 * 只在打包版、且新名字底下還沒有東西時做一次。
 */
const LEGACY_LOGIN_ITEM = 'electron.app.VoiceInk'
/** 值名稱沿用 AUMID，但改名前寫的路徑是 VoiceInk.exe，升級後指向已刪掉的檔 → 重寫 */
const APP_LOGIN_ITEM = 'com.voiceink.app'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'

function migrateLoginItemName() {
  // 帶 --user-data-dir 的是預覽／沙箱／e2e：getLoginItemSettings 比對的是自己的 exe 路徑，
  // 會判成「沒開」而把使用者的開機啟動改寫成 dist 裡的預覽版（實際發生過）
  if (isDev || userDataDir) return
  try {
    if (app.getLoginItemSettings(LOGIN_ITEM_OPTIONS).openAtLogin) return
    // 系統工具一律指名 System32：PATH 上可能擺著 MSYS 的同名執行檔
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const { spawnSync } = require('child_process')
    const has = (name) => spawnSync(reg, ['query', RUN_KEY, '/v', name], { windowsHide: true }).status === 0
    const legacy = has(LEGACY_LOGIN_ITEM)
    if (!legacy && !has(APP_LOGIN_ITEM)) return
    app.setLoginItemSettings({ ...LOGIN_ITEM_OPTIONS, openAtLogin: true })
    if (legacy) spawnSync(reg, ['delete', RUN_KEY, '/v', LEGACY_LOGIN_ITEM, '/f'], { windowsHide: true })
    bootLog('login item migrated')
  } catch {
    // 搬不動就算了：舊的那筆還在，開機自啟動的行為不變
  }
}

ipcMain.handle('system:getStartup', (event) => {
  if (!assertMainWindowSender(event)) return { openAtLogin: false, supported: false }
  if (isDev || userDataDir) return { openAtLogin: false, supported: false }
  return { openAtLogin: app.getLoginItemSettings(LOGIN_ITEM_OPTIONS).openAtLogin === true, supported: true }
})

ipcMain.handle('system:setStartup', (event, enabled) => {
  if (!assertMainWindowSender(event)) return { openAtLogin: false, supported: false }
  if (isDev || userDataDir) return { openAtLogin: false, supported: false }
  app.setLoginItemSettings({ ...LOGIN_ITEM_OPTIONS, openAtLogin: enabled === true })
  return { openAtLogin: app.getLoginItemSettings(LOGIN_ITEM_OPTIONS).openAtLogin === true, supported: true }
})

// ===== 應用程式內更新 =====
// 只有主視窗能碰；狀態一律由 main 推給 renderer（renderer 不指定任何網址）
ipcMain.handle('update:status', (event) => {
  if (!assertMainWindowSender(event)) return null
  return updater.status()
})

ipcMain.handle('update:check', async (event) => {
  if (!assertMainWindowSender(event)) return null
  return updater.check()
})

ipcMain.handle('update:install', (event) => {
  if (!assertMainWindowSender(event)) return false
  return updater.quitAndInstall()
})

// GPU 能力（設定頁）
ipcMain.handle('system:gpuCapability', async () => {
  return loadGpu().detectGpuCapability()
})

ipcMain.handle('system:refreshGpuCapability', async () => {
  loadGpu().clearGpuCapabilityCache()
  return loadGpu().detectGpuCapability()
})

/**
 * 自動安裝 CUDA Runtime／Toolkit（UAC 提升）
 */
ipcMain.handle('system:installCudaEnv', async (event) => {
  if (!assertMainWindowSender(event)) {
    return { ok: false, message: '僅主視窗可安裝' }
  }
  const send = (p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToPages('system:cudaInstallProgress', p)
    }
  }
  try {
    const result = await loadCudaEnv().installCudaEnv(send)
    loadGpu().clearGpuCapabilityCache()
    const cap = await loadGpu().detectGpuCapability()
    return { ...result, capability: cap }
  } catch (e) {
    return { ok: false, message: e.message || String(e) }
  }
})

// 語音輸入的桌面指示器。
// 狀態只信主視窗（錄音在那一側）；指示器自己只送得出 ✕／✓ 兩個動作，而且要證明
// 那則訊息真的來自指示器那扇視窗——否則任何 renderer 都能偽造「使用者按了送出」。
ipcMain.handle('dictation:hudState', (event, payload) => {
  if (!assertMainWindowSender(event)) return false
  return dictationHud.update(payload || {})
})

ipcMain.handle('dictation:hudAction', (event, action) => {
  if (!dictationHud.isSender(event)) return false
  if (action !== 'cancel' && action !== 'stop') return false
  if (!mainWindow || mainWindow.isDestroyed()) return false
  // 走跟全域熱鍵同一條路：主視窗的 dictation.js 已經在處理 stop／cancel
  mainWindow.webContents.send('dictation:event', { type: action, data: {} })
  return true
})

// 字幕視窗控制
ipcMain.handle('subtitle:show', () => {
  if (!subtitleWindow) {
    createSubtitleWindow()
  } else {
    subtitleWindow.show()
  }
  return true
})

ipcMain.handle('subtitle:close', () => {
  if (subtitleWindow) {
    subtitleWindow.close()
    subtitleWindow = null
  }
  // 通知主視窗字幕已關閉，讓 UI 同步更新
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToPages('subtitle:closed')
  }
  return true
})

ipcMain.handle('subtitle:update', (event, text) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    subtitleWindow.webContents.send('subtitle:text', text)
  }
  return true
})

ipcMain.handle('subtitle:setOpacity', (event, value) => {
  if (subtitleWindow && !subtitleWindow.isDestroyed()) {
    const n = Number(value)
    const opacity = Number.isFinite(n) ? Math.min(1, Math.max(0.3, n)) : 1
    subtitleWindow.setOpacity(opacity)
  }
  return true
})

// ===== 本地模型相關 =====

ipcMain.handle('models:status', () => models.status())

ipcMain.handle('models:download', async (event, key) => {
  // 更新引擎要先停服務：執行中的 miroxen.exe 蓋不過去
  if (key === 'miroxenruntime' && miroxenMod) await miroxenMod.stop()
  return models.download(key, (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToPages('models:progress', progress)
    }
  })
})

ipcMain.handle('models:cancel', (event, key) => models.cancelDownload(key))

ipcMain.handle('models:delete', async (event, key) => {
  if (pdfTranslateMod && ['paddleocrvl16', 'ppdoclayoutv3', 'pdfruntime', 'pdfruntimegpu', 'llamaruntime', 'llamaruntimecuda',
    ...models.LLM_MODEL_KEYS].includes(key)) pdfTranslateMod.assertIdle()
  if (screenTranslateMod && ['paddleocrvl16', 'llamaruntime', 'llamaruntimecuda', ...models.LLM_MODEL_KEYS].includes(key)) screenTranslateMod.assertIdle()
  if (['breezetts2q8', 'breezeruntime'].includes(key) && breezeMod) await breezeMod.shutdown()
  if ((key === 'miroxenruntime' || models.MIROXEN_MODEL_KEYS.includes(key)) && miroxenMod) await miroxenMod.stop()
  return models.remove(key)
})

ipcMain.handle('models:openFolder', (event, key) => models.openFolder(key))

// 這條只有即時字幕在用（檔案走 transcribeFile、語音輸入走 dictation 服務）
ipcMain.handle('localAsr:transcribe', async (event, req) => transcribeSamples('live', req))

/** 長檔案串流轉錄（ffmpeg 切段，支援 ≥2h / ≥100MB；雲端走 mp3 segment） */
ipcMain.handle('localAsr:transcribeFile', async (event, req) => {
  if (!store) await initStore()
  const engine = modelScope.readAsr(store, 'file').engine
  const onProgress = (progress) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      sendToPages('localAsr:fileProgress', progress)
    }
  }
  if (engine === 'cloud') {
    return loadFileTranscribe().transcribeFileCloud({ ...(req || {}), store }, onProgress)
  }
  return loadFileTranscribe().transcribeFile(req || {}, onProgress)
})

ipcMain.handle('localAsr:cancelFileTranscribe', () => loadFileTranscribe().cancel())

ipcMain.handle('translate', async (event, text, targetLang, opts) => {
  if (!store) await initStore()
  if (typeof text !== 'string') throw new Error('翻譯文字必須是字串')
  const trimmed = text.trim()
  if (!trimmed) return ''
  // 來源由 main 的設定決定，不能信任 renderer 指定的模式。
  const scope = modelScope.isScope(opts?.scope) && opts.scope !== 'dictation' ? opts.scope : ''
  const translator = scope ? modelScope.readLlm(store, scope).mode : store.get('translator', 'local')
  const maxChars = translator === 'cloud' ? MAX_CLOUD_TRANSLATE_CHARS : MAX_TRANSLATE_CHARS
  if (trimmed.length > maxChars) {
    throw new Error(`文字過長（上限 ${maxChars} 字），請縮短後再翻譯`)
  }
  const lang = typeof targetLang === 'string' ? targetLang : 'zh-TW'
  if (!TRANSLATE_TARGET_LANGS.has(lang)) {
    throw new Error(`不支援的目標語言: ${lang}`)
  }
  // scope 是白名單：renderer 只能說「我是哪一頁」，模型與金鑰仍由 main 從 store 取
  return loadLocalLlm().translate(store, trimmed, lang, { ...(opts || {}), scope, signal: undefined })
})

// ===== Edge TTS =====
ipcMain.handle('tts:listVoices', () => listVoices())

ipcMain.handle('tts:synthesize', async (event, req) => {
  if (!store) await initStore()
  const text = typeof req?.text === 'string' ? req.text : ''
  const lang = typeof req?.lang === 'string' ? req.lang : 'zh-TW'
  const safeLang = Object.prototype.hasOwnProperty.call(DEFAULT_TTS_VOICES, lang) ? lang : 'en'
  const tts = loadEdgeTts()
  const voice = tts.resolveVoice(store, safeLang)
  const rate = tts.formatTtsRate(tts.resolveTtsRate(store))
  try {
    return await tts.synthesize({
      text,
      voice,
      rate,
      chunkIndex: req?.chunkIndex
    })
  } catch (err) {
    const msg = err?.message || String(err)
    const e = new Error(msg)
    e.code = err?.code || 'REJECTED'
    throw e
  }
})

/**
 * 翻譯頁的語音試聽：唸固定的一句範例。
 * `voice` 一樣是 main 的固定表白名單（`tts-voices.js`），不是自由字串。
 * 語速用前端送來的 rate（滑桿當下的值）；正式朗讀則讀 store。
 */
ipcMain.handle('tts:preview', async (event, req) => {
  if (!store) await initStore()
  const lang = typeof req?.lang === 'string' ? req.lang : 'zh-TW'
  const safeLang = Object.prototype.hasOwnProperty.call(DEFAULT_TTS_VOICES, lang) ? lang : 'en'
  const candidate = typeof req?.voice === 'string' ? req.voice : ''
  const allowed = VOICES_BY_LANG[safeLang].some((v) => v.id === candidate)
  const voice = allowed ? candidate : DEFAULT_TTS_VOICES[safeLang]
  const tts = loadEdgeTts()
  const rate = tts.formatTtsRate(sanitizeTtsRate(req?.rate))
  try {
    return await tts.synthesize({ text: TTS_PREVIEW_TEXT[safeLang], voice, rate })
  } catch (err) {
    const e = new Error(err?.message || String(err))
    e.code = err?.code || 'REJECTED'
    throw e
  }
})

ipcMain.handle('tts:cancel', () => {
  loadEdgeTts().cancelAll()
  return true
})

// 引擎生命週期：acquire / release / status
ipcMain.handle('engine:acquire', async (event, owner, needs) => {
  return loadEngine().acquire(owner, needs || {})
})

ipcMain.handle('engine:release', async (event, owner) => {
  return loadEngine().release(owner)
})

ipcMain.handle('engine:status', () => loadEngine().status())

// ===== 聊天 =====
// 會話內容與 model 都由 main 擁有；renderer 只給 conversationId 與文字
// 不同對話可以同時串流；`streaming` 讓 renderer 重載後仍知道哪幾個還在跑
ipcMain.handle('chat:list', async () => {
  const active = new Set(chat.activeConversationIds())
  return (await chatStore.list()).map((c) => ({ ...c, streaming: active.has(c.id) }))
})
ipcMain.handle('chat:get', (event, id) => chatStore.get(id))
// 新對話的取樣參數一律由 main 從預設值給，renderer 只能指定放哪個資料夾
ipcMain.handle('chat:create', async (event, folderId, site) => {
  if (!store) await initStore()
  return chatStore.create({ folderId, site, params: store.get('chatParams', {}) })
})
// 網頁版 AI 對話：renderer 只回報 webview 換到哪、分頁標題是什麼，收不收由 chat-store／ai-web 把關
ipcMain.handle('chat:setWebUrl', (event, id, url) => chatStore.setWebUrl(id, url))
ipcMain.handle('chat:setWebTitle', (event, id, title, url) => chatStore.setWebTitle(id, title, url))
ipcMain.handle('chat:delete', (event, id) => {
  chat.abortConversation(id)
  return chatStore.remove(id)
})
ipcMain.handle('chat:rename', (event, id, title) => chatStore.rename(id, title))
ipcMain.handle('chat:reorder', (event, items) => chatStore.reorder(items))
ipcMain.handle('chat:setParams', (event, id, params) => chatStore.setParams(id, params))
// 改寫／刪除訊息會跟串流搶同一串訊息：那個對話還在回應時一律不收
ipcMain.handle('chat:editMessage', (event, id, index, text) =>
  chat.isBusy(id) ? null : chatStore.editUserMessage(id, index, text))
ipcMain.handle('chat:deleteMessage', (event, id, index) =>
  chat.isBusy(id) ? false : chatStore.deleteMessage(id, index))
ipcMain.handle('chat:fork', (event, id, index) => chatStore.fork(id, index))
ipcMain.handle('chat:folders', () => chatStore.listFolders())
ipcMain.handle('chat:createFolder', (event, name) => chatStore.createFolder(name))
ipcMain.handle('chat:updateFolder', (event, id, patch) => chatStore.updateFolder(id, patch))
ipcMain.handle('chat:deleteFolder', (event, id) => chatStore.removeFolder(id))
ipcMain.handle('chat:reorderFolders', (event, ids) => chatStore.reorderFolders(ids))
ipcMain.handle('chat:moveToFolder', (event, id, folderId) => chatStore.moveToFolder(id, folderId))
// 匯出：內容由 main 從 chats.json 取、路徑由系統存檔對話框決定，renderer 只給 id
ipcMain.handle('chat:export', async (event, id) => {
  const conv = await chatStore.get(id)
  if (!conv) return { ok: false, error: '找不到這個對話' }
  const safeName = conv.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || '對話'
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || undefined, {
    title: '匯出對話',
    defaultPath: `${safeName}.md`,
    filters: [{ name: 'Markdown', extensions: ['md'] }]
  })
  if (result.canceled || !result.filePath) return { ok: true, saved: false }
  try {
    await fs.promises.writeFile(result.filePath, chatStore.toMarkdown(conv), 'utf8')
  } catch (e) {
    console.error('[chat] export failed:', e?.code || 'unknown')
    return { ok: false, error: '寫入檔案失敗' }
  }
  return { ok: true, saved: true }
})

/**
 * 聊天模型選單的選項來源。
 *
 * renderer 以前是自己讀 `chatProviders`——那樣看不到「本機模型」（它是 main 在 router
 * 跑著時合成的一筆，刻意不落盤）。改成跟 main 要一份，兩邊就只有一個真相。
 * **不回 apiKey**（連雲端那幾組的也不回）：選單只需要名字與模型清單。
 */
ipcMain.handle('chat:providerOptions', async () => {
  if (!store) await initStore()
  return {
    providers: chat.allProviders().map((p) => ({
      id: p.id,
      name: p.name,
      models: p.models,
      imageModels: p.imageModels,
      local: p.id === chat.LOCAL_PROVIDER_ID,
      hasApiUrl: Boolean(p.apiUrl),
      hasKey: Boolean(p.apiKey)
    })),
    providerId: String(store.get('chatProviderId', '') || ''),
    modelId: String(store.get('chatModelId', '') || '')
  }
})

/**
 * 掃描某個供應商的模型清單。
 *
 * renderer 只給 providerId，網址與金鑰一律由 main 從 store 取——
 * 讓 renderer 指定 URL 等於把 App 變成「幫你打任意網址」的跳板。
 */
ipcMain.handle('chat:scanModels', async (event, providerId) => {
  if (!store) await initStore()
  const providers = require('./cloud-providers').read(store)
  const provider = providers.find((p) => p.id === providerId)
  if (!provider) return { ok: false, code: 'NO_PROVIDER', error: '找不到這個供應商' }
  return loadChatModels().fetchModels({ apiUrl: provider.apiUrl, apiKey: provider.apiKey, includeTypes: true })
})
ipcMain.handle('chat:send', async (event, req) => {
  if (!store) await initStore()
  return chat.send(req || {}, event.sender)
})
// 一定要指名哪一條：不帶 id 的 abort() 會停掉所有對話（不同對話可以同時回應）
ipcMain.handle('chat:abort', (event, reqId) => (typeof reqId === 'string' && reqId ? chat.abort(reqId) : false))
// 圖片實體存在 <userData>/chat-images/；renderer 只拿得到檔名，讀取由 main 驗證
ipcMain.handle('chat:image', (event, name) => loadChatImages().toDataUrl(name))
// 下載：renderer 只給檔名，main 驗格式後從 chat-images 複製到使用者在存檔對話框選的位置
ipcMain.handle('chat:saveImage', async (event, name) => {
  const images = loadChatImages()
  if (!images.isValidName(name)) return { ok: false, error: '圖片不存在' }
  const ext = name.slice(name.lastIndexOf('.') + 1)
  const result = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender) || undefined, {
    title: '下載圖片',
    defaultPath: path.join(app.getPath('downloads'), `axondeck-${name.slice(4)}`),
    filters: [{ name: '圖片', extensions: [ext] }]
  })
  if (result.canceled || !result.filePath) return { ok: true, saved: false }
  try {
    await fs.promises.copyFile(images.filePath(name), result.filePath)
  } catch (e) {
    console.error('[chat] save image failed:', e?.code || 'unknown')
    return { ok: false, error: '寫入檔案失敗' }
  }
  return { ok: true, saved: true }
})

// ===== 額度儀錶板 =====
// URL、憑證路徑、SQL 與 provider 清單固定在 main；renderer 只能觸發整體同步。
registerUsageIpc({
  ipcMain,
  service: {
    load: (...args) => loadUsage().load(...args),
    sync: (...args) => loadUsage().sync(...args),
    saveSettings: (...args) => loadUsage().saveSettings(...args),
    redeemCodexReset: (...args) => loadUsage().redeemCodexReset(...args),
    listClaudeAccounts: () => loadUsage().listClaudeAccounts(),
    switchClaudeAccount: (id) => loadUsage().switchClaudeAccount(id),
    removeClaudeAccount: (id) => loadUsage().removeClaudeAccount(id),
    loginClaudeAccount: () => loadUsage().loginClaudeAccount(),
    cancelClaudeLogin: () => loadUsage().cancelClaudeLogin(),
    publicError: (error) => loadUsage().publicError(error)
  },
  isMainSender: assertMainWindowSender
})

// 額度提醒與 5 小時窗口預熱：額度條沒開著也在背景看（usage/quota-watch.js）
let quotaWatch = null
function startQuotaWatch() {
  const { Notification } = require('electron')
  const notify = (title, body) => {
    if (!Notification.isSupported()) return
    const note = new Notification({ title, body, icon: APP_ICON })
    note.on('click', showMainWindow)
    note.show()
  }
  quotaWatch = require('./usage/quota-watch').createQuotaWatch({
    usage: { load: () => loadUsage().load(), sync: () => loadUsage().sync() },
    notify,
    file: path.join(app.getPath('userData'), 'usage-watch.json'),
    // 真的要預熱才載入（開機不多拉模組）
    warmDeps: {
      cwd: path.join(app.getPath('userData'), 'warmup'),
      launch: (...args) => require('./ccswitch/mcp-check').launch(...args),
      withPath: (...args) => require('./ccswitch/cli-install').withPath(...args)
    }
  })
  quotaWatch.start()
}

// ===== AGY 反向代理 =====
// 憑證、上游 URL、project id 與 API key 全在 main；agy* 設定刻意不進 STORE_ALLOWLIST，
// renderer 只能透過 agy:* 操作，沒有任何路徑能直接改掉金鑰。
registerAgyIpc({
  ipcMain,
  service: {
    status: async (...args) => (await loadAgy()).status(...args),
    start: async (...args) => (await loadAgy()).start(...args),
    stop: async (...args) => (await loadAgy()).stop(...args),
    saveSettings: async (...args) => (await loadAgy()).saveSettings(...args),
    regenerateApiKey: async (...args) => (await loadAgy()).regenerateApiKey(...args),
    getLogs: async (...args) => (await loadAgy()).getLogs(...args),
    getStats: async (...args) => (await loadAgy()).getStats(...args),
    listModels: async (...args) => (await loadAgy()).listModels(...args),
    clearLogs: async (...args) => (await loadAgy()).clearLogs(...args),
    selfTest: async (...args) => (await loadAgy()).selfTest(...args)
  },
  isMainSender: assertMainWindowSender
})

// ===== 終端機 =====
let agentNotifier = null
/** 背景 agent 的系統通知；第一次要通知才載入 */
function notifyAgent(id, kind, title) {
  agentNotifier ||= require('./agent-notify').createAgentNotifier({ icon: APP_ICON, reveal: revealTerminal })
  return agentNotifier.notify(id, kind, title)
}

/** 點了通知：叫出 SI 頁那扇窗，再請它切到那個終端機的專案與分頁 */
async function revealTerminal(id) {
  if (pageWindows) {
    await pageWindows.navigate({ page: 'chat' }).catch(() => console.warn('[pages] reveal terminal failed'))
    showPageWindow('chat')
  } else showMainWindow()
  sendToPages('terminal:reveal', { id })
}

// shell 執行檔、啟動指令與工作目錄的驗證全在 main；renderer 只送 key 與由系統對話框選出的路徑。
registerTerminalIpc({
  ipcMain,
  service: {
    catalog: (...args) => loadTerminal().catalog(...args),
    listSessions: (...args) => loadTerminal().listSessions(...args),
    conversation: (...args) => loadTerminal().conversation(...args),
    contextUsage: (...args) => loadTerminal().contextUsage(...args),
    navJump: (...args) => loadTerminal().navJump(...args),
    // 宿主是不是更新前的舊程式碼（漏這兩支＝更新後 pty.js 的修正永遠不會生效）
    hostState: (...args) => loadTerminal().hostState(...args),
    restartHost: (...args) => loadTerminal().restartHost(...args),
    createSession: (...args) => loadTerminal().createSession(...args),
    renameSession: (...args) => loadTerminal().renameSession(...args),
    deleteSession: (...args) => loadTerminal().deleteSession(...args),
    openSession: (...args) => loadTerminal().openSession(...args),
    writeSession: (...args) => loadTerminal().writeSession(...args),
    resizeSession: (...args) => loadTerminal().resizeSession(...args),
    killSession: (...args) => loadTerminal().killSession(...args),
    // 畫面上的連結（v1.16.0 加的）：漏在這份逐一列舉的白名單裡，`terminal:resolveLinks`
    // 就只會回通用錯誤——路徑候選全部驗不過，等於整個連結功能安靜地沒作用。
    resolveLinks: (...args) => loadTerminal().resolveLinks(...args),
    revealLink: (...args) => loadTerminal().revealLink(...args),
    raiseChildWindow: (...args) => loadTerminal().raiseChildWindow(...args),
    notifyAgent: (...args) => loadTerminal().notifyAgent(...args),
    // Ctrl+G 的編輯器橋接（漏一支＝那個分頁按送出只會回通用錯誤，CLI 一直卡著）
    editorSave: (...args) => loadTerminal().editorSave(...args),
    editorCancel: (...args) => loadTerminal().editorCancel(...args),
    // 貼上讀的是 main 的剪貼簿（renderer 那支沒焦點會 reject）
    clipboardText: (...args) => loadTerminal().clipboardText(...args),
    // 複製選取的文字，同一個理由走 main（navigator.clipboard 沒焦點會失敗）
    clipboardWrite: (...args) => loadTerminal().clipboardWrite(...args),
    // 貼上截圖：main 把剪貼簿的圖存成 PNG，renderer 只拿得到路徑
    clipboardImage: (...args) => loadTerminal().clipboardImage(...args),
    // 終端機桌布（三支都要列，漏一支那顆按鈕就只會回通用錯誤）
    backgroundImage: (...args) => loadTerminal().backgroundImage(...args),
    adoptBackground: (...args) => loadTerminal().adoptBackground(...args),
    clearBackground: (...args) => loadTerminal().clearBackground(...args)
  },
  isMainSender: assertMainWindowSender,
  dialog,
  getWindow: (event) => (mainWindow && !mainWindow.isDestroyed() ? pageWindows.host(event?.sender || pageWindows.contents('chat')) : null)
})

// ===== 專案工作區 =====
// renderer 只送 projectId 與專案內的相對路徑；絕對路徑一律由 workspace/index.js 從 store 取，
// 檔案存取全部過 workspace/files.js 的 resolveIn（逃出專案範圍就拒絕）。
registerWorkspaceIpc({
  ipcMain,
  service: {
    listProjects: (...args) => loadWorkspace().listProjects(...args),
    addProject: (...args) => loadWorkspace().addProject(...args),
    addDropped: (...args) => loadWorkspace().addDropped(...args),
    renameProject: (...args) => loadWorkspace().renameProject(...args),
    removeProject: (...args) => loadWorkspace().removeProject(...args),
    reorderProjects: (...args) => loadWorkspace().reorderProjects(...args),
    listFolders: (...args) => loadWorkspace().listFolders(...args),
    createFolder: (...args) => loadWorkspace().createFolder(...args),
    updateFolder: (...args) => loadWorkspace().updateFolder(...args),
    removeFolder: (...args) => loadWorkspace().removeFolder(...args),
    reorderFolders: (...args) => loadWorkspace().reorderFolders(...args),
    saveTabsState: (...args) => loadWorkspace().saveTabsState(...args),
    getTabsState: (...args) => loadWorkspace().getTabsState(...args),
    getFileMtime: (...args) => loadWorkspace().getFileMtime(...args),
    listDir: (...args) => loadWorkspace().listDir(...args),
    readFile: (...args) => loadWorkspace().readFile(...args),
    convertOffice: (...args) => loadWorkspace().convertOffice(...args),
    writeFile: (...args) => loadWorkspace().writeFile(...args),
    createEntry: (...args) => loadWorkspace().createEntry(...args),
    renameEntry: (...args) => loadWorkspace().renameEntry(...args),
    moveEntry: (...args) => loadWorkspace().moveEntry(...args),
    importDropped: (...args) => loadWorkspace().importDropped(...args),
    removeEntry: (...args) => loadWorkspace().removeEntry(...args),
    searchFiles: (...args) => loadWorkspace().searchFiles(...args),
    listFiles: (...args) => loadWorkspace().listFiles(...args),
    listPorts: (...args) => loadWorkspace().listPorts(...args),
    reveal: (...args) => loadWorkspace().reveal(...args),
    openEntry: (...args) => loadWorkspace().openEntry(...args),
    scriptCommand: (...args) => loadWorkspace().scriptCommand(...args),
    openExternal: (...args) => loadWorkspace().openExternal(...args),
    gitStatus: (...args) => loadWorkspace().gitStatus(...args),
    gitLog: (...args) => loadWorkspace().gitLog(...args),
    gitStage: (...args) => loadWorkspace().gitStage(...args),
    gitUnstage: (...args) => loadWorkspace().gitUnstage(...args),
    gitStageAll: (...args) => loadWorkspace().gitStageAll(...args),
    gitDiscard: (...args) => loadWorkspace().gitDiscard(...args),
    gitCommit: (...args) => loadWorkspace().gitCommit(...args),
    gitPush: (...args) => loadWorkspace().gitPush(...args),
    gitPull: (...args) => loadWorkspace().gitPull(...args),
    gitDiff: (...args) => loadWorkspace().gitDiff(...args),
    gitFileVersions: (...args) => loadWorkspace().gitFileVersions(...args),
    gitBranches: (...args) => loadWorkspace().gitBranches(...args),
    gitCompareBranch: (...args) => loadWorkspace().gitCompareBranch(...args),
    gitFileVersionsAgainst: (...args) => loadWorkspace().gitFileVersionsAgainst(...args),
    worktreeList: (...args) => loadWorkspace().worktreeList(...args),
    worktreeAdd: (...args) => loadWorkspace().worktreeAdd(...args),
    worktreeAdopt: (...args) => loadWorkspace().worktreeAdopt(...args),
    worktreeCheck: (...args) => loadWorkspace().worktreeCheck(...args),
    worktreeRemove: (...args) => loadWorkspace().worktreeRemove(...args),
    setSetupScript: (...args) => loadWorkspace().setSetupScript(...args),
    worktreeSetupCommand: (...args) => loadWorkspace().worktreeSetupCommand(...args),
    watchProject: (...args) => loadWorkspace().watchProject(...args),
    unwatchProject: (...args) => loadWorkspace().unwatchProject(...args),
    agentSessions: (...args) => loadWorkspace().agentSessions(...args),
    agentResume: (...args) => loadWorkspace().agentResume(...args),
    agentSessionDetail: (...args) => loadWorkspace().agentSessionDetail(...args)
  },
  isMainSender: assertMainWindowSender,
  dialog,
  getWindow: (event) => (mainWindow && !mainWindow.isDestroyed() ? pageWindows.host(event?.sender || pageWindows.contents('chat')) : null)
})

// ===== 整機檔案總管 =====
// renderer 送本機絕對路徑；sanitize + realpath 全在 explorer/paths.js。
// 搜尋走本機 UFFS CLI，關 App 不停它的 daemon。
registerExplorerIpc({
  ipcMain,
  service: {
    bootstrap: (...args) => loadExplorer().bootstrap(...args),
    saveState: (...args) => loadExplorer().saveState(...args),
    listPlaces: (...args) => loadExplorer().listPlaces(...args),
    savePlaces: (...args) => loadExplorer().savePlaces(...args),
    addPlace: (...args) => loadExplorer().addPlace(...args),
    removePlace: (...args) => loadExplorer().removePlace(...args),
    connectShare: (...args) => loadExplorer().connectShare(...args),
    pickFolder: (...args) => loadExplorer().pickFolder(...args),
    resolvePath: (...args) => loadExplorer().resolvePath(...args),
    extract: (...args) => loadExplorer().extract(...args),
    createShortcut: (...args) => loadExplorer().createShortcut(...args),
    listDrives: (...args) => loadExplorer().listDrives(...args),
    driveInfo: (...args) => loadExplorer().driveInfo(...args),
    listDevices: (...args) => loadExplorer().listDevices(...args),
    listDir: (...args) => loadExplorer().listDir(...args),
    preview: (...args) => loadExplorer().preview(...args),
    readMarkdown: (...args) => loadExplorer().readMarkdown(...args),
    // 大預覽的來源網址（`vi-media://`，邊讀邊送）
    mediaUrl: (...args) => loadExplorer().mediaUrl(...args),
    inspect: (...args) => loadExplorer().inspect(...args),
    details: (...args) => loadExplorer().details(...args),
    createEntry: (...args) => loadExplorer().createEntry(...args),
    renameEntry: (...args) => loadExplorer().renameEntry(...args),
    removeEntry: (...args) => loadExplorer().removeEntry(...args),
    removeEntries: (...args) => loadExplorer().removeEntries(...args),
    restoreEntry: (...args) => loadExplorer().restoreEntry(...args),
    purgeEntry: (...args) => loadExplorer().purgeEntry(...args),
    emptyRecycle: (...args) => loadExplorer().emptyRecycle(...args),
    copyEntry: (...args) => loadExplorer().copyEntry(...args),
    moveEntry: (...args) => loadExplorer().moveEntry(...args),
    openPath: (...args) => loadExplorer().openPath(...args),
    fileIcon: (...args) => loadExplorer().fileIcon(...args),
    startDrag: (...args) => loadExplorer().startDrag(...args),
    shellMenu: (...args) => loadExplorer().shellMenu(...args),
    shellInvoke: (...args) => loadExplorer().shellInvoke(...args),
    shellRelease: (...args) => loadExplorer().shellRelease(...args),
    copyImage: (...args) => loadExplorer().copyImage(...args),
    setClipboard: (...args) => loadExplorer().setClipboard(...args),
    paste: (...args) => loadExplorer().paste(...args),
    dropEntries: (...args) => loadExplorer().dropEntries(...args),
    operationCancel: (...args) => loadExplorer().operationCancel(...args),
    operationRetry: (...args) => loadExplorer().operationRetry(...args),
    operationUndo: (...args) => loadExplorer().operationUndo(...args),
    operationState: (...args) => loadExplorer().operationState(...args),
    setOperationPolicy: (...args) => loadExplorer().setOperationPolicy(...args),
    watchDir: (...args) => loadExplorer().watchDir(...args),
    watchDirs: (...args) => loadExplorer().watchDirs(...args),
    unwatch: (...args) => loadExplorer().unwatch(...args),
    uffsStatus: (...args) => loadExplorer().uffsStatus(...args),
    uffsSearch: (...args) => loadExplorer().uffsSearch(...args),
    uffsCancel: (...args) => loadExplorer().uffsCancel(...args),
    uffsEnsure: (...args) => loadExplorer().uffsEnsure(...args),
    folderSize: (...args) => loadExplorer().folderSize(...args),
    folderSizeCancel: (...args) => loadExplorer().folderSizeCancel(...args),
    dirSizesScan: (...args) => loadExplorer().dirSizesScan(...args),
    dirSizesCancel: (...args) => loadExplorer().dirSizesCancel(...args)
  },
  isMainSender: assertMainWindowSender
})

// ===== HF模型（本機 llama.cpp router）=====
// renderer 只送 repoId／variantId／模型 id；下載網址由 hub.fileUrl 在 main 組，
// router 的 api key 不出 main（`runtimeStatus` 只回 running 與 port）。
registerHfModelsIpc({
  ipcMain,
  service: {
    search: (...args) => loadHfModels().search(...args),
    inspect: (...args) => loadHfModels().inspect(...args),
    preview: (...args) => loadHfModels().preview(...args),
    detail: (...args) => loadHfModels().detail(...args),
    install: (...args) => { assertModelWorkIdle(); return loadHfModels().install(...args) },
    cancelInstall: (...args) => loadHfModels().cancelInstall(...args),
    listLocal: (...args) => loadHfModels().listLocal(...args),
    removeLocal: (...args) => { assertModelWorkIdle(); return loadHfModels().removeLocal(...args) },
    pickAndImport: (...args) => loadHfModels().pickAndImport(...args),
    openModelsDir: (...args) => loadHfModels().openModelsDir(...args),
    rescan: (...args) => loadHfModels().rescan(...args),
    updateModelSettings: (...args) => { assertModelWorkIdle(); return loadHfModels().updateModelSettings(...args) },
    refreshFit: (...args) => { assertModelWorkIdle(); return loadHfModels().refreshFit(...args) },
    tune: (...args) => { assertModelWorkIdle(); return loadHfModels().tune(...args) },
    autoTune: (...args) => { assertModelWorkIdle(); return loadHfModels().autoTune(...args) },
    chooseModelsDir: (...args) => { assertModelWorkIdle(); return loadHfModels().chooseModelsDir(...args) },
    setToken: (...args) => loadHfModels().setToken(...args),
    tokenStatus: (...args) => loadHfModels().tokenStatus(...args),
    hardwareInfo: (...args) => loadHfModels().hardwareInfo(...args),
    runtimeReady: (...args) => loadHfModels().runtimeReady(...args),
    runtimeStatus: (...args) => loadHfModels().runtimeStatus(...args),
    // router 起停都要同步「聊天看得到哪幾顆」，不然選單會停在上一輪的狀態
    startRuntime: async (...args) => {
      const status = await loadHfModels().startRuntime(...args)
      await refreshHfLocalModels()
      return status
    },
    stopRuntime: (...args) => {
      assertModelWorkIdle()
      const status = loadHfModels().stopRuntime(...args)
      hfLocalModelIds = []
      return status
    },
    currentDevice: (...args) => loadHfModels().currentDevice(...args),
    applyPresets: (...args) => { assertModelWorkIdle(); return loadHfModels().applyPresets(...args) },
    loadModel: (...args) => loadHfModels().loadModel(...args),
    unloadModel: (...args) => { assertModelWorkIdle(); return loadHfModels().unloadModel(...args) },
    refreshModels: () => refreshHfLocalModels().then(() => loadHfModels().refreshModels()),
    dashboard: (...args) => loadHfModels().dashboard(...args)
  },
  isMainSender: assertMainWindowSender
})

let appInstaller = null
function loadAppInstaller() {
  if (!appInstaller) appInstaller = require('./app-installer').createInstaller({
    cacheDir: path.join(app.getPath('userData'), 'app-installers'),
    notify: (state) => sendToPages('appInstaller:state', state)
  })
  return appInstaller
}
registerAppInstallerIpc({
  ipcMain,
  service: {
    snapshot: () => loadAppInstaller().snapshot(),
    refresh: () => loadAppInstaller().refresh(),
    start: (request) => loadAppInstaller().start(request),
    upgradeAll: () => loadAppInstaller().upgradeAll(),
    icons: () => loadAppInstaller().icons()
  },
  isMainSender: assertMainWindowSender
})

registerCloudTtsIpc({
  ipcMain,
  service: {
    status: async () => { await initStore(); return loadCloudTts().status() },
    generate: async (options) => { await initStore(); return loadCloudTts().generate(options) },
    cancel: (options) => loadCloudTts().cancel(options),
    saveAudio: (options) => loadCloudTts().saveAudio(options)
  },
  isMainSender: assertMainWindowSender
})

registerBreezeIpc({
  ipcMain,
  service: {
    status: () => loadBreeze().status(),
    generate: (options) => loadBreeze().generate(options),
    cancel: (options) => loadBreeze().cancel(options),
    pickAudio: (options) => loadBreeze().pickAudio(options),
    voices: () => loadBreeze().voices(),
    saveVoice: (options) => loadBreeze().saveVoice(options),
    removeVoice: (options) => loadBreeze().removeVoice(options),
    saveAudio: (options) => loadBreeze().saveAudio(options),
    importRecording: (options) => loadBreeze().importRecording(options),
    trimAudio: (options) => loadBreeze().trimAudio(options),
    saveTake: (options) => loadBreeze().saveTake(options),
    loadTake: (options) => loadBreeze().loadTake(options),
    listTakes: () => loadBreeze().listTakes(),
    removeTake: (options) => loadBreeze().removeTake(options)
  },
  isMainSender: assertMainWindowSender
})

registerMiroxenIpc({
  ipcMain,
  service: {
    status: (options) => loadMiroxen().status(options),
    start: () => loadMiroxen().start(),
    stop: () => loadMiroxen().stop(),
    openOutput: () => loadMiroxen().openOutput(),
    api: () => loadMiroxen().api(),
    setLan: (enabled) => loadMiroxen().setLan(enabled)
  },
  isMainSender: assertMainWindowSender
})

registerPdfTranslateIpc({
  ipcMain,
  service: {
    pick: async () => (await loadPdfTranslate()).pick(),
    inspect: async (filename) => (await loadPdfTranslate()).inspect(filename),
    pasteImage: async (payload) => (await loadPdfTranslate()).pasteImage(payload),
    start: async (options) => (await loadPdfTranslate()).start(options),
    cancel: async (jobId) => (await loadPdfTranslate()).cancel(jobId),
    status: async () => (await loadPdfTranslate()).status(),
    save: async (jobId) => (await loadPdfTranslate()).save(jobId),
    clearCache: async () => (await loadPdfTranslate()).clearCache()
  },
  isMainSender: assertMainWindowSender
})

registerScreenTranslateIpc({
  ipcMain,
  service: {
    open: async (options) => (await loadScreenTranslate()).open(options),
    pause: async (paused) => (await loadScreenTranslate()).pause(paused),
    resize: async (bounds) => (await loadScreenTranslate()).resize(bounds),
    close: async () => (await loadScreenTranslate()).close(),
    status: async () => (await loadScreenTranslate()).status()
  },
  isMainSender: assertMainWindowSender,
  isOverlaySender: (event) => screenTranslateMod?.owns(event) === true
})

// ===== 系統監控 =====
// PowerShell 腳本、nvidia-smi 參數、taskkill 參數與測速目錄的驗證全在 main；
// renderer 只送取樣間隔的 key 與要結束的 pid。
registerSysmonIpc({
  ipcMain,
  service: {
    status: (...args) => loadSysmon().status(...args),
    start: (...args) => loadSysmon().start(...args),
    stop: (...args) => loadSysmon().stop(...args),
    idle: (...args) => loadSysmon().idle(...args),
    inventory: (...args) => loadSysmon().inventory(...args),
    detail: (...args) => loadSysmon().detail(...args),
    killProcess: (...args) => loadSysmon().killProcess(...args),
    enableSensors: (...args) => loadSysmon().enableSensors(...args),
    installPawnIo: (...args) => loadSysmon().installPawnIo(...args),
    openPawnIoPage: (...args) => loadSysmon().openPawnIoPage(...args),
    cpuStress: (...args) => loadSysmon().cpuStress(...args),
    memStress: (...args) => loadSysmon().memStress(...args),
    stressStatus: (...args) => loadSysmon().stressStatus(...args),
    diskBench: (...args) => loadSysmon().diskBench(...args),
    cancelDiskBench: (...args) => loadSysmon().cancelDiskBench(...args),
    diskTree: (...args) => loadSysmon().diskTree(...args),
    diskTreeCancel: (...args) => loadSysmon().diskTreeCancel(...args),
    // 風扇控制（identifier 由 main 對照即時通道清單驗過，見 sysmon/fans.js）
    fanList: (...args) => loadSysmon().fanList(...args),
    fanEnable: (...args) => loadSysmon().fanEnable(...args),
    fanSetChannel: (...args) => loadSysmon().fanSetChannel(...args),
    fanIdentify: (...args) => loadSysmon().fanIdentify(...args),
    fanResetAll: (...args) => loadSysmon().fanResetAll(...args),
    fanTaskStatus: (...args) => loadSysmon().fanTaskStatus(...args),
    fanTaskInstall: (...args) => loadSysmon().fanTaskInstall(...args),
    ocStatus: (...args) => loadSysmon().ocStatus(...args),
    ocSetDraft: (...args) => loadSysmon().ocSetDraft(...args),
    ocApply: (...args) => loadSysmon().ocApply(...args),
    ocReset: (...args) => loadSysmon().ocReset(...args),
    // GPU 壓力測試期間把 renderer 的背景節流關掉，測完立刻打開。
    //
    // 視窗被別的視窗遮住時，Chromium 會把這個 renderer 降級——GPU 指令跟著被降優先，
    // 壓力測試就安靜地垮掉（實測 nvidia-smi 從 100% 掉到 3%，畫面上還寫著「執行中」）。
    // **不可以改成建視窗時就 `backgroundThrottling: false`**：那會連帶讓最小化到系統匣時
    // `document.hidden` 不再變成 true（實測過），而 AGY 頁那條五秒輪詢——每輪都會開一次
    // PowerShell 去讀 Credential Manager——正是靠它自己停下來的。
    // 順帶一提：關掉節流時 `document.hidden` 會跟著變成 false（縮小與 hide 都一樣，
    // `scripts/probe-dictation-latency.js` 有量），所以它只能是「跑測試那幾秒」的暫時狀態。
    setGpuStress: (active) => {
      if (!mainWindow || mainWindow.isDestroyed()) return { active: false }
      pageWindows.contents('sysmon')?.setBackgroundThrottling(active !== true)
      return { active: active === true }
    }
  },
  isMainSender: assertMainWindowSender
})

// ===== Claude Code 工作台（供應商切換／MCP／CLI 版本） =====
// 端點與 npm 套件名都是 main 的固定表；格式值由白名單驗證後才送入路由，renderer 只送 preset key 與工具 key。
// 寫入的是使用者家目錄的 ~/.claude/settings.json 與 ~/.claude.json，一律備份＋原子替換，
// 而且只動我們管的那幾個 env 鍵與 mcpServers。
registerCcSwitchIpc({
  ipcMain,
  service: {
    catalog: (...args) => loadCcSwitch().catalog(...args),
    listProviders: (...args) => loadCcSwitch().listProviders(...args),
    createProvider: (...args) => loadCcSwitch().createProvider(...args),
    updateProvider: (...args) => loadCcSwitch().updateProvider(...args),
    deleteProvider: (...args) => loadCcSwitch().deleteProvider(...args),
    reorderProviders: (...args) => loadCcSwitch().reorderProviders(...args),
    activateProvider: (...args) => loadCcSwitch().activateProvider(...args),
    testProvider: (...args) => loadCcSwitch().testProvider(...args),
    scanProviderModels: (...args) => loadCcSwitch().scanProviderModels(...args),
    gatewayStatus: (...args) => loadCcSwitch().gatewayStatus(...args),
    mcpHomesList: (...args) => loadCcSwitch().mcpHomesList(...args),
    listMcp: (...args) => loadCcSwitch().listMcp(...args),
    saveMcp: (...args) => loadCcSwitch().saveMcp(...args),
    toggleMcp: (...args) => loadCcSwitch().toggleMcp(...args),
    deleteMcp: (...args) => loadCcSwitch().deleteMcp(...args),
    skillHomes: (...args) => loadCcSwitch().skillHomes(...args),
    listSkills: (...args) => loadCcSwitch().listSkills(...args),
    setSkillEnabled: (...args) => loadCcSwitch().setSkillEnabled(...args),
    memoryFiles: (...args) => loadCcSwitch().memoryFiles(...args),
    readMemory: (...args) => loadCcSwitch().readMemory(...args),
    writeMemory: (...args) => loadCcSwitch().writeMemory(...args),
    listAccounts: (...args) => loadCcSwitch().listAccounts(...args),
    beginLogin: (...args) => loadCcSwitch().beginLogin(...args),
    loginStatus: (...args) => loadCcSwitch().loginStatus(...args),
    cancelLogin: (...args) => loadCcSwitch().cancelLogin(...args),
    removeAccount: (...args) => loadCcSwitch().removeAccount(...args),
    checkVersions: (...args) => loadCcSwitch().checkVersions(...args),
    runCliTask: (...args) => loadCcSwitch().runCliTask(...args),
    cliTaskStatus: (...args) => loadCcSwitch().cliTaskStatus(...args)
  },
  isMainSender: assertMainWindowSender
})

// ===== 語音輸入（全域右 Alt）=====
// 熱鍵、麥克風以外的每一段都在 main：ASR 模型、整理用的供應商金鑰、剪貼簿與模擬按鍵。
// renderer 只送得出「錄好的一段 PCM」與字典的兩個字串。
registerScreentimeIpc({
  ipcMain,
  service: {
    status: (...args) => loadScreentime().status(...args),
    stats: (...args) => loadScreentime().stats(...args),
    drill: (...args) => loadScreentime().drill(...args),
    exportCsv: (...args) => loadScreentime().exportCsv(...args),
    openFolder: (...args) => loadScreentime().openFolder(...args)
  },
  isMainSender: assertMainWindowSender
})

registerDictationIpc({
  ipcMain,
  service: {
    status: async (...args) => (await loadDictation()).status(...args),
    refresh: async (...args) => (await loadDictation()).refresh(...args),
    submit: async (...args) => (await loadDictation()).submit(...args),
    listRecords: async (...args) => (await loadDictation()).listRecords(...args),
    removeRecord: async (...args) => (await loadDictation()).removeRecord(...args),
    clearRecords: async (...args) => (await loadDictation()).clearRecords(...args),
    listDictionary: async (...args) => (await loadDictation()).listDictionary(...args),
    upsertDictionary: async (...args) => (await loadDictation()).upsertDictionary(...args),
    removeDictionary: async (...args) => (await loadDictation()).removeDictionary(...args)
  },
  isMainSender: assertMainWindowSender
})

// 錄音機的錄音檔與即時字幕的逐字稿（語音轉文字頁）
sttArchive.configure({ userDataPath: app.getPath('userData') })
sttArchive.registerSttArchiveIpc({
  ipcMain,
  isMainSender: assertMainWindowSender
})

// ===== 本機 token 用量統計 =====
// 讀的是使用者家目錄的 session 記錄與本 App 的 AGY 日誌；路徑與 SQL 固定在 main，
// 回給 renderer 的只有彙總數字，對話內容與專案名稱一律不出 main。
registerCodeUsageIpc({
  ipcMain,
  service: {
    stats: (...args) => loadCodeUsage().stats(...args),
    sync: (...args) => loadCodeUsage().sync(...args),
    savePrices: (...args) => loadCodeUsage().savePrices(...args),
    reset: (...args) => loadCodeUsage().reset(...args)
  },
  isMainSender: assertMainWindowSender
})

// 任何一個畫面程序（主視窗、Telegram 等 webview）或 GPU 程序死掉都記一行到 userData/crash.log，
// 不然事後只看得到「當機了」，查不到是 crash、OOM 還是被砍掉。
// ponytail: 只追加不輪替，一行約 150 字，真的長到礙事再加輪替
function logProcessGone(kind, details, where) {
  const line = `${new Date().toISOString()} ${kind} reason=${details?.reason} exitCode=${details?.exitCode} ${where || ''}\n`
  console.warn('[process-gone]', line.trim())
  fs.promises.appendFile(path.join(app.getPath('userData'), 'crash.log'), line).catch(() => {})
}
app.on('render-process-gone', (_event, contents, details) => {
  let where = ''
  try { where = new URL(contents.getURL()).origin } catch { /* 空白頁 */ }
  logProcessGone('renderer', details, where)
})
app.on('child-process-gone', (_event, details) => {
  if (details.reason !== 'clean-exit') logProcessGone(details.type, details, details.name || '')
})

// webview guest 的 popup 走不到主視窗那條 attachWindowSecurity（那是掛在
// 主視窗 webContents 上），一律在 app 層補上：http(s) 開成專案瀏覽器分頁，其餘擋掉。
// 網頁版 AI 與工作區瀏覽器的分區（whenReady 時登記）：session → partition 名稱
const aiWebPartitions = new Map()
/** Browser 模式首頁／新分頁用的擴充功能（Infinity New Tab Pro）；renderer 的 browser-page.js 也寫了同一個 ID */
const NEWTAB_EXTENSION_ID = 'nnnkddnnlpamobajfibfdgfnbcnkgngh'
/** 工作區瀏覽器的 Chrome 擴充功能（whenReady 時建） @type {ReturnType<typeof import('./browser-extensions').createBrowserExtensions> | null} */
let browserExtensions = null

/**
 * 「擴充功能」選單；結果用對話框告訴使用者
 * @param {Electron.WebContents | null} tab 目前那顆瀏覽器 webview
 * @param {Electron.BrowserWindow | null} parent
 * @param {Electron.Rectangle} [anchor] popup 要對齊的位置（視窗內座標），沒給就靠右上
 */
function browserExtensionItems(tab, parent, anchor) {
  if (!browserExtensions) return []
  const notify = (message) => {
    const opts = { type: 'info', title: '擴充功能', message }
    ;(parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, opts) : dialog.showMessageBox(opts)).catch(() => {})
  }
  const width = parent && !parent.isDestroyed() ? parent.getContentBounds().width : 800
  return browserExtensions.menuItems({ tab, parent, notify, anchor: anchor || { x: width - 48, y: 40, width: 32, height: 32 } })
}

/** 畫面傳來的瀏覽器 webview id：只認掛在這個視窗裡的 guest */
function senderGuest(event, guestId) {
  const guest = Number.isInteger(guestId) ? webContents.fromId(guestId) : null
  return guest && guest.hostWebContents === event.sender ? guest : null
}

/** 畫面傳來的按鈕位置（視窗內座標）；格式不對回 undefined */
function anchorRect(anchor) {
  return anchor && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(anchor[k]))
    ? { x: Math.round(anchor.x), y: Math.round(anchor.y), width: Math.round(anchor.width), height: Math.round(anchor.height) }
    : undefined
}

ipcMain.handle('workspace:extensionsMenu', (event, guestId, anchor) => {
  if (!assertMainWindowSender(event)) return false
  const parent = BrowserWindow.fromWebContents(event.sender)
  Menu.buildFromTemplate(browserExtensionItems(senderGuest(event, guestId), parent, anchorRect(anchor))).popup(parent ? { window: parent } : {})
  return true
})

// Browser 模式的分頁彈出成獨立視窗（工作列顯示網頁標題）；給了 guestId 就連歷史、捲動、表單一起搬
ipcMain.handle('workspace:browserPopout', async (event, url, title, guestId, slot) => {
  if (!assertMainWindowSender(event) || typeof url !== 'string' || !isWebUrl(url)) return false
  await browserWindow.open(url, typeof title === 'string' ? title.slice(0, 200) : '', senderGuest(event, guestId),
    Number.isInteger(slot) && slot > 0 ? slot : 0)
  return true
})

// 彈出視窗的工具列：只能操作自己那扇窗的網頁
ipcMain.handle('browserWindow:navigate', (event, action, url) => browserWindow.navigate(event.sender, action, url))
ipcMain.handle('browserWindow:extensionActions', (event) => {
  const page = browserWindow.pageOf(event.sender)
  return page && browserExtensions ? browserExtensions.actions(page.id) : []
})
ipcMain.handle('browserWindow:extensionActivate', (event, extensionId, anchor) => {
  const page = browserWindow.pageOf(event.sender)
  const rect = anchorRect(anchor)
  if (!page || !rect || typeof extensionId !== 'string' || !browserExtensions) return false
  browserExtensions.activate(extensionId, page, rect)
  return true
})
ipcMain.handle('browserWindow:extensionsMenu', (event, anchor) => {
  const page = browserWindow.pageOf(event.sender)
  const win = browserWindow.windowOf(event.sender)
  if (!page || !win) return false
  Menu.buildFromTemplate(browserExtensionItems(page, win, anchorRect(anchor))).popup({ window: win })
  return true
})

// 工具列圖示列：圖示、標題、徽章；按下去開 popup（或送 action.onClicked）
ipcMain.handle('workspace:extensionActions', (event, guestId) => {
  if (!assertMainWindowSender(event) || !browserExtensions) return []
  return browserExtensions.actions(senderGuest(event, guestId)?.id ?? -1)
})

ipcMain.handle('workspace:extensionActivate', (event, guestId, extensionId, anchor) => {
  const tab = assertMainWindowSender(event) ? senderGuest(event, guestId) : null
  const rect = anchorRect(anchor)
  if (!tab || !rect || typeof extensionId !== 'string' || !browserExtensions) return false
  browserExtensions.activate(extensionId, tab, rect)
  return true
})

/**
 * 網頁的右鍵選單＋F5（瀏覽器分頁多一組「擴充功能」）。webview 與彈出視窗的網頁共用。
 * @param {Electron.WebContents} contents
 * @param {() => BrowserWindow | null} hostWindow
 * @param {boolean} isBrowser
 */
function attachWebMenu(contents, hostWindow, isBrowser) {
  require('./web-context-menu').attachWebContextMenu(contents, {
    openUrl: openInProjectBrowser,
    isWebUrl,
    extraItems: isBrowser ? (params) => [
      ...(browserExtensions?.contextMenuItems(contents, params) || []),
      { label: '擴充功能', submenu: browserExtensionItems(contents, hostWindow()) }
    ] : undefined
  })
}

app.on('web-contents-created', (_event, contents) => {
  // 網頁版 AI 與工作區瀏覽器：右鍵選單＋F5 重新整理（工作區瀏覽器多一組「擴充功能」，也登記成擴充功能看得到的分頁）
  if (contents.getType() === 'webview' && aiWebPartitions.has(contents.session)) {
    const isBrowser = aiWebPartitions.get(contents.session) === 'persist:wsbrowser'
    const hostWindow = () => {
      const host = contents.hostWebContents
      return host && !host.isDestroyed() ? BrowserWindow.fromWebContents(host) : null
    }
    if (isBrowser) {
      contents.once('did-attach', () => {
        const win = hostWindow()
        if (win && browserExtensions) browserExtensions.attachTab(contents, win)
      })
    }
    attachWebMenu(contents, hostWindow, isBrowser)
  }
  // 滑鼠側鍵：webview 裡的滑鼠事件進不到主視窗 DOM（主視窗自己的由 nav-history.js 接）。
  // 網頁還退得動就自己上／下一頁（Telegram 多格時就是游標底下那格），退到底再交給 App 換頁
  if (contents.getType() === 'webview') {
    contents.on('before-mouse-event', (_e, input) => {
      if (input.type !== 'mouseUp' || (input.button !== 'back' && input.button !== 'forward')) return
      const back = input.button === 'back'
      const nav = contents.navigationHistory
      if (back ? nav.canGoBack() : nav.canGoForward()) {
        if (back) nav.goBack()
        else nav.goForward()
        return
      }
      const host = contents.hostWebContents
      if (host && !host.isDestroyed()) host.send('nav:side', back ? -1 : 1)
    })
  }
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (browserExtensions?.openInternalUrl(url, contents)) return { action: 'deny' }
    const partition = aiWebPartitions.get(contents.session)
    // 比照 Chrome 開成小視窗、保留 opener，第三方登入才收得到 postMessage 回傳的結果（Infinity 新分頁的 Google 登入等）：
    // 帶視窗大小的 window.open（new-window）、先開空白頁再導過去的寫法、登入／授權頁。其餘連結才轉成分頁
    const popup = (disposition === 'new-window' && isWebUrl(url)) || url === 'about:blank'
    if (partition && (popup || require('./ai-web').isLoginPopup(url))) {
      // 登入小視窗留在 App 裡、同一個分區，登完網站才收得到結果；一樣沙箱、沒有 preload
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520, height: 720, autoHideMenuBar: true, icon: APP_ICON,
          webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false }
        }
      }
    }
    if (partition === 'persist:wsbrowser-clean' && isWebUrl(url)) {
      void browserWindow.open(url, '', null, 0, true)
      return { action: 'deny' }
    }
    // Telegram 等 AI 頁以外的 webview 點的連結開在 Browser 模式
    if (isWebUrl(url)) openInProjectBrowser(url, '', linkTarget(contents))
    return { action: 'deny' }
  })
})

// 設定系統音訊擷取的媒體請求處理器
app.whenReady().then(() => {
  // 沒搶到鎖的那份只負責把訊號送出去就結束，不可以建窗、更不可以 autoStart 反代（撞埠）
  if (!hasInstanceLock) return
  bootLog('whenReady')
  // 網頁版 AI 的四個登入分區＋工作區瀏覽器：瀏覽器特徵補成跟 Chrome 一樣（登入、hCaptcha、Cloudflare 才不會當成
  // 內嵌瀏覽器擋掉）、權限只給用得到的、登入小視窗在 App 內開
  const aiWeb = require('./ai-web')
  // 跟 navigator.languages 同一份（Electron 用 App 語系＋系統偏好語言排出來的）
  const languages = [...new Set([app.getLocale(), ...app.getPreferredSystemLanguages()].filter(Boolean))].join(',')
  for (const partition of [...Object.keys(aiWeb.SITES).map((site) => `persist:ai-${site}`), 'persist:wsbrowser', 'persist:wsbrowser-clean']) {
    const ses = session.fromPartition(partition)
    aiWeb.setupSession(ses, { userAgent: app.userAgentFallback, shimPath: path.join(__dirname, '../preload/ai-web-shim.js'), languages })
    // 被 Cloudflare 擋的分頁改回 Electron 識別重新載入；Grok 另有 grok-clearance（借 Edge 過驗證）
    if (partition !== 'persist:ai-grok') aiWeb.installChallengeFallback(ses, aiWeb.electronUserAgent(app.userAgentFallback))
    aiWebPartitions.set(ses, partition)
  }
  browserExtensions = require('./browser-extensions').createBrowserExtensions({
    session: session.fromPartition('persist:wsbrowser'),
    dir: path.join(app.getPath('userData'), 'browser-extensions'),
    fetch: (url) => net.fetch(url),
    chromeVersion: process.versions.chrome,
    aliasPreload: path.join(__dirname, '../preload/crx-browser-alias.js'),
    identityPreload: path.join(__dirname, '../preload/crx-identity.js'),
    openUrl: (url, source) => openInProjectBrowser(url, '', 'tab', source?.id || 0),
    openCompatible: (url, title) => browserWindow.open(url, title, null, 0, true),
    onActionsChanged: () => {
      sendToPages('workspace:extensionsChanged')
      browserWindow.broadcast('browserWindow:extensionsChanged')
    }
  })
  // uBlock Origin Lite、Raindrop.io、Infinity New Tab Pro、ScriptCat、Read Frog
  const DEFAULT_EXTENSIONS = [
    'ddkjiahejlhfcafbddmgiahcphecmpfh', 'ldgfbffkinooeloadekpmfoklnobpien', NEWTAB_EXTENSION_ID,
    'ndcooeababalnlpkfedmmbbbgkljhpjf', 'modkelfkcfjpgbfmnbnllalkiogfofhb'
  ]
  browserExtensions.loadInstalled()
    .catch((error) => console.warn('[browser-ext] 載入失敗:', error))
    .then(() => browserExtensions.ensureDefaults(DEFAULT_EXTENSIONS))
    .finally(() => browserExtensions.startAutoUpdate())
  // Grok 的 Cloudflare 擋 Electron：碰到驗證頁就請系統的 Edge／Chrome 過一次，把通行證帶回來（grok-clearance.js）
  const grokSes = session.fromPartition('persist:ai-grok')
  require('./grok-clearance').install(grokSes, {
    userDataDir: app.getPath('userData'),
    getGuests: () => webContents.getAllWebContents().filter((c) => c.session === grokSes && c.getType() === 'webview')
  })
  // 第三個參數是檔案總管的大預覽：路徑一律過 `explorer/paths` 的 `resolveExisting`
  // （跟檔案總管讀檔同一個入口，沒有放寬任何範圍），拿不到就丟例外 → 協定回 404。
  workspaceMedia.register(
    protocol,
    (projectId) => loadWorkspace().rootOf(projectId),
    (full) => require('./explorer/paths').resolveExisting(full)
  )
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => {
        if (!sources || sources.length === 0) {
          // 拒絕：無可用畫面來源（callback 空物件）
          callback({})
          return
        }
        callback({ video: sources[0], audio: 'loopback' })
      })
      .catch((err) => {
        console.error('[displayMedia] getSources failed:', err)
        callback({})
      })
  }, { useSystemPicker: false })

  createMainWindow()
  bootLog('window created')
  // 預覽／沙箱／e2e 帶 --user-data-dir：不在背景提醒或預熱（會跟正式那份重複跳通知、重複送請求）
  if (!userDataDir) startQuotaWatch()
  editorWindow.configure({
    isDev,
    preload: path.join(__dirname, '../preload/preload.js'),
    icon: APP_ICON,
    secure: attachWindowSecurity,
    theme: () => store?.get('theme') || 'dark',
    imageBase: (file) => workspaceMedia.localBaseFor(file),
    forceClose: () => sessionEnding
  })
  browserWindow.configure({
    isDev,
    icon: APP_ICON,
    preload: path.join(__dirname, '../preload/browser-window-preload.js'),
    secure: attachWindowSecurity,
    theme: () => store?.get('theme') || 'dark',
    isQuitting: () => isQuitting || sessionEnding,
    onDock: (info) => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      sendToPages('browserPopout:dock', info)
      showMainWindow()
    },
    attach: (contents, win) => {
      browserExtensions?.attachTab(contents, win)
      attachWebMenu(contents, () => (win.isDestroyed() ? null : win), true)
    }
  })
  if (startupFile) openFromShell(startupFile)
  setImmediate(() => {
    mediaPlayer.initializeAssociations({
      isPackaged: app.isPackaged,
      isPreview: Boolean(userDataDir),
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData')
    }).catch((err) => console.warn('[media] association initialization failed:', err?.code || 'INIT_FAILED'))
  })
  // Claude hooks：複製執行檔、寫 settings、補處理 App 關著時積下的事件。不擋視窗出來。
  // 帶 --user-data-dir 的（預覽／CDP／e2e）不寫真的 ~/.claude/settings.json：
  // 寫進去的 command 指向暫存 userData，測完一刪，使用者每次開 claude 都會報 hook 錯誤。
  setImmediate(() => {
    try {
      require('./terminal/claude-hooks').start(app.getPath('userData'), (payload) => {
        sendToPages('terminal:agent', payload)
      }, { writeSettings: !userDataDir })
    } catch (err) {
      console.error('[claude-hook] start failed:', err && err.code ? err.code : 'START_FAILED')
    }
  })
  migrateLoginItemName()
  initStore()
    .then(() => {
      // 更新檢查要等 store（自動更新開關存在裡面）；延後 20 秒讓開機那陣忙完再說
      updater.configure({
        autoUpdate: store.get('autoUpdate', true) !== false,
        onStatus: (s) => {
          sendToPages('update:status', s)
        }
      })
      setTimeout(() => updater.checkQuietly(), 20000)
      // 常駐好幾天的話光靠開機那一次不夠，六小時再看一次
      setInterval(() => updater.checkQuietly(), 6 * 60 * 60 * 1000)
    })
    .then(() => {
      // 風扇接管：使用者上次開著就在開機自啟動時直接接手，**不必等他點開系統監控頁**。
      // 這之前的幾秒由 BIOS 曲線負責，那是安全的預設值。
      try { loadScreentime().start() } catch (err) {
        console.error('[screentime] start failed:', err?.message || err)
      }
      const sysmon = loadSysmon()
      try { sysmon.start(store?.get('sysmonInterval'), { background: true }) } catch (err) {
        console.error('[sysmon] sampler start failed:', err?.message || err)
      }
      const fansOn = store?.get('fanControl')?.enabled === true
      const sensorsOn = store?.get('sysmonSensors') !== false
      if (fansOn) {
        return sysmon.ensureFanControl()
          .catch((err) => console.error('[sysmon] fan takeover failed:', err?.message || err))
      }
      if (!sensorsOn) return undefined
      return sysmon.ensureSensors()
        .catch((err) => console.error('[sysmon] sensors start failed:', err?.message || err))
    })
    .catch((err) => console.error('[store] init failed:', err?.message || err))
})

// 關閉前同步卸載模型，再真正退出
/**
 * 結束前先讓工作區把未存草稿寫完。
 *
 * renderer 的 `beforeunload` 攔不住這件事——那裡的儲存是非同步的，視窗一關就沒了，
 * 所以由這裡送一次請求、等它回報。逾時（renderer 卡住）就照樣往下走，
 * 不能讓 App 因為存草稿而關不掉。
 *
 * @returns {Promise<boolean>} false＝真的存不進去
 */
function flushWorkspaceDrafts() {
  return new Promise((resolve) => {
    const contents = pageWindows?.contents('chat')
    if (!contents || contents.isDestroyed()) {
      resolve(true)
      return
    }
    const done = (ok) => {
      clearTimeout(timer)
      ipcMain.removeListener('workspace:draftsFlushed', onDone)
      resolve(ok)
    }
    const onDone = (event, ok) => {
      if (event.sender !== contents) return
      done(ok !== false)
    }
    const timer = setTimeout(() => done(true), 3000)
    ipcMain.on('workspace:draftsFlushed', onDone)
    contents.send('workspace:flushDrafts')
  })
}

/** 草稿沖洗狀態：pending → flushing → done。done 之後不再攔（不可以讓 App 關不掉） */
let draftFlush = 'pending'

app.on('before-quit', (e) => {
  if (isQuitting) {
    // 卸載進行中再次 quit：繼續擋，只允許 app.exit 那條路結束
    e.preventDefault()
    return
  }
  if (draftFlush !== 'done') {
    // 未存草稿是這台機器上唯一一份，寫完之前一步都不能拆
    e.preventDefault()
    if (draftFlush === 'flushing') return
    draftFlush = 'flushing'
    flushWorkspaceDrafts().then((ok) => {
      draftFlush = 'done'
      if (ok) {
        app.quit()
        return
      }
      // 存不起來就先不要結束，讓使用者看得到那份草稿（再按一次結束就會直接走）
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show()
    })
    return
  }
  e.preventDefault()
  isQuitting = true
  // 終端機由獨立宿主持有；更新／結束 App 只斷線，明確關閉分頁才結束程序。
  const stopTerminal = terminalMod
    ? Promise.resolve(terminalMod.disconnect()).catch(() => console.error('[terminal] disconnect failed'))
    : Promise.resolve()
  try { require('./terminal/claude-hooks').stop() } catch { /* 沒裝過 */ }
  // 檔案總管收自己的 fs.watch，並休眠本 App 用過的 UFFS 索引，保留 daemon／磁碟快取。
  // 殼層 sidecar 要一起收：它抓著 IContextMenu COM 物件，不放會留程序。
  const stopExplorer = explorerMod
    ? Promise.resolve(typeof explorerMod.shutdown === 'function' ? explorerMod.shutdown() : explorerMod.unwatch())
      .catch(() => console.warn('[explorer] shutdown failed'))
    : Promise.resolve()
  // 系統監控有三顆子程序（probe.ps1／nvidia-smi／感測器 sidecar），少收一顆就變孤兒。
  // **這條是 await 得到的**：風扇的手動 PWM 留在晶片裡，沒等它交還就退出等於把風扇
  // 釘在最後的轉速（事後 SetDefault 也救不回來，只有重開機）。
  const stopSysmon = sysmonMod
    ? Promise.resolve(sysmonMod.shutdown()).catch((err) => console.error('[sysmon] shutdown failed:', err))
    : Promise.resolve()
  const stopScreentime = screentimeMod
    ? Promise.resolve(screentimeMod.shutdown()).catch((err) => console.error('[screentime] shutdown failed:', err))
    : Promise.resolve()
  // 低階鍵盤 hook 有自己的執行緒，不收掉會擋住程序真的結束
  if (dictationMod) dictationMod.shutdown()
  // llama.cpp router：它自己會帶走底下跑模型的子程序，但沒人收它就會留一台在背景吃顯存
  // 翻譯可能先載入共用 router，此時 Local SI 頁還沒載入，也必須收掉它。
  const hfService = hfModelsMod || require.cache[require.resolve('./hfmodels')]?.exports
  if (hfService) hfService.shutdown()
  // 指示器是 alwaysOnTop 的獨立視窗：留著就會浮在桌面上關不掉
  dictationHud.close()
  // 反代先關：留著監聽的 socket 會讓下次啟動撞到 EADDRINUSE
  // Claude Code 的轉換閘道同理（跟 AGY 是兩個不同的埠）
  const stopGateway = ccSwitchMod
    ? ccSwitchMod.stopGateway().catch((err) => console.error('[ccswitch] gateway stop failed:', err))
    : Promise.resolve()
  const stopAgy = Promise.all([
    screenTranslateMod ? screenTranslateMod.close() : Promise.resolve(),
    pdfTranslateMod ? pdfTranslateMod.shutdown() : Promise.resolve(),
    loadCloudTts().shutdown(),
    breezeMod ? breezeMod.shutdown() : Promise.resolve(),
    miroxenMod ? miroxenMod.shutdown() : Promise.resolve(),
    stopTerminal,
    stopExplorer,
    stopSysmon,
    stopScreentime,
    stopGateway,
    ccSwitchMod ? ccSwitchMod.stopMcpChecks() : Promise.resolve(),
    agyMod ? agyMod.shutdown() : Promise.resolve()
  ])
  stopAgy
    .catch((err) => console.error('[agy] shutdown on quit failed:', err))
    .then(() => {
      if (require.cache[require.resolve('./engine')]) return loadEngine().unloadAll()
      // engine 沒被載過但 ASR 被直接叫過：llama-server sidecar 是獨立程序，不收會變孤兒
      if (require.cache[require.resolve('./asr-select')]) return loadLocalAsr().unload()
      return undefined
    })
    .catch((err) => console.error('[engine] unloadAll on quit failed:', err))
    .finally(() => {
      // 已下載好的更新在這裡靜默安裝（autoInstallOnAppQuit 對這個 App 無效，見 updater.js）
      updater.installOnQuit(sessionEnding)
      app.exit(0)
    })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (mainWindow === null) {
    createMainWindow()
  }
})
