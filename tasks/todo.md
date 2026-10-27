# tasks/todo.md — 進行中與待辦

> 非簡單任務先在「進行中」列可勾選計畫，完成後補一行 Review，再收成「近期完成」的一行摘要。細節與數字查 git log（`git log -- tasks/todo.md` 可看壓縮前的完整紀錄）。本檔維持 200 行內。

## 進行中

（無）

## 待辦／未解

### 需要真帳號或真硬體才驗得了
- [ ] Claude 官方訂閱多帳號：「登入新帳號」與真的切換帳號尚未用第二個真帳號走過。
- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。
- [ ] 真 MTP 手機裝置未實測（`devices` 清單改殼層 sidecar 後只驗了磁碟）。
- [ ] SATA SMART 用 access=0 開磁碟（要重編 probe＋SATA 碟＋管理員才驗得了）。
- [ ] 系統監控網路欄的提權 sidecar 真實吞吐未驗。
- [ ] LibreOffice 轉 PDF 那條沒實機驗（這台只有 MS Office）。

### 需要取捨
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

### 未確認的問題
- [ ] 終端機「突然全空白」未重現，根因未確認（`fitAndSync` 切回一定重畫已補）。
- [ ] `probe-asr-key-cdp.js` 初始化回報 `Promise was collected`，未進入斷言。
- [ ] `test-screentime.js` 需要已不存在的 Tai `data.db`，在這台跑不起來。

### 決定不做（記錄理由）
- 58 支 CDP client 全面收斂與 Playwright 遷移：現有腳本可用，重寫風險大於收益；只修真的有害的重複（收程序順序、nav 清單）。
- PDF 中文避頭尾：MuPDF `insert_htmlbox` 已照 UAX#14 處理，不另做。
- 較小的 PP-DocLayout 模型：S／M 漏公式框、L／plus-L 把標題誤判成公式，不換。

## 已知限制（實作如此，不是 bug）

- PDF／圖片翻譯：複雜背景與數學排版仍要人核對；文字放不下、位置不可靠時保留原文並列警告。
- 終端機對話導覽：緩衝區上限 50000 列；Grok Build 沒有原生輪次跳轉；OpenCode 1.18.35 回答沒有節點 ID，同一提問內用第一行唯一吻合；Antigravity 依賴本機 `altScreenMode: never`。
- AI 紀錄：Antigravity CLI 部分工具結果非明文；多個同工具終端機同時產生對話、無法判定歸屬時不接。
- 文字轉語音：變聲是上游實驗功能；官方模型與本機輸出限研究及非商用。
- 系統監控網路欄：未提權時 ETW／TCP EStats 回 Access denied，顯示「—」。
- 安裝檔 NotSigned。

## 近期完成（新→舊，一行一件）

- 2026-10-26 v1.68.0：外部指令改在 utilityProcess 開（`proc-broker.js`）、預載最近 7 天用過的頁，切回已開過的頁最慢 0.65→0.09 秒。
- 2026-10-26 文字轉語音改版：女聲範本試聽、底部播放列、生成排隊、`audio-clean.js` 音量與頭尾靜音整理、runaway 自動重做。
- 2026-10-26 額度條延伸到右側欄底下，Port 搬進條裡，新增 App 資源佔用抽屜（`app-resources.js`）。
- 2026-10-26 Git 面板按鈕依狀態顯示、沒暫存直接全部提交、新分支一鍵發布。
- 2026-10-25 v1.67.0：Antigravity 的 MCP／Skills／GEMINI.md／設定檔可管，各家設定檔可編（存前驗格式），終端機糊字自動修復。
- 2026-10-24 v1.66.0：瀏覽器切分頁最近 2 顆透明疊放（最長一幀 146–236→7–14ms）、背景分頁 1 小時休眠、`parkBrowserMain`；10 分鐘反覆切換記憶體持平。
- 2026-10-23 v1.65.0：Local SI 推薦併進執行環境、探索只列文字生成模型（`archs.js`）。
- 2026-10-22 v1.64.x：專案搜尋／程序快照／Ctrl+G 抬視窗／大資料夾列目錄改 Rust，手機清單改殼層 sidecar（與舊版輸出逐筆對照一致）；檔案頁一律顯示隱藏項目。
- 2026-10-21 v1.63.1：功能頁初始化前移除別頁 DOM、拆聊天／設定初始化，降低記憶體；腳本啟動改編輯器「執行」入口。
- 2026-10-21 v1.63.0：超大文字檔（>256MB）唯讀分段檢視、Git diff 只收前 2MB、大 Markdown 預設編輯。
- 2026-10-20 Telegram 切回保留每格位置（背景暫停連線檢查、子 frame 導覽不寫入）。
- 2026-10-20 v1.62.x：AGY 支援 Gemini 4 Argon；網頁版 AI 長對話 `installRenderBoost`、工作區 HTML 預覽、大資料夾縮圖、內建瀏覽器透出深色底。
- 2026-10-18 v1.61.0：用量統計讀 Antigravity CLI 本機對話。
- 2026-10-18 v1.60.0：螢幕框選自動翻譯（參考 LunaTranslator）、PDF 翻譯借鑑 BabelDOC（快取、術語抽取、頁碼、雙語對照、跨欄接段）。
- 2026-10-18 v1.59.0：工作區 Office 預覽（原始版面走 Office COM→PDF、簡易檢視自解 zip）；專案側欄分類。
- 2026-10-17 v1.58.x：Chat Local 改版（思考強度 8 檔、生圖退 `/images/generations`、閱讀欄版面）；v1.57.0 Markdown 預覽補齊。
- 2026-10-17 借鑑 magpie／t3code／paseo 12 項：settings 去 BOM、toml 只改 MCP 區塊、MCP 測試、背景通知、上下文用量、額度提醒與預熱、models.dev 單價、worktree 流程、指令面板。
- 2026-10-16 整合 Miroxen（生成圖片影像頁、Local SI 引擎與模型、API 與區網），v1.56.0。
- 2026-10-16 v1.55.0：語音轉文字錄音紅點、檔案轉錄紀錄清單。
- 2026-10-16 v1.54.x：取消網頁／Telegram 自動拆頁、Monaco 保留快取、終端機 WebGL 畫布保留 8 個（修 v1.53.0 退化）、即時字幕與文字翻譯切頁保留模型。
- 2026-10-16 系統監控總覽重排、壓力測試併入效能調整；全庫死碼清理＋子代理找 bug（修約 55 條，未修的列在待辦）。
- 2026-10-16 記憶體：OpenCC 字典樹共用（81→42MB）、看不到的終端機格卸 WebGL、nvidia-smi 不再 detached。
- 2026-10-16 Claude 官方訂閱多帳號；開 AI 時終端機畫面破碎（open 後尺寸不同補送 resize）。
- 2026-10-15 Codex 終端機意外退出（別處按名稱全殺 node）→ 宿主直接跑 codex.exe；GitHub 按鈕閃爍。
- 2026-10-15 v1.52.0：擴充功能完整管理、本機安裝、ScriptCat userScripts、popup 與分頁分流、ScienceDirect 相容性；Edge TTS 403 → node-edge-tts 1.2.11。
- 2026-10-14 專案 `.bat`／`.cmd` 腳本開瀏覽器改開在該專案（`script-launch.js`）。
- 2026-10-13 設定「安裝」分頁（WinGet＋官方直連、分類、全部更新、失敗自動重試、圖示）；v1.51.0。
- 2026-10-13 文字轉語音參考 yovoice：MP3／M4A 參考音、錄音裁切、版本保留、逐句重做、字幕配音、讀音字典。
- 2026-10-12 網頁版 AI 右鍵＋F5、專案瀏覽器 Chrome 擴充功能（專案改 GPL-3.0）；拆掉 CC Proxy 頁。
- 2026-10-11 全專案死碼清理（刪 node-llama-cpp、sherpa-onnx、10 條死 IPC）；ESLint＋`lint-ipc.js` 靜態檢查閘門。
- 2026-10-11 PDF 翻譯修亂碼（worker stdin UTF-8）、1.1GB→1.6MB（字型子集化）、GPU 加速；Index-Translate 修補；翻譯術語表。
- 2026-10-11 參考 cc-switch 修 CC Proxy（Responses strict、訊息順序、串流假成功、5xx 重試一次）；雲端模型設定合併；Haiku 5.5 單價；功能頁獨立視窗。
- 2026-10-11 打包卡 15 分鐘（自己開的預覽咬住 exe）→ `pack-preview` 打包前先擋；翻譯輸入框貼上圖片。
- 2026-10-10 PDF 保留版面翻譯（PaddleOCR-VL-1.6＋PP-DocLayoutV3＋隔離 Python）；Breeze-TTS-2 文字轉語音頁；v1.43.0、v1.44.0。
- 2026-10-10 預覽接回正式資料（`dev-sandbox --packed --with-chats`）；AI 紀錄單頁＋搜尋；終端機切回一定重畫。
- 2026-10-08～09 終端機對話導覽、五家 resume 綁定、全螢幕 CLI 原生捲動；robocopy /MIR 穿 junction 事故 → `/XJ`＋排除 user-data。
- 2026-10-07 CC Proxy：CLI 版本搬設定頁、MCP 四家讀寫、Skills 與記憶；v1.42.0。
- 2026-10-06 改名 AxonDeck＋新 logo；本地模型搬進 Local SI、改走共用 llama-server router；AGY 接 Claude Code。
- 2026-10-03～04 v1.39.x：網頁版 AI、Google 登入、全專案讀碼修 61 條 bug、Grok Cloudflare。
