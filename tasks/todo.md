# tasks/todo.md — 進行中與待辦

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。完成的任務只留一行摘要；細節與數字查 git log（`git log -- tasks/todo.md` 可看壓縮前的完整紀錄）。

## 待辦／未解

### 2026-10-15 — v1.52.0 發版

- [x] 審閱完整工作樹、分支與遠端 tag，`gitleaks protect --staged --redact` 未發現敏感資料。
- [x] 更新版本與發行說明，跑回歸、native build、打包版 E2E。
- [x] 建立正式安裝檔並核對 `latest.yml`、blockmap、版本、大小與 SHA-512。
- [ ] Commit/tag/push、建立 GitHub Release，比對遠端資產並檢查最終 Git 狀態。

Review：`npm run lint`、Shell build、`electron:pack`（345 支 src 完整比對）通過；打包版擴充功能／設定／腳本分頁／四語 Edge TTS 與翻譯朗讀、ScienceDirect 文章及 PDF 驗收通過。`node scripts/run-tests.js` 139/142；`test-download-speed.js` 單獨重跑通過。另兩個 `test-usage.js` 斷言受本機憑證影響，`test-workspace-ui.js` 的 about:blank 舊斷言未在本次修改範圍。`gitleaks protect --staged --redact` 未發現洩漏；安裝檔 320,703,783 bytes，與 `latest.yml` 的 SHA-512、大小相符；blockmap v2 及 GitHub updater 設定有效。安裝檔尚未簽署（Authenticode `NotSigned`）。

### 2026-10-15 — 擴充功能頁面分頁與工具列 popup 分流

- [x] 完整設定／管理頁沿用瀏覽器新分頁；工具列圖示與 `action.openPopup()` 顯示浮動 popup。
- [x] 更新打包版驗收：popup 不新增瀏覽器分頁，options／詳細設定仍開新分頁。
- [x] 跑 lint、打包、CDP 驗收並重新開啟隔離預覽。
- Review：`npm run lint`（359 IPC channels）、`test-browser-extensions`、打包版 `e2e-browser-scripts-cdp --extension-tabs-only` 通過；`electron:pack` 驗證 345 支 src 檔案與原始碼相同。隔離預覽已開啟（`--user-data-dir=axondeck-dev`）。未操作正式安裝版。

### 2026-10-14 — 擴充功能完整管理、ScriptCat 與網站相容性

- [x] 查清所有瀏覽器的擴充功能管理／選項／詳細頁入口，以及 ScriptCat userScripts 缺口。
- [x] 補足啟用／停用／重載／更新／詳細設定及使用者指令碼開關，驗真 ScriptCat 腳本執行。
- [x] 真實查證 ScienceDirect 阻擋原因，修正常瀏覽相容性並驗證結果。
- [x] lint、單元／真插件流程、打包版跨瀏覽器驗收；更新交接與已知限制。
- Review：lint 359 channels、asar 344 支一致、打包版跨頁 smoke 22/22；`e2e-browser-extensions` 驗真 ScriptCat popup 無警告、options、@grant none／GM 儲存腳本、登記／更新／移除／立即執行、訊息與 port、原生登記失敗回復、開關／重載保留、來源不寫回及無套件視窗隔離；`e2e-browser-settings` 五顆真套件都渲染自己的介面，uBO 真選項重載仍保存、Infinity 可開完整設定，Read Frog 右鍵更新／checked 事件及錯誤回呼通過。ScienceDirect 真公開文章與正常連結的 PDF 均 200、PDF success／7 頁／截圖可讀。Raindrop 未登入、未逐一操作每個第三方設定或付費 API；Electron 未提供的 USER_SCRIPT 獨立 world／named world／自訂 CSP 已記在 CONTEXT。未發版。

### 2026-10-14 — 翻譯 Edge TTS 403

- [x] 真服務重現 403，查證上游修正與受影響的朗讀／試聽 caller。
- [x] `node-edge-tts` 固定升至 1.2.11（新 Microsoft 位址）；未增加依賴，該套件鏈無 audit finding。
- [x] 驗證翻譯頁四語試聽與朗讀的真 MP3 播放，確認打包版帶新版套件。
- 最終腳本／商店驗收：最新版打包 `e2e-browser-scripts-cdp` exit 0，本機套件重裝／重啟／移除／無 manifest 拒絕、真 CMD／PowerShell 啟動、原專案單一分頁、真 Google CRX 全過。已啟動 `dev-sandbox.js --packed` 預覽，未 commit/push、未更新正式安裝版。
- Review：`test-tts-boundaries`／`test-tts-playback-lifecycle` 通過；隔離打包版 `e2e-browser-scripts-cdp --tts-only` 實際繁中／簡中／英文／日文 MP3 duration 4.584／3.768／3.768／4.632 秒，四語試聽與原文朗讀都觸發 playing。重跑整套腳本後有一次簡中試聽逾時，服務仍有連線不穩的可能；因此獨立執行語音驗收，避免商店／終端機流程與語音真上游耦合。沒有改正式設定或安裝版。

### 2026-10-14 — 自訂瀏覽器擴充功能與專案開發腳本

- [x] 在既有擴充功能選單加入本機資料夾安裝，保留商店安裝、重啟還原及移除。
- [x] 專案檔案樹的啟動腳本接上瀏覽器改道，固定所屬專案；本機服務就緒後開專案新分頁。
- [x] 驗證輸入邊界、腳本與擴充功能回歸，跑 lint、打包及隔離打包版端到端驗收。
- Review：lint、`test-script-launch`（含真 TCP）、`test-browser-extensions`、終端機 14/14 支、工作區 9/10 支、error-hygiene 85/85、IPC 11/11、temp-hygiene 通過；打包 asar 336 檔一致，打包版跨頁 smoke 22/22。`e2e-browser-scripts-cdp` 通過本機安裝／重裝／重啟／移除保留來源／無 manifest 拒絕、真商店 CRX 安裝，以及真 CMD／PowerShell 啟動（中文＋單引號路徑、巢狀專案仍留點擊時專案、不開系統瀏覽器、不重複分頁、跨專案拒絕）。工作區 UI 197/198，唯一既有舊斷言仍期待 about:blank，而 HEAD 已改 Infinity 新分頁；未改此無關斷言。未發版。

- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。
- [ ] 未修（需硬體或判斷）：SATA SMART 用 access=0 開磁碟（要重編 probe＋SATA＋管理員才驗得了）；網頁版 AI 會記住同站非對話頁（對話網址格式不確定，怕擋掉正常對話）；網頁時長寫入失敗不重試（有 busy_timeout，跨小時重試會重複算）；檔案轉錄 `validateFilePath` 同步 stat（檔案剛由對話框選出）。
- [ ] 依賴稽核剩餘：`concurrently`→9.2.5／`shell-quote`→1.11.0（critical，只影響 `electron:dev`；10/22 後發佈滿兩週再升）；monaco-editor 0.55→0.57（內含 dompurify XSS，pre-1.0 小版號可能破壞，需驗工作區編輯器）；electron-builder 傳遞相依（建置期）。electron 已升 43.7.5。
- 決定不做（記錄理由）：58 支 CDP client 全面收斂與 Playwright 遷移——現有腳本可用，重寫風險大於收益；改為只修真的有害的重複（收程序順序、nav 清單），新腳本照 AGENTS 測試段寫。
- [ ] `probe-asr-key-cdp.js` 初始化回報 `Promise was collected`，未進入斷言。
- [ ] 終端機「突然全空白」未重現，根因未確認（`fitAndSync` 切回一定重畫已補）。

## 已知限制（實作如此，不是 bug）

- PDF／圖片翻譯：複雜背景與數學排版仍要人核對；文字放不下、位置不可靠時保留原文並列警告。
- 終端機對話導覽：緩衝區上限 50000 列；Grok Build 沒有原生輪次跳轉；OpenCode 1.18.35 回答沒有節點 ID，同一提問內用第一行唯一吻合；Antigravity 依賴本機 `altScreenMode: never`。
- AI 紀錄：Antigravity CLI 部分工具結果非明文；多個同工具終端機同時產生對話、無法判定歸屬時不接。
- 文字轉語音：變聲是上游實驗功能；官方模型與本機輸出限研究及非商用。
- 系統監控網路欄：未提權時 ETW／TCP EStats 回 Access denied，顯示「—」；提權 sidecar 真實吞吐未驗。

# 2026-10-13 — 設定「安裝」分頁

- [x] 常用程式 18 個（WinGet＋官方直連：NVIDIA App／Broadcast、RustDesk、Z-Library 更新 API＋SHA-512、FreeCAD-TW 指定 release＋SHA-256）、已安裝／可更新清單、安裝／更新／解除安裝背景工作與進度（`src/main/app-installer/`、`app-installer-page.js`）。
- [x] 子頁 `install` 加進功能視窗允許清單；分頁按鈕不折行、標頭撐滿寬度。
- [x] 清單改緊湊方格卡片；「全部更新（N）」逐一更新（`upgradeAll`，期間鎖住其他操作）。
- [x] 自動分類（`categoryFor`：常用清單用指定類別，其餘依名稱＋ID 關鍵字）＋分類篩選 chip；實機 278 筆約 18% 落「其他」（銀行元件、小工具）。
- Review：`test-app-installer`／`-download`、真實唯讀 `probe-app-installer`（18 個來源都解析成功）、Z-Library 實際下載 222MB 校驗通過（未執行）、lint、打包版 `e2e-app-installer-cdp` 4/4、`e2e-page-windows-cdp` 全過。未實際安裝／解除安裝真程式（e2e 用 mock）。

# 2026-10-13 — 文字轉語音參考 yovoice 改進

- [x] 參考音／原錄音支援 MP3、M4A 等（ffmpeg 轉 24kHz 單聲道）、麥克風錄音、波形拖曳裁切。
- [x] 版本保留（切換、匯出、刪除）、逐句生成與單句修改重做、停止時保留完成的句子。
- [x] 字幕配音（SRT／VTT／ASS、角色指定聲音、依時間放置）、讀音字典。
- [x] 版面改左稿右設定＋下方結果區；e2e 支援 `AXONDECK_DEV=1` 跑原始碼。
- Review：單元測試＋e2e 165 項全過（fixture，不含真模型推論）；未打包驗證、未用真 Q8 跑逐句／字幕。

# 2026-10-12 — 網頁版 AI 右鍵＋F5、專案瀏覽器 Chrome 擴充功能

- [x] 網頁版 AI 與專案瀏覽器 webview：右鍵選單、F5／Ctrl+R（`web-context-menu.js`）。
- [x] 擴充功能：商店頁一鍵安裝、工具列 🧩／右鍵選單開 popup／選項／移除（`browser-extensions.js`＋`electron-chrome-extensions` 4.9.0，專案改 GPL-3.0）。
- [x] 驗證：lint、`test-browser-extensions.js`、Electron 實測（uBO Lite 背景程式／popup、F5、安裝→重裝→移除→重啟）、打包。
- [x] 工具列圖示列＋徽章、自動更新（啟動後 1 分鐘、每 6 小時）。
- [x] 專案 `.bat`／`.cmd` 開瀏覽器改開在該專案（`script-launch.js`）：真 cmd＋打包版沙箱實測 `start`（含 `/?`、`&`）與 Python `webbrowser`。

# 2026-10-11 — 全專案死碼清理與精簡

- [x] 掃描：頂層定義／export 沒人用、preload API 畫面沒呼叫、沒人 require 的檔案與套件、CSS class 全站找不到、跨檔完全相同的函式本體。
- [x] 刪死套件 `node-llama-cpp`、`sherpa-onnx-node`（App 自 1757312／c986a24 起已不用）及 `local-asr.js`、`llama-addon.js`、只測它們的 16 支腳本。
- [x] 拆 10 條沒有呼叫者的 IPC（preload／handler／main 轉發／service／開發替身一起）與零散死定義。
- [x] CSS 刪 11 個全站無引用的 class（24 條規則）。
- [x] 共用：`anthropic-stream.js`（閘道與 AGY 的 Anthropic SSE 產生器原本各一份）、`local-proxy-http.js`（兩個本機代理的 Host／金鑰／JSON 小工具）。
- [x] 文件：README 技術棧、AGENTS asarUnpack、CONTEXT 模組地圖；本檔 822 → 200 行內。
- [x] 驗證：全部單元、AGY e2e、打包、打包版 CDP。
- [x] 順手修驗證時撞到的兩個測試問題：`e2e-agy-cdp` nav 舊預期（少 `speech`）；`e2e-agy-cdp`／`e2e-usage-cdp` 先 `child.kill()` 再 `taskkill /T`，樹找不到 → 留下孤兒 nvidia-smi 咬住 CDP 埠、node 不結束。

## Review（死碼清理）

- 刪除的 IPC：`subtitle:hide`、`system:openCudaDownloadPage`、`llm:loadInfo`、`workspace:projectPath`、`workspace:gitUnstageAll`、`sysmon:fanTaskRemove`、`hfmodels:cancelTune`、`explorer:uffsInstall`／`uffsCancelInstall`／`uffsInstallBroker`。底層仍被測試或其他流程用的（`uffs.cancelDownload`、`sensors-task.remove`、`bench.cancel`、`local-llm.getLoadInfo`）保留。
- 零散死碼：`TRANSLATE_MODEL_KEY`、Qwen wrapper 三件、`cuda-env` 的 `prependCudaBinToPath`／`openCudaDownloadPage`、`background.dirExists`、`disk-treemap.CATEGORIES`、`terminal-page.runInNewTerminal`（舊「更新 CLI」流程）、`api.DEFAULT_MODEL`、`claude-hooks.clearAgent`、`ccswitch-page.mcpHomeLabel`。
- 共用 SSE：AGY 的 `consume` 改成把 Gemini 一格拆成中性 delta 交給同一個 `apply`；收尾 `message_delta` 現在也補輸入與快取用量（原本只有閘道有）。
- 沒動的：只在本檔用卻多 export 的名字（無害）；1–3 行的 `fail`／`el`／`withStore` 各模組各一份（合併反而多一層依賴）；xterm／Monaco 產生的 class 與 `is-${...}` 動態拼的 class。
- 驗證：`node scripts/run-tests.js` 131/131（少的 2 支是刪掉的死模組測試）；`npx electron scripts/e2e-agy.js` 98/0；`npm run electron:pack` 28 秒、asar 290 支一致。對照安裝版 v1.44.0：`app.asar` 482→206MB、`app.asar.unpacked` 72→4.8MB。打包版 CDP：smoke 22/22、`e2e-agy-cdp` 34/34（exit 0，不再卡住）、`e2e-ccswitch-cdp` 149/149、`e2e-hf-cdp` 51/51、`e2e-pdf-translate-cdp` 30/30。
- 中途改壞一次：`THINK_PREFIX` 在 `logLinguaforgeDecode` 還有一處用到，只數「別檔有沒有用」漏掉；單元全綠，打包版 smoke 的真翻譯才抓到。修法是把這兩個已無意義的 log 欄位一起拿掉，並對所有刪掉的名字全庫再 grep 一次。
- 清掉 5 個父程序已死的孤兒 nvidia-smi（1 個是本輪測試留下、4 個是 10/7–10/10 留下的）；安裝版自己那個保留。

# 2026-10-11 — 靜態檢查閘門與測試清理

- [x] ESLint 9.39.5（`eslint.config.mjs`，只開 `no-undef`／`no-unused-vars`／`import/no-unresolved`）；`npm run lint` 通過；`electron:pack` 打包前先跑。
- [x] `scripts/lint-ipc.js` 取代三清單守衛：preload channel 有 main 註冊、`electronAPI.ns.fn` 有定義、ipc.js 的 `service.X` 有轉發。
- [x] 死碼：69 條沒用到的 `require`、14 條其他死變數、22 條沒作用的 `eslint-disable` 註解。
- [x] 測試：刪 `test-explorer-browse-wiring.js`、`test-explorer-operations-ui.js`（只讀原始碼字串）；`test-workspace.js`／`test-explorer.js` 的 `[Q]`／`[Q2]` 守衛（已由 lint 涵蓋）；nav 清單改讀 `index.html`（`e2e-usage-cdp`、`e2e-visual-cdp`）。
- [x] AGENTS.md（驗證方式、作業守則 3／4、專案工作區地雷）、CONTEXT.md（驗證工具）同步。

## Review（靜態檢查閘門）

- 驗證：`npm run lint` 0 項；`lint-ipc` 突變（移除 `pdfTranslate:pasteImage` 轉發）→ `pdf-translate/ipc.js:10 用到 service.pasteImage` exit 1；`run-tests.js` 129/129；`electron:pack` 通過（asar 290 支一致）；打包版 `e2e-cdp-smoke` 22/22。
- 補驗與後續（Opus 複查）：修 `test-chat-image-memory` 替換留下的巢狀 Promise；4 支 CDP 收程序順序錯／沒收樹（`e2e-screentime-cdp`、`probe-dictation-live`、`e2e-ui-transcribe`、`probe-startup`，後者另補暫存 userData）；nav 清單抽成 `scripts/lib/nav-pages.js`（usage／visual／agy／terminal）；visual 的 stt signature 改 `.stt-column`（語音頁改版後 drop-zone 刻意是平的）；electron 43.4.1→43.7.5（修 preload 程式碼快取污染）。
- 驗證（新 electron 打包版）：smoke 22/22、terminal 68/68、agy 34/34、usage 24/24、screentime 19/19、visual 59/59、`probe-startup` 正常；單元 129/129；lint 0。
- 死腳本掃描：280 支無引用已刪檔者（12 條命中皆為字串資料或 `-e` 子程序內路徑，誤判）。

# 近期完成（新→舊，一行一件）

- 2026-10-11 打包卡 15 分鐘：自己開的預覽咬住 exe、robocopy 無限重試 → `pack-preview` 打包前先擋、`/R:12 /W:5`。
- 2026-10-11 翻譯輸入框貼上圖片（`pdfTranslate:pasteImage`）；根因是 `main.js` 轉發漏了 `pasteImage`，補三清單守衛。
- 2026-10-11 PDF／圖片併入翻譯輸入框：「＋ 檔案」、附件 chip、拖放、單一主按鈕；圖片先 `convert_to_pdf` 走同一管線。
- 2026-10-10 PDF 保留版面翻譯（PaddleOCR-VL-1.6＋PP-DocLayoutV3＋隔離 Python）；修 fitz 警告污染 JSONL、孤立替代字；smoke 三條舊 600 字分段預期改 2000。
- 2026-10-10 文字轉語音：模式列收窄、生成上限預設 30000、參考音逐字稿用 ASR 自動填（失敗退回手動）。
- 2026-10-10 文字轉語音四模式卡片排版、鍵盤切換、變聲只顯示適用欄位；語音標記九組中英配對。
- 2026-10-10 Local SI 執行環境排版（文字／狀態／操作三欄）。
- 2026-10-10 預覽接回正式資料（`dev-sandbox --packed --with-chats`，models junction 共用）；清理舊打包與測試資料 42.7 GiB。
- 2026-10-10 Breeze-TTS-2 Q8 文字轉語音頁（設計／克隆／指導／變聲、收藏聲音、WAV 匯出），獨立 breeze-server。
- 2026-10-10 發行 v1.43.0、v1.44.0（NSIS 三件套已上傳）。
- 2026-10-10 AI 紀錄：緊湊排版、完整單頁自動接續、長標題摘要、Ctrl+F 搜尋、側欄複製路徑。
- 2026-10-10 語音頁：三欄等寬、紀錄加長、功能合卡、錄音／字幕音源（麥克風／系統／混音）。
- 2026-10-10 終端機：切回一定重畫（尺寸沒變不送 resize）；分頁標題用 Grok `generated_title`，側欄狀態跟 `events.jsonl`。
- 2026-10-10 Claude `/resume` 改綁（pid 檔優先，停住才看較新 jsonl）；Codex 重複命中不重播；OpenCode 單一按鈕；Grok `--minimal --no-alt-screen`；AGY 綁程序對話庫。
- 2026-10-09 五家 resume 後清單與跳轉：搜目前畫面、略過 system-reminder；Codex 標題只有資料夾名時改綁唯一較新紀錄；改綁成功才通知分頁重讀。
- 2026-10-09 全螢幕 CLI 原生捲動：OpenCode 用 `OPENCODE_TUI_CONFIG` 外掛跳轉；全螢幕且 CLI 收滑鼠時 AxonDeck 讓出捲軸。
- 2026-10-08 終端機對話導覽（右側滑入清單、提問／回答跳轉、只捲動運行中的 CLI，不替換成保存文字）。
- 2026-10-08 實際 CLI 接續入口：用 CLI 回報的明確標題辨識舊對話，重名不猜。事故：舊 robocopy /MIR 清掉預覽 user-data 並穿 junction 刪模型 → 加 `/XJ`＋排除 user-data（`test-pack-preview-data.js`）。
- 2026-10-08 終端機重複貼上：xterm handler `return false` 不擋原生 paste → 補 `preventDefault`、忽略 repeat。
- 2026-10-08 專案側欄 Git 狀態四顆 chip、提交紀錄 30 筆。
- 2026-10-08 Local SI 推薦名稱拿掉 CPU／GPU；0.6B ASR 改 GGUF，兩顆共用 router。
- 2026-10-08 檔案頁右鍵「複製圖片」（`explorer:copyImage`）。
- 2026-10-07 檔案頁方格縮圖整片閃：載入按快取鍵去重、重試預算按鍵算、無變化不重畫。
- 2026-10-07 CC Proxy：CLI 版本搬去設定、MCP 四家讀寫（smol-toml）、Skills 與記憶分頁；發行 v1.42.0。
- 2026-10-07 Local SI 執行環境：API 網址複製、統計改名、推論兩欄；模型庫併進執行環境。
- 2026-10-06 終端機開了就消失（先掛分頁再等 PTY）；本地模型搬進 Local SI、推論自動、Index-Translate；改走共用 llama-server router（GPU 切模型 Access Violation）。
- 2026-10-06 改名 AxonDeck＋新 logo（舊名相容點見 AGENTS.md）。
- 2026-10-06 頂排 SI／Local SI、CC Proxy 精簡、CLI 背景安裝與更新、系統監控處理程序（網路欄、圖示、欄位拖曳）。
- 2026-10-06 AGY 接 Claude Code：攤平 `anyOf`、tool id、先查即時型錄；閘道自動開關；媒體縮圖 `TypeOverlay`。
- 2026-10-04 全專案讀碼掃 bug（61 條查證後修，未修的列在待辦）；檔案頁右欄雙擊（`event.detail === 2`）；Grok Cloudflare（後改 `grok-clearance.js`）；文件精簡。
- 2026-10-03／04 v1.39.0：網頁版 AI、Google 登入、記憶體回收；專案搜尋逐行讀、UFFS 閒置休眠、五家 AI 紀錄與終端機接續。

# 2026-10-11 — PDF 翻譯：亂碼、1GB、速度、警告、介面

- [x] 亂碼：worker 以 `-I` 啟動忽略 `PYTHONIOENCODING`，正式路徑 stdin 用 cp950 解譯文 → 中文全亂碼（也是大量「縮小字體」的來源）；改在程式內設 UTF-8。
- [x] 1.1GB：每段譯文各嵌一份 Droid Sans Fallback（3.5MB）；每頁 `subset_fonts`、最後 `garbage=4` 重寫 → 1.6MB。
- [x] 速度：版面只跑 PP-DocLayoutV3（不再整頁 VL）；有文字層的區塊不 OCR（原本數學多的段落被整塊 OCR 蓋回去）；翻譯一頁並行送出，雲端 4 段＋429／5xx 退避重試。
- [x] 警告：數學變數、函數名（cos、exp）、微分（dx、Mdx）不送翻譯；段落合併不蓋到留著的數學字。
- [x] 介面：chip 上有「翻譯檔案／停止」，進度／警告／另存移到譯文格；主「翻譯」只翻文字，可同時用。
- [x] worker 在 Windows 用 detached 啟動，避免從終端機開 App 時被 llama 的 Ctrl-C 波及。

## Review（PDF 翻譯）

- 實測 CH1_ODE（22 頁，雲端 gemini-3.5-flash-lite）：約 10 分 → 約 3 分 20 秒；1.1GB → 1.6MB；警告 682／217／45 → 0 未轉換、12 縮小、1 放不下（修亂碼後同譯文重放）；輸出頁面目視中文正常、公式保留。
- 驗證：`npm run lint`、`test-pdf-translate-worker.py` 5 組、`test-pdf-translate.js`、真模型 `probe-pdf-translate.js`（PDF＋圖片走 VL OCR）、打包版 `e2e-pdf-translate-cdp.js` 31 項。
- 短片段上下文：80 字以下附整頁原文當 `reference`（雲端放 system prompt，本地忽略）；實測第 1 頁 Physical→物理、Formulation→建立模型、Interpretation→解釋，提示要求只翻片段本身，避免把參考裡的鄰近字帶進譯文。

# 2026-10-11 — Index-Translate 譯文修補

- [x] 行首「A. 」被 `stripPromptLeak` 當答題標籤刪掉 → 原文也是「A. 」開頭時保留；「1. 」被模型吃掉 → Index 也走剝標記再貼回。
- [x] 殘留英文（populations）、日文假名（振り子）→ 偵測到才用 instTrans 約束格式重翻。
- [x] 日文新字體（補関數）→ `jpKanjiToTw` 逐字轉，排除臺灣常用字；專案 287 個檔案驗過只轉真正的日文／簡體字。

## Review（Index 修補）

- 60 段實測：漏翻英文、假名、「A.」「1.」全部修正；PDF 第 1 頁實跑正常。
- 沒修：用詞偏大陸（增長），opencc twp 只在偵測到簡體時才套，套在繁體上會把「參數」改成「引數」；詞義錯（Exact equations→正確方程）是 2B 模型本身的限制。
- `e2e-linguaforge-list.js` 原本失敗（11 行剩 8 行）：沒編號的多行併成一段，0.8B 只翻第一行；`translatePacked` 行數變少就逐行重翻，已通過。

# 2026-10-11 — 翻譯術語表

- [x] 自訂術語（翻譯頁頁首卡片，預設內建數理清單）＋內建國家教育研究院學術名詞庫（理工 45 科、54.6 萬條片語）。
- [x] 雲端：system prompt 附原文出現的術語，多候選依上下文挑；Index：唯一譯名用 instTrans 術語約束；LinguaForge 不套。
- [x] PDF 翻譯快照帶上術語設定；README 補資料來源與授權。
- [x] 順手修：LinguaForge 多行併段只翻第一行（`e2e-linguaforge-list.js` 原本失敗）→ 行數變少就逐行重翻。

## Review（術語表）

- 實測：Index 的正確方程→正合方程、同質→齊次、調和振動子→諧振子、增長→成長、直接整合→直接積分；雲端 Growth→成長。一般新聞句不會被套術語（單字不收）。
- 驗證：`test-glossary.js`、`test-strip-prompt-leak.js`、`e2e-linguaforge-list.js`、lint、打包版 `e2e-pdf-translate-cdp.js`。
- 限制：內建詞庫是學術用語，部分詞偏某學科（physical system→物理系統／實體系統）；Index 對多候選的詞不套用。

# 2026-10-11 — 參考 cc-switch 修復 CC Proxy

- [x] 比對 cc-switch df40d53c 與本機切換、設定、代理呼叫鏈；保留既有翻譯修改。
- [x] 重現並修復 Responses 工具 strict、訊息順序及串流假成功。
- [x] 502／503／504 延遲半秒重試一次，不強制換憑證、不重播已開始的串流；429 不重試。
- [x] CC Switch 單元 4/4 支、gateway E2E 78/78、SSE 邊界、error-hygiene 85/85、lint 通過。
- [x] 真實 Claude Code 2.1.296 → Codex gpt-5.6-luna：純文字、串流、Bash 工具往返、非串流全通過；正式設定與憑證雜湊未變。
- [ ] 打包與打包版 CDP：`npm run electron:pack` 被既有 dist/win-unpacked 預覽程序擋下，未關閉使用者程序。

## Review（CC Proxy）

- 參考 cc-switch df40d53c 的 Responses strict:false、串流終止處理與有限重試；測試先重現 3 個轉換失敗、6 個串流假成功，再修正。
- 實測曾遇一次 Claude 工具請求 503；同一流程重跑及最終驗證皆成功。無法保證排除上游服務持續故障。
- 修正既有真流量 probe 還讀已移除 ANTHROPIC_MODEL 的問題，改用 Sonnet 模型設定。未 commit／push／發版；執行中的版本尚未套用。

# 2026-10-11 — PDF 翻譯加速與警告清零

- [x] 前後頁重疊：這頁等翻譯時先做下一頁版面偵測並送出請求。
- [x] 雲端整頁合併送翻（<<編號>>），漏段／原樣／殘留英文再單獨翻；跟公式同一行的片段單獨翻（合併時模型會搬字：「下列函數的 n 線性獨立性」）。
- [x] 放不下：先往右延伸（同行下一個字、框線、頁面右界），再縮到 3pt；縮寫原樣、公式跳過不算沒翻到；Index 約束格式外洩改一般格式重翻。

## Review（加速與警告）

- CH1_ODE 22 頁：雲端約 199 秒 → 125～146 秒（公式多時合併比例低）；Index 約 118～152 秒（受 CPU 負載影響）。瓶頸是版面偵測約 4.3 秒／頁。
- 警告：使用者那份 7 頁講義 31 未轉換／9 放不下／3 縮小 → 0／0／1；CH1_ODE 雲端 0／0／9、Index 0／0／12。
- 本地模型：前後頁重疊已讓翻譯藏在偵測時間裡；Index 合併送翻對齊 31/32 但會冒「係」，不採用。
- 驗證：worker 測試（含跨頁回覆）、`test-pdf-translate.js`、lint、真模型實跑雲端與 Index。

# 2026-10-11 — 數學不翻、較小版面模型評估、片段品質

- [x] 每個詞都是數學記號的片段（「, sin」「cos x, exp」）不送翻譯。
- [x] 評估較小版面模型（不是量化，是同系列較小的模型）：S 0.34 秒／M 1.32／L 2.34／plus-L 3.26（V3 4.5）；S、M 公式框只抓到約一半，L、plus-L 把標題與句子誤判成公式、留下英文（22 頁中 14／9 頁）→ 維持 V3。
- [x] 跟公式同行的片段試過附整行原文：模型把公式也翻進去（n 重複、$n$），已撤回。
- [x] 雲端合併譯文逐段簡轉繁；opencc「證明瞭」修正；冒出的 $ 拿掉；術語、程式碼原樣保留不算沒翻到。

## Review（數學與片段）

- 使用者那份講義 7 頁：0 警告、54 秒；Prompt Engineering 白皮書 8 頁：版面與譯文正常、45 秒；CH1_ODE 22 頁：0 未轉換、0 放不下、9 縮小。
- 驗證：worker 測試、`test-pdf-translate.js`、`test-strip-prompt-leak.js`（含 opencc）、`test-glossary.js`、lint、打包版介面測試。


# 2026-10-11 — 雲端模型設定合併

- [x] 合併供應商草稿與原子儲存，保留舊 ASR／聊天模型選取。
- [x] 模型能力辨識、手動用途選擇、功能頁路由與選單整理。
- [x] 預設 OpenRouter；AGY 啟動自動帶入 Antigravity 與指定兩模型。
- [x] 雲端文字轉語音生成、取消、播放與匯出。
- [x] 移除底部「儲存設定」，雲端設定改自動儲存。
- [x] 設定側欄新增「外觀」（主題＋終端機外觀＋預覽），「基本」重排、更新區加大。
- [x] 邏輯測試、lint、打包與隔離介面驗收。

## Review（雲端模型設定合併）

- Codex 中途用量用完，Claude 接手收尾：修外觀預覽 lint（`electronAPI` 未定義）、雲端語音與預覽被 CSP 擋（`data:` 播放／`fetch(data:)`）、語音頁模組晚載入時切換「語音來源」沒反應。
- 舊 e2e 跟上新設計：chat（用途下拉取代生圖勾選、改種 `cloudProviders`）、smoke／stt（四個分區、無儲存列）、visual（模型列對齊）。
- 驗證：`npm run lint`、`run-tests.js` 132/132、`test-cloud-providers` 14/14、`test-cloud-tts`、打包版 `e2e-cloud-models-cdp`／`e2e-chat-cdp` 75／`e2e-cdp-smoke` 22／`e2e-visual-cdp` 59 全過。
- 預覽／沙箱／e2e（帶 `--user-data-dir`）啟動會把使用者的開機啟動改寫成 dist 預覽版：`migrateLoginItemName` 與開機設定 IPC 對這類實例停用；登錄值已改回安裝版。預覽一律用 `dev-sandbox.js --packed`（寫進 AGENTS.md）。
- `e2e-stt-cdp` 沒過：腳本還寫死「推薦模型 4 項、兩組」（10/06 的狀態），實際已是 7 項、4 組（語音生成／語音辨識／翻譯／PDF 文件辨識），是舊斷言過期，與本次無關。

# 2026-10-11 — Haiku 5.5 用量單價

- [x] 查證官方一般／長上下文及快取單價，追查計費 caller。
- [x] 補內建價格、逐請求分級、舊統計自動重掃與相關驗證。
- [x] 跑用量測試、lint、打包與隔離驗收，記錄結果。

## Review（Haiku 5.5 用量單價）

- 官方 100K 以下 input/output/read/5m/1h：$0.10/$0.50/$0.01/$0.125/$0.20；超過 100K：$0.50/$2.50/$0.05/$0.625/$1，皆為 USD/1M tokens。
- `node scripts/test-code-usage.js` 174/174；`node scripts/test-code-usage-persistence.js` 通過；`npm run lint` 通過。
- `npm run electron:pack` 通過（300 支 src asar 比對）；`node scripts/e2e-usage-cdp.js` 25/25，包含 80 筆混合級距的計費與拆帳。
- `npx electron scripts/probe-code-usage-audit.js` 真實資料獨立對帳全部通過；Haiku 5.5 實際 80 次、13,627,912 tokens，手算與 App 均約 $1.01。只寫隔離暫存，不改正式統計檔。
- 已重新開啟原有沙箱預覽；未 commit/push、未發版或覆蓋正式安裝版。

# 2026-10-11 — 功能頁獨立視窗

- [x] 每頁只保留一份畫面，使用 WebContentsView 在主視窗與獨立視窗間搬移。
- [x] 導覽列右鍵彈出；最小化／關閉收回；保留輸入、執行中工作與跨頁入口。
- [x] 驗證 IPC 邊界、生命週期、全頁彈出／收回；lint、打包與隔離 CDP。

## Review（功能頁獨立視窗）

- 修：原生最小化（Win+↓、工作列）在 `minimize` 事件內同步 `destroy` 會卡死主程序 → `setImmediate` 後再收回；單元測試補「事件內未 destroy」斷言。
- smoke 兩項在同一段 eval 內先點導覽再讀畫面，新架構下讀到的是舊頁 → 切頁拆成前一步。
- 驗證：`node scripts/run-tests.js` 133/133；`electron:pack`（含 lint）通過、asar 302 支一致；打包版 `e2e-page-windows-cdp` 全過（10 頁＋跨頁＋雙視窗＋原生最小化）、`e2e-cdp-smoke` 22/22。
- 注意：`AXONDECK_TEST_SOURCE=1` 需要先開 vite（5173）；測試中途卡死時會留孤兒 nvidia-smi 咬住 9287。

# 2026-10-12 — 拆掉 CC Proxy 頁

- [x] 專案右側欄「埠號」→「Port」，分「網頁」在上（可點）、「其他服務」在下（main 端 HTTP 探測）
- [x] 額度條拿掉同步診斷（按鈕、彈窗、IPC 整條）
- [x] MCP＋Skills 與記憶合成一頁，右側欄第五顆「MCP/Skills」→ 在目前專案開分頁（tab kind `cc-tools`）
- [x] AGY 反代搬到設定頁新分類
- [x] 供應商、用量統計併進額度條：條左邊兩顆按鈕，點開從條上方展開抽屜；條加高到 34px
- [x] 刪 CC Proxy nav 與頁面；app.js／agy-page／e2e／CONTEXT／AGENTS 跟著改
- [x] 驗證：lint、單元（usage／ccswitch／workspace／mcp／skills／agy）、打包、打包版 CDP（smoke 22、ccswitch 147、agy 34、usage 25）全過；截圖看過寬窄兩種
- Review：`e2e-usage-cdp` 原本點別頁再點回來，在功能頁多視窗模式下會把 CDP 帶到別的 renderer，改成同頁重畫；`e2e-usage.js`（打真上游）沒跑。

## 追加（2026-10-12）

- [x] Port：「網頁」只收真的點得開的（2xx HTML／3xx），按鈕「開啟」放每列最右邊
- [x] 設定頁 AGY 反代圖示改用 Antigravity 標誌（原本誤用 Claude）
- [x] 用量統計重排：兩欄固定高度（左總計＋趨勢、右分佈自己捲），分佈明細改成一種 token 一格
- [x] 預覽開不了終端機：08c4413 的 `term-themes.js` 對已經是 `blob:` 的桌布再 `atob` 一次丟例外；有設桌布的設定才會中（測試用全新設定所以沒抓到）
- Review：`e2e-terminal-cdp`／`e2e-chat-cdp` 原本靠點 CC Proxy 再點回聊天來「切走再回來」，功能頁多視窗下同一個 eval 點回聊天不會真的切回 → 改走 `pages.navigate`。terminal 68/68、usage 25、smoke 22 過；`e2e-chat-cdp` 剩「兩個請求都送到上游」（測試仍寫舊的 `chatProviders`，疑 08c4413 起就壞，未比對）；`e2e-workspace-cdp` 每次掛的項目不同（hover／焦點類，未處理）。
- [x] 功能頁右鍵彈出的視窗標題帶頁名（`檔案 — AxonDeck`），工作列分得出是哪一頁（原本全叫 AxonDeck）
- [x] 滑鼠側鍵在功能頁之間退錯頁：每個功能頁 renderer 載入時讀到 index.html 預設的 chat，多記一步假足跡 → 功能頁模式下只記自己那頁，跨頁交給 main `pages.history`
- [x] 工作區檔案樹就地新增／改名時，跑到一半的監看重畫醒來會把正在打字的那列刪掉 → 開始打字先作廢進行中的重畫（`treeSeq`）
- [x] e2e 跟上功能頁多視窗：`e2e-visual-cdp` 切頁拆成獨立一步；`e2e-workspace-cdp` 開焦點模擬
- [x] 同專案多開分頁：每顆終端機右上角的對話紀錄各看各的——一筆對話只綁給一個還在跑的分頁；agy「目錄最後開過的對話」只在單一分頁時才拿來猜（`agent-resume.js`／`agent-processes.js`／`agent-live-session.js`，單元測試補一則）
- Review（全面掃描）：單元 133/133；打包版 e2e 32 支先全跑一輪，失敗的 11 支拿 HEAD 打包重跑，失敗點完全相同＝既有問題（多半是 f9a2460 功能頁多視窗後測試沒跟上、或 08c4413／1757312 等改版後斷言過時）。本次改壞的只有 speech 寫死 10 頁、stt 的設定分區數，已修。逐支修正測試後再全跑一輪確認。
- [x] 設定頁切走時沒存的修改當下就存：背景 renderer 計時器被節流，450ms 的存檔會延到幾秒後，拿舊草稿蓋掉這段期間別處寫進來的 `cloudProviders`（聊天頁掃描、AGY 自動加的供應商）。`e2e-chat-cdp` 時好時壞就是這個；補了回歸檢查
- [x] 工作區檔案樹：開始就地打字先作廢進行中的監看重畫（`treeSeq`），不然打到一半那列會被刪掉
- Review（第二輪全跑）：e2e 32 支先 30 過，剩 chat（上面那個真 bug）與 workspace（測試跟「重開專案自動展開資料夾」互相抵消）；兩個都修完單獨連跑通過，最後再全跑一輪。


# 2026-10-13 — 設定「安裝」

- [ ] 查證常用程式來源與靜默參數，建立已安裝／更新查詢及背景工作。
- [ ] 串接 main／IPC／preload／設定分頁，呈現搜尋、狀態、安裝／更新／解除安裝。
- [ ] 驗證真實唯讀盤點、操作邊界與 UI，跑 lint、打包及隔離 CDP。

## 2026-10-13 — 圖示與安裝紀錄修復

- [x] 對照 WinGet、登錄檔與 MSIX，保留版本／架構／安裝範圍的唯一身分。
- [x] 修復圖示候選、ICO／DLL 取圖與通用圖退路，涵蓋三個清單。
- [x] 釐清失效移除程式，提供精確錯誤與有備份的紀錄清理。
- [x] 驗證單元、真實唯讀盤點、lint、shell build、打包與隔離 CDP。

Review：281 筆各自身分不再誤判重複（DirectX x86／x64 分開）；233 筆用本機圖示、其餘官網標誌，無白紙圖；雷電移除程式已遺失改提供「清除失效紀錄」（先備份、資料變動就拒絕）。lint、四支單元測試、打包版 CDP e2e 全過。

## 2026-10-13 — 安裝下載加速與常用程式

- [x] 直接下載：各節點先抓 1 MB 測速，最快的先用；支援 Range 的大檔切 8 MB 小塊、16 線並行、單塊重試 3 次。
- [x] NVIDIA 加 us／international／uk 官方節點；修正從 pwsh 7 啟動時 PSModulePath 讓驗簽失敗。
- [x] 常用程式加入 WinRAR、Free Download Manager（20 項）。

Review：實測 FreeCAD 618 MB 由 30 分鐘逾時 → 205 秒（3.0 MB/s）；Z-Library 2.3 → 43 MB/s（主節點卡死改走較快節點）；NVIDIA 已達約 100 MB/s 線路上限。winget 自身下載器不受影響，wininet／DO 比較未得出有效結果。
