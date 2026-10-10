# tasks/todo.md — 進行中與待辦

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。完成的任務只留一行摘要；細節與數字查 git log（`git log -- tasks/todo.md` 可看壓縮前的完整紀錄）。

## 待辦／未解

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
