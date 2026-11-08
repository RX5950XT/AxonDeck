# tasks/todo.md — 進行中與待辦

> 非簡單任務先在「進行中」列可勾選計畫，完成後補一行 Review，再收成「近期完成」的一行摘要。細節與數字查 git log（`git log -- tasks/todo.md` 可看壓縮前的完整紀錄）。本檔維持 200 行內。

## 進行中

### Local SI／系統監控拿掉頁首、版面重構、處理程序數字校正
- [x] 拿掉兩頁的頁首（小標＋大標＋說明）；系統監控「更新頻率」移到子分頁那一排
- [x] 系統監控總覽：展開的卡佔滿整列、收起的卡併排成儀表；加「全部收起／展開」
- [x] Local SI 執行環境：寬畫面左主（啟動、本機模型、推薦）右側欄（推論、圖片 API、log）
- [x] 處理程序記憶體改「私有工作集」（工作集加總會重複算共用頁，AxonDeck 顯示 12.3 GB、實際約 4.8 GB）；Rust 與 ps1 同步
- [x] 「磁碟」欄其實是全部 I/O（含管道、快取命中）：改名 I/O，表頭改總速率
- [x] 同類合併：多顆硬碟收進「儲存」卡、多張顯示卡收成一張「GPU」卡，展開後每個裝置一段（寬時並排）；`e2e-sysmon-cdp` 改看卡內 `.sysmon-device`
- [x] 語音輸入卡緊湊化：開關＋說明＋狀態一排、下拉一排（1440 寬高度約 160px）
- [x] 驗證：lint、`build:probe`＋`cargo test finds_self`、`probe-native-probe-parity.js`、`test-sysmon(-procs)`、`e2e-hf-cdp` 52 項、`e2e-sysmon-cdp` 112/113、`e2e-visual-cdp` 兩頁 1440／900 深淺色、截圖
- Review：`e2e-sysmon-cdp` 的「page-sysmon 存在」在主框架找頁面（各頁已拆 renderer）是既有失敗；`e2e-visual-cdp` 卡在聊天頁控制項檢查（chatModelSelect 抓不到），也是既有、與本次無關。`e2e-hf-cdp` 的推薦分組預期是 v1.70.0 改名後沒同步，已更新。

### 文字轉語音頁重構
- [x] 整頁工作桌：左稿子、右聲音、底部生成結果（播放列＋「版本／分句」抽屜），各自捲動；版本原本在右側分頁，使用者覺得結果拆兩處很怪，已併到播放列
- [x] 四個模式分頁拆成「生成方式」＋「聲音從哪裡來＋語氣」
- [x] 保存的聲音改成可點選清單；版本改成清單（播放、上下鍵切換、刪除）；分句清單預設展開並跟著播放捲動
- [x] 雲端併進同一頁、結果存成版本；草稿自動保存；Ctrl+Enter；生成進度條
- [x] 驗證：lint、單元、`e2e-speech-cdp`（176 項）、`e2e-cloud-models-cdp`
- Review：版面截圖 1440／1000／760／640 深淺色都檢查過。未驗：真 Breeze 模型（e2e 用 fixture）。雲端結果改存 WAV 版本，不再能匯出原始 MP3。
- [x] 邊生成邊播放：抽成 `speech-stream.js`。修掉生成一結束就把還沒播的聲音切掉；加自適應緩衝（跟不上不再一頓一頓）、句間停頓、重做那句倒回重排；串流中播放鍵可暫停／繼續，第一次生成也看得到
- [x] 驗證：`test-speech-stream.js`（假 AudioContext）、lint、`e2e-speech-cdp` 178 項。未驗：真模型實際聽感

### 語音轉文字頁緊湊化、即時字幕邊聽邊修正、全域半透明反白
- [x] 全部可選取文字反白半透明（主程式、編輯器、Monaco、終端機預設色、字幕窗、螢幕翻譯、webview）
- [x] 字幕窗可選取；更新不打斷選取
- [x] 字幕紀錄改用閱讀視窗（時間軸、雙語層次）
- [x] 錄音／字幕：按鈕、狀態、音源併成一條；拖放區改窄；省下的高度給紀錄
- [x] 即時字幕：邊聽邊重新辨識、語言改自動偵測、雲端送前文、靜音切句、選安靜處切長句
- [x] 驗證：lint、單元、CDP、真模型實測
- Review：真模型串流（`probe-live-asr.js`）第一句出字雲端 1.6 秒、本地 1.0 秒（舊流程至少等 6 秒切段）；後面的音訊確實修正前面的字。未驗：真翻譯模型下的中途翻譯、實際喇叭放音的 `e2e-live-cdp`。檔案轉錄也把目標語言當辨識語言送，同一個問題還在（待決）。

### 資源抽屜重複計算、Telegram 跑掉、網頁閒置釋放
- [x] 資源抽屜記憶體改獨占量（Electron `privateBytes`、子程序 `privateMemory`）
- [x] Telegram：切回只改 hash 會被彈回列表並寫進設定 → 整頁重載；載入中回列表不寫入；最小化也算看不到
- [x] Telegram／網頁版 AI 閒置 1 小時釋放；重開會變樣的不收
- Review：`test-app-resources`、`test-telegram-page`（舊程式碼重現失敗）、`test-ai-web-sleep`、lint 通過；真實 Web A 驗到彈回與收格／載回。有焦點視窗＋完整 session 副本對真實 Web A 實測：載入、背景改址切回、閒置收格切回都回到原聊天室。未驗：真的最小化再還原（只測了切頁訊號）、使用者自己的群組聊天室。

### OCR 換成 Unlimited-OCR-2 Q8（取代 PaddleOCR-VL-1.6）
- [x] 在 patch 過的 llama.cpp b11913 編 `llama.dll`＋`mtmd.dll`（BACKEND_DL，只這兩顆有改推論），疊在官方 b11913 包上
- [x] 本機組 b11913 CUDA 執行環境＋疊加包，實測 OCR、ASR、翻譯模型都載得起來
- [x] models.js：LLAMA_BUILD→b11913、疊加包＋版本記號、`unlimitedocr2q8` 取代 `paddleocrvl16`、清掉舊資料夾
- [x] router preset：OCR 用 `-np 1`、不量化 KV
- [x] 螢幕翻譯：`<PAGE>` 提示、輸出區塊轉純文字
- [x] PDF worker：PaddleOCRVL spotting → 直接打 router，`<BLOCK>` 區塊轉 units（保留 PP-DocLayoutV3 版面）
- [x] archs.js 跟 b11913 同步；測試／腳本／README／CONTEXT／NOTICE 更新
- [x] 用 Griffiths 量子力學 PDF 實測；lint＋相關測試
- [x] 疊加包上傳到 HF `RX5950XT/Unlimited-OCR-2-GGUF` 的 `llama.cpp-bin/`（README 補說明）；用 App 的 models.download 實際下載驗過 SHA-256、解壓順序與記號檔
- Review：worker／螢幕翻譯／pdf models／hf 推薦／archs 測試全過；真模型 router 跑 Griffiths 掃描頁 21、15 頁（每頁約 25 秒），段落全翻、公式與圖留原樣；後續修掉框線接縫（改蓋矩形）、補行距／首行縮排／左右對齊／標題粗體、全大寫標題轉大小寫；Vulkan 執行環境＋Antigravity gemini-3.5-flash-lite 實測 15、21 頁通過。
- [x] 行內上下標、譯文被改寫回的 LaTeX、局部粗體（系統黑體粗體字）；螢幕翻譯公式轉 Unicode
- [x] Vulkan：SAM 的 rel-pos／qkv 乘法改成不在第 4 維廣播（不再退回 CPU），疊加包與 patch 重新上傳 HF
- [x] 掃描表格：逐格換字／整張重排；OCR preset 開 `special`（表格標籤）；`other`（表格標題、資料來源）也翻
- Review（後續）：CUDA 實測每頁 5.5～7 秒（之前 25 秒是錯的）、Vulkan 約 15 秒；不切塊模式會讀錯字不採用。表格用 OmniDocBench 8 張表驗：6 張逐格、2 張整張重排。

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

- 2026-10-29 v1.69.0：AGY 反代支援生圖，更新模型清單與工具呼叫相容性；真實上游成功產圖。

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

## Review：Telegram 移進 Chat 側欄、入口可選、網頁對話狀態

- Telegram 從導覽列移到 Chat 側欄，住 AI 頁主區（`setChatPaneMode('telegram')`），不再有獨立 renderer，也不能單獨開獨立視窗。入口顯示選擇存 localStorage `chatLaunchersHidden`。
- 網頁對話每 2 秒看開著的 webview 有沒有停止鈕，生成中＝`running`，背景結束＝`done`（未讀）。
- 已驗證：lint、test-telegram-page、test-ai-web-sleep、test-browser-mode-recycle-fix、test-window-security、e2e-side-nav；打包版隔離資料 CDP 跑側欄、選單、停放、狀態（停止鈕是注入的）。
- 未驗證：已登入的真實 Telegram 在新位置的行為；ChatGPT／Gemini／Claude／Grok 真實停止鈕的標籤。

## Review：分類右鍵、Port／資源直條、額度條移到 Chat 頁

- 專案分類拿掉三點按鈕，標題按右鍵開選單。
- Port、資源抽屜改貼右邊的直條（寬上限 420px、高上限 68vh／720px），供應商、用量統計維持整條寬。
- 額度條從 `#wsShell` 搬到 `.chat-stage` 最下面：Agent、Chat、網頁 AI、Telegram 都有，Browser 模式藏起來。
- 已驗證：lint、test-browser-mode-recycle-fix、e2e-usage-cdp、e2e-workspace-folders-cdp、打包版隔離資料 CDP（各模式額度條、抽屜尺寸與截圖）。
