# CONTEXT.md — 交接文件

> 只寫「現在長什麼樣」。規則與地雷見 [AGENTS.md](./AGENTS.md)，判斷原則見 [tasks/lessons.md](./tasks/lessons.md)，歷史查 git log。

## 概況

AxonDeck（v1.40 前叫 VoiceInk，留舊名的相容點見 AGENTS.md「打包／建置」）：Windows Electron AI 工作台。Vanilla JS + Vite，Electron 43.7.5。目前版本 **v1.65.0**（2026-10-23）。
nav 十頁（順序可拖曳，存 localStorage `navOrder`；圖示是 SVG，`ws-tool-icons.js` 的 `toolIcon`）：

| 頁 | `data-page` | 一句話 |
|---|---|---|
| SI | `chat` | 側欄 Agent（專案）／Chat（對話）；主區三選一 `setChatPaneMode('chat'\|'workspace'\|'web')` |
| Telegram | `telegram` | Web A 放 `<webview>`，最多 4 格並排、共用 `persist:telegram` |
| 檔案 | `explorer` | 整機檔案總管＋UFFS 檔名搜尋 |
| 語音轉文字 | `stt` | 轉錄、錄音、即時字幕、語音輸入同一頁（辨識／翻譯／目標語言共用；語音輸入的模型與輸出語言獨立） |
| 翻譯 | `translate` | local（LinguaForge）／cloud 翻譯；EdgeTTS 與模型按鈕同一排、按鈕寬度貼文字，展開浮在內容上。語音是繁中、簡中、英文、日文 |
| 文字轉語音 | `speech` | Breeze-TTS-2 Q8：聲音設計、語音克隆、語氣指導、保存聲音、實驗性變聲；整段／逐句／字幕配音、讀音字典、錄音與裁切參考音、版本保留與單句重做、串流試聽與 WAV 匯出 |
| 生成圖片影像 | `imagegen` | 內嵌 Miroxen 工作台（Qwen-Image-2.1 圖片、MiniMax-H3 影音）；引擎與模型都在 Local SI 執行環境 |
| 系統監控 | `sysmon` | 總覽／使用時長／處理程序／風扇／效能與壓力測試／磁碟空間 |
| Local SI（原 HF模型） | `hfmodels` | 搜 GGUF → 下載 → llama-server router 一顆程序管全部模型 |
| 設定 | `settings` | 雲端端點、終端機配色與桌布、AGY 反代、CLI 版本；本地模型與推論方式在 Local SI；EdgeTTS 在翻譯頁 |

滑鼠側鍵（上一頁／下一頁）：`nav-history.js` 記「頁＋AI 主區＋對話」足跡（功能頁模式下每個 renderer 只記自己那頁，跨頁的足跡在 main `pages.history`）；檔案頁先退資料夾歷史，webview 裡按由 main 的 `before-mouse-event` 先讓網頁自己退，退到底才 `nav:side` 換 App 頁。回歸 `scripts/e2e-side-nav-cdp.js`。
功能頁獨立視窗（`src/main/page-windows.js`）：每頁一個 WebContentsView，主視窗外殼是 `index.html?host=1`（不畫頁面）。`app.js` 第一個 import 的 `page-content.js` 在其他模組抓 DOM 前移除非本頁 `.page`，外置對話框用 `data-page-content` 指定所屬頁；無分頁參數的相容模式保留完整介面。設定頁只初始化供應商表單，桌布預覽只在外觀區啟用時載入；切頁仍保留同一個 renderer 與草稿。右鍵彈出的視窗標題＝導覽鈕的 aria-label＋` — AxonDeck`（工作列靠它分辨）。CDP 測試三個坑：①切頁要獨立一個 eval（同一個 eval 裡點完別頁再讀，讀到的是被藏起來的舊頁；`scripts/lib/page-cdp.js` 會跟著主視窗目前的頁換 target），被藏的頁要切回來走 `pages.navigate`；②模擬 main 推送要廣播給每個 `index.html` 的 webContents（跟 `sendToPages` 一樣），只送外殼頁面收不到；③`--hidden` 視窗不畫、不收合成滑鼠事件、不發 scroll／IntersectionObserver，要量這些先用 main inspector `showInactive()`。
設定頁雲端分區是整份 `providerDraft` 寫回 `cloudProviders`：功能頁切走（`visibilitychange` hidden）時有沒存的修改就當下存，不能等被節流的計時器，否則會用舊草稿蓋掉別頁或 main 期間寫進來的供應商。

## 模組地圖

```
src/main/
  main.js            frameless 主窗、IPC 註冊、store allowlist、單一實例鎖、系統匣、網頁分區 setupSession
  ipc-invoke.js      模組 IPC 共用外殼；raw-fs.js（不鎖 asar）；safe-rm.js（不穿 junction）
  anthropic-stream.js／local-proxy-http.js   CC Proxy 閘道與 AGY 共用：中性 delta→Anthropic SSE、本機代理 Host／金鑰／JSON
  updater.js / update-mirrors.js   electron-updater＋GitHub latest.yml；安裝檔走鏡像、差分下載關閉
  chat*.js           雲端聊天 SSE（每對話一條 inflight）、會話＋側欄資料夾、取樣參數／思考檔位、自動標題、圖片、chat-imagegen（生圖退 images 端點、參考圖）
  ai-web.js          網頁版 AI：網址把關、標題、Google 登入修正、登入小視窗、分區 UA
  grok-clearance.js  Grok 被 Cloudflare 擋時開 Edge／Chrome 拿通行證（cf_clearance＋UA）帶回 App
  terminal/          service.js（門面）→ 獨立宿主 host*.js／Rust axondeck-term；claude-hooks.js、editor-bridge.js、
                     links.js、clipboard-image.js、admin*.js
  workspace/         files.js（resolveIn）、git.js、agents.js（五家 AI 記錄）、worktree.js、watch.js、media.js（vi-media://）、office-convert.js（Office 轉 PDF／xlsx）
  explorer/          paths.js、fs.js、recycle.js、drives.js、watch.js、uffs.js、zip*.js、mtp.js、details.js、size.js、shell*.js
  media-player.js    本機圖片／影音分流到原生彈窗 axondeck-media.exe
  hfmodels/          hub／gguf／fit／download.js（共用續傳＋分段下載）／presets／runtime（router）
  miroxen/           runtime.js（跟 GitHub latest release 裝／更新）／index.js（serve 程序、狀態）／ipc.js
  pdf-translate/     index.js（工作／來源保護）／ipc.js／protocol.js／runtime.js（隔離 Python）／worker.py（逐頁 OCR 與 PDF 替換）
  screen-translate/  index.js（取景窗／工作生命週期）／capture.js（挖空形狀／DPI 擷取／畫面去重）／ipc.js
  ccswitch/          claude-settings.js、providers.js（routeFor）、models-scan.js、mcp.js、versions.js、gateway/
  codeusage/         scan.js（游標）、parsers.js（五家）、pricing.js（RULES_VERSION）
  usage/             七家額度、claude-auth.js（續期）、claude-accounts.js（Claude 多帳號）、codex-reset.js（app-server 兌換）
  agy/               server.js、轉換器、catalog.js／model-map.js、credential.js（renewViaCli）、logs.js
  sysmon/            sampler.js、metrics.js、gpu.js、sensors.js（提權 sidecar）、fans.js、oc.js、disktree.js、stress.js
  screentime/        Tai 相容 SQLite、前景觀測、8908 WebSocket
  dictation/         管線、hotkey.js、insert.js、text.js（字典／切段）、hud.js
  asr-select.js／model-scope.js／llama-asr／cloud-asr／file-transcribe／stt-archive／local-llm／edge-tts
src/renderer/scripts/
  app.js  chat-page.js  chat-sidebar.js  chat-menu.js  ai-web-page.js  telegram-page.js  markdown.js
  workspace-page.js  ws-tabs.js  ws-monaco.js  ws-review.js  ws-git-status.js  terminal-page.js  term-*.js
  explorer-page.js  explorer-*.js  quota-bar.js  code-usage-page.js  ccswitch-page.js  cc-model-groups.js
  sysmon-*.js  disk-treemap.js  stt-page.js  recorder.js  live-caption.js  live-history.js  dictation.js  custom-select.js  app-dialog.js
native/
  axondeck-probe/    Rust：sysmon／usage-scan／dir-size／disk-tree／search（專案全文搜尋，平行讀檔）／procs-json（終端機認 AI 對話的程序清單）／raise-window（Ctrl+G 抬視窗）／list-dir（檔案頁超過 300 項的資料夾）；沒 exe 各自退回 JS／PowerShell／hook／claude-hook 子指令；bin/axondeck-term、bin/axondeck-media
  explorer-shell/    .NET 殼層 sidecar（IContextMenu、縮圖、overlay、內容視窗、MTP、屬性）
  sysmon-sensors/    .NET LHM 提權 sidecar；dictation-hook/ 熱鍵 .NET 退路
```

## 各模組現況

- 螢幕翻譯：翻譯頁頁首開啟 `pages/screen-translate.html`，原生 `setShape` 挖空取景區、`setOpacity(0.92)` 半透明工具列與譯文區，必須 `setBackgroundMaterial('none')` 才不會被 Windows 材質塗灰；保留原生縮放與中央滑鼠穿透，`showInactive` 開啟不搶焦點；`setContentProtection` 排除自身畫面。PaddleOCR-VL 直接經共用 llama router 讀取記憶體中的截圖，不用 Python／layout 模型、不落盤；每輪完成後隔一秒檢查變動，相同原文不重翻。翻譯模型與術語表於開啟時取快照，獨立 `screen` engine owner 防切頁卸載；暫停／移動／關閉中止當輪請求，錯誤暫停等待重試，共用模型操作先要求關閉取景窗。目前 Windows，框內需位於同一個螢幕。驗證：`test-screen-translate.js`、`e2e-screen-translate-cdp.js`（真擷取／OCR／本地翻譯）。

### 本地推論（Local SI）
- 本機預覽使用既有 `%APPDATA%/axondeck-dev`（`dev-sandbox.js --packed --with-chats`），複製正式設定／專案／聊天，models／hf-models 連到 `%APPDATA%/voiceink`；Breeze 實體也在正式 models，舊 D 槽 Breeze QA profile 已清除。預覽設定與正式設定分開，模型共用。
- 子分頁：執行環境／探索。本機模型、推薦模型跟啟動、硬體、引擎、設定在同一頁「執行環境」（舊的 `switchPage('hfmodels','recommend')` 導到執行環境並捲到 `#hf-recommend`）。推薦模型標「運行中」靠儀表板輪詢的 router 模型狀態（id＝推薦 key）＋ `breeze:status` 的 ready；卸載走 `hfmodels.unloadModel(key)`／`breeze:unload`（只停程序不刪檔）。推薦有 Breeze-TTS-2 Q8_0、ASR 兩顆、翻譯 LinguaForge 0.8B／Index-Translate 2B Q4_K_M；舊 Qwen3.5 key 遷移到 Index。
- Index-Translate 譯文修補：行首「A. 」「1. 」先剝掉再貼回（共用 LinguaForge 的 `packLinguaforge`）；譯文殘留原文小寫英文單字或日文假名時，改用官方 instTrans 約束格式重翻（先寬鬆版，不行再加「只能用繁中」，後者對正常片段會冒粵語「係」）；出口用 `jpKanjiToTw` 把日文新字體逐字換回繁體（排除臺灣本來在用的字）。`translate-clean` 原文本來就是「A. 」開頭時不當答題標籤剝掉。
- 翻譯術語表（`glossary.js`）：翻譯頁頁首「術語表」卡片。自訂詞條 `translateGlossary`（每行 英文=繁中，沒設定過＝內建數理清單，存 null 恢復）優先，再補內建學術名詞庫 `translateGlossaryBuiltin`（預設開）：`glossary-data/naer-terms.tsv.gz` 由 `scripts/build-glossary-data.js` 下載國家教育研究院理工 45 科整併，只收至少兩個學科都有的詞（只出自一科的常是該科特有用法：電子計算機的 order information＝訂單資訊；實測雲端模型拿到就照抄，標成「參考」或附學科名也一樣，不給反而依上下文翻對；54.6 萬→20.8 萬條），只收 2–5 字片語（單字在一般文章常是別的意思）、頭尾功能詞不收、每條最多 3 個候選；執行時整段文字＋行首位移二分搜尋（Map 多吃約 60MB）；翻譯開始前 `warm()` 背景解壓，載入後常駐約 17MB 不閒置釋放。只在目標繁中套用；雲端進 system prompt（多候選依上下文挑），Index 只給唯一譯名、用 instTrans 術語約束，LinguaForge 不套。資料授權：政府資料開放授權條款第 1 版，README 技術棧有標示出處。
- 文字轉語音：`breeze-tts/{index,protocol,takes,ipc}.js` → `speech-page.js`（流程）＋`speech-{script,takes,audio-input,wave}.js`／`speech.css`；`breezetts2q8`（3,568,844,480 bytes）搭配固定 v0.1.0 `breezeruntime`，SHA-256 驗證後才安裝。不寫 llama preset；NVIDIA ≥8GB + Vulkan 自動用 GPU，其餘 CPU。首次生成或保存聲音才載模型；列表直接讀保存檔，不因切頁載模型。
- Breeze 僅監聽 main 指定的 loopback 隨機埠，參考／來源錄音由 main 選檔（WAV 直讀；MP3／M4A 等先用 ffmpeg 轉 24kHz 單聲道，上限約 23 分鐘）、驗證再用 token 呼叫；voice name 只收 ASCII 英數／`-`／`_`。收藏在 `userData/breeze-tts/voices`；移除模型或 runtime 先 shutdown，收藏保留。生成可取消；三種語音模式串流播放，實驗性變聲整段完成後播放；PCM 最後包 24kHz mono WAV。選參考音後前 120 秒轉 16k 單聲道，用檔案轉錄同一顆 ASR 自動辨識逐字稿並轉台灣繁體後填入，可再改；失敗退回手動。進階「生成上限」預設 30000。模型與本機輸出限研究及非商用。
- 版面參考 yovoice：左稿子、右設定（生成鈕在最上）、下方結果區（版本選單＋波形播放＋分句清單）。每次生成都存成版本 `userData/breeze-tts/takes`（index.json＋WAV，最多 50 版，最舊的自動刪）；版本記每句在音檔裡的位置，重做單句只生成那一句（換隨機種子），其他句從舊版本切出來重組成新版本。逐句／字幕是 renderer 依序呼叫 `generate`，main 先把各句 PCM 留在記憶體（上限 256MB），`saveTake` 合併後就丟；中途停止會把完成的句子存成版本。字幕（SRT／VTT／ASS）依時間放、前句沒講完就順延；角色可指定保存的聲音（指定後該角色用克隆）。讀音字典存 `speechPronunciations`（main 端過濾），生成時才換字、原稿不動。錄音（MediaRecorder）與裁切都在 main 用 ffmpeg 從原始檔重新解碼。
- 驗證：`node scripts/test-breeze-tts.js`、`node scripts/test-speech-script.js`、`AXONDECK_DEV=1 node scripts/e2e-speech-cdp.js`（原始碼＋vite，不用打包；不設就測 `dist/win-unpacked`）。
- NVIDIA ≥8GB VRAM 才使用 GPU（8184 MiB 門檻容許顯卡回報誤差），其餘 CPU；模型庫與 1.7B ASR 使用同一篩選規則，沒有手動 `llmGpu` 開關。
- ASR 0.6B／1.7B 均為 Q8_0 GGUF，經 `asr-select` 選模型、`llama-asr` 共用 Local SI router；兩顆皆自動 GPU／CPU。推薦名稱不帶 CPU／GPU，設定 key 不變。sherpa-onnx 與 node-llama-cpp 已整個移除（套件、`local-asr.js`、`llama-addon.js`）。
- 本地翻譯經 `local-llm-router.js` 沿用 Local SI 的 llama-server router；推薦模型以絕對檔案路徑寫入 preset，不複製模型。關 App 要連只由翻譯載入的 router 一起收掉。
- PDF 翻譯：`pdf-translate.js` 共用翻譯頁語言與模型；輸入框工具列「＋ 檔案」、拖入或貼上圖片（`pasteImage` 只收 `data:image` base64，檔頭定副檔名，暫存 userData；PDF／png／jpg／webp／bmp／tiff，驗副檔名＋檔頭），附件 chip 上有自己的「翻譯檔案／停止」鈕，進度、警告、另存放在譯文格；主「翻譯」鈕只翻文字，檔案處理中仍可用；main 凍結模型設定、驗來源後複製到每工作暫存，逐頁版面偵測（只跑 PP-DocLayoutV3）／翻譯／替換／落盤；有文字層的區塊只用原生文字，VL OCR 只補沒有文字層的掃描頁與圖片（用到才載入）；數學變數、函數名、微分記號不送翻譯；80 字以下的短片段附整頁原文（前 1500 字）當參考，只有雲端用得上（LinguaForge 單輪格式會把參考當成要翻的字；Index-Translate 2B 試過官方 instTrans 約束格式，仍會把約束段落吐成譯文）；worker 這一頁在等翻譯時先做下一頁的版面偵測並送出請求（`Translations` 收別頁回覆先存著）；雲端把同一頁的段落用 <<編號>> 合成一個請求（`translateSegments`，每批 ≤3000 字／40 段，漏段、原樣或殘留英文的再單獨翻），跟公式同一行的片段（worker 標 `alone` 與 `line` 行號）可以合併，但同一批裡每一行最多一段，以免模型在被公式切開的兩段間搬字；雲端並行 4 批、429／5xx 退避重試，本地一次一段；譯文放不下先往右延伸到同行下一個字／包住它的框線／頁面右界，再縮到最小 3pt，正常文件不再保留原文；縮寫原樣回傳、公式跳過不算沒翻到；可選加裝 `pdfruntimegpu`（PDF GPU 加速，只在 NVIDIA 驅動夠新時列出）：同一套 runtime.js 安裝流程換成 paddlepaddle-gpu 3.3.1 cu129（支援 RTX 50 系列）＋nvidia-*-cu12，約 2.5 GB 下載、5 GB 空間，安裝時驗證抓得到顯示卡；兩版套件都照 `requirements-cpu.txt`／`requirements-gpu.txt`（版本＋官方 SHA-256；`--exclude-newer` 兩週前，其餘沿用實測版本）以 `--require-hashes` 安裝，下載點由 `rankedIndexes` 依序各量 3 MB 挑清華／中科大／騰訊最快的，失敗換下一個，PyPI 官方墊底（官方在亞洲約 0.1 MB/s；量 256 KB 只量到延遲會挑錯；實測 CPU 版 82 秒、GPU 版 3.5 分鐘裝好），裝好後 `prune` 刪 wheelhouse、uv 快取與 uv 本身（venv 是硬連結，不受影響）；Python 程序一律帶 `isolatedEnv`（USERPROFILE 指到環境的 home：`import paddle` 會在家目錄建 .cache/paddle、家目錄不存在就改寫 %TEMP%），使用者資料夾不留東西；裝了就由 `pdfRuntime()` 選它並傳 `layoutDevice: gpu`，worker 版面偵測 4.3→0.09 秒／頁（結果與 CPU 相同），GPU 起不來自動退回 CPU；CPU 版仍是 OCR 模型下載時的必備環境；CPU 版面偵測約 4.3 秒一頁（執行緒、MKLDNN、縮圖都無效，多程序僅 1.6 倍且吃滿 CPU；較小的 PP-DocLayout-S／M／L／plus-L 要關 MKLDNN 才跑得動，快 1.4～13 倍，但 S／M 漏一半公式框、L／plus-L 把標題與句子誤判成公式留下英文，不換）；數學一律不翻：每個詞都是數學記號（「, sin」）的片段也不送；雲端多段合併的譯文逐段做簡轉繁（整批轉時「证明了」變「證明瞭」），opencc 後再把「X明瞭」動詞改回；原文沒有 $ 卻出現的 LaTeX 記號拿掉；每頁先子集化字型、最後整份去重重寫（原本每段譯文各嵌 3.5MB 字型，22 頁 1.1GB→1.6MB）；worker 以 `-I` 啟動會忽略 PYTHONIOENCODING，stdin 必須在程式內設 UTF-8，否則譯文亂碼；Windows 上 worker 用 detached 啟動，避免共用主控台被 llama 的 Ctrl-C 波及；取消會中止翻譯請求及自己的 Python 程序，另存禁止覆蓋來源。`engine` 新增 `pdf` owner，切頁不卸載使用中的翻譯模型，工作期間禁止重啟／調參／移除共用環境。參考 BabelDOC（AGPL，只借做法不搬程式碼）：附件下方「頁碼」（`1-3, 5, 8-`，`protocol.parsePages`；沒選的頁原樣輸出）與「雙語對照」（`interleave`：原文頁後接譯文頁，書籤指到譯文頁，跨頁連結與頁碼標籤不保留）；worker 開頭送 `document`（metadata 標題，不可信就用第一頁最大字；選定頁文字層前 3 萬字），main 收到前不送翻；雲端用它抽術語（`terms.js`，最多 3 段×1 萬字並行，JSON 只收原文出現過、不含「=」的詞，參考只給使用者詞條：內建詞庫的跨學科通用譯名會把模型帶偏，order information→訂單資訊），術語優先順序 使用者詞條＞文件術語＞內建詞庫，標題進 system prompt；本地模型都不帶。譯文快取 `cache.js`（`node:sqlite`，userData/pdf-translate-cache.sqlite，key＝模型＋語言＋術語設定＋標題＋文件術語＋原文＋參考，30 天沒用就清、上限 20 萬筆；術語抽取結果也進快取，重翻同一份文件術語不變才打得中；附件下方「清除譯文快取」走 `pdfTranslate:clearCache`，翻譯中不能清）。雙欄換欄、換頁切開的句子（正文段落 `body`、前段沒有句末標點、後段小寫開頭；跟公式同一行的不接、不串成鏈）接起來送一次，譯文照原文長度比例在最近的標點切回兩邊；頁尾那段先不送，等下一頁開好才決定。模型多吐的 `<<編號>>`、`<reference>`、`$`（原文沒有的）由 `dropArtifacts` 拿掉。中文避頭尾 MuPDF 的 `insert_htmlbox` 本來就照 UAX#14 處理（「，」不上行首、「（」不留行尾），不另做。
- PDF 模型：`paddleocrvl16` 官方 GGUF＋mmproj 共用 llama router；`ppdoclayoutv3` 固定 layout 權重，`pdfruntime` 固定 uv／Python 3.12.12／PaddlePaddle 3.3.1／PaddleOCR 3.7.0／PyMuPDF 1.28.2，全部留在 models，無系統 Python 前置條件。文字型 PDF 使用字元位置，掃描頁與圖軸使用 OCR Spotting；公式框不替換，向量線條不刪除。文字溢出／位置不可靠保留原文且回報，特殊背景與數學排版仍需核對；不承諾任意文件完全相同。保留 metadata、書籤、頁碼標籤與跨頁連結。
- 推薦模型已裝 CUDA 或 Vulkan 任一環境就能使用；補裝依 `hfmodels.hardware()` 的 `{ ok, data }` 取建議環境。預設 ASR ctx 4096、翻譯 ctx 8192，KV q8_0 與 flash attention 同開，`[*]` 設 `cache-ram = 512`（預設 8GB 會被翻譯一路塞滿）；儀表板顯存以 nvidia-smi 為準（WDDM 下 llama 回報的 free 看不到別的程式）、`--list-devices` 30 秒才重抓；本地翻譯約 2000 字一段，LinguaForge 的清單標記送前剝掉、翻完貼回。
- 進 Local SI 自動補建議執行環境；推薦下載補必要環境；探索下載完成後排隊 fit＋bench，最佳化期間不能換模型資料夾。暫存 userData 不自動下載。
- HF README 的 HTML 表格先轉 Markdown，再以零 innerHTML 的既有 renderer 畫列欄。
- Markdown 預覽（工作區編輯分頁、獨立編輯視窗、檔案頁、HF README）傳 `{ html: true }`：內嵌 HTML 用 DOMParser 解成 inert 文件再照白名單重建（`markdown-html.js`，標籤／屬性／網址都過表，圖片沿用 `vi-media` 路徑守衛），`<details>` 跨段落會把中間的 Markdown 畫進去；聊天不開。```mermaid 在隱藏的 srcdoc iframe 裡跑（`mermaid-frame.js`；同頁跑會撞 Monaco 的 AMD `define`），SVG 以 data URL 的 `<img>` 顯示。mermaid 是 devDependency，打包只用 `build.files` 的 FileSet 帶 `mermaid.esm.min`（約 3.6MB，FileSet 要放在 files 陣列最後，否則後面的排除規則失效）。其餘語法：巢狀／待辦清單、參考式連結、自動連結、提示框、腳註、底線式標題、#錨點（data-anchor，不用 id 免得撞 App 元素）、:emoji:（gemoji）、碼塊上色（highlight.js cdn-assets ESM，罕見語言按需載）、文件模式另有 $／$ 數學（KaTeX 只輸出 MathML，DOMParser 解後白名單重建）、縮排碼塊、front matter、軟換行當空白；聊天不吃跳脫字元（Windows 路徑的 `\.`）。katex／highlight.js／gemoji 同樣是 devDependency＋FileSet。語法比對式在 `markdown-syntax.js`，INLINE_SRC 的群組編號就是分派依據。相對路徑連結交給呼叫端的 `openLink`（`resolveLinkPath` 解路徑）：工作區開分頁／檔案樹選資料夾、檔案頁就地預覽或交給檔案頁、編輯視窗走 `editorFile:openLink`（main 照檔案位置解，只開編輯器收得了的格式）、HF README 接在 main 給的 `readmeBase` 後面開內建瀏覽器。mermaid 圖登記在 markdown-mermaid.js，`data-theme` 一變就重畫。



### 生成圖片影像（Miroxen）
- `imagegen-page.js` 用 iframe 內嵌 `http://127.0.0.1:<port>/?embed=1&theme=…&c-*=…#key=…`：Miroxen 工作台在 embed 模式藏品牌、吃 App 主題色，App 換主題時 postMessage `miroxen:theme`。網址沒變不重載 iframe。App 不另做頂列：重新啟動／停止在工作台頂列、輸出資料夾在作品庫，按了回送 `miroxen:host`（App 驗 source 與 origin 才執行）。工作台內嵌時藏「模型與硬體」「API」分頁：模型清單改成右上角模型按鈕的 popover；硬體看 Local SI 的占用；API 在 Local SI 執行環境的「圖片影像 API」面板（`hf-miroxen-api.js`）。
- 區網：store `miroxenLan`，開了引擎改聽 `0.0.0.0:8188`（被占退隨機埠），切換時正在跑就重開（佇列有工作拒絕）。API key 存 store `miroxenApiKey`，固定不變，區網裝置填同一組。`/`、`/files/` 不驗金鑰（Miroxen 設計），區網打開時同網段看得到輸出檔。
- 引擎 `miroxenruntime`：只有 NVIDIA 驅動 ≥580 才列在執行環境；狀態寫目前 tag，有新版多一顆「更新到 vX」（進生成頁時另跳一次提示）。zip 內含 miroxen.exe＋web、cuBLAS、VC runtime、ffmpeg／ffprobe，PATH 前接 runtime 資料夾。
- 模型：Qwen-Image-2.1 Turbo／標準（共用編碼器、VAE、tokenizer）、MiniMax-H3、H3 加速 LoRA，全部固定 revision＋SHA-256，放 `models/miroxen/`（`image/…`、`video/…`、`loras/…`，結構同 Miroxen repo）。H3 的 VAE config 用 `MX_H3_*_CONFIG` 環境變數給絕對路徑。輸出在 `userData/miroxen/out`。
- 開發機 `%APPDATA%/voiceink/models/miroxen` 是接到 `D:\Workspace\Personal_Project\Miroxen\models` 的 junction（免重下 75 GB）。

### AI 頁
- Chat 側欄上方：Local、資料夾各半排，ChatGPT／Gemini／Claude／Grok 只留圖示並排；每按一次新增一則。網頁版對話列在標題左邊放該家 logo，不再顯示「XX 網頁版」小字。對話與資料夾整列右鍵（選單鍵／Shift+F10）叫 `chat-menu.js`。
- Local 對話輸入列：思考強度選單（`chat-composer-menus.js`，8 檔，存 `chatThinking`）；選到生圖模型換成比例／解析度選單（`chatImageOptions`；選 auto 的項目從提示詞猜：寫了比例／橫式直式／4K／透明背景就照送，`resolveOptions`）。沒附圖時自動拿上一張生成圖當參考圖（接著改）；存好的圖右上角有下載鈕（`chat:saveImage`，只收檔名、main 驗格式後複製）。訊息置中 880px 閱讀欄、使用者訊息靠右泡泡、助理回覆不包框。
- 網頁版 AI 對話存 `chats.json` 的 `web: { site, url, title }`，可改名、搬資料夾、拖曳；webview 回報網址／標題由 `ai-web.js` 把關。
- Chat 側欄：第一排五顆新增鈕（Local＋四家網頁版）、資料夾鈕在搜尋框旁、Arena（`llm-arena-opal.vercel.app`）釘在清單上方。Arena 只開一個（不像網頁版 AI 每按一次多一則）：`ai-web-page.js` 的 `openArena`（id `__arena`、`persist:ai-arena`），不進 chats.json、不存網址／標題；看 Arena 時 `#chatPanel.is-arena`。
- 分區 `persist:ai-<site>`，工作區瀏覽器 `persist:wsbrowser` 套同一套 `setupSession`：UA 偽裝 Chrome（Grok 改用替它過驗證的 Edge／Chrome 的 UA，存在 `grok-clearance.json`）、`ai-web-shim.js` 補 `window.chrome` 與 `navigator.userAgentData` 的 Google Chrome 品牌、https 請求補 `Sec-CH-UA`（品牌順序照 Chromium 算法，跟 JS 同一份）、Accept-Language 對齊 `navigator.languages`、權限只給剪貼簿／全螢幕／純麥克風、`accounts.google.com` 走精簡版登入、登入小視窗在 App 內開。
- 外連（App 內 `target=_blank`、各 webview 的 popup、終端機網址、Git 面板 GitHub 鈕）在哪點就開在哪（`openInProjectBrowser` → `pages:navigate` 的 `action: 'browser'`＋`target` → app.js `openUrlInApp`）：SI 頁 Agent 模式（工作區）→ 專案瀏覽器分頁（`openUrlInProject`，沒有任何專案才退回系統瀏覽器）；對話／網頁版 AI → 右側瀏覽器（`chat-browser.js`）；側欄 Browser 模式、以及 SI 頁以外（Telegram 等，main 的 `linkTarget` 給 `target: 'browser'`）→ Browser 模式新分頁（`browser-page.js`，分頁與群組存 localStorage `browserTabs`；比照 Edge 垂直分頁：可拖曳排序／分組、沒固定時側欄收成圖示、滑鼠移上去展開——收合用 class `sidebar-browser`／`bt-open` 不用 `:has()`／`:hover`，`.chat-layout` 不可加 position，否則 webview 畫不出來；分頁右鍵「彈出獨立視窗」走 main `browser-window.js`：工具列是 `pages/browser-window.html`（preload `browser-window-preload.js`，只能動自己那扇窗），網頁是 main 自建的 WebContentsView——<webview> 搬不了視窗、載過東西就不能 `navigationHistory.restore`，所以用 view 在首次載入前還原原分頁整串歷史（含 pageState），再補彈出當下量的捲動／欄位／影音；視窗標題跟網頁標題，擴充功能圖示列共用 `browser-actions.js`）。三處都是 `persist:wsbrowser`，登入與擴充功能共用；Browser 模式與專案瀏覽器的空白分頁都開 Infinity New Tab Pro（`NEWTAB_URL`，網址列留空）。登入視窗三種情況都接住：①`window.open` 帶視窗大小（`new-window`）、先開 `about:blank` 再導、或登入／授權頁（`ai-web.js` `isLoginPopup`：已知登入網域＋路徑某段是 oauth／authorize／auth／login／signin／sso）→ 比照 Chrome 開成 App 內小視窗並保留 opener（postMessage 回傳），網頁版 AI 分區同樣適用，其餘連結才轉分頁；②擴充功能的 `chrome.identity.launchWebAuthFlow`／`getRedirectURL`（Electron 沒有）由 `preload/crx-identity.js`＋`main/crx-identity.js` 補上：登入小視窗導到 `https://<ID>.chromiumapp.org/` 就攔下網址交回，ID 由呼叫端網址／SW scope 取；preload 必須在 electron-chrome-extensions 之前登記（它會 `Object.freeze(chrome)`）。只剩瀏覽器工具列與分頁右鍵的「用系統瀏覽器開」、OAuth 裝置碼、PawnIO 下載仍走系統瀏覽器。
- 右鍵與 F5：網頁版 AI 與工作區瀏覽器的 webview 在 main 掛 `web-contents-created` → `web-context-menu.js`（連結、圖片、編輯、拼字、上／下一頁、重新整理、檢查元素；F5／Ctrl+R 重新整理，Shift 或 Ctrl+F5 略過快取）。焦點在 webview 裡時按鍵到不了主視窗，所以只能在 guest 的 `before-input-event` 收。
- Chrome 擴充功能（只限 `persist:wsbrowser`）：`browser-extensions.js` 從商店下載 CRX3、把公鑰寫進 manifest `key`（ID 跟商店一致）、用 Windows `tar.exe` 解到 `userData/browser-extensions/<id>_<時間>`（載入中檔案被鎖，刪不掉的下次啟動清），啟動時全部載回。chrome.tabs／action／permissions 由 `electron-chrome-extensions`（GPL-3.0，整個專案因此改 GPL-3.0）補；Chromium 原生的 `browser` 命名空間沒被補，`crx-browser-alias.js` 把它指回 `chrome`（不然 uBO Lite 背景直接當）。入口：瀏覽器工具列的圖示列（`browser-actions.js`，圖示＋徽章由 main 的 `actions()` 依分頁算，套件的 observer 一變就推 `workspace:extensionsChanged`）、🧩 與右鍵「擴充功能」；在商店詳情頁會多「安裝這個擴充功能」。自動更新：啟動後 1 分鐘、之後每 6 小時打商店的 updatecheck，有新版就重裝。
- 本機擴充功能：同一選單可選含 `manifest.json` 的資料夾（main 系統對話框＋manifest 校驗）；`browser-extensions/local-extensions.json` 原子保存 ID／路徑，重啟還原。需要 userScripts 的套件使用 App 管理的副本與固定 key，產生的執行檔不寫回來源；其他套件直接載入來源。重新載入會讀取最新來源，移除不刪原始碼；商店與本機同 ID 不可同時安裝，本機不走商店自動更新。
- 擴充功能管理：右鍵「詳細設定」、`chrome://extensions`／`edge://extensions` 都開瀏覽器新分頁（`browser-extension-manager.js`）。管理頁固定 `axon-extensions://manager/pages/browser-extensions.html`，協定只供應四個固定資源；session preload 及 IPC 同時限制正確分區、主 frame 與管理網址，普通網頁拿不到管理權限。`extension-state.json` 保留啟用狀態、userScripts 開關與停用套件資料；停用不刪設定，停用的商店套件仍可更新。每個套件根據 manifest 打開自己的 options（含舊 options_page）、新分頁、popup 或 side panel 介面；工具列圖示與 `action.openPopup()` 顯示錨定浮動 popup，沒有 popup 時送 `action.onClicked`；options、管理頁、`tabs.create`、`window.open` 共用分頁路由，依來源 webContents ID 留在原專案或 Browser 模式，popup 保留原網頁的 active tab。沒有介面會明示。Raindrop 的帳號設定須登入；不替套件虛構選項。
- ScriptCat：Electron 43 沒有原生 userScripts，`crx-user-scripts.js`＋preload 以原生 scripting 補登記／更新／刪除／立即執行及訊息／port。每個套件獨立開關，ScriptCat 預設允許；一般 scripting 不受此開關影響。腳本與 messaging 設定原子保存，跨 popup／worker 共用鎖，失敗登記不保存；重新載入恢復普通與使用者腳本。USER_SCRIPT 映射 ISOLATED，MAIN 保留原生全域；尚無真正獨立 USER_SCRIPT world／named world／自訂 CSP，後兩者會明確拒絕。`crx-context-menus.js` 補 update、勾選／可見／啟用及點擊事件，preload 排在 SDK 後；不改 node_modules。驗真插件 `e2e-browser-extensions.js`／`e2e-browser-settings.js`（可帶 AXONDECK_ASAR）。
- 網站相容性：JS 與 HTTP 的 UA 品牌／major 對齊（仍保留 Grok clearance 的 UA）。Cloudflare 驗證認得出「裝成 Chrome 的 Electron」（自動檢查不過、勾選框無限重來；學術站 ACS／OUP／RSC／SSRN 2026-10-17 實測），照實報 Electron 反而多半直接放行：`ai-web.js` 的 `installChallengeFallback` 在 Grok 以外的分區掛 `onHeadersReceived`，整頁回 `cf-mitigated: challenge` 就把那個分頁 `setUserAgent` 成 Electron 原本的 UA（只拿掉 App 名字）並重載一次；這種分頁 shim 不補、`sec-ch-ua` 也不補。ScienceDirect 目前連真 Edge 都要人工勾選。擴充功能選單「在無套件相容視窗開啟此頁」開 App 原生 WebContentsView、`persist:wsbrowser-clean`，cookie 與套件和一般瀏覽器隔離，登入與新連結仍留這個分區。`probe-browser-capabilities.js` 驗真 ScienceDirect 公開文章與正常 PDF 連結：HTTP 200、PDF 7 頁、原生檢視器可讀。Chromium 新 PDF 檢視器在 OOPIF，不能僅查主頁 DOM 判空白；網站驗證／訂閱限制仍由網站決定。
- 翻譯 Edge TTS：`node-edge-tts` 固定 1.2.11，服務從舊 speech.platform.bing.com 改為 api.msedgeservices.com；舊版真請求 403、新版成功。維持 voice allowlist、語速與切塊／取消流程，`e2e-browser-scripts-cdp.js --tts-only` 共用隔離打包版啟動，獨立驗四語試聽＋朗讀的真 MP3 播放（靜音測試，不碰正式設定）。真上游可能偶發逾時。
- 專案腳本開瀏覽器（`script-launch.js`）：檔案頁／專案檔案樹執行專案裡的 `.bat`／`.cmd` 改由 App 啟動——`BROWSER`＝AxonDeck.exe（Python `webbrowser`、Vite `--open`）；暫存副本把有網址／變數的 `start …` 改成 `(%AXONDECK_START% … || start …)`（不能用 `call :標籤`，參數有 `/?` 會變成顯示說明）。第二份 AxonDeck 用**原始順序**的 `process.argv` 判斷（轉給第一份的 argv 會被 Chromium 重排、丟空字串、加開關），帶 `AXONDECK_PROJECT` 給第一份開在那個專案；不是網址回 3、App 沒在跑回 4，腳本改照原樣 start。
- 右側檔案樹的一鍵啟動仍在專案終端機：`ws-tabs.runInTerminal` → `workspace:scriptCommand`（專案相對路徑＋同專案終端機守衛）→ `script-launch.terminalCommand`。用獨立 PowerShell 執行，批次副本以環境變數保留中文原路徑，PowerShell 的 `Start-Process`／`Invoke-Item` 網址也改道；不改原腳本或 PTY 宿主協定。main 只追蹤這次腳本的輸出 5 分鐘，看到 loopback URL 後等 TCP 就緒（最多 30 秒）開原專案分頁；主動開網址與日誌共用 run ID 去重。指定專案不存在／開頁失敗不退回系統瀏覽器。驗收 `scripts/e2e-browser-scripts-cdp.js`：隔離打包版、真本機服務／套件 content script、真 Google CRX。
- 網頁版 AI 順暢度：webview 本身（含 UA／標頭／滑鼠掛勾）實測跟 Edge 同速，長對話與大量公式卡在網頁自己重排／重畫舊訊息（Layout＋Paint 約 7 成）。`ai-web.js` 的 `installRenderBoost` 在 `dom-ready` 對 ChatGPT `[data-message-author-role]`、Gemini `.conversation-container`、Grok `div[id^="response-"]` 插 `content-visibility:auto`（Claude 官方已自帶）；300 則公式訊息捲動 98→136fps、串流每幀 229→49ms。選擇器改版就失效（退回原樣）。
- 記憶體：網頁版 AI 與工作區瀏覽器分頁切換時保留 webview（v1.54.3 起取消閒置／數量回收，避免切回重載），關閉對話／分頁或當機才收。聊天圖片快取 LRU 約 16MB。
- 聊天：不同對話可同時回應；每對話取樣參數；第一輪後 AI 自動取標題；編輯／分叉／重新生成。

### 專案工作區與終端機
- 終端機常用分頁保留 WebGL 畫布，最多 8 個；超額只收最久沒看的背景格，三格並排不回收。不可回到切走立刻 dispose：會同步建立 DOM renderer，再切回又重建 GPU 畫布，造成切專案／新增分頁卡頓（v1.53.0 的退化）。`probe-workspace-latency.js --paint` 以可見隔離視窗、真側欄入口及兩幀完成量測，另驗長內容、畫布上限與並排。
- 專案＝本機資料夾（`workspaces.json`，含 `tabsState`）；分頁列放終端機／Monaco 編輯器／瀏覽器；右側欄五顆：檔案樹（含搜尋）／Git／AI 記錄／Port（main 對每個埠打一次 HTTP，2xx 的 HTML 或 3xx 轉址才算「網頁」，排上面、每列最右邊一顆「開啟」；其他服務只列）／MCP/Skills（不是側欄面板，是在目前專案開一個 `cc-tools` 分頁，一個專案最多一個）；主區底部是額度條 `quota-bar.js`。
- Agent 專案分類沿用 Chat 資料夾：`ws-project-folders.js` 管新增／改名／收合／分類排序；專案用拖曳或右鍵「移至資料夾」移動，分類標題可拖曳排序。`workspaces.json` 的 `folders`＋專案 `folderId` 走同一條 store 寫入佇列；刪分類只移回未分類，保留專案、草稿與檔案。回歸 `test-workspace-folders.js`／`e2e-workspace-folders-cdp.js`。
- 檔案樹圖片與 MP4／WebM 直接開工作區分頁（`vi-media://`）；Markdown 圖片支援專案相對路徑；Git 面板有 GitHub 按鈕（`githubUrl`）。
- 專案全文搜尋 64KB 區塊逐行讀、新查詢停止舊查詢。AI 記錄讀 Claude Code／Codex／Grok／OpenCode／Antigravity CLI；IPC 分段讀取，renderer 自動接成完整單頁，後續只重讀末段。標題／接續／複製路徑與概況／工具統計共用置頂區塊，長標題可展開；Ctrl+F 搜尋全文與工具內容，Enter／Shift+Enter／F3 前後跳轉，命中工具自動展開，Esc 關閉。
- 終端機 PTY 在獨立宿主（`<userData>/terminal-host/`），App 重開／更新只斷線；五種 AI CLI 重開時接回原程序，程序已結束就用記住的對話 ID 接續（Claude 靠 hook，其他靠啟動前紀錄基準）。
- Claude 狀態：hook（`<userData>/claude-hook/`）＋畫面判斷 → 分頁顯示運行中／等你回答／閒置。
- 背景通知（`agent-notify.js`）：agent 分頁（preset 不是 shell 或有 hook）從運行中掉到閒置／等人、而且人沒在看（`isWatching` 含 `document.hidden`）或 App 沒焦點 → renderer 送 `terminal:notifyAgent`，main 出 Windows 通知＋工作列 overlay 紅點數字（16×16 點陣自畫）＋閃爍；點通知 → `pages.navigate('chat')`＋廣播 `terminal:reveal`，workspace-page 用 `focusSession` 切回專案與分頁；任何一扇窗拿到焦點就收掉全部通知。純 shell 不通知。
- 分頁上下文用量（`workspace/agent-context.js`）：回合結束或切到那格時 `terminal:context` 尾讀綁定紀錄 512KB。Codex 用 `token_count` 的 `last_token_usage.total_tokens`／`model_context_window` 畫百分比；Claude 記錄沒有上限，只顯示幾 K（不拿模型名猜）。紀錄檔路徑快取，搬家（ENOENT）重找一次。
- Diff 審查意見「貼到終端機」：貼進這個專案最近切過、還在跑的 **agent** 終端機（純 shell 不收，多行會被當指令執行），走 `term.paste`、不自動送出。
- 新 worktree 單一表單（`ws-worktree-flow.js`）：基底／名稱／要開的 agent／是否跑初始化腳本。初始化腳本存在專案的 `setupScript`（只收專案內相對路徑 .ps1／.cmd／.bat），建 worktree／加入現有樹時帶給新專案；`workspace:worktreeSetupCommand` 只收專案 id＋已屬於該工作樹的終端機 id，main 組 PowerShell 指令（`script-launch.terminalCommand`＋`AXONDECK_SOURCE_DIR／WORKTREE_DIR／BRANCH`，引號跳脫含 ‘’‚‛），終端機固定開 powershell。任何一步失敗都保留已建的工作樹。
- 刪 worktree：`check` 會問終端機宿主（`listRunningUnder`，不啟動宿主）這棵樹底下還在跑的終端機，有就擋下並列名；讀不到 git 狀態也擋。確認框附「還有幾個提交沒推」（有 upstream 比 `@{u}`，否則比建立時記下的基底）。
- `Ctrl+Shift+P` 指令面板（`ws-commands.js`，沿用快速開啟的樣式與 `scorePath` 排序）：切專案／終端機、新增各種 agent、新 worktree、開 Git／AI 記錄／檔案樹、快速開啟。只在工作區終端機區看得到、沒有對話框時生效；xterm 內也攔下這組鍵。
- 其他：WebGL renderer、搜尋、字級、最多 3 格並排、OSC 標題與 cwd、連結（CLI 自己換行的網址／路徑也接得起來：接續列縮排不算、上一列要寫到附近最長列的寬度才算被切斷）、Ctrl+G 用 App 內編輯分頁、剪貼簿截圖貼路徑、桌布與配色、管理員終端機。Codex 預設指令 `codex --no-daemon`（避免彈外部視窗）；兩種宿主把 npm 套件內 codex.exe 的資料夾排到 PATH 最前，直接跑原生檔，別處「殺光 node.exe」不會連帶收掉 Codex。
- 終端機右緣：`term-scrollbar.js` 與滑鼠滾輪共用 xterm 的實際列號；`term-conversation.js` 右上角滑入展開、離開收合，只列提問／最終回答（略過 Grok 的 system-reminder 注入），點選同步 `scrollToLine`，全螢幕的 alternate buffer 也照目前畫面定位，不送逐段滾輪、不建立第二份終端機。main 依已驗證 session id 讀正式紀錄；同視窗切換對話時，OpenCode 用 `OC | 標題`（含狀態前綴與結尾省略）、Codex 先去掉忙碌圖示再對唯一明確標題；標題只有資料夾名稱時，改看這次程序開始後、這個目錄裡唯一且較新的紀錄。Grok 先對 `~/.grok/active_sessions.json` 裡同一個 grok.exe、同一個目錄、開檔時間不早於這次程序的最新 session（OSC 標題一直停在 `grok` 也會改綁）；標題以 `標題 - grok` 結尾時同樣改綁。分頁在 OSC 只是 `grok` 這類通用名稱時顯示該對話 `summary.json` 的 `generated_title`（沒有就用 `session_summary`），使用者改過的名字仍優先。側欄與分頁的運行狀態跟該對話 `events.jsonl` 的回合與權限，回合結束就離開運行中。Antigravity 對該次 agy.exe 的 cli log，取最後一筆 `Streaming conversation`；這次 log 沒有對話代碼、且這個目錄只有一個 agy 分頁時，才改用這個目錄在 `last_conversations.json` 的那一筆。同專案多開分頁時各看各的：一筆對話只綁給一個還在跑的分頁（`agent-resume.js` 的 `claimed` 記擁有者），那個分頁的 CLI 關了才放行給新分頁接續。工作區路徑和終端機目錄不同時，仍綁定這次程序已證實的對話庫並顯示紀錄。終端機清單與專案裡的同一頁會改讀該段最新內容並繼續更新。改綁寫入後通知該分頁重讀，面板關著也換；進行中的掃描不把已經讀過的舊標題交給後到的查詢。Claude 由 PTY 子程序對應 `sessions/<pid>.json`（`/resume` 會改這份）。離開的對話若在同一秒再寫入 jsonl，仍以 pid 檔為準；pid 檔沒跟著改、專案 jsonl 又晚了兩秒以上，且這個目錄只有一支 Claude 時，才改綁那份較新的紀錄。其他可讀明確 resume 參數。啟動與恢復：Codex `--no-alt-screen`、Grok `--minimal --no-alt-screen`；JS／Rust 宿主均給 Claude `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`。OpenCode 維持全螢幕，宿主以 `OPENCODE_TUI_CONFIG` 載入 `opencode/navigation.mjs`（右緣拖曳軌用實際內容高度；對話清單只留 AxonDeck 右上角那一顆，外掛不再畫第二顆。依訊息 ID 跳轉；點任何一則都停在該則開頭，後面的輸出留在下面。xterm 找不到時寫 `terminal-nav/<id>.json`，外掛把內部捲軸移到該則；1.18.35 的回答沒有節點 ID 時，只接受同一提問內第一行唯一吻合的區塊）。專案側欄的 AI 紀錄每家各留最新 30 筆，面板開著時會再讀。全螢幕只收起 AxonDeck 捲軸，對話清單留著；點擊、拖曳與滾輪交給 CLI，Shift＋拖曳仍做本地選取。本機 Antigravity 已備份設定並設 `altScreenMode: never`（其他機器仍需同項 CLI 設定）。一般緩衝區保留 50000 列。經使用者同意，開啟時將正式保存的提問／回答（移除 ANSI 控制碼）逐頁補入同一個 xterm 的上方，再接原 PTY 畫面與即時輸出；以 marker 定位重複提問，保留可輸入的原 CLI。若 CLI 內切換舊對話後目標尚未載入，點選會補回保存紀錄與原 PTY 快照（期間即時輸出排隊、按 seq 去重），再一次跳轉；不重啟 PTY。超過緩衝區上限或仍無法定位時明示找不到。已運行的 CLI 要重啟接回後才套用原生模式。

### 檔案頁
- 分頁、雙欄（作用欄＋各自分頁組）、首頁「本機」（插拔即時更新）、清單／方格（Ctrl+滾輪 48～256px）、每個資料夾記自己的檢視／大小／排序（`explorer.json` 的 `folderViews`）。
- 刪除進系統回收筒、Ctrl+Z 復原、撞名可改名／略過／覆蓋（覆蓋先把舊的丟回收筒）、操作中心在狀態列。
- 殼層 sidecar 提供原生右鍵（7-Zip／WinRAR／傳送到）、真縮圖＋Drive 綠勾、內容視窗、詳細資訊（EXIF／影音串流／版本）、手機 MTP。ZIP 唯讀瀏覽與解壓。
- 「資料夾大小」開關（`explorer.json` 的 `folderSizes`）：`dir-sizes.js` 每欄一條 lane 背景用原生 `dir-size` 逐個算子資料夾（單個上限 20 秒，超過顯示「≥」，5 分鐘內不重算），`listDir` 帶 `dirSizes` 才套進 size 參與排序；renderer 收進度節流重拿已載入的頁。回歸 `test-explorer-dir-sizes.js`。
- UFFS：進頁只準備授權，搜尋時才載索引，保留到 App 結束才休眠。

### 原生媒體播放器
- `native/axondeck-probe/src/bin/axondeck-media/`：Rust＋Win32，mpv／ImageMagick 解碼，放 Windows Job object；跟主 App 完全分開。
- 自繪選單、播放清單（搜尋、拖入、續播）、倍速滑桿、快捷鍵表；偏好存 `%LOCALAPPDATA%/AxonDeck Media/preferences.json`。
- 右鍵「在 AxonDeck 檔案頁顯示」：`registration::reveal` 用安裝目錄的 `AxonDeck.exe --reveal=<路徑>` 叫主程式（main 的 `revealInFiles`：已開走 second-instance，沒開就等第一頁載完再導），檔案頁開新分頁並選起來；旁邊沒有主程式（開發版）才退回系統檔案總管。
- 預設關聯：新安裝或首次更新背景套用（同時寫 UserChoice 與 UserChoiceLatest 有效 Hash 並回讀），備份在 `association-backups/`，之後不覆寫使用者自選；解除安裝還原。
- `npm run build:media` 固定 runtime 版本與 SHA-256；GPL 授權見 `resources/media-NOTICE.txt`。

### 獨立編輯器（取代 VS Code 的開檔）
- `src/main/editor-window.js`＋`pages/editor.html`／`scripts/editor-window.js`／`styles/editor.css`：一檔一窗（同檔再開只叫到前面），Monaco 編輯＋Markdown 編輯／分割／預覽（預設預覽、相對圖片走 `vi-media` 的 `localBaseFor`）。路徑只由 main 決定，renderer 只能讀寫自己那個檔；存檔帶 mtime（STALE 問覆寫）、暫存檔再 rename；UTF-8／BOM／UTF-16 LE 原樣存回，其他當 Big5 唯讀；有沒存的修改關窗會問。Monaco 上限 256MB（跟工作區同一條；超過 2.56 億字元 `getValue()` 會丟例外），20MB／30 萬行以上 Monaco 自動關上色與換行；超過 256MB 的文字檔（UTF-8，或有 BOM 的 UTF-16 LE／BE；編輯視窗與工作區都一樣）改用唯讀分段檢視：main `big-text.js` 掃一遍每 1024 列記一個書籤、只讀畫面要的列（長行每 4KB 切一列；搜尋是位元組 indexOf，預設不分大小寫但只折 A–Z，Aa 鈕切成區分），renderer `big-text-view.js` 自己畫捲軸（元素高度有上限），每 2 秒問一次修改時間、變了就重建索引（檔頭檔尾各 4KB 沒變、只是變長就從最後一個書籤接著掃，330MB 的 log 幾毫秒；停在檔尾就跟到新檔尾，視窗縮著不問）；工作區索引快取最近 8 份、同時要共用同一趟。Git diff（`git.js` 的 `run` 帶 `maxChars`）只收前 2MB 就結束 git，工作區那一邊超過 2MB 只看大小不讀，幾百 MB 的檔點「檢視變更」不會撐爆（330MB 約 4.5 秒，時間花在 git 比對；等超過 0.4 秒掛「讀取變更中…」提示，`showToast` 的 duration 0＋`hideToast`）。Markdown 超過 512K 字預設開編輯，預覽只畫開頭（`markdown.js` 的 `previewSlice`）；工作區超過 1M 字的檔不倒進影子 textarea。兩邊存檔的 rename 遇 EPERM／EACCES／EBUSY 每 100ms 重試最多 20 次（`files.renameRetry`；防毒剛寫完會掃，大檔約一半機率撞到）。
- 格式清單 `src/main/editor-formats.json`（不可與 `media-formats.json` 重疊，Rust 測試擋；`.ts` 已從媒體移給編輯器（媒體 `retired`，舊備份略過，`adopt_from_media` 只改還指著媒體 ProgID 的），`.mts` 留給媒體、HTML／CSV／`.sh` 不接管）。
- 工作區 HTML 預覽走 `workspace:previewHtml`：main 記下編輯器手上那一版（沒存也算），回 `vi-media://<十六進位專案id>.<SITE_TOKEN>/<rel>`（每專案一個來源、根路徑＝專案根，只送網頁資源副檔名、點開頭的不給、不回 CORS），iframe `allow-scripts allow-same-origin`；每份 HTML 回應在 `<head>` 後塞一小段腳本，把 Ctrl+滾輪 postMessage 給外層的預覽縮放（外層 CSS zoom 會傳進 iframe）；CSP `frame-src` 要留 `vi-media:`。檔案樹點腳本（.bat／.ps1／.py…）先開編輯器，右上「執行」先存再開終端機跑。回歸 `e2e-workspace-html-cdp.js`（打包版）。
- 專案右側檔案樹盡量開在分頁：圖片（含 AVIF／APNG）、音訊、影片（MP4／WebM／M4V／MOV／MKV）走 `vi-media` 分頁，分頁解不了編碼才改開原生播放器；獨立編輯器／播放器主要給檔案頁與 Windows 點兩下用。
- Office 文件（docx／docm／xlsx／xlsm／pptx／pptm／doc／xls／ppt／odt／ods／odp）唯讀預覽，標題列按鈕切「原始版面／簡易檢視」：原始版面＝`workspace:convertOffice` 請 main 用 Office COM（沒有才 LibreOffice）轉 PDF，快取 userData/office-preview（雜湊含路徑＋大小＋mtime，`vi-media://…/~office/<雜湊>` 只認快取檔名），交給 pdf.js；Word／PowerPoint 會接到使用者開著的程序，開之前沒有文件才 Quit，一次只轉一份。簡易檢視＝`ws-office*.js` 自己解 zip（DecompressionStream）＋DOMParser，文字只走 textContent；試算表預設看表格，有公式沒結果或是 xls 就請 main 轉一份 xlsx 重算。回歸 `test-workspace-office.js`（electron）。
- 關聯共用 `axondeck-media.exe` 那套有備份的預設切換：`--editor` 換成 `EDITOR` 組（ProgID `AxonDeck.Editor.*`、指令 `AxonDeck.exe "--open-file=%1"`、備份 `editor-association-backups/`）；安裝程式與 `initializeAssociations` 各跑一次（標記 `editor-associations-initialized`），解除安裝還原。
- `--open-file=` 啟動時主視窗留在系統匣；第二實例只開編輯窗。檔案頁／工作區／ZIP／MTP 開檔共用 `mediaPlayer.openPath`（媒體→播放器、文字→編輯器、其餘→系統）。回歸 `test-media-player.js`、`test-editor-window.js`（electron-as-node）。

### 系統監控
- 取樣器 `axondeck-probe.exe sysmon` 開機常駐、沒人看 30 秒一輪；nvidia-smi 常駐；多 GPU 各自一卡。
- 提權感測器 sidecar 走排程工作，斷線一直重拉；風扇曲線每秒重送；效能調整不開機自動套用。
- 總覽：CPU 整列，其餘卡片依面板寬一／二／三欄（container query 掛在 `#sysmon-overview` 與各卡，不掛有下拉選單的分頁——container 會變成 fixed 定位基準）；規格表不重抄標題列讀數／副標／別張卡已有的值，子清單收成一排膠囊。
- 效能與壓力測試同一分頁：CPU／GPU 即時儀表只有 `sysmon-oc.js` 那份，`sysmon-page.js` 只畫「記憶體與硬碟」列與四張測試卡。
- 處理程序：`sysmon-procs.js` 管理圖示、整機占用與保存的欄序（名稱固定第一欄）；取樣器帶執行檔路徑，main 非同步快取圖示。網路沿用感測器 sidecar 的 Kernel-Network ETW（TCP／UDP、IPv4／IPv6），未啟用、權限不足、遺失事件或資料過期顯示「—」，不新增 UAC。
- 磁碟空間：`axondeck-probe disk-tree` 平行掃＋treemap，刪除只丟回收筒。強制結束權限不足會跳一次 UAC。

### 額度與用量統計
- 額度：七家官方端點（`usage.json`），條看得到時快取超過 60 秒自動同步；Claude token 自己續期、報 `claude-code/` UA；Codex 重置次數可在詳情卡兌換。
- Claude 官方訂閱多帳號：併在「Claude 官方訂閱」那張供應商卡裡（第二行是目前帳號；存兩個以上時卡片拉成整列、列出各帳號可切換／移除），終端機登入過的帳號自動記下、卡上「＋ 帳號」走隔離的 `claude auth login`；切換＝換 `.credentials.json` 的 `claudeAiOauth`＋`.claude.json` 的 `oauthAccount`，正在用第三方供應商會順便切回官方。存兩個以上時 Claude 詳情卡一個帳號一段（`profiles`），條上那顆仍是使用中的帳號。
- 額度條左邊兩顆按鈕「供應商」「用量統計」（顯示目前供應商、目前範圍花費），點開從條上方展開不透明抽屜（疊在內容上、不推擠終端機；點條外或 Esc 收起，彈窗與選單內的點擊不算）。同步診斷已整條拿掉（按鈕、彈窗、IPC）。
- 用量統計：掃 Claude／Codex／Grok 等本機記錄（Rust `usage-scan`），每小時桶＋游標存 `code-usage.json`，第一次打開抽屜才載。Antigravity 讀 CLI 的 `~/.gemini/antigravity-cli/conversations/<id>.db`（`gen_metadata` protobuf，`db-sources.js#readAntigravityCli`）＋AGY 反代日誌，兩邊不重疊；CLI 會自己刪對話檔，所以跟 JSONL 一樣一檔一游標（`antigravity:<id>`）、刪檔進封存區；IDE 的用量讀不到。不限保留期（桶子永久留、檔案不看修改時間）；範圍 24 小時／7 天／30 天／全部／自訂（`resolveRange`：起訖日含迄日，兩天內小時桶，超過 96 天改週桶）。
- Codex 新版把舊 session 壓成 `.jsonl.zst`（Rust `zstd` crate 解壓，JS 退路用 Node 內建 zstd），游標 key 去掉 `.zst`、位移算解壓後的，壓縮前讀過的不重算。Grok 子代理自己的 session 預設跳過（母那一輪的 usage 已含）；母那一輪結束時沒跑完或那一輪沒用量的才照算（`parsers.js#resolveSubagents`；`parent_prompt_id` 跟 `turn_completed.prompt_id` 不是同一套 id，靠「開出來後的下一個 turn_completed」判斷）。Claude resume／fork 複製的訊息跨檔去重（事件帶 `id`，比對其他游標的 `seen`）。OpenCode 遇到還沒完成（無 `time.completed`）且一天內的訊息先停，游標不跳過它。
- 重讀不丟資料：每個游標記自己貢獻的用量（`contrib`）；檔案被工具刪掉（Claude Code 只留約 30 天）時移進 `archive`（有複本在別檔的訊息 id 進 `archiveIds`），整份重讀時加回去；記帳前就刪掉的才退回 `keepOrphans`（現存最舊檔案之前、那小時沒新資料才留舊桶）。`reset()` 只標成要重讀，不清桶子。
- 用量統計抽屜：左邊總計（花費＋四種 token，色點兼圖例）在上、趨勢填滿下方；右邊依工具／依模型，每列明細一種 token 一格。整塊固定高度、分佈在自己那欄捲；抽屜窄於 760px（container query）改成一欄往下疊。
- Haiku 5.5 依逐請求輸入（含快取）是否超過 100K 分開價格級距，同一模型顯示時合併；`RULES_VERSION = 16`（v16：讀 Antigravity CLI、它的實驗分流模型名收回本體）會重讀舊桶。單價順序：自訂 → 內建表 → models.dev（`codeusage/models-dev.js`：只收原廠那一家、一天抓一次、小快取 `models-dev-prices.json`，沒給寫入價的非 Anthropic 當 0）；來源自帶金額仍優先。
- 背景看額度（`usage/quota-watch.js`，帶 `--user-data-dir` 的預覽／e2e 不跑）：每 5 分鐘 tick、30 分鐘同步一次。提醒（`quota-alerts.js`，照 magpie）：週／月窗口 6 小時內重置且用量 < 85%、Codex 重置次數 6 小時內過期 → Windows 通知；每輪窗口只講一次（記號存重置時間，差 10 分鐘內算同一輪）。預熱（`warmup.js`）：設定的 `HH:MM` 到了、5 小時窗口沒在跑（只信 `available` 的官方讀數）就用 CLI 送 hi——Claude `-p --model haiku --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`、Codex `exec -c mcp_servers={}`；每個時間點一天一次、晚超過 1 小時放掉；只預熱 CLI 目前登入的帳號；工作目錄固定 `userData/warmup`（Claude 會替每個新目錄建空的 `projects/<dir>/memory/`）。記號存 `usage-watch.json`。設定在「額度顯示設定」對話框（usage settings 的 `alerts`／`warmup`）。

### Claude Code 供應商／MCP／Skills（原 CC Proxy 頁，邏輯都在 `ccswitch-page.js`）
- 內建 Grok、Codex、Ollama Cloud、OpenCode Go、Command Code、OpenRouter 可選上游格式，非 Anthropic 走本機閘道轉換；Codex／Grok 可在 App 登入或沿用 CLI。
- 轉換閘道跟著供應商自動開關（沒有手動開關）；AGY 反代執行中會自動多一張「Antigravity」供應商（直連反代、位址金鑰自動帶入，啟用時反代沒開會自動開）。
- 入口：`refreshProviders`（額度條抽屜）、`refreshCcTools`（MCP 與 Skills 分頁：五家共用最上面一個切換，`.agents` 沒有 MCP 就收起 MCP 那塊）、`refreshVersionsSection`（設定頁 CLI）。訊息寫進看得到的那塊（`.cc-page-error`／`.cc-page-status`），彈窗開著寫彈窗。
- AGY 反代在設定頁 `#set-agy`（`agy-page.js` 照舊管自己的輪詢，只在設定頁該區看得到時輪詢）。AGY 模型映射先比對即時型錄，再退回靜態表；型錄列著但實測 404 的放 `RETIRED_MODELS`（`catalog.parseCatalog` 標成淘汰並導到 3.8）。上游額度 Gemini 與 Claude／GPT 各一池，5 小時＋每週兩道，依 token 成本比例扣；Pro 方案的 Gemini 4 Argon 另一池只有每週（`antigravity-argon-weekly`）。上游看 HTTP User-Agent 給模型：`USER_AGENT` 必須報 `antigravity/cli/x.y.z`，否則型錄沒有 Argon、生成回 404。
- 供應商彈窗：金鑰／登入／模型在外面，名稱、上游格式、1M 收在「進階設定」（自訂預設展開）；多一顆「儲存並啟用」。
- 模型清單每天自動同步一次（`modelsCheckedAt`），下拉依 AI lab 分組（`cc-model-groups.js`）；Codex 查詢的 `client_version` 跟隨已安裝 CLI。
- 寫使用者設定檔：`claude-settings.readJsonFile` 先去 BOM（PowerShell 5.1／記事本存的檔）；Codex／Grok `config.toml` 由 `toml-edit.js` 只換有變動的 `[mcp_servers.<id>]` 區塊（含子表），註解／順序／CRLF／BOM 原樣保留，切不安全（inline table、dotted key、拆散的區塊）才退回整份重寫；寫前重解析比對，非 MCP 鍵不准變。
- MCP「測試」（`mcp-check.js`＋`cc-mcp-check.js`）：renderer 只送 `{ home, id }`，設定由 main 讀；stdio 解析 PATH／PATHEXT，`.cmd`／`.bat` 照 cross-spawn 雙重跳脫經 `cmd.exe /d /s /c`；HTTP 走 streamable（JSON／SSE、`Mcp-Session-Id`、`redirect: 'error'`），舊式 sse 回暫不支援。initialize → initialized → tools/list（最多 5 頁 200 個），stdio 30 秒、HTTP 60 秒逐步逾時，結束 `taskkill /T /F`；錯誤只回固定原因。關 App 由 `stopMcpChecks` 收掉（不掛在 stopGateway：切供應商也會關閘道）。`launch` 也給預熱代跑 CLI 用。

### 語音
- 檔案轉錄／錄音／字幕各一張功能卡，操作與紀錄上下合併；三欄間距 12px，900px 以下依功能單欄堆疊。錄音 `recAudioSource`（預設 mic）與字幕 `liveAudioSource`（預設 system）均有 mic／system／both；共用 `recording-audio.js` 將兩路各半合進單一音軌，字幕保留麥克風降噪，停止或啟動失敗都釋放輸入軌與混音 context。兩顆開始按鈕均 64px 高，狀態與音源列對齊。
- 語音輸入：右 Alt → 錄音 → ASR → 字典 → LLM 整理 → 插入（自己視窗直接插、外部才走剪貼簿）；HUD 每次載入重送狀態。
- 檔案轉錄：ffmpeg 串流切段；雲端遇 429／逾時／5xx 同段重試，仍失敗保留已完成內容。錄音機跟檔案轉入同一頁，錄音可拖過去（只帶檔名，路徑由 main 解析）。錄音與字幕邊錄邊 append。
- 錄音清單可下載原始 webm；仍由 main 驗證檔名並讀取，不接受 renderer 提供路徑。
- 轉錄與即時字幕共用模型（`fileAsr`／`fileLlm` 為準，開機 `alignSharedStt` 抄到 live；目標語言 `sttLanguage`）。語音輸入仍各自選（`dictationAsr`／`dictationLlm`）。值 `local:<key>`／`cloud:<設定 id>:<模型 id>`。
- 即時字幕按「開始」後持續持有 `live` 引擎，切工具不釋放；按停止或關閉字幕視窗後才釋放，仍有其他功能使用時保留模型。尚未開始字幕的待機預熱，切頁時可釋放。
- 一般文字翻譯工作中切頁仍繼續分段，保留 `translate` 引擎；背景完成、失敗或明確停止後才釋放。切回翻譯頁不重載正在用的模型，前景完成時維持待機預熱。

### 設定頁
- 側欄四區：雲端模型／基本（更新置頂、視窗與啟動）／外觀（主題、終端機外觀＋`term-appearance-preview.js` 即時預覽）／CLI 版本。全部自動儲存，沒有底部「儲存設定」列。
- 雲端模型只有一份 `cloudProviders`（`src/main/cloud-providers.js`）：每顆模型帶用途（`src/shared/cloud-model-types.mjs` 的 chat／image／asr／tts／unknown／unsupported），掃描時依 `/models` 能力欄位自動分類，猜不到標「待選用途」不進任何選單。寫入時一次投影回 `chatProviders`（聊天＋生圖；翻譯與整理排除生圖）與 `asrClouds`，功能頁照舊讀這兩把；沒有 `cloudProviders` 時由舊鍵即時合併（同網址＋金鑰合併，ID 保留舊選取）。
- 全新設定預設一組空的 OpenRouter；AGY 反代啟動時 `syncAntigravity` 自動加入 Antigravity（`gemini-3.8-flash-high`、`gemini-3.5-flash-lite`，位址金鑰跟著反代）。
- 雲端文字轉語音 `src/main/cloud-tts/`：OpenAI 相容 `/audio/speech`、MP3、可取消、匯出；語音頁「語音來源」切本機 Breeze／雲端（`cloud-speech.js`）。音訊以 base64 回 renderer 轉 blob（CSP `media-src` 不收 `data:`）。
- 驗證：`npx electron scripts/test-cloud-providers.js`、`node scripts/test-cloud-tts.js`、打包版 `node scripts/e2e-cloud-models-cdp.js`（本機 mock，不用真金鑰）。

### Telegram
- 各格同時載；外部連結（非 t.me）直接交系統瀏覽器；各格切走不卸載（v1.54.3 起取消 5 分鐘只留一格，避免切回重連）。✕ 先導 `about:blank` 再拿掉；每 20 秒探各格，卡「等待網路連線」60 秒或格子當掉就全部依序重載（兩次隔 5 分鐘）；當機記到 `userData/crash.log`。
- 切走時用 `opacity:0`＋`position:absolute` 藏（`display:none` 會丟圖塊，切回來卡頓）。

### 更新與安裝
- 設定「安裝」分頁（`app-installer/`）：WinGet 用 node-pty 跑（管線模式不出進度），讀 OSC 9;4 百分比與「X MB / Y MB」；全部更新同時 3 筆、MSI 互撞（0x8A150102／1618）等 10 秒重試；0x8A15008E（新版換安裝技術）自動先移除再安裝；其他背景失敗依序：系統管理員權限靜默重試（舊版 MSI 移除 1603）→ 開原廠安裝畫面（程式使用中、不支援靜默）；升級帶 `--include-unknown`；WinGet 更新不了的改走內建更新程式（`direct.js` `SELF_UPDATERS`：iCUE 用 cuepkg、Google Cloud SDK 用 `gcloud components update`）；常用另收：iCUE（WinGet `Corsair.iCUE.5`，更新走 cuepkg）、Google App（WinGet 沒收錄——`Google.GoogleDesktop` 是 2003 年舊 widget——改抓官方固定 stub，`/silent` 使用者層級安裝、驗 Google LLC 簽章，裝完由 Omaha 自己更新故不追版本）；EVGA Unleash RGB 官方只有版本化 .zip（`evga.com/unleash` 可解析版本）且 CDN 擋驗證，未收錄；下載階段 10 分鐘沒進度就放棄。`inventory.js` 用原始登錄檔／MSIX 補齊完整名稱、版本、架構與範圍，卡片 key 依安裝實例；移除精確指定 product code＋版本／scope，MSIX 指定 PackageFullName。移除程式不存在時改顯示「清除失效紀錄」：確認後備份至 `userData/app-installers/registry-backups`，再次核對紀錄與檔案，再刪單一登錄鍵，不刪程式檔案。圖示另走 `appInstaller:icons`（依卡片 key、不塞進進度通知）：`icons.js` 依序找 DisplayIcon（保留 index）、MSI ProductIcon、捷徑實際目標、安裝資料夾主程式、MSIX logo；ICO 真解碼、EXE/DLL 用殼層 `extractIcon`。拒絕通用／透明圖後找下一個，缺圖用發行者官網 favicon，離線失敗才用首字。回歸 `test-app-installer*.js`、真唯讀 `probe-app-installer*.js`、打包版 `e2e-app-installer-cdp.js`。
- 功能頁 view：最大化／還原時 Windows 不一定發 resize，`page-windows.js` 在 maximize／unmaximize／restore 也重設尺寸；外殼（`?host=1`）標題列關掉拖曳區，否則它的拖曳區會吃掉功能頁導覽鈕的點擊；彈窗收回時主視窗正在顯示別頁就維持原畫面。
- 手動「重新啟動並安裝」顯示進度、裝完自己開回；結束 App 時靜默安裝；關機／登出不安裝。
- `electron:build` 走 `pack-preview.js --release`：先 `npm run lint` → 磁碟根完整 NSIS → 驗 asar／`app-update.yml`／latest.yml 雜湊 → 同步回 dist → 清理。

### 驗證工具
- `npm run lint`：ESLint（三類規則）＋`scripts/lint-ipc.js`（IPC 三條對齊）。取代各測試裡的原始碼字串守衛；打包前自動跑。
- 單元測試 `node scripts/run-tests.js`（129 支，純邏輯與 vm 行為測試）；e2e／probe 需打包版或真上游，不在這裡跑。

## 資料落點（`%APPDATA%/axondeck/`）

| 檔案 | 內容 |
|---|---|
| `config.json` | 一般設定（`store:*`，key 僅 allowlist） |
| `chats.json`／`chat-images/` | 對話（含網頁版 `web`）、資料夾、每對話參數／圖片附件 |
| `terminals.json` | 終端機 metadata、AI 類型與對話 ID |
| `workspaces.json`／`explorer.json` | 專案清單＋分頁狀態／檔案頁路徑、位置、資料夾檢視 |
| `dictations.json` | 語音輸入紀錄與字典 |
| `recordings/`／`live-transcripts/`／`file-transcripts/` | 錄音（webm）／即時字幕逐字稿（jsonl）／檔案轉錄紀錄（tx-*.json）；錄音機或字幕在錄時導覽列亮紅點（`markSttRecording`） |
| `usage.json`／`code-usage.json` | 額度快取／用量桶＋游標 |
| `claude-accounts.json` | Claude 各帳號登入快照（含 token，不進 allowlist） |
| `agy-logs.db` | AGY 流量日誌 |
| `claude-backup/` | `~/.claude/settings.json` 寫入前備份 |
| `models/`／`hf-models/`／`hf-presets.ini` | 模型與執行環境／HF 模型庫／router preset |
| `screentime/data.db` | 使用時長 |
| `terminal-host/`／`claude-hook/`／`clipboard-images/`／`terminal-bg/` | 終端機宿主、Claude hook、貼上截圖、桌布 |
| `uffs/` | UFFS 執行檔與索引 |

## 已知取捨與未做

- 使用者決定維持：不全面拿掉毛玻璃（ClearType 彩邊）、Telegram 不共用程序（一格當掉會全白）、不改 Tauri。
- 轉換閘道只有 Codex 的請求形狀對真上游驗過，其餘 mock。Antigravity 用量讀 CLI 本機對話＋反代，IDE 那部分算不到；CLI 的 protobuf 欄位是實測反推，CLI 改版可能要重對。
- HF：沒真的跑過大模型（只驗 0.8B／4B dense）；CUDA 執行環境沒實際安裝驗過。
- 網頁版 AI：Grok 登入、Claude 的 Google 登入只驗到登入頁出現，沒輸入真密碼走完；Edge cookie 是 app-bound 加密，不做匯入。
- 原生媒體：格式清單是白名單不代表每種變種都驗過；DRM、MIDI 不支援；CUE 不分軌；全機安裝不改其他帳戶預設。
- Codex npm launcher 的 `--no-daemon` 本機修正會被 npm 更新覆蓋（App 端旗標仍在）。
- 探索只列文字生成模型：`hfmodels/archs.js` 是 llama.cpp `LLM_ARCH_NAMES`（版本＝LLAMA_BUILD，升級要重抄，`test-hf-archs.js` 會擋）扣掉 clip／草稿頭／向量／TTS；另看 HF 用途標籤、repo 名稱（embed／rerank／tts／asr）與檔頭 `pooling_type`。搜尋（HF 回報 clip 的先留）、詳情（讀最大變體的檔頭）、下載前（讀該變體檔頭）三處把關。`imatrix*.gguf` 不算變體。
- `probe-dictation-live.js` 需要前景焦點，只能在使用者沒在用電腦時跑。

## 最近版本

| 版本 | 日期 | 重點 |
|---|---|---|
| v1.52.0 | 10-15 | 瀏覽器擴充功能完整管理與本機安裝；專案腳本可在 App 分頁啟動服務；改善 ScienceDirect 瀏覽；Edge TTS 更新至 1.2.11 |
| v1.51.0 | 10-14 | 設定「安裝」更新失敗自動重試；補齊專案瀏覽器登入小視窗 |
| v1.47.0 | 10-12 | 省記憶體：llama prompt 快取上限 512MB（原 8GB，翻譯每段 +73MB）、Telegram 沒在看只留一格、術語表閒置釋放；Local SI 顯存改用 nvidia-smi |
| v1.46.1 | 10-12 | .ts 改由編輯器開；專案檔案樹的音訊、MOV／MKV 影片、AVIF 圖片改開在分頁 |
| v1.46.0 | 10-12 | 自家文字／Markdown／程式碼編輯器接管 VS Code 的檔案關聯；Chat 側欄網頁版對話改放 logo |
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
