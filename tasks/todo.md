# tasks/todo.md — 進行中與待辦

> 非簡單任務先在「進行中」列可勾選計畫，完成後補一行 Review，再收成「近期完成」的一行摘要。已知限制寫在 [CONTEXT.md](../CONTEXT.md)；細節與數字查 git log（`git log -- tasks/todo.md` 有壓縮前的完整紀錄）。本檔維持 150 行內。

## 進行中

（無）

## 待辦／未解

### 需要真帳號或真硬體才驗得了
- [ ] Claude 官方訂閱多帳號：「登入新帳號」與真的切換帳號尚未用第二個真帳號走過。
- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。
- [ ] DeepSeek、Meta AI 網頁版的真實登入與停止鈕標籤（v1.76.0 只驗了網址把關）。
- [ ] 真 MTP 手機裝置未實測（`devices` 清單改殼層 sidecar 後只驗了磁碟）。
- [ ] SATA SMART 用 access=0 開磁碟（要重編 probe＋SATA 碟＋管理員才驗得了）。
- [ ] 系統監控網路欄的提權 sidecar 真實吞吐未驗。
- [ ] LibreOffice 轉 PDF 那條沒實機驗（這台只有 MS Office）。
- [ ] 文字轉語音真 Breeze 模型的邊生成邊播放聽感（e2e 用 fixture）；即時字幕在真翻譯模型下的中途翻譯。
- [ ] Telegram 真的最小化再還原（只測了切頁訊號）、使用者自己的群組聊天室。

### 需要取捨
- [ ] 檔案轉錄把目標語言當辨識語言送（即時字幕已修，檔案轉錄待決）。
- [ ] 感測器交接檔沒 ACL（提權 sidecar 可被同帳號程序導到假管道）。
- [ ] `Oc.Reset` 忽略 SMU 回傳值。
- [ ] 同步 I/O 殘留：terminal store、file-transcribe 的 `validateFilePath`、workspace 拖入。
- [ ] worktree 移除會刪 .gitignore 檔；`showAt` 把 git 失敗畫成空檔；Monaco 首載競態；終端機清單快照蓋掉新狀態。
- [ ] 網頁版 AI 會記住同站非對話頁（對話網址格式不確定，怕擋掉正常對話）。
- [ ] 網頁時長寫入失敗不重試（有 busy_timeout；跨小時重試會重複算）。
- [ ] 久未使用的功能頁回收 renderer、擴充功能延後到第一次開瀏覽器才載入。
- [ ] Browser 模式切換剩下的頓挫一半來自側欄 0.16s 寬度動畫，未拿掉。

### 依賴
- [ ] `concurrently`→9.2.5／`shell-quote`→1.11.0（critical，只影響 `electron:dev`；發佈滿兩週再升）。
- [ ] monaco-editor 0.55→0.57（內含 dompurify XSS 修正，pre-1.0 小版號可能破壞，需驗工作區編輯器）。
- [ ] electron-builder 傳遞相依（只影響建置期）。

### 既有失敗／未確認
- [ ] 終端機「突然全空白」未重現，根因未確認（`fitAndSync` 切回一定重畫已補）。
- [ ] `probe-asr-key-cdp.js` 初始化回報 `Promise was collected`，未進入斷言。
- [ ] `e2e-browser-extensions.js:65` ScriptCat `installByCode` 回 -1（未改動的原始碼也一樣，疑 ScriptCat 上游改了訊息格式）。
- [ ] `probe-explorer-shell.js` 5 項失敗、`probe-explorer-icon-fallback-cdp.js` 的 `.txt` 圖示失敗（v1.73.0 起就有，與縮圖改動無關）。

### 決定不做（記錄理由）
- 58 支 CDP client 全面收斂與 Playwright 遷移：現有腳本可用，重寫風險大於收益；只修真的有害的重複（收程序順序、nav 清單）。
- PDF 中文避頭尾：MuPDF `insert_htmlbox` 已照 UAX#14 處理，不另做。
- 較小的 PP-DocLayout 模型：S／M 漏公式框、L／plus-L 把標題誤判成公式，不換。
- `edge-tts` 試聽打斷朗讀：判斷是設計。

## 近期完成（新→舊，一行一件）

- 2026-11-14 GPU 可重建圖片快取上限 64 MiB（`force-gpu-mem-discardable-limit-mb`，明確啟動參數可覆寫）：隔離 PNG 負載閒置 GPU 335.57→167.95 MiB、截圖與 WebGL2 讀回一致；安裝版實測 60 秒約 314–319 MiB、九頁與加速檢查通過。證據在 terminal/logs/gpu-cache-probe；未做數小時重度媒體回歸。
- 2026-11-14 獨立編輯器對齊主流體驗（參考 VS Code／Notepads／Notepad++／Win11 記事本）：狀態列每格可點（跳行、縮排、以其他編碼重新開啟／以 UTF-8 等儲存、CRLF／LF、可搜尋語言模式）、「⋯」選單（開啟、另存新檔、比較未儲存的變更、在檔案頁顯示、複製路徑、縮圖地圖、空白字元）、sticky scroll／括號配色（大檔自動關）；預覽加 HTML（不開 CORS 的 `vi-preview`）、CSV／TSV 表格、Mermaid，Markdown 分割跟捲；補約 120 種副檔名，HTML／CSV 只進「開啟方式」；修 `.gitignore` 類檔名關聯打不開。驗證：lint、`test-editor-window`、cargo test 7/7、`probe-editor-formats` 9 項、`probe-editor-bigfile`（打字 13ms，基準 15ms）、electron:pack＋打包版 HTML 預覽。
- 2026-11-14 分頁列「＋」滑過就展開、往右開；「終端機」子選單直接選 shell（PowerShell 7／Windows PowerShell／命令提示字元／WSL，WSL 拖放路徑轉 `/mnt/<碟>`），每列右邊盾牌圖示＝系統管理員，拿掉「終端機（自訂…）」彈窗與管理員勾選（連同 `terminal:pickDirectory`）。終端機對話導覽 AI 回覆走 Markdown、每則顯示完整（上限 2 萬字）、面板加寬不透明。驗證：lint、`test-terminal-conversation`、打包版 `e2e-terminal-cdp`、`e2e-terminal-conversation-cdp`。
- 2026-11-14 擴充功能管理頁新增「鍵盤快速鍵」（錄製、衝突檢查、在 AxonDeck 中／全域），分頁按下去開 popup 或送 `commands.onCommand`；工具列圖示可釘選／取消釘選（圖示右鍵、🧩 選單、管理頁），「用系統瀏覽器開」改純圖示。驗證：lint、`test-browser-extensions`、`probe-crx-commands.js` 原始碼與打包版各 9/9、electron:pack；工具列圖示按鈕未在完整 App 截圖確認。

- 2026-11-13 Browser 的 Chrome 線上應用程式商店可直接按「加到 Chrome」安裝、「從 Chrome 中移除」移除（自補 webstorePrivate／management，接既有 install／remove，前後跳原生確認）。驗證：lint、`probe-crx-webstore.js` 原始碼與打包版各 5/5、`test-browser-extensions`、electron:pack。預設擴充功能另加 Bitwarden、最終啟用右鍵、Dark Reader、SponsorBlock（舊使用者下次啟動補裝一次）。
- 2026-11-13 原生媒體播放器對齊主流（參考 uosc／ModernZ／IINA／mpv.net）：點哪跳哪、懸停時間＋章節泡泡、章節刻痕與選單、剩餘時間、同名字幕與資料夾封面自動載入、媒體鍵（Windows 媒體浮窗實測可暫停）、0–9 跳百分比、音量 OSD。驗證：cargo test 18/18、`probe-media-ui.js` 10/10、lint、electron:pack。
- 2026-11-10 v1.76.0：Chat 新增 DeepSeek、Meta AI 網頁版；處理程序分「應用程式／背景」兩段、拿掉取樣頻率設定、修 CPU 重複計算；感測器斷線持續重連。
- 2026-11-10 v1.75.1：深度讀碼（7 個子代理唯讀回報、主代理複核）修三十多個 bug；拆 6 條死 IPC、11 個多餘 export、88 行死 CSS；修三支過期 e2e。驗證：lint、單元 169/169、打包版 `e2e-cdp-smoke` 22/22、`e2e-sysmon-cdp` 118/118。
- 2026-11-09 v1.75.0：系統監控總覽改成硬體側欄（`#sysmonRail`）、段落全部攤開、右側目錄（`sysmon-toc.js`）。
- 2026-11-09 v1.74.0：媒體縮圖改內建 mpv／magick＋磁碟快取、上限 512；沒有關聯的副檔名：文字開自家編輯器、其他顯示 App 內訊息。
- 2026-11-08 v1.73.0：Local SI／系統監控拿掉頁首並重排、同類硬體合併成一張卡、處理程序記憶體改私有工作集（AxonDeck 由 12.3 GB 校正為約 4.8 GB）、「磁碟」欄改名 I/O。
- 2026-11-08 文字轉語音頁重構（左稿右聲音、底部播放列＋版本／分句抽屜、雲端併入同頁、`speech-stream.js` 自適應緩衝）；語音轉文字頁緊湊化、即時字幕邊聽邊修正（第一句出字雲端 1.6 秒、本地 1.0 秒）、全域半透明反白。
- 2026-11-07 v1.72.x：Telegram 移進 Chat 側欄（入口可選、右鍵開獨立視窗）、網頁對話生成狀態、額度條移到 AI 頁最下方、Port／資源改右側直條、資源改算獨占記憶體、Telegram／網頁版 AI 閒置 1 小時釋放、Telegram 前景維持。
- 2026-11-01 v1.70.x：OCR 換成 Unlimited-OCR-2 Q8（patch 過的 llama.cpp b11913 疊加包放 HF）、掃描表格逐格換字或整張重排、行內上下標與局部粗體；CUDA 每頁 5.5～7 秒、Vulkan 約 15 秒。v1.71.0 探索篩 Dense／MoE 與參數上限。
- 2026-10-29 v1.69.0：AGY 反代支援生圖，更新模型清單與工具呼叫相容性；真實上游成功產圖。
- 2026-10-26 v1.68.0：外部指令改在 utilityProcess 開（`proc-broker.js`）、預載最近 7 天用過的頁，切回已開過的頁最慢 0.65→0.09 秒；文字轉語音改版、額度條加 App 資源抽屜、Git 面板按鈕依狀態。
- 2026-10-25 v1.67.0：Antigravity 的 MCP／Skills／GEMINI.md／設定檔可管，各家設定檔可編（存前驗格式），終端機糊字自動修復。
- 2026-10-24 v1.66.0：瀏覽器切分頁最近 2 顆透明疊放（最長一幀 146–236→7–14ms）、背景分頁 1 小時休眠、`parkBrowserMain`。
- 2026-10-23 v1.65.0：Local SI 推薦併進執行環境、探索只列文字生成模型（`archs.js`）。
- 2026-10-22 v1.64.x：專案搜尋／程序快照／Ctrl+G 抬視窗／大資料夾列目錄改 Rust，手機清單改殼層 sidecar；檔案頁一律顯示隱藏項目。
- 2026-10-21 v1.63.x：功能頁初始化前移除別頁 DOM；超大文字檔（>256MB）唯讀分段檢視、Git diff 只收前 2MB。
- 2026-10-20 v1.62.x：AGY 支援 Gemini 4 Argon；網頁版 AI 長對話 `installRenderBoost`、工作區 HTML 預覽。
- 2026-10-18 v1.59～1.61：Office 預覽、螢幕框選翻譯、PDF 翻譯借鑑 BabelDOC、用量統計讀 Antigravity。
- 更早（v1.39～v1.58：改名 AxonDeck、網頁版 AI、Local SI router、終端機獨立宿主、Miroxen、擴充功能、PDF 翻譯、Breeze-TTS）見 `git log -- tasks/todo.md`。
