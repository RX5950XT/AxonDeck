# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」。規則與地雷見 [AGENTS.md](./AGENTS.md)，判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史查 git log。

## 概況

AxonDeck（v1.40 前叫 VoiceInk，留舊名的相容點見 AGENTS.md「打包／建置」）：Windows Electron AI 工作台。Vanilla JS + Vite，Electron 43.4.1。目前版本 **v1.44.0**（2026-10-10）。
nav 十頁（順序可拖曳，存 localStorage `navOrder`；圖示是 SVG，`ws-tool-icons.js` 的 `toolIcon`）：

| 頁 | `data-page` | 一句話 |
|---|---|---|
| SI | `chat` | 側欄 Agent（專案）／Chat（對話）；主區三選一 `setChatPaneMode('chat'\|'workspace'\|'web')` |
| Telegram | `telegram` | Web A 放 `<webview>`，最多 4 格並排、共用 `persist:telegram` |
| 檔案 | `explorer` | 整機檔案總管＋UFFS 檔名搜尋 |
| CC Proxy | `ccswitch` | 供應商切換改 `~/.claude/settings.json`、轉換閘道（自動）、子分頁：AGY 反代（Antigravity → OpenAI／Anthropic 端點）／MCP（Claude／Codex／Grok／OpenCode 四家）／Skills 與記憶／用量統計；CLI 版本搬去設定頁 |
| 語音轉文字 | `stt` | 轉錄、錄音、即時字幕、語音輸入同一頁（辨識／翻譯／目標語言共用；語音輸入的模型與輸出語言獨立） |
| 翻譯 | `translate` | local（LinguaForge）／cloud 翻譯；EdgeTTS 與模型按鈕同一排、按鈕寬度貼文字，展開浮在內容上。語音是繁中、簡中、英文、日文 |
| 文字轉語音 | `speech` | Breeze-TTS-2 Q8：聲音設計、語音克隆、語氣指導、保存聲音、實驗性變聲、串流試聽與 WAV 匯出 |
| 系統監控 | `sysmon` | 總覽／使用時長／處理程序／壓力測試／風扇／效能調整／磁碟空間 |
| Local SI（原 HF模型） | `hfmodels` | 搜 GGUF → 下載 → llama-server router 一顆程序管全部模型 |
| 設定 | `settings` | 雲端端點、終端機配色與桌布；本地模型與推論方式在 Local SI；EdgeTTS 在翻譯頁 |

滑鼠側鍵（上一頁／下一頁）：`nav-history.js` 記「頁＋AI 主區＋對話」足跡；檔案頁先退資料夾歷史，webview 裡按由 main 的 `before-mouse-event` 先讓網頁自己退，退到底才 `nav:side` 換 App 頁。回歸 `scripts/e2e-side-nav-cdp.js`。

## 模組地圖

```
src/main/
  main.js            frameless 主窗、IPC 註冊、store allowlist、單一實例鎖、系統匣、網頁分區 setupSession
  ipc-invoke.js      模組 IPC 共用外殼；raw-fs.js（不鎖 asar）；safe-rm.js（不穿 junction）
  updater.js / update-mirrors.js   electron-updater＋GitHub latest.yml；安裝檔走鏡像、差分下載關閉
  chat*.js           雲端聊天 SSE（每對話一條 inflight）、會話＋側欄資料夾、取樣參數、自動標題、圖片
  ai-web.js          網頁版 AI：網址把關、標題、Google 登入修正、登入小視窗、分區 UA
  grok-clearance.js  Grok 被 Cloudflare 擋時開 Edge／Chrome 拿通行證（cf_clearance＋UA）帶回 App
  terminal/          service.js（門面）→ 獨立宿主 host*.js／Rust axondeck-term；claude-hooks.js、editor-bridge.js、
                     links.js、clipboard-image.js、admin*.js
  workspace/         files.js（resolveIn）、git.js、agents.js（五家 AI 記錄）、worktree.js、watch.js、media.js（vi-media://）
  explorer/          paths.js、fs.js、recycle.js、drives.js、watch.js、uffs.js、zip*.js、mtp.js、details.js、size.js、shell*.js
  media-player.js    本機圖片／影音分流到原生彈窗 axondeck-media.exe
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
  axondeck-probe/    Rust：sysmon／usage-scan／dir-size／disk-tree／hook／claude-hook 子指令；bin/axondeck-term、bin/axondeck-media
  explorer-shell/    .NET 殼層 sidecar（IContextMenu、縮圖、overlay、內容視窗、MTP、屬性）
  sysmon-sensors/    .NET LHM 提權 sidecar；dictation-hook/ 熱鍵 .NET 退路
```

## 各模組現況

### 本地推論（Local SI）
- 本機預覽使用既有 `%APPDATA%/axondeck-dev`（`dev-sandbox.js --packed --with-chats`），複製正式設定／專案／聊天，models／hf-models 連到 `%APPDATA%/voiceink`；Breeze 實體也在正式 models，舊 D 槽 Breeze QA profile 已清除。預覽設定與正式設定分開，模型共用。
- 子分頁：探索／推薦／執行環境。本機模型跟啟動、硬體、引擎、設定在同一頁「執行環境」。推薦有 Breeze-TTS-2 Q8_0、ASR 兩顆、翻譯 LinguaForge 0.8B／Index-Translate 2B Q4_K_M；舊 Qwen3.5 key 遷移到 Index。
- 文字轉語音：`breeze-tts/{index,protocol,ipc}.js` → `speech-page.js`／`speech.css`；`breezetts2q8`（3,568,844,480 bytes）搭配固定 v0.1.0 `breezeruntime`，SHA-256 驗證後才安裝。不寫 llama preset；NVIDIA ≥8GB + Vulkan 自動用 GPU，其餘 CPU。首次生成或保存聲音才載模型；列表直接讀保存檔，不因切頁載模型。
- Breeze 僅監聽 main 指定的 loopback 隨機埠，參考／來源 WAV 由 main 選檔、驗證再用 token 呼叫；voice name 只收 ASCII 英數／`-`／`_`。收藏在 `userData/breeze-tts/voices`；移除模型或 runtime 先 shutdown，收藏保留。生成可取消；三種語音模式串流播放，實驗性變聲整段完成後播放；PCM 最後包 24kHz mono WAV。選參考音後前 120 秒轉 16k 單聲道，用檔案轉錄同一顆 ASR 自動辨識逐字稿並轉台灣繁體後填入，可再改；失敗退回手動。進階「生成上限」預設 30000。模型與本機輸出限研究及非商用。
- NVIDIA ≥8GB VRAM 才使用 GPU（8184 MiB 門檻容許顯卡回報誤差），其餘 CPU；模型庫與 1.7B ASR 使用同一篩選規則，沒有手動 `llmGpu` 開關。
- ASR 0.6B／1.7B 均為 Q8_0 GGUF，經 `asr-select` 選模型、`llama-asr` 共用 Local SI router；兩顆皆自動 GPU／CPU。推薦名稱不帶 CPU／GPU，設定 key 不變；舊 0.6B ONNX 檔不再用於 App 的推論。
- 本地翻譯經 `local-llm-router.js` 沿用 Local SI 的 llama-server router；推薦模型以絕對檔案路徑寫入 preset，不複製模型。避免 node-llama-cpp 在 Windows 釋放 GPU context 時當機；關 App 要連只由翻譯載入的 router 一起收掉。
- 推薦模型已裝 CUDA 或 Vulkan 任一環境就能使用；補裝依 `hfmodels.hardware()` 的 `{ ok, data }` 取建議環境。預設 ASR ctx 4096、翻譯 ctx 8192，KV q8_0 與 flash attention 同開；本地翻譯約 2000 字一段，LinguaForge 的清單標記送前剝掉、翻完貼回。
- 進 Local SI 自動補建議執行環境；推薦下載補必要環境；探索下載完成後排隊 fit＋bench，最佳化期間不能換模型資料夾。暫存 userData 不自動下載。
- HF README 的 HTML 表格先轉 Markdown，再以零 innerHTML 的既有 renderer 畫列欄。



### AI 頁
- Chat 側欄上方：Local、資料夾各半排，ChatGPT／Gemini／Claude／Grok 只留圖示並排；每按一次新增一則。對話與資料夾整列右鍵（選單鍵／Shift+F10）叫 `chat-menu.js`。
- 網頁版 AI 對話存 `chats.json` 的 `web: { site, url, title }`，可改名、搬資料夾、拖曳；webview 回報網址／標題由 `ai-web.js` 把關。
- 分區 `persist:ai-<site>`，工作區瀏覽器 `persist:wsbrowser` 套同一套 `setupSession`：UA 偽裝 Chrome（Grok 改用替它過驗證的 Edge／Chrome 的 UA，存在 `grok-clearance.json`）、`ai-web-shim.js` 補 `window.chrome`、權限只給剪貼簿／全螢幕／純麥克風、`accounts.google.com` 走精簡版登入、登入小視窗在 App 內開。
- 記憶體：網頁藏超過 5 分鐘或同時超過 3 則就移除 webview（正在出聲的不收），再點照網址重建；工作區背景瀏覽器分頁閒置 10 分鐘拆掉。聊天圖片快取 LRU 約 16MB。
- 聊天：不同對話可同時回應；每對話取樣參數；第一輪後 AI 自動取標題；編輯／分叉／重新生成。

### 專案工作區與終端機
- 專案＝本機資料夾（`workspaces.json`，含 `tabsState`）；分頁列放終端機／Monaco 編輯器／瀏覽器；右側欄檔案樹（含搜尋）／Git／AI 記錄／監聽埠，主區底部是額度條 `quota-bar.js`。
- 檔案樹圖片與 MP4／WebM 直接開工作區分頁（`vi-media://`）；Markdown 圖片支援專案相對路徑；Git 面板有 GitHub 按鈕（`githubUrl`）。
- 專案全文搜尋 64KB 區塊逐行讀、新查詢停止舊查詢。AI 記錄讀 Claude Code／Codex／Grok／OpenCode／Antigravity CLI；IPC 分段讀取，renderer 自動接成完整單頁，後續只重讀末段。標題／接續／複製路徑與概況／工具統計共用置頂區塊，長標題可展開；Ctrl+F 搜尋全文與工具內容，Enter／Shift+Enter／F3 前後跳轉，命中工具自動展開，Esc 關閉。
- 終端機 PTY 在獨立宿主（`<userData>/terminal-host/`），App 重開／更新只斷線；五種 AI CLI 重開時接回原程序，程序已結束就用記住的對話 ID 接續（Claude 靠 hook，其他靠啟動前紀錄基準）。
- Claude 狀態：hook（`<userData>/claude-hook/`）＋畫面判斷 → 分頁顯示運行中／等你回答／閒置。
- 其他：WebGL renderer、搜尋、字級、最多 3 格並排、OSC 標題與 cwd、連結、Ctrl+G 用 App 內編輯分頁、剪貼簿截圖貼路徑、桌布與配色、管理員終端機。Codex 預設指令 `codex --no-daemon`（避免彈外部視窗）。
- 終端機右緣：`term-scrollbar.js` 與滑鼠滾輪共用 xterm 的實際列號；`term-conversation.js` 右上角滑入展開、離開收合，只列提問／最終回答（略過 Grok 的 system-reminder 注入），點選同步 `scrollToLine`，全螢幕的 alternate buffer 也照目前畫面定位，不送逐段滾輪、不建立第二份終端機。main 依已驗證 session id 讀正式紀錄；同視窗切換對話時，OpenCode 用 `OC | 標題`（含狀態前綴與結尾省略）、Codex 先去掉忙碌圖示再對唯一明確標題；標題只有資料夾名稱時，改看這次程序開始後、這個目錄裡唯一且較新的紀錄。Grok 先對 `~/.grok/active_sessions.json` 裡同一個 grok.exe、同一個目錄、開檔時間不早於這次程序的最新 session（OSC 標題一直停在 `grok` 也會改綁）；標題以 `標題 - grok` 結尾時同樣改綁。分頁在 OSC 只是 `grok` 這類通用名稱時顯示該對話 `summary.json` 的 `generated_title`（沒有就用 `session_summary`），使用者改過的名字仍優先。側欄與分頁的運行狀態跟該對話 `events.jsonl` 的回合與權限，回合結束就離開運行中。Antigravity 對該次 agy.exe 的 cli log，取最後一筆 `Streaming conversation`；這次 log 沒有對話代碼時，改用這個目錄在 `last_conversations.json` 的那一筆。工作區路徑和終端機目錄不同時，仍綁定這次程序已證實的對話庫並顯示紀錄。終端機清單與專案裡的同一頁會改讀該段最新內容並繼續更新。改綁寫入後通知該分頁重讀，面板關著也換；進行中的掃描不把已經讀過的舊標題交給後到的查詢。Claude 由 PTY 子程序對應 `sessions/<pid>.json`（`/resume` 會改這份）。離開的對話若在同一秒再寫入 jsonl，仍以 pid 檔為準；pid 檔沒跟著改、專案 jsonl 又晚了兩秒以上，且這個目錄只有一支 Claude 時，才改綁那份較新的紀錄。其他可讀明確 resume 參數。啟動與恢復：Codex `--no-alt-screen`、Grok `--minimal --no-alt-screen`；JS／Rust 宿主均給 Claude `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。OpenCode 維持全螢幕，宿主以 `OPENCODE_TUI_CONFIG` 載入 `opencode/navigation.mjs`（右緣拖曳軌用實際內容高度；對話清單只留 AxonDeck 右上角那一顆，外掛不再畫第二顆。依訊息 ID 跳轉；點任何一則都停在該則開頭，後面的輸出留在下面。xterm 找不到時寫 `terminal-nav/<id>.json`，外掛把內部捲軸移到該則；1.18.35 的回答沒有節點 ID 時，只接受同一提問內第一行唯一吻合的區塊）。專案側欄的 AI 紀錄每家各留最新 30 筆，面板開著時會再讀。全螢幕只收起 AxonDeck 捲軸，對話清單留著；點擊、拖曳與滾輪交給 CLI，Shift＋拖曳仍做本地選取。本機 Antigravity 已備份設定並設 `altScreenMode: never`（其他機器仍需同項 CLI 設定）。一般緩衝區保留 50000 列。經使用者同意，開啟時將正式保存的提問／回答（移除 ANSI 控制碼）逐頁補入同一個 xterm 的上方，再接原 PTY 畫面與即時輸出；以 marker 定位重複提問，保留可輸入的原 CLI。若 CLI 內切換舊對話後目標尚未載入，點選會補回保存紀錄與原 PTY 快照（期間即時輸出排隊、按 seq 去重），再一次跳轉；不重啟 PTY。超過緩衝區上限或仍無法定位時明示找不到。已運行的 CLI 要重啟接回後才套用原生模式。

### 檔案頁
- 分頁、雙欄（作用欄＋各自分頁組）、首頁「本機」（插拔即時更新）、清單／方格（Ctrl+滾輪 48～256px）、每個資料夾記自己的檢視／大小／排序（`explorer.json` 的 `folderViews`）。
- 刪除進系統回收筒、Ctrl+Z 復原、撞名可改名／略過／覆蓋（覆蓋先把舊的丟回收筒）、操作中心在狀態列。
- 殼層 sidecar 提供原生右鍵（7-Zip／WinRAR／傳送到）、真縮圖＋Drive 綠勾、內容視窗、詳細資訊（EXIF／影音串流／版本）、手機 MTP。ZIP 唯讀瀏覽與解壓。
- UFFS：進頁只準備授權，搜尋時才載索引，閒置 60 秒或 App 結束時休眠。

### 原生媒體播放器
- `native/axondeck-probe/src/bin/axondeck-media/`：Rust＋Win32，mpv／ImageMagick 解碼，放 Windows Job object；跟主 App 完全分開。
- 自繪選單、播放清單（搜尋、拖入、續播）、倍速滑桿、快捷鍵表；偏好存 `%LOCALAPPDATA%/AxonDeck Media/preferences.json`。
- 預設關聯：新安裝或首次更新背景套用（同時寫 UserChoice 與 UserChoiceLatest 有效 Hash 並回讀），備份在 `association-backups/`，之後不覆寫使用者自選；解除安裝還原。
- `npm run build:media` 固定 runtime 版本與 SHA-256；GPL 授權見 `resources/media-NOTICE.txt`。

### 系統監控
- 取樣器 `axondeck-probe.exe sysmon` 開機常駐、沒人看 30 秒一輪；nvidia-smi 常駐；多 GPU 各自一卡。
- 提權感測器 sidecar 走排程工作，斷線一直重拉；風扇曲線每秒重送；效能調整不開機自動套用。
- 處理程序：`sysmon-procs.js` 管理圖示、整機占用與保存的欄序（名稱固定第一欄）；取樣器帶執行檔路徑，main 非同步快取圖示。網路沿用感測器 sidecar 的 Kernel-Network ETW（TCP／UDP、IPv4／IPv6），未啟用、權限不足、遺失事件或資料過期顯示「—」，不新增 UAC。
- 磁碟空間：`axondeck-probe disk-tree` 平行掃＋treemap，刪除只丟回收筒。強制結束權限不足會跳一次 UAC。

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
- 檔案轉錄／錄音／字幕各一張功能卡，操作與紀錄上下合併；三欄間距 12px，900px 以下依功能單欄堆疊。錄音 `recAudioSource`（預設 mic）與字幕 `liveAudioSource`（預設 system）均有 mic／system／both；共用 `recording-audio.js` 將兩路各半合進單一音軌，字幕保留麥克風降噪，停止或啟動失敗都釋放輸入軌與混音 context。兩顆開始按鈕均 64px 高，狀態與音源列對齊。
- 語音輸入：右 Alt → 錄音 → ASR → 字典 → LLM 整理 → 插入（自己視窗直接插、外部才走剪貼簿）；HUD 每次載入重送狀態。
- 檔案轉錄：ffmpeg 串流切段；雲端遇 429／逾時／5xx 同段重試，仍失敗保留已完成內容。錄音機跟檔案轉入同一頁，錄音可拖過去（只帶檔名，路徑由 main 解析）。錄音與字幕邊錄邊 append。
- 錄音清單可下載原始 webm；仍由 main 驗證檔名並讀取，不接受 renderer 提供路徑。
- 轉錄與即時字幕共用模型（`fileAsr`／`fileLlm` 為準，開機 `alignSharedStt` 抄到 live；目標語言 `sttLanguage`）。語音輸入仍各自選（`dictationAsr`／`dictationLlm`）。值 `local:<key>`／`cloud:<設定 id>:<模型 id>`。

### Telegram
- 一格載完等 1.5 秒再載下一格；✕ 先導 `about:blank` 再拿掉；每 20 秒探各格，卡「等待網路連線」60 秒或格子當掉就全部依序重載（兩次隔 5 分鐘）；當機記到 `userData/crash.log`。
- 切走時用 `opacity:0`＋`position:absolute` 藏（`display:none` 會丟圖塊，切回來卡頓）。

### 更新與安裝
- 手動「重新啟動並安裝」顯示進度、裝完自己開回；結束 App 時靜默安裝；關機／登出不安裝。
- `electron:build` 走 `pack-preview.js --release`：磁碟根完整 NSIS → 驗 asar／`app-update.yml`／latest.yml 雜湊 → 同步回 dist → 清理。

## 資料落點（`%APPDATA%/axondeck/`）

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
| v1.44.0 | 10-10 | 文字轉語音（Breeze-TTS-2 Q8 四模式、串流試聽、WAV 匯出、逐字稿自動辨識）；EdgeTTS 收進翻譯頁 |
| v1.42.0 | 10-07 | CC Proxy：MCP 管四家 CLI、Skills 開關＋全域記憶、CLI 版本搬設定頁；Local SI 子分頁執行環境擺第一 |
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
