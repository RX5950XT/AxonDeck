# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」。規則與地雷見 [AGENTS.md](./AGENTS.md)，判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史查 git log。

## 概況

VoiceInk：Windows Electron AI 工作台。Vanilla JS + Vite，Electron 43.4.1。目前版本 **v1.39.1**（2026-10-04）。
nav 十頁（順序可拖曳，存 localStorage `navOrder`；圖示是 SVG，`ws-tool-icons.js` 的 `toolIcon`）：

| 頁 | `data-page` | 一句話 |
|---|---|---|
| AI | `chat` | 側欄 Agent（專案）／Chat（對話）；主區三選一 `setChatPaneMode('chat'\|'workspace'\|'web')` |
| Telegram | `telegram` | Web A 放 `<webview>`，最多 4 格並排、共用 `persist:telegram` |
| 檔案 | `explorer` | 整機檔案總管＋UFFS 檔名搜尋 |
| CC Proxy | `ccswitch` | 供應商切換改 `~/.claude/settings.json`、轉換閘道（自動）、子分頁：AGY 反代（Antigravity → OpenAI／Anthropic 端點）／MCP／CLI 版本／用量統計 |
| 語音轉文字 | `stt` | 檔案與錄音（左轉入、右錄音）｜即時字幕（系統聲音／麥克風）｜語音輸入 |
| 翻譯與 TTS | `translate` | local（LinguaForge）／cloud 翻譯；Edge TTS |
| 系統監控 | `sysmon` | 總覽／使用時長／處理程序／壓力測試／風扇／效能調整／磁碟空間 |
| Local SI（原 HF模型） | `hfmodels` | 搜 GGUF → 下載 → llama-server router 一顆程序管全部模型 |
| 設定 | `settings` | 裝了什麼、怎麼推論、雲端端點、終端機配色與桌布 |

## 模組地圖

```
src/main/
  main.js            frameless 主窗、IPC 註冊、store allowlist、單一實例鎖、系統匣、網頁分區 setupSession
  ipc-invoke.js      模組 IPC 共用外殼；raw-fs.js（不鎖 asar）；safe-rm.js（不穿 junction）
  updater.js / update-mirrors.js   electron-updater＋GitHub latest.yml；安裝檔走鏡像、差分下載關閉
  chat*.js           雲端聊天 SSE（每對話一條 inflight）、會話＋側欄資料夾、取樣參數、自動標題、圖片
  ai-web.js          網頁版 AI：網址把關、標題、Google 登入修正、登入小視窗、分區 UA
  grok-clearance.js  Grok 被 Cloudflare 擋時開 Edge／Chrome 拿通行證（cf_clearance＋UA）帶回 App
  terminal/          service.js（門面）→ 獨立宿主 host*.js／Rust voiceink-term；claude-hooks.js、editor-bridge.js、
                     links.js、clipboard-image.js、admin*.js
  workspace/         files.js（resolveIn）、git.js、agents.js（五家 AI 記錄）、worktree.js、watch.js、media.js（vi-media://）
  explorer/          paths.js、fs.js、recycle.js、drives.js、watch.js、uffs.js、zip*.js、mtp.js、details.js、size.js、shell*.js
  media-player.js    本機圖片／影音分流到原生彈窗 voiceink-media.exe
  hfmodels/          hub／gguf／fit／download.js（共用續傳＋分段下載）／presets／runtime（router）
  ccswitch/          claude-settings.js、providers.js（routeFor）、models-scan.js、mcp.js、versions.js、gateway/
  codeusage/         scan.js（游標）、parsers.js（五家）、pricing.js（RULES_VERSION）
  usage/             七家額度、claude-auth.js（續期）、codex-reset.js（app-server 兌換）
  agy/               server.js、轉換器、catalog.js／model-map.js、credential.js（renewViaCli）、logs.js
  sysmon/            sampler.js、metrics.js、gpu.js、sensors.js（提權 sidecar）、fans.js、oc.js、disktree.js、stress.js
  screentime/        Tai 相容 SQLite、前景觀測、8908 WebSocket
  dictation/         管線、hotkey.js、insert.js、text.js（字典／切段）、hud.js
  asr-select.js／model-scope.js／local-asr／llama-asr／cloud-asr／file-transcribe／stt-archive／local-llm／edge-tts
src/renderer/scripts/
  app.js  chat-page.js  chat-sidebar.js  chat-menu.js  ai-web-page.js  telegram-page.js  markdown.js
  workspace-page.js  ws-tabs.js  ws-monaco.js  ws-review.js  ws-git-status.js  terminal-page.js  term-*.js
  explorer-page.js  explorer-*.js  quota-bar.js  code-usage-page.js  ccswitch-page.js  cc-model-groups.js
  sysmon-*.js  disk-treemap.js  stt-page.js  recorder.js  live-caption.js  live-history.js  dictation.js  custom-select.js  app-dialog.js
native/
  voiceink-probe/    Rust：sysmon／usage-scan／dir-size／disk-tree／hook／claude-hook 子指令；bin/voiceink-term、bin/voiceink-media
  explorer-shell/    .NET 殼層 sidecar（IContextMenu、縮圖、overlay、內容視窗、MTP、屬性）
  sysmon-sensors/    .NET LHM 提權 sidecar；dictation-hook/ 熱鍵 .NET 退路
```

## 各模組現況

### AI 頁
- Chat 側欄上方：Local、資料夾各半排，ChatGPT／Gemini／Claude／Grok 只留圖示並排；每按一次新增一則。對話與資料夾整列右鍵（選單鍵／Shift+F10）叫 `chat-menu.js`。
- 網頁版 AI 對話存 `chats.json` 的 `web: { site, url, title }`，可改名、搬資料夾、拖曳；webview 回報網址／標題由 `ai-web.js` 把關。
- 分區 `persist:ai-<site>`，工作區瀏覽器 `persist:wsbrowser` 套同一套 `setupSession`：UA 偽裝 Chrome（Grok 改用替它過驗證的 Edge／Chrome 的 UA，存在 `grok-clearance.json`）、`ai-web-shim.js` 補 `window.chrome`、權限只給剪貼簿／全螢幕／純麥克風、`accounts.google.com` 走精簡版登入、登入小視窗在 App 內開。
- 記憶體：網頁藏超過 5 分鐘或同時超過 3 則就移除 webview（正在出聲的不收），再點照網址重建；工作區背景瀏覽器分頁閒置 10 分鐘拆掉。聊天圖片快取 LRU 約 16MB。
- 聊天：不同對話可同時回應；每對話取樣參數；第一輪後 AI 自動取標題；編輯／分叉／重新生成。

### 專案工作區與終端機
- 專案＝本機資料夾（`workspaces.json`，含 `tabsState`）；分頁列放終端機／Monaco 編輯器／瀏覽器；右側欄檔案樹（含搜尋）／Git／AI 記錄／監聽埠，主區底部是額度條 `quota-bar.js`。
- 檔案樹圖片與 MP4／WebM 直接開工作區分頁（`vi-media://`）；Markdown 圖片支援專案相對路徑；Git 面板有 GitHub 按鈕（`githubUrl`）。
- 專案全文搜尋 64KB 區塊逐行讀、新查詢停止舊查詢。AI 記錄讀 Claude Code／Codex／Grok／OpenCode／Antigravity CLI，長對話分頁讀取。
- 終端機 PTY 在獨立宿主（`<userData>/terminal-host/`），App 重開／更新只斷線；五種 AI CLI 重開時接回原程序，程序已結束就用記住的對話 ID 接續（Claude 靠 hook，其他靠啟動前紀錄基準）。
- Claude 狀態：hook（`<userData>/claude-hook/`）＋畫面判斷 → 分頁顯示運行中／等你回答／閒置。
- 其他：WebGL renderer、搜尋、字級、最多 3 格並排、OSC 標題與 cwd、連結、Ctrl+G 用 App 內編輯分頁、剪貼簿截圖貼路徑、桌布與配色、管理員終端機。Codex 預設指令 `codex --no-daemon`（避免彈外部視窗）。

### 檔案頁
- 分頁、雙欄（作用欄＋各自分頁組）、首頁「本機」（插拔即時更新）、清單／方格（Ctrl+滾輪 48～256px）、每個資料夾記自己的檢視／大小／排序（`explorer.json` 的 `folderViews`）。
- 刪除進系統回收筒、Ctrl+Z 復原、撞名可改名／略過／覆蓋（覆蓋先把舊的丟回收筒）、操作中心在狀態列。
- 殼層 sidecar 提供原生右鍵（7-Zip／WinRAR／傳送到）、真縮圖＋Drive 綠勾、內容視窗、詳細資訊（EXIF／影音串流／版本）、手機 MTP。ZIP 唯讀瀏覽與解壓。
- UFFS：進頁只準備授權，搜尋時才載索引，閒置 60 秒或 App 結束時休眠。

### 原生媒體播放器
- `native/voiceink-probe/src/bin/voiceink-media/`：Rust＋Win32，mpv／ImageMagick 解碼，放 Windows Job object；跟主 App 完全分開。
- 自繪選單、播放清單（搜尋、拖入、續播）、倍速滑桿、快捷鍵表；偏好存 `%LOCALAPPDATA%/VoiceInk Media/preferences.json`。
- 預設關聯：新安裝或首次更新背景套用（同時寫 UserChoice 與 UserChoiceLatest 有效 Hash 並回讀），備份在 `association-backups/`，之後不覆寫使用者自選；解除安裝還原。
- `npm run build:media` 固定 runtime 版本與 SHA-256；GPL 授權見 `resources/media-NOTICE.txt`。

### 系統監控
- 取樣器 `voiceink-probe.exe sysmon` 開機常駐、沒人看 30 秒一輪；nvidia-smi 常駐；多 GPU 各自一卡。
- 提權感測器 sidecar 走排程工作，斷線一直重拉；風扇曲線每秒重送；效能調整不開機自動套用。
- 處理程序：`sysmon-procs.js` 管理圖示、整機占用與保存的欄序（名稱固定第一欄）；取樣器帶執行檔路徑，main 非同步快取圖示。網路沿用感測器 sidecar 的 Kernel-Network ETW（TCP／UDP、IPv4／IPv6），未啟用、權限不足、遺失事件或資料過期顯示「—」，不新增 UAC。
- 磁碟空間：`voiceink-probe disk-tree` 平行掃＋treemap，刪除只丟回收筒。強制結束權限不足會跳一次 UAC。

### 額度與用量統計
- 額度：七家官方端點（`usage.json`），條看得到時快取超過 60 秒自動同步；Claude token 自己續期、報 `claude-code/` UA；Codex 重置次數可在詳情卡兌換。
- 用量統計：掃 Claude／Codex／Grok 等本機記錄（Rust `usage-scan`），每小時桶＋游標存 `code-usage.json`，在 CC Proxy 子分頁。

### CC Proxy
- 內建 Grok、Codex、Ollama Cloud、OpenCode Go、Command Code、OpenRouter 可選上游格式，非 Anthropic 走本機閘道轉換；Codex／Grok 可在 App 登入或沿用 CLI。
- 轉換閘道跟著供應商自動開關（沒有手動開關）；AGY 反代執行中會自動多一張「Antigravity」供應商（直連反代、位址金鑰自動帶入，啟用時反代沒開會自動開）。
- AGY 反代從獨立頁搬成 CC Proxy 的子分頁（`#cc-agy`，`agy-page.js` 照舊管自己的輪詢）。AGY 模型映射先比對即時型錄，再退回靜態表。
- 供應商彈窗：金鑰／登入／模型在外面，名稱、上游格式、1M 收在「進階設定」（自訂預設展開）；多一顆「儲存並啟用」。
- 模型清單每天自動同步一次（`modelsCheckedAt`），下拉依 AI lab 分組（`cc-model-groups.js`）；Codex 查詢的 `client_version` 跟隨已安裝 CLI。

### 語音
- 語音輸入：右 Alt → 錄音 → ASR → 字典 → LLM 整理 → 插入（自己視窗直接插、外部才走剪貼簿）；HUD 每次載入重送狀態。
- 檔案轉錄：ffmpeg 串流切段；雲端遇 429／逾時／5xx 同段重試，仍失敗保留已完成內容。錄音機跟檔案轉入同一頁，錄音可拖過去（只帶檔名，路徑由 main 解析）。即時字幕音源記在 `liveAudioSource`（system／mic）。錄音與字幕邊錄邊 append。
- 三個子分頁各自選模型（`model-scope.js`）：`file`／`live`／`dictation`；值 `local:<key>`／`cloud:<設定 id>:<模型 id>`。

### Telegram
- 一格載完等 1.5 秒再載下一格；✕ 先導 `about:blank` 再拿掉；每 20 秒探各格，卡「等待網路連線」60 秒或格子當掉就全部依序重載（兩次隔 5 分鐘）；當機記到 `userData/crash.log`。
- 切走時用 `opacity:0`＋`position:absolute` 藏（`display:none` 會丟圖塊，切回來卡頓）。

### 更新與安裝
- 手動「重新啟動並安裝」顯示進度、裝完自己開回；結束 App 時靜默安裝；關機／登出不安裝。
- `electron:build` 走 `pack-preview.js --release`：磁碟根完整 NSIS → 驗 asar／`app-update.yml`／latest.yml 雜湊 → 同步回 dist → 清理。

## 資料落點（`%APPDATA%/voiceink/`）

| 檔案 | 內容 |
|---|---|
| `config.json` | 一般設定（`store:*`，key 僅 allowlist） |
| `chats.json`／`chat-images/` | 對話（含網頁版 `web`）、資料夾、每對話參數／圖片附件 |
| `terminals.json` | 終端機 metadata、AI 類型與對話 ID |
| `workspaces.json`／`explorer.json` | 專案清單＋分頁狀態／檔案頁路徑、位置、資料夾檢視 |
| `dictations.json` | 語音輸入紀錄與字典 |
| `recordings/`／`live-transcripts/` | 錄音（webm）／即時字幕逐字稿（jsonl） |
| `usage.json`／`code-usage.json` | 額度快取／用量桶＋游標 |
| `agy-logs.db` | AGY 流量日誌 |
| `claude-backup/` | `~/.claude/settings.json` 寫入前備份 |
| `models/`／`hf-models/`／`hf-presets.ini` | 模型與執行環境／HF 模型庫／router preset |
| `screentime/data.db` | 使用時長 |
| `terminal-host/`／`claude-hook/`／`clipboard-images/`／`terminal-bg/` | 終端機宿主、Claude hook、貼上截圖、桌布 |
| `uffs/` | UFFS 執行檔與索引 |

## 已知取捨與未做

- 使用者決定維持：不全面拿掉毛玻璃（ClearType 彩邊）、Telegram 不共用程序（一格當掉會全白）、不改 Tauri。
- 轉換閘道只有 Codex 的請求形狀對真上游驗過，其餘 mock。Antigravity 用量只統計經過反代的部分。
- HF：沒真的跑過大模型（只驗 0.8B／4B dense）；CUDA 執行環境沒實際安裝驗過。
- 網頁版 AI：Grok 登入、Claude 的 Google 登入只驗到登入頁出現，沒輸入真密碼走完；Edge cookie 是 app-bound 加密，不做匯入。
- 原生媒體：格式清單是白名單不代表每種變種都驗過；DRM、MIDI 不支援；CUE 不分軌；全機安裝不改其他帳戶預設。
- Codex npm launcher 的 `--no-daemon` 本機修正會被 npm 更新覆蓋（App 端旗標仍在）。
- `probe-dictation-live.js` 需要前景焦點，只能在使用者沒在用電腦時跑。

## 最近版本

| 版本 | 日期 | 重點 |
|---|---|---|
| v1.39.3 | 10-05 | Grok 改借 Edge 過 Cloudflare 驗證；刪對話等可還原操作不再跳確認框 |
| v1.39.2 | 10-04 | 全專案讀碼修掉五十多個 bug |
| v1.39.1 | 10-04 | Grok 網頁版保留 Electron 識別，不再卡 Cloudflare 驗證 |
| v1.39.0 | 10-04 | AI 頁四家網頁版對話、右鍵選單、Google 登入不被擋、閒置網頁自動收；搜尋記憶體下降、五種 AI 紀錄與終端機接續 |
| v1.38.4 | 10-03 | 檔案轉錄限流／逾時重試並保留已完成內容 |
| v1.38.3 | 10-03 | 原生播放器有聲音卻沒視窗 |
| v1.38.2 | 10-03 | CC 模型掃描修正與 lab 分組 |
| v1.38.1 | 10-02 | CC 模型每日同步、共用下載加速、語音膠囊修復 |
| v1.38.0 | 10-01 | 原生媒體播放器與預設關聯 |
| v1.37.x | 09-29～10-02 | 更新看得到進度、終端機用使用者環境、正式包保留 app-update.yml、檔案圖示修正 |
| v1.36.x | 09-27～28 | 檔案頁右鍵／詳細資訊、感測器不掉線、硬碟溫度修正 |
| v1.35.0 | 09-27 | 終端機辨識 Claude 狀態並接回對話；檔案頁插拔與手機瀏覽 |
| v1.30～1.34 | 09-24～26 | 主程序同步 I/O 改非同步、Rust 化（宿主／用量掃描／資料夾大小／熱鍵）、磁碟空間、ZIP、Telegram 自救 |
