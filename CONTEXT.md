# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」。規則與地雷見 [AGENTS.md](./AGENTS.md)，判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，待辦見 [tasks/todo.md](./tasks/todo.md)，歷史與數字查 git log（`git log -- CONTEXT.md` 有壓縮前的完整版）。

## 概況

AxonDeck（v1.40 前叫 VoiceInk，舊名相容點見 AGENTS「打包／建置」）：Windows Electron AI 工作台，Vanilla JS＋Vite，Electron 43.7.5。目前 **v1.68.0**（2026-10-26）。

| 頁 | `data-page` | 一句話 |
|---|---|---|
| Super Intelligence | `chat` | 側欄 Agent（專案）／Chat（對話）／Browser；主區 `setChatPaneMode('chat'\|'workspace'\|'web')` |
| Telegram | `telegram` | Web A 放 `<webview>`，最多 4 格、共用 `persist:telegram` |
| 檔案 | `explorer` | 整機檔案總管＋UFFS 搜尋 |
| 語音轉文字 | `stt` | 檔案轉錄、錄音機、即時字幕、語音輸入 |
| 翻譯 | `translate` | 文字／螢幕／PDF 翻譯、術語表、EdgeTTS（跟模型按鈕同一排） |
| 文字轉語音 | `speech` | Breeze-TTS-2 Q8；可切雲端 `/audio/speech` |
| 生成圖片影像 | `imagegen` | iframe 內嵌 Miroxen 工作台 |
| 系統監控 | `sysmon` | 總覽／使用時長／處理程序／風扇／效能與壓力測試／磁碟空間 |
| Local SI | `hfmodels` | 執行環境（含推薦）／探索；llama-server router 一顆程序管全部模型 |
| 設定 | `settings` | 雲端模型／基本／外觀／AGY 反代／安裝／CLI 版本 |

原 CC Proxy 頁已拆：供應商與用量統計是工作區額度條的抽屜，MCP／Skills 是專案分頁，AGY 與 CLI 版本在設定頁；邏輯仍在 `ccswitch-page.js`。導覽順序存 localStorage `navOrder`，圖示在 `ws-tool-icons.js` 的 `toolIcon`。

## 跨模組架構

- **功能頁獨立視窗**（`src/main/page-windows.js`）：每頁一個 WebContentsView，主視窗外殼是 `index.html?host=1`（不畫頁面）。`app.js` 第一個 import `page-content.js`，在其他模組抓 DOM 前移除非本頁 `.page`；外置對話框用 `data-page-content` 指定所屬頁。彈出視窗標題＝導覽鈕 aria-label＋` — AxonDeck`；maximize／restore 也要重設 view 尺寸；外殼標題列關掉拖曳區（否則吃掉導覽鈕點擊）。
- **預載**：第一頁好了 8 秒後 `prewarm` 依序載好最近 7 天用過的頁（config `pageUse`）；沒用過的頁不預載。切頁順暢度用 `scripts/probe-page-switch.js` 量。
- **跨頁動作**一律走 app.js 的 `openInFilesPage`／`openUrlInApp`／`switchPage`（每頁是獨立 renderer）。main 推送要廣播給每個 `index.html` 的 webContents（`sendToPages`）。
- **滑鼠側鍵**：`nav-history.js` 記「頁＋主區＋對話」，跨頁足跡在 main `pages.history`；檔案頁先退資料夾歷史，webview 先讓網頁自己退（`before-mouse-event`），到底才 `nav:side`。回歸 `e2e-side-nav-cdp.js`。
- **子程序**：`proc-broker.js` 在 utilityProcess 代開（Windows CreateProcess 偶爾 200ms+，在 main 開會整個頓住）；git、worktree、procs-json 走這條。IPC：`ipc-invoke.js` 共用外殼（主視窗守衛＋`{ ok, data|error }`），`npm run lint` 的 `lint-ipc.js` 擋三清單對不上。
- **CDP 測試三個坑**：①切頁要獨立一個 eval（`scripts/lib/page-cdp.js` 會跟著換 target）；②模擬推送要廣播給每個 `index.html`；③`--hidden` 視窗不畫、不收合成滑鼠、不發 scroll／IntersectionObserver，要量先 `showInactive()`。
- 設定頁雲端分區把整份 `providerDraft` 寫回 `cloudProviders`：頁面 hidden 時有未存修改要立刻存，否則舊草稿會蓋掉別頁寫入。

## 模組地圖

```
src/main/
  main.js            frameless 主窗、IPC 註冊、store allowlist、單一實例鎖、系統匣、setupSession
  page-windows.js／ipc-invoke.js／proc-broker.js／raw-fs.js（不鎖 asar）／safe-rm.js（不穿 junction）
  updater.js／update-mirrors.js   electron-updater＋GitHub latest.yml；安裝檔走鏡像、差分下載關閉
  chat*.js／ai-web.js／grok-clearance.js   雲端聊天 SSE 與會話；網頁版 AI 網址把關、UA、登入小視窗、Cloudflare 退路
  browser-*.js／crx-*.js（＋preload/crx-*）／web-context-menu.js   內建瀏覽器、擴充功能、右鍵與 F5
  terminal/          service.js（門面）→ 獨立宿主 host*.js／Rust axondeck-term；claude-hooks、agent-notify、admin*
  workspace/         files.js（resolveIn）、git.js、agents.js（五家 AI 記錄）、agent-context.js、worktree.js、watch.js、media.js（vi-media://）、office-convert.js
  explorer/          paths.js、fs.js、recycle.js、drives.js、uffs.js、zip*.js、mtp.js、details.js、dir-sizes.js、shell*.js
  editor-window.js／big-text.js／media-player.js   獨立編輯器、超大文字檔、原生播放器分流
  hfmodels/          hub／gguf／fit／download（續傳＋分段）／presets／runtime（router）／archs.js
  models.js          推薦模型與執行環境 registry（固定版本＋SHA-256）
  breeze-tts/／cloud-tts/   本機 Breeze server（index／protocol／takes／audio-clean）／雲端 TTS
  miroxen/           runtime.js（跟 latest release 裝／更新）、index.js（serve 程序）
  pdf-translate/     index／ipc／protocol／runtime（隔離 Python）／worker.py／terms.js／cache.js
  screen-translate/  取景窗、擷取、去重
  glossary.js／glossary-data/   翻譯術語表（NAER 學術名詞）
  ccswitch/          claude-settings、providers（routeFor）、models-scan、mcp、mcp-check、toml-edit、versions、gateway/
  codeusage/         scan（游標）、parsers（五家）、pricing（RULES_VERSION）、models-dev
  usage/             七家額度、claude-auth（續期）、claude-accounts、codex-reset、quota-watch／alerts／warmup
  agy/               server、轉換器、catalog／model-map、credential、logs
  sysmon/            sampler、metrics、gpu、sensors（提權 sidecar）、fans、oc、disktree、stress；app-resources.js
  screentime/        Tai 相容 SQLite、前景觀測、8908 WebSocket
  dictation/         管線、hotkey、insert、text（字典）、hud
  app-installer/     WinGet＋直連安裝、inventory、icons、direct（SELF_UPDATERS）
  asr-select／model-scope／llama-asr／cloud-asr／file-transcribe／stt-archive／local-llm-router／edge-tts／opencc
src/renderer/scripts/
  app.js page-content.js nav-history.js  chat-*.js ai-web-page.js browser-page.js webview-warm.js
  workspace-page.js ws-*.js terminal-page.js term-*.js  explorer-*.js  quota-bar.js app-resources-bar.js
  ccswitch-page.js cc-*.js code-usage-page.js  speech-*.js  imagegen-page.js  sysmon-*.js  stt-page.js
  markdown*.js mermaid-frame.js big-text-view.js  custom-select.js app-dialog.js
native/
  axondeck-probe/    Rust：sysmon／usage-scan／dir-size／disk-tree／search／procs-json／raise-window／list-dir；bin/axondeck-term、bin/axondeck-media
  explorer-shell/    .NET 殼層 sidecar（IContextMenu、縮圖、內容視窗、MTP、devices）
  sysmon-sensors/    .NET LHM 提權 sidecar；dictation-hook/ 熱鍵退路（Rust 子指令沒 exe 時各自退回 JS／PowerShell）
```

## 各模組現況

### SI 頁：聊天、網頁版 AI、內建瀏覽器
- Chat 側欄第一排五顆新增鈕（Local＋四家網頁版）、資料夾鈕在搜尋框旁、Arena（`openArena`，id `__arena`，不進 chats.json）釘在清單上方。對話與資料夾右鍵走 `chat-menu.js`。
- Local 對話：思考強度 8 檔（`chatThinking`）；生圖模型換成比例／解析度選單（`chatImageOptions`，auto 從提示詞猜），沒附圖時拿上一張生成圖當參考；圖片右上下載鈕（`chat:saveImage`）。不同對話可同時回應。
- 網頁版對話存 `chats.json` 的 `web: { site, url, title }`；分區 `persist:ai-<site>`，工作區瀏覽器 `persist:wsbrowser` 套同一套 `setupSession`（UA 偽裝 Chrome、`ai-web-shim.js`、`Sec-CH-UA`、權限只給剪貼簿／全螢幕／麥克風）。
- Cloudflare：Grok 用 `grok-clearance.js` 借 Edge／Chrome 拿 `cf_clearance`；其他分區 `installChallengeFallback` 看到 `cf-mitigated: challenge` 就把該分頁改回 Electron 原 UA 重載。另有「無套件相容視窗」（`persist:wsbrowser-clean`）。
- 順暢度：`installRenderBoost` 對 ChatGPT／Gemini／Grok 的訊息節點插 `content-visibility:auto`（選擇器改版就失效，退回原樣）。
- 外連開在哪：Agent 模式 → 專案瀏覽器分頁；對話／網頁版 AI → 右側 `chat-browser.js`；Browser 模式與 SI 以外 → Browser 模式新分頁（`browser-page.js`，分頁與群組存 localStorage `browserTabs`，垂直分頁可拖曳分組）。空白分頁開 Infinity New Tab（`NEWTAB_URL`）。
- 分頁右鍵「彈出獨立視窗」走 `browser-window.js`：main 自建 WebContentsView，首次載入前還原整串歷史（webview 搬不了視窗）。
- 登入小視窗：`window.open` 帶尺寸、先開 `about:blank`、或 `isLoginPopup` 判定的登入頁 → App 內小視窗並保留 opener；擴充功能 `chrome.identity` 由 `crx-identity.js` 補（preload 要在 electron-chrome-extensions 之前登記）。
- 瀏覽器切分頁（`webview-warm.js` `showGuest`）：最近 2 顆用 `.webview-warm` 透明疊放（display:none 會丟圖塊），更舊的才 `[hidden]`；背景分頁 1 小時沒看就 `sleepIdle`（正在看／出聲的不收），點回由 `ensureGuest` 重建。離開 Browser 模式由 `parkBrowserMain` 凍結原尺寸疊放。
- Chrome 擴充功能（只限 `persist:wsbrowser`）：`browser-extensions.js` 從商店下載 CRX3、寫公鑰進 manifest、`tar.exe` 解到 `userData/browser-extensions/`；啟動後 1 分鐘、之後每 6 小時檢查更新。本機資料夾安裝存 `local-extensions.json`；啟用狀態存 `extension-state.json`。
- 擴充功能管理頁 `axon-extensions://manager/...`（`chrome://extensions` 也導過來），協定只供應固定資源、IPC 限分區與主 frame。`crx-browser-alias.js` 補 `browser` 命名空間；ScriptCat 的 userScripts 由 `crx-user-scripts.js` 用原生 scripting 補（USER_SCRIPT 映射 ISOLATED）；`crx-context-menus.js` 補 contextMenus。右鍵與 F5 由 `web-context-menu.js` 掛在 guest 的 `before-input-event`（焦點在 webview 時按鍵到不了主視窗）。
- 專案腳本開瀏覽器（`script-launch.js`）：`.bat`／`.cmd` 由 App 啟動，`BROWSER`＝AxonDeck.exe、`start` 改道 `%AXONDECK_START%`；第二份 AxonDeck 用原始順序 argv 判斷並帶 `AXONDECK_PROJECT`。檔案樹一鍵啟動用 `workspace:scriptCommand` 在終端機跑，看到 loopback URL 等 TCP 就緒再開專案分頁。

### 專案工作區與終端機
- 專案＝本機資料夾（`workspaces.json`，含 `tabsState`、`folders`、`folderId`、`setupScript`）。分類沿用 Chat 資料夾（`ws-project-folders.js`），刪分類只移回未分類。
- 右側欄四顆：檔案樹／Git／AI 記錄／MCP・Skills（開成 `cc-tools` 分頁，一專案一個）。主區＋右側欄包在 `#wsShell`，額度條 `quota-bar.js` 在最下面橫跨兩者。
- Git 面板按鈕依狀態（`paintGitActions`）：暫存區空就「全部提交 N 個」＝`add -A`；沒上游時「發布分支」＝`push -u origin HEAD`；GitHub 鈕 `githubUrl`。
- 專案全文搜尋走 Rust `search`（平行讀檔，結果與 JS 版一致）；新查詢停止舊查詢。
- AI 記錄讀 Claude Code／Codex／Grok／OpenCode／Antigravity；IPC 分段讀、renderer 接成完整單頁；Ctrl+F 搜尋全文與工具內容。
- 終端機 PTY 在獨立宿主（`<userData>/terminal-host/`），App 重開只斷線；五種 AI CLI 接回原程序，已結束就用記住的對話 ID 接續。Codex 預設 `codex --no-daemon`，宿主把 npm 套件內 codex.exe 排到 PATH 最前。
- 狀態：Claude 靠 hook（`<userData>/claude-hook/`）＋畫面判斷；其他家看 `events.jsonl`／CLI log。對話綁定（`agent-resume.js` 的 `claimed`）：一筆對話只綁給一個還在跑的分頁；Claude 由 PTY 子程序對 `sessions/<pid>.json`。
- 背景通知（`agent-notify.js`）：agent 分頁從運行中掉到閒置／等人且沒在看 → Windows 通知＋工作列 overlay 數字；點通知 `terminal:reveal` 切回該分頁。純 shell 不通知。
- 上下文用量（`agent-context.js`）：Codex 用 `last_token_usage.total_tokens`／`model_context_window` 畫百分比；Claude 只顯示幾 K。
- 右緣：`term-scrollbar.js` 共用 xterm 實際列號；`term-conversation.js` 滑入展開的對話清單，點選 `scrollToLine`。Codex `--no-alt-screen`、Grok `--minimal --no-alt-screen`、Claude `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`；OpenCode 全螢幕，靠 `OPENCODE_TUI_CONFIG` 載 `opencode/navigation.mjs` 跳轉。緩衝區 50000 列；開啟時把保存的提問／回答補進同一個 xterm 上方。
- 畫布：常用分頁保留 WebGL，最多 8 個，超額收最久沒看的背景格；不可回到切走立刻 dispose（v1.53.0 退化）。量測 `probe-workspace-latency.js --paint`。
- 新 worktree 單一表單（`ws-worktree-flow.js`）；初始化腳本只收專案內 .ps1／.cmd／.bat，由 main 組指令。刪 worktree 先問宿主底下還有沒有在跑的終端機（`listRunningUnder`）。`Ctrl+Shift+P` 指令面板在 `ws-commands.js`；Diff 審查意見貼到最近的 agent 終端機（`term.paste`，不自動送出）。

### 編輯器與預覽
- 獨立編輯器 `editor-window.js`＋`pages/editor.html`：一檔一窗、路徑只由 main 決定、存檔帶 mtime（STALE 問覆寫）、暫存檔再 rename（EPERM 重試 20 次，`files.renameRetry`）。UTF-8／BOM／UTF-16 LE 原樣存回，其他當 Big5 唯讀。
- 大檔：Monaco 上限 256MB（20MB／30 萬行以上關上色與換行）；超過 256MB 用唯讀分段檢視（main `big-text.js` 每 1024 列一個書籤，renderer `big-text-view.js` 自畫捲軸，每 2 秒看修改時間、變長就接著掃）。Git diff 只收前 2MB（`run` 帶 `maxChars`）。Markdown 超過 512K 字預設開編輯（`previewSlice`）。
- 格式清單 `editor-formats.json`（不可與 `media-formats.json` 重疊，Rust 測試擋）。關聯 ProgID `AxonDeck.Editor.*`、指令 `AxonDeck.exe "--open-file=%1"`，備份 `editor-association-backups/`。開檔共用 `mediaPlayer.openPath`（媒體→播放器、文字→編輯器、其餘→系統）。
- Markdown 預覽傳 `{ html: true }`（聊天不開）：內嵌 HTML 經 DOMParser＋白名單重建（`markdown-html.js`）；mermaid 在隱藏 srcdoc iframe 跑（`mermaid-frame.js`，避開 Monaco 的 AMD `define`）；KaTeX 只輸出 MathML；highlight.js 按需載。mermaid／katex／highlight.js／gemoji 是 devDependency，靠 `build.files` 的 FileSet 打包（FileSet 放陣列最後）。相對連結交給呼叫端 `openLink`。
- HTML 預覽 `workspace:previewHtml` → `vi-media://<專案id>.<SITE_TOKEN>/<rel>`，iframe `allow-scripts allow-same-origin`，CSP `frame-src` 要留 `vi-media:`。
- Office 預覽：原始版面＝`workspace:convertOffice` 用 Office COM（沒有才 LibreOffice）轉 PDF 交 pdf.js，快取 `userData/office-preview`；簡易檢視＝`ws-office*.js` 自己解 zip。檔案樹的圖片／音訊／影片開 `vi-media` 分頁，解不了編碼才開原生播放器。

### 檔案頁與原生媒體播放器
- 分頁、雙欄、首頁「本機」（插拔即時更新）、清單／方格（Ctrl+滾輪 48～256px）、每資料夾記自己的檢視（`explorer.json` 的 `folderViews`）。
- 刪除進回收筒、Ctrl+Z 復原、撞名可改名／略過／覆蓋；殼層 sidecar 給原生右鍵、真縮圖、內容視窗、詳細資訊、MTP、手機清單（`devices`）。
- 超過 300 項的資料夾改 Rust `list-dir`；資料夾大小（`folderSizes`）由 `dir-sizes.js` 背景用 `dir-size` 逐個算（單個上限 20 秒）。
- UFFS 進頁只準備授權，搜尋時才載索引，保留到 App 結束。
- 原生媒體播放器 `native/axondeck-probe/src/bin/axondeck-media/`：Rust＋Win32，mpv／ImageMagick 解碼，跑在 Job object，跟主 App 分開。偏好存 `%LOCALAPPDATA%/AxonDeck Media/preferences.json`。
- 右鍵「在 AxonDeck 檔案頁顯示」叫 `AxonDeck.exe --reveal=<路徑>`（main `revealInFiles`）。
- 預設關聯：新安裝或首次更新背景套用（同時寫 UserChoice 與 UserChoiceLatest Hash 並回讀），備份在 `association-backups/`，之後不覆寫自選；解除安裝還原。`npm run build:media` 固定 runtime 版本與 SHA-256。

### 額度條、用量統計、Claude Code 供應商、AGY 反代
- 額度：七家官方端點（`usage.json`），條看得到且快取超過 60 秒自動同步。背景 `quota-watch.js` 每 5 分鐘 tick、30 分鐘同步（帶 `--user-data-dir` 不跑）；提醒 `quota-alerts.js`、預熱 `warmup.js`（CLI 送 hi，工作目錄 `userData/warmup`），記號存 `usage-watch.json`。
- 條左「供應商」「用量統計」、右「Port」「資源」都是向上展開的抽屜（點條外或 Esc 收）。Port：`renderPorts` 對每個埠打 HTTP 判斷是不是網頁；資源：`app-resources.js` 用 `getAppMetrics` 對頁／網站，子程序從取樣器清單找子孫。
- Claude 多帳號：併在「Claude 官方訂閱」供應商卡；切換＝換 `.credentials.json` 的 `claudeAiOauth`＋`.claude.json` 的 `oauthAccount`。
- 用量統計：Rust `usage-scan` 掃本機紀錄，每小時桶＋游標存 `code-usage.json`，第一次開抽屜才載；不限保留期。Antigravity 讀 CLI 的 `conversations/<id>.db`（protobuf 實測反推）＋AGY 日誌；IDE 用量讀不到。
- 重讀不丟資料：每個游標記 `contrib`；檔案被刪移進 `archive`，整份重讀時加回。Codex `.jsonl.zst` 解壓後算位移；Grok 子代理預設跳過（`resolveSubagents`）；Claude resume／fork 跨檔去重。
- 單價：自訂 → 內建表 → models.dev（只收原廠、一天一次）；`RULES_VERSION = 16`；Haiku 5.5 依單請求是否超過 100K 分級距。
- 供應商：Grok、Codex、Ollama Cloud、OpenCode Go、Command Code、OpenRouter 可選上游格式，非 Anthropic 走本機閘道；閘道跟著供應商自動開關。AGY 執行中自動多一張「Antigravity」供應商。模型清單每天同步一次，依 AI lab 分組（`cc-model-groups.js`）。
- MCP：五家共用切換；Codex／Grok `config.toml` 由 `toml-edit.js` 只換變動的 `[mcp_servers.<id>]` 區塊（註解、CRLF、BOM 原樣），切不安全才整份重寫。「測試」走 `mcp-check.js`（stdio 30 秒、HTTP 60 秒，結束 `taskkill /T /F`）。
- AGY 反代：設定頁 `#set-agy`，`agy-page.js` 只在該區看得到時輪詢。模型映射先比即時型錄再退靜態表；實測 404 的放 `RETIRED_MODELS`。`USER_AGENT` 必須報 `antigravity/cli/x.y.z`（否則型錄沒有 Argon）。上游額度 Gemini 與 Claude／GPT 各一池，Pro 的 Gemini 4 Argon 另一池只有每週。

### Local SI 與本地推論
- 子分頁：執行環境（本機模型、推薦 `#hf-recommend`、啟動、硬體、引擎、圖片影像 API）／探索。推薦有 ASR 兩顆、LinguaForge 0.8B、Index-Translate 2B、PaddleOCR-VL-1.6、PP-DocLayoutV3、Breeze-TTS-2 Q8、Miroxen 模型；舊 Qwen3.5 key 遷移到 Index。
- 推論一律 llama-server router；推薦模型以絕對路徑寫 preset 不複製。NVIDIA ≥8GB（門檻 8184 MiB）用 GPU，否則 CPU。預設 ASR ctx 4096、翻譯 ctx 8192，KV q8_0＋flash attention，`cache-ram = 512`；顯存以 nvidia-smi 為準。
- 進 Local SI 自動補建議執行環境；探索下載後排隊 fit＋bench。探索只列文字生成模型（`archs.js`＝llama.cpp `LLM_ARCH_NAMES` 扣掉非文字，升級 llama 要重抄，`test-hf-archs.js` 擋）。
- ASR 0.6B／1.7B 都是 Q8_0 GGUF，經 `asr-select` 走共用 router。本地翻譯經 `local-llm-router.js`；關 App 要連只由翻譯載入的 router 一起收。
- 本機預覽 `dev-sandbox.js --packed --with-chats` 用 `%APPDATA%/axondeck-dev`，models／hf-models 接回正式資料。

### 翻譯
- 一般翻譯切頁仍繼續，保留 `translate` 引擎，完成／失敗／停止才釋放。LinguaForge 約 2000 字一段、清單標記先剝再貼回。Edge TTS 的 `node-edge-tts` 固定 1.2.11（舊服務 403）。
- Index-Translate 修補：行首「A. 」先剝再貼回；殘留英文／假名改用官方 instTrans 格式重翻；出口 `jpKanjiToTw` 換回繁體字。
- 術語表（`glossary.js`）：自訂 `translateGlossary` 優先，再補內建 `translateGlossaryBuiltin`（`naer-terms.tsv.gz`，只收至少兩學科共用的 2–5 字片語，約 20.8 萬條，由 `build-glossary-data.js` 產生）。只在目標繁中套用；雲端進 system prompt，Index 只給唯一譯名，LinguaForge 不套。
- 螢幕翻譯：`pages/screen-translate.html`，`setShape` 挖空取景、`setBackgroundMaterial('none')`、`setContentProtection`；PaddleOCR-VL 經 router 讀記憶體截圖不落盤；獨立 `screen` engine owner。驗證 `test-screen-translate.js`、`e2e-screen-translate-cdp.js`。
- PDF／圖片翻譯（`pdf-translate/`）：main 凍結設定、複製來源到暫存，worker 逐頁 PP-DocLayoutV3 版面偵測→翻譯→替換。有文字層用原生文字，VL OCR 只補掃描頁；數學不翻。雲端同頁段落合批（`translateSegments`，≤3000 字／40 段）並行 4 批；本地一次一段。
- PDF 其他：頁碼選擇（`parsePages`）、雙語對照（`interleave`）、文件術語抽取（`terms.js`，只雲端）、譯文快取（`cache.js`，`node:sqlite`，30 天）；每頁子集化字型；worker 以 `-I` 啟動所以 stdin 要在程式內設 UTF-8；Windows 上 detached 啟動。
- PDF 環境：`pdfruntime` 固定 uv／Python 3.12.12／PaddlePaddle 3.3.1／PaddleOCR 3.7.0／PyMuPDF 1.28.2；`pdfruntimegpu` 換 paddlepaddle-gpu cu129。套件照 `requirements-*.txt` `--require-hashes` 安裝，`rankedIndexes` 量 3MB 挑最快鏡像；裝完 `prune`；Python 一律帶 `isolatedEnv`。GPU 版面偵測 4.3→0.09 秒／頁。

### 文字轉語音（Breeze-TTS-2）
- `breeze-tts/{index,protocol,takes,audio-clean,ipc}.js` → `speech-page.js`＋`speech-{script,takes,audio-input,wave}.js`。模型 `breezetts2q8`＋固定 v0.1.0 `breezeruntime`，SHA-256 驗證；不進 llama router。NVIDIA ≥8GB＋Vulkan 用 GPU。首次生成或保存聲音才載模型。
- Breeze 只聽 main 指定的 loopback 隨機埠；參考音由 main 選檔（非 WAV 先 ffmpeg 轉 24kHz 單聲道），renderer 只拿 token。選參考音後用檔案轉錄的 ASR 自動填逐字稿。收藏聲音在 `userData/breeze-tts/voices`。
- 進階預設照官方：重複懲罰 1.1、每段 600 字、每段上限 750 幀（防失控，不是總長）。
- 版面：左稿子、右設定（模式→聲音→進階）、底部黏著播放列；聲音設計有女聲範本（▶ 用固定台詞實際生成）。每次生成存版本 `userData/breeze-tts/takes`（最多 50 版），記每句位置，重做單句只生成那一句。
- 存版本前每句過 `audio-clean.js`：裁頭尾靜音、拉到 -20 dBFS、10ms 淡入淡出；偵測 `runaway`（講完又出聲）自動換種子重做最多兩次。參考音先 `cleanReference`。
- 生成可排隊（`snapshot`＋`enqueue`），排隊中參考音與版本區鎖住；停止清空佇列。逐句／字幕由 renderer 依序呼叫 `generate`，main 暫存 PCM（上限 256MB）。讀音字典 `speechPronunciations`。
- 驗證：`test-breeze-tts.js`、`test-breeze-audio-clean.js`、`test-speech-script.js`、`AXONDECK_DEV=1 node scripts/e2e-speech-cdp.js`（用 `AXONDECK_DEV_URL` 指專屬埠）。模型與輸出限研究、非商用。

### 生成圖片影像（Miroxen）
- `imagegen-page.js` 的 iframe 網址 `http://127.0.0.1:<port>/?embed=1&theme=…#key=…`；換主題 postMessage `miroxen:theme`；工作台按鈕回送 `miroxen:host`（驗 source 與 origin）。模型選擇在工作台右上 popover；API 面板在 Local SI（`hf-miroxen-api.js`）。
- 區網 `miroxenLan`：改聽 `0.0.0.0:8188`（被占退隨機埠）；金鑰 `miroxenApiKey` 固定；`/`、`/files/` 不驗金鑰。
- 引擎 `miroxenruntime` 只在 NVIDIA 驅動 ≥580 列出；模型固定 revision＋SHA-256，放 `models/miroxen/`（結構同 Miroxen repo），輸出 `userData/miroxen/out`。開發機的 `models/miroxen` 是接到 Miroxen repo 的 junction。

### 語音轉文字
- 檔案轉錄／錄音／字幕各一張功能卡；錄音 `recAudioSource`（預設 mic）、字幕 `liveAudioSource`（預設 system），都可 mic／system／both，共用 `recording-audio.js` 混音。
- 轉錄與字幕共用模型（`fileAsr`／`fileLlm`，開機 `alignSharedStt` 抄到 live）；語音輸入各自選（`dictationAsr`／`dictationLlm`）。值格式 `local:<key>`／`cloud:<設定 id>:<模型 id>`。
- 即時字幕按開始後持有 `live` 引擎到停止／關窗；待機預熱切頁可釋放。語音輸入：右 Alt → 錄音 → ASR → 字典 → LLM 整理 → 插入；檔案轉錄 ffmpeg 串流切段，雲端 429／逾時／5xx 同段重試。

### 系統監控
- 取樣器 `axondeck-probe.exe sysmon` 開機常駐、沒人看 30 秒一輪；提權感測器 sidecar 走排程工作。總覽卡片依面板寬一／二／三欄（container query 掛在 `#sysmon-overview` 與各卡，不掛在有下拉選單的分頁）。效能與壓力測試同一分頁，即時儀表只有 `sysmon-oc.js` 那份。
- 處理程序：`sysmon-procs.js` 管圖示與欄序；網路欄用感測器 sidecar 的 Kernel-Network ETW，未啟用顯示「—」。磁碟空間：`disk-tree` 平行掃＋treemap。

### 設定頁
- 六區全部自動儲存。雲端模型只有一份 `cloudProviders`（`cloud-providers.js`），每顆模型帶用途（`cloud-model-types.mjs`：chat／image／asr／tts…），寫入時投影回 `chatProviders` 與 `asrClouds`。全新設定預設一組空的 OpenRouter；AGY 啟動時 `syncAntigravity` 自動加入。
- 安裝（`app-installer/`）：WinGet 用 node-pty 跑讀進度；同時 3 筆、MSI 互撞重試；失敗依序改管理員靜默→原廠安裝畫面；`SELF_UPDATERS`（iCUE、gcloud）；Google App 走官方 stub 並驗簽章。`inventory.js` 依安裝實例定位，移除程式不存在時可「清除失效紀錄」（先備份）。
- 更新：手動「重新啟動並安裝」顯示進度；結束 App 時靜默；關機登出不裝。`electron:build` 走 `pack-preview.js --release`（lint→磁碟根 NSIS→驗 asar／`app-update.yml`／latest.yml→同步回 dist）。

### Telegram
- 各格同時載、切走不卸載；用 `opacity:0`＋`position:absolute` 藏（display:none 會丟圖塊）。每 20 秒探各格，卡住 60 秒或當掉就依序重載；當機記到 `userData/crash.log`。

## 資料落點（`%APPDATA%/axondeck/`，舊安裝沿用 `%APPDATA%/voiceink`）

| 檔案 | 內容 |
|---|---|
| `config.json` | 一般設定（key 僅 allowlist） |
| `chats.json`／`chat-images/` | 對話（含網頁版 `web`）、資料夾、圖片 |
| `terminals.json`／`workspaces.json`／`explorer.json` | 終端機 metadata／專案與分頁狀態／檔案頁狀態 |
| `dictations.json`／`recordings/`／`live-transcripts/`／`file-transcripts/` | 語音輸入紀錄與字典／錄音／字幕逐字稿／轉錄紀錄 |
| `usage.json`／`code-usage.json`／`usage-watch.json`／`claude-accounts.json` | 額度快取／用量桶＋游標／提醒記號／Claude 帳號快照（含 token） |
| `agy-logs.db`／`claude-backup/`／`screentime/data.db`／`uffs/` | AGY 流量日誌／`~/.claude/settings.json` 寫入前備份／使用時長／UFFS |
| `models/`／`hf-models/`／`hf-presets.ini` | 推薦模型與執行環境／HF 模型庫／router preset |
| `breeze-tts/`／`miroxen/`／`browser-extensions/` | 聲音與版本／生成輸出／擴充功能 |
| `terminal-host/`／`claude-hook/`／`clipboard-images/`／`terminal-bg/` | 終端機宿主、Claude hook、貼上截圖、桌布 |

## 已知取捨與未做

- 使用者決定維持：不全面拿掉毛玻璃（ClearType 彩邊）、Telegram 不共用程序、不改 Tauri、CDP 腳本不全面改寫成 Playwright。
- 轉換閘道只有 Codex 對真上游驗過，其餘 mock；HF 沒跑過大模型、CUDA 執行環境沒實際安裝驗過。
- 網頁版 AI：Grok 登入、Claude 的 Google 登入只驗到登入頁；Edge cookie 是 app-bound 加密，不做匯入。
- 原生媒體：格式白名單不代表每種變種都驗過；DRM、MIDI 不支援；CUE 不分軌。
- PDF／圖片翻譯：複雜背景與數學排版仍要人核對。終端機對話導覽：Grok 沒有原生輪次跳轉；Antigravity 依賴本機 `altScreenMode: never`。
- Codex npm launcher 的 `--no-daemon` 本機修正會被 npm 更新覆蓋。`probe-dictation-live.js` 需要前景焦點。
