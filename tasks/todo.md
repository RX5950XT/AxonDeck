# 2026-10-02 — 修復其餘四類設定不一致

- [x] 為 LLM 預載設定、ASR 刪除後復活、本機聊天提示、URL／Key 提示留下先失敗的回歸
- [x] 修復共用初始化與設定判斷，保留舊版設定升級
- [x] 跑相關回歸、重新打包，再以隔離 CDP 驗證畫面與重開設定

## Review

- `engine.setStore` 同時交給 ASR／LLM；ASR 只在清單欄位不存在時升級舊設定，刪空後不復活、不使用舊 Key；聊天提示與選單共用 main 的供應商清單，僅回傳 URL／Key 是否存在；轉錄／翻譯／整理選單共用精確缺欄位提示。
- `node scripts/test-settings-consistency.js`：修復前 4 passed, 7 failed，修復後 11 passed, 0 failed；保留真正舊版與單模型格式升級回歸。
- `node scripts/probe-asr-key-cdp.js`：四類舊包 4 passed, 4 failed，新包 8 passed, 0 failed；真 IPC／ffmpeg／本機假上游驗證選用 Key、模型 ID，背景 CDP 驗證本機聊天、缺 URL 提示、刪光後重開。
- `npm run electron:pack` 成功，248 支 src 檔案與 asar 相同；`npx electron scripts/e2e-chat.js` 195/0、`node scripts/e2e-chat-cdp.js` 62/0、`test-model-scope.js` 31/0、`test-error-hygiene.js` 85/0、`test-file-transcribe-cancel.js` PASS；語法與 `git diff --check` 通過，隔離測試程序已收完。
- 已更新 `dist/win-unpacked`，未替換正在使用的安裝版；GPU 僅驗設定傳遞，未載真模型；字幕僅驗啟動檢查，未擷取麥克風／系統音訊。既有無關 `test-temp-hygiene.js` 問題仍如下一節所列。

# 2026-10-02 — 雲端轉錄誤報缺 API Key

- [x] 追查設定儲存與檔案轉錄／即時字幕的檢查，先跑失敗回歸（初版舊包 1 passed, 3 failed；完善初始化等待與早期阻擋斷言後，安裝版 0 passed, 4 failed）
- [x] 重用模型選單的 ready 判斷，檢查當頁選用的雲端設定
- [x] 打包後用隔離 CDP 驗證轉錄、正確金鑰與真正缺金鑰的阻擋

## Review

- 根因：設定頁存 `asrClouds[].apiKey`，檔案轉錄／即時字幕仍以舊 `asrApiKey` 擋空；改為重用 `asrOptions`，依當頁選用值檢查 ready。
- `node scripts/probe-asr-key-cdp.js`：新打包版 4 passed, 0 failed；本機假上游收到選用那組的 Key 與含冒號模型 ID；真正缺 Key 會在送出前擋住。字幕僅驗啟動前檢查，音訊擷取刻意取消。
- `npm run electron:pack` 成功，asar 248 支 src 與原始碼相同；`test-model-scope.js` 31/0、`test-error-hygiene.js` 85/0、`test-file-transcribe-cancel.js` PASS；語法與 diff 檢查通過。
- 既有無關問題：`test-temp-hygiene.js` 指出 `test-usage.js:824,844` 使用 `os.tmpdir()`，本次未修改。
- 已更新 `dist/win-unpacked`，未替換正在使用的安裝版，未呼叫真正雲端供應商、未 commit／push。

# 2026-09-29 — 檔案頁 Google Drive 綠勾＋每個資料夾各自記檢視

- [x] 方格縮圖不帶同步標記：sidecar `thumb` 多回 `overlay`（問 ShellIconOverlayIdentifiers 處理常式），renderer 疊在左下
- [x] `explorer.json` 的 `folderViews`：檢視／Ctrl+滾輪大小／排序依資料夾記，左右欄共用，全域值只當預設

## Review

- 驗證：`test-explorer` 313/0、`test-explorer-shell` 44/0、page-state／browse-wiring／icons-state 綠；electron:pack 後 `probe-explorer-folder-views-cdp.js` 4/4 全過，截圖確認綠勾與雲朵
- 疑點：另寫的截圖版腳本兩次數不到 `.ex-row-overlay`，但同次截圖有標記；正式探針沒重現

# 2026-09-28 — 系統監控硬碟溫度偏高＋整頁體檢

- [x] 硬碟溫度：LHM 0.9.7 對 NVMe 送出門檻值 `Warning Temperature` 70／`Critical Temperature` 75，頁面 `diskTempOf` 取最大值把門檻當讀數；風扇 `readSource` 同樣排除
- [x] `ocGpuSpark` id 補回（多 GPU 改版後遺失）；`e2e-sysmon-oc-cdp` 的 V/F 斷言改成「沒開感測器時要講原因」
- [x] `e2e-sysmon-cdp` 陣列 pid 斷言過期（v1.33.0 起支援多選）：改驗「陣列夾壞值整批擋掉」，不再真的送 taskkill
- [x] `e2e-sysmon-fans-cdp`／`oc-cdp` 收尾順序跟 disk-cdp 對齊（先同步 `taskkill /T` 再 kill），stdio 改 ignore：之前每跑一次留一顆 nvidia-smi 抱住 CDP 埠，下一輪卡死

## Review

- 驗證：11 支 test-sysmon*、cargo test 25＋12、native-probe parity、真 Electron `e2e-sysmon.js` 63/0；electron:pack 後 `e2e-sysmon-cdp` 114/0、disk 17/0、fans 23/0（5 秒結束）、oc 18/0，跑完零孤兒
- `e2e-sysmon-sensors.js` 29/0（真 UAC）：孤兒檢查原本把使用者開著的正式版 sidecar 也算進去，改成只數測試自己拉起的 pid，並輪詢到 10 秒（實測 stop 後約 8 秒收掉：先交還風扇再關 LHM）
- 未跑：`probe-sysmon-fans.js`／`probe-sysmon-oc.js`（會真的改風扇／時脈）

# 2026-09-25（二）— 系統監控加「磁碟空間」子分頁（類似 disktree）

- [x] Rust `voiceink-probe disk-tree`：一次掃完、bottom-up 修剪（每層留前 200、太小併「其他」）、輸出單行 JSON
- [x] main `sysmon/disktree.js`＋IPC＋main 白名單＋preload（三份清單）
- [x] renderer：磁碟清單、squarified treemap（類型上色、快取 hatch）、放大／麵包屑、大小／檔案數、名稱篩選
- [x] 側欄：選取詳情、最大檔案、標記 → 檢閱 → 丟資源回收筒（不做永久刪除）
- [x] 測試：cargo test、test-sysmon-disktree、test-disk-treemap、打包版 CDP 實測
  - [x] `scripts/e2e-sysmon-disk-cdp.js`：子分頁、掃描總量、treemap 點擊／Backspace、檔案數與篩選、回收筒、深淺色截圖、console error（17 passed）

## Review

- 實作交給 Grok CLI（grok-4.7 high）分後端／前端／CDP／平行化四批，這邊規劃、審 code、驗收
- 整顆 C: 單執行緒 180 秒逾時 → 改平行＋列舉 8 秒逾時（Containers\Layers 有一層會卡死 FindFirstFile），60 秒內掃完 223 萬檔
- 驗收時抓到：淺色截圖太早拍（主題過場）、磁碟清單與工具列擠同一排 → 分兩排；CDP 收尾順序讓 nvidia-smi 變孤兒佔住埠（新舊兩支 e2e 都修）
- 驗證：cargo test 21＋11、test-sysmon-disktree 49、test-disk-treemap、test-sysmon 188、page-lifecycle、sensor-groups 全過；electron:pack asar 驗證過；e2e-sysmon-disk-cdp 17（連跑兩次、零孤兒）、e2e-sysmon-cdp 114 全過

# 2026-09-25 — 檔案頁補齊跟 Windows 檔案總管的差距

- [x] 內容／權限：App 選單加「內容」＋ Alt+Enter，走殼層 `properties` 動詞（Windows 原生內容視窗，含「安全性」分頁）；殼層那份不再重複列
- [x] 原生右鍵選單：實測 sidecar 回來的項目（已經接好，只驗證）
- [x] ZIP 瀏覽：`explorer/zip.js`（讀中央目錄、stored／deflate、CRC 檢查、擋 zip-slip）；點 .zip 進得去、檔案開得了（解到暫存）、複製貼上＝解壓、拖得出去、「解壓縮到…」「全部解壓縮」；壓縮檔裡唯讀
- [x] 開啟／另存新檔對話框：別的程式自己跟 Windows 要的，換不掉——回報，不做
- [x] 測試：zip 單元測試、打包後 CDP 實測

## Review

- 「內容」一開始 `InvokeCommand` 回報成功卻沒有視窗：sidecar 主執行緒卡在讀 stdin、不跑訊息迴圈。改成背景讀 stdin＋主執行緒訊息迴圈後視窗出現（列 sidecar 的頂層視窗驗證）
- 實測順便抓到：右鍵選單等殼層項目時資料夾被背景重讀就安靜不出來（比的是 navSeq）→ 改成只比資料夾
- 驗證：test-explorer-zip 35、test-explorer 299 等檔案頁單元測試全過；打包版 e2e-explorer 112／dual 42／files-plan 55／zip 11、drag 12、probe-explorer-shell 14 全過

# 2026-09-24（二）— 檔案頁排序／緊湊、終端機、語音、風扇示意圖、總覽、卡死

- [x] 檔案：左欄加「整機／只篩這個資料夾」切換（跟右欄同一顆，分頁各自記住）；左欄工具列加排序下拉＋方向（方格檢視也排得了）；搜尋結果名稱欄改照路徑排、可選相關度；右欄搜尋中也能排序
- [x] 檔案：欄位間距 16→6px、工具列／指令列縮 padding；收起的欄位把手一起藏（右邊不再剩兩條拖不動的線）；900px 寬工具列換行不吃掉路徑；左欄太窄收掉「修改」欄
- [x] 終端機：xterm.css 的 `overflow-y: scroll` 在打包版畫出原生捲軸軌道，跟 xterm 自己的捲軸疊成兩條 → 藏原生那條；焦點在終端機裡也能 Ctrl+Tab 切分頁；新增 Ctrl+Shift+T 開終端機、Ctrl+Shift+W 關分頁
- [x] 語音：即時字幕改左設定右紀錄兩欄（原本 520px 窄欄置中、紀錄在畫面外）；檔案轉錄直接列最近 4 段錄音點了就轉；錄音中導覽列亮紅點（實測縮小視窗 15 秒照樣寫檔）
- [x] 風扇：機殼示意圖改側透斜上方視角（主機板正對、CPU／GPU 風扇正圓），16 個位置投影後外框與標籤兩兩不重疊（CDP 量過）
- [x] 系統監控總覽：每執行緒／容量長條改多欄；S.M.A.R.T.、磁碟區等細項預設收起；標題單行。總高 6464→約 3850px；選中的程序結束後「強制結束」鈕跟著停用
- [x] 卡死：Windows 事件記錄 30 天內 22 次「VoiceInk 停止回應被關閉」。主程序同步 I/O 改非同步＋逾時：檔案頁常用位置／磁碟清單（下載在 NAS 上，睡著時 statSync 卡到 SMB 逾時）、上次路徑、回收筒掃描、whoami／丟回收筒 PowerShell；終端機滑過連結偵測（JSON 轉義的 `\Users` 被當 UNC 查網路名稱）；用量統計與 AI 記錄掃檔；讀錄音檔；匯入 GGUF 複製

## Review

- 驗證：vite build 過；單元測試其餘全過，4 支失敗在 HEAD 上一樣失敗（app-dialog-ime、explorer「監看保留選取」、temp-hygiene、usage-state-race）；electron:pack asar 驗證 237 支過
- CDP（打包版）：smoke、explorer 112、explorer-dual、terminal 59、workspace 183、sysmon 114、fans 23、stt 21、live 6、recorder 15、visual 59 全過。explorer 舊斷言改成略過 Telegram、空白點擊避開 toast；recorder 改測新的錄音清單；visual 抓到停用下拉的選中項灰字（已補 `option:disabled:checked`）
- 追加：檔案頁加「類型」排序（沒副檔名在前、同類依名）、「大小」「修改」欄可拖曳調寬（記在 localStorage）、欄標題留捲軸槽跟欄位對齊；4 支既有失敗單元測試都是測試過時（Enter 改由 dialog 統一處理、註解把 regex 視窗撐破、設定多了 bar 預設值、探測根目錄用了 os.tmpdir），已改好全過。壓縮／解壓縮交給 WinRAR 右鍵，不做。重打包後 explorer、explorer-dual、visual 全過
- 卡死原因沒有堆疊可證（事件記錄只有 AppHang），修的是讀程式碼找得到、會讓主程序整段停住的同步呼叫；實際是否消失要看之後的事件記錄
- 測試中兩個用 PowerShell Start-Process 開的實例「消失」是工具結束時連帶收掉，不是 App 當機（改用 node 開的實例一路正常）

# 2026-09-24 — 全專案 UX 稽核：修掉「不合常理」的地方

十區稽核（外殼／聊天／工作區／分頁編輯器／終端機／檔案／CC代理／AGY＋HF／語音／系統監控），逐條對照程式碼查證後修。

- [x] 更新：手動模式「發現新版本」後按鈕變「下載更新」真的能下載；下載失敗不再說成「檢查失敗」
- [x] 設定頁：本地模型刪除就地二次確認；沒存的草稿切頁不被洗掉；雲端 ASR 金鑰檢查看真正被選用的那組；驗證失敗帶到出錯分類；附帶提醒併進「設定已儲存」；改名即時反映下拉；取消下載不報紅；開機自啟失敗照實講；文案對齊
- [x] CC代理：彈窗內顯示錯誤／提示；編輯使用中那家存檔即重新套用；使用中的不能刪；閘道沒開講真正原因；Base URL 格式先擋；MCP 同名不覆蓋、改完提示要重開；載入模型已先存檔的說明；舊掃描結果不塞進別家；版本檢查有進行中狀態；用量統計日桶改當地零點、未設單價不顯示 $0、Antigravity 說明顯示、長名稱不截斷
- [x] 聊天：回應中 Enter 不再砍掉回覆；圖片可點開大圖；非圖片拖入有提示；失效模型顯示「請選擇模型」；確認刪除不會 hover 一離開就消失
- [x] 工作區：取消第二個對話框不再照樣建 worktree；Git 篩選框藏起時清字；＋選單 Esc 可關；不支援預覽的檔案藏「帶入聊天」；關閉其他略過的分頁有說明
- [x] 輸入法：檔案右欄路徑、終端機搜尋、工作區搜尋、瀏覽器網址、HF 搜尋的 Enter 擋組字
- [x] 終端機：新終端機防連點；不支援的 OSC 8 連結有提示
- [x] 檔案：工具列新增／清空回收筒跟著作用中那一欄
- [x] HF／AGY：下載可取消、切回來進度還在、刪除後可重新下載、錯誤會清、取消換資料夾不報成功、調參全失敗不說「已最快」、移除必 401 的「複製端點」；AGY 改埠失敗照實講、錯誤不被輪詢洗掉、篩選無結果文案
- [x] 系統監控：還原 BIOS 真的放手；風扇編輯器不被每秒重建打斷、右鍵刪曲線點；磁碟測速 undefined／虛擬磁碟／取消回饋；合併程序結束不誤報失敗；UAC 拒絕後重試成功會恢復自動；壓測自動停止反映到畫面；處理程序數用實際數量；效能調整錯誤留住、改了未套用有標示、還原後提示收起；使用時長對準今天、不翻進未來、點柱子有標示、匯出失敗有提示
- 刻意不改：額度條顏色（藏起來的視窗用盡時仍紅＝真的不能用）、檔案左右欄搜尋範圍預設不同（設計取捨）、個人字典刪詞確認（易重加）、處理程序結束後按鈕狀態、GPU 壓測勾選框（低影響）

Review：`test-updater.js`（新增 [B] 手動下載，修前紅）＋ 17 支單元測試全綠（code-usage 158、sysmon-fans 55、hfmodels 171、ccswitch 258、workspace 280、workspace-ui 181…）；
`electron:pack` asar 驗證通過；CDP：ccswitch 125、chat 62、workspace 183、sysmon 114、hf 44、agy 34、usage 24、screentime 19、fans 23 全過。
既有失敗（安裝版 v1.28.0 同樣失敗、與本次無關）：`e2e-explorer-cdp`「檔案排在聊天後面」（nav 多了 Telegram，斷言過期）、`e2e-sysmon-oc-cdp` 3 項（GPU 走勢圖／V/F 容器）。

# 2026-09-23 — 額度詳情精簡、Claude 429、Codex 重置、Grok 方案；工作區搜尋放大鏡

- [x] 工作區右欄：「檔案／搜尋」切換拿掉，標題列加放大鏡（`wsFilesSearchBtn`，aria-pressed）
- [x] 額度詳情卡精簡成一行一個視窗，留方案名
- [x] Claude 429：改報 `claude-code/…` UA；`fetchJson` 429 不重試＋端點冷卻；soft cache 沿用 planName
- [x] Grok `tier: 1` → SuperGrok（CLI log 佐證），其他數字不猜
- [x] Codex 重置次數＋到期日＋「使用」（官方 `codex app-server` 兌換）；Claude／Grok 查無同類 API

Review：`test-usage.js` 38/38（新增 429／UA／重置明細／app-server 協定／id 驗證）、`test-claude-auth.js` 7/7、
`e2e-usage-cdp.js` 24/24、`e2e-workspace-cdp.js` 183/183、`test-workspace-ui.js` 181/181；打包版截圖確認三家詳情卡與放大鏡。
實測：同一顆 token，`claude-code/2.1.280` 連打 5 次全 200；`node`／`VoiceInk/1.26.0` 429。重置的兌換沒有真的按（會扣使用者的次數），只用唯讀的 `account/rateLimits/read` 驗過 app-server 握手。

# 2026-09-23 — 兩支常駐 PowerShell 改寫成 Rust（voiceink-probe.exe）

- [x] `native/voiceink-probe`：`sysmon` 模式＝probe.ps1（static／tick／detail 同協定同格式）、`observer` 模式＝observer.ps1
- [x] 程序清單走 NtQuerySystemInformation、網路走 GetAdaptersAddresses＋GetIfEntry2；其餘 WMI 查詢照抄
- [x] `src/main/native-probe.js`：有 exe 就用、沒有退回 PowerShell；`npm run build:probe`、extraResources、.gitignore
- [x] `probe-native-probe-parity.js`：兩邊輸出對照；`probe-sysmon-idle-cpu.js` 改成兩種都量

Review：`cargo test` 7/7、clippy 0 警告；parity ALL PASS（static 83 列逐字相同）；`electron:pack` 過；
`e2e-sysmon-cdp.js` 114/114、`e2e-screentime-cdp.js` 19/19；sysmon／screentime 單元測試全綠。
實測：常駐記憶體 190.9＋70.3MB → 3.2＋1.2MB；背景 CPU 6.02＋0.21% → 0.08＋0.03%；開著系統監控頁（2 秒一輪）7.03% → 1.09%。

# 2026-09-23 — 全庫掃 bug、清死碼、降背景開銷

- [x] ESLint（recommended＋no-undef／no-unexpected-multiline）掃 src 與 scripts
- [x] 修 2 個「行首是 `(` 被接到上一行」：語音輸入手動插入退路（`start(el)` TypeError）、風扇曲線方向鍵移點後丟例外
- [x] 刪死碼：未定義的 `renderSpecs` 呼叫、13 個沒人讀的變數、12 個沒人呼叫的 export／函式、~500 行沒人用的 CSS
- [x] 系統監控取樣器沒人看時 `idle()`（30 秒一輪），常駐不變

Review：ESLint src 0 問題；`vite build` 過；`test-sysmon-sampler-lifecycle.js`（修前紅：`sampler.idle is not a function`）、
`test-sysmon-resident.js`、`test-sysmon-page-lifecycle.js`、`test-workspace-ui.js` 181/181 綠；`electron:pack` asar 驗證過；
`e2e-sysmon-cdp.js` 114/114；`probe-sysmon-idle-cpu.js` 背景 CPU 5.65% → 0.52% 單核。
既有失敗（改前就紅、與本次無關）：test-app-dialog-ime、test-asar-lock（要 npx electron）、test-explorer「監看保留選取」、
test-temp-hygiene（test-explorer.js:396）、test-usage-state-race。

# 2026-09-23 — 額度收成終端機下面那條、用量統計進 CC代理、Claude 自動續期、終端機複製與連結

- [x] 額度頁 → `#termMain` 底下 26px 的 `#quotaBar`（點開原卡片、拖曳／Alt+←→ 排序、診斷、同步）
- [x] 顯示設定：哪幾家＋每一家顯示什麼（`settings.bar`，main 逐欄驗）
- [x] 看得到時每 60 秒自動同步；進工作區／切回視窗補一次
- [x] Claude token 照 CLI 協定自己續（鎖＋重讀＋CAS＋原子替換），401 也強制續一次
- [x] 用量統計搬到 CC代理子分頁；nav 從十頁變九頁，五支 CDP 腳本的頁面清單跟著改
- [x] 單價：Claude Opus 5.5、GPT-6 Sol、GPT-6 Luna（官方價，2026-09-23 查證）
- [x] OSC 8 超連結不再跳 confirm，直接開內建瀏覽器
- [x] 終端機複製：有選取 Ctrl+C／Ctrl+Shift+C／Ctrl+Insert／右鍵複製，剪貼簿走 main

Review：`test-claude-auth.js` 7/7（舊 claude.js 紅 2）、`test-usage.js` 34/34、`test-code-usage.js` 158/158、
`e2e-usage-cdp.js` 23/23、`e2e-terminal-copy-cdp.js` 12/12（安裝版 v1.25.0 紅 8）、`e2e-terminal-cdp.js` 58/58、
`e2e-cdp-smoke.js` 22/22、`e2e-visual-cdp.js` 73、`e2e-agy-cdp.js` 34/34、`e2e-chat-cdp.js` 62/62、
`probe-claude-refresh.js --force` 真的續了一次全綠。

# 2026-09-21 — 欄寬可拖、分頁列縮小並可拖曳排序

回報：四塊欄位（側欄／主欄／右欄／詳情）之間的縫隙要能拖大小；分頁列要窄一點矮一點，
而且像瀏覽器那樣可以左右拖。

- `initResizer()` 從 `app.js` 抽成 `pane-resize.js`（多了 min／max／onResize），聊天側欄沿用，
  檔案總管三條把手共用同一份。寬度進 CSS 變數＋localStorage。
- 詳情欄本來是 CSS `resize: horizontal`：把手只在右下角一個小三角、換頁就忘記，換掉。
- 分頁列 padding 8→3、分頁 180px→`flex: 0 1 148px`（最小 96px）、字 13→12px、
  關閉鈕 28→20px、新增鈕 32→26px。整條從 54px 降到 34px。
- 分頁左右拖排序：`createListReorder` 加 `axis`，鍵盤改 Alt+←→。

地雷：
1. `.ex-resizer` 沒有 `position: relative` 的話 `z-index` 不生效，`margin-inline: -3px`
   會讓左右欄疊在把手上面，整條點不到（詳情欄那條完全拖不動，查了三輪才看到
   `elementFromPoint` 回傳的是隔壁欄）。
2. 操作中心那塊浮動面板蓋在右下角，詳情欄把手中段被它擋住。使用者抓上半段沒問題，
   測試也要抓 `rect.top + 40`。
3. **CDP 的滑鼠「按下／放開」在視窗沒有前景時會被 Chromium 丟掉**，只剩 mousemove。
   探針一開始沒加 `--hidden`，三個拖曳全部靜靜地沒反應，差點以為是程式壞了。
4. 右欄要吃固定寬（`flex: 0 0 var(--ex-second-w)`），兩邊都 `flex: 1` 的話把手一拖會互推。

驗收：`e2e-explorer-cdp.js` 112 條（新增 [J]）、`test-explorer.js` 297 條、
`e2e-explorer-dual-cdp.js` 42 條全綠。

已知偶發（改動前就有，跟這次無關）：`e2e-explorer-cdp.js` 的 [C6] 框選與 [C8]／[F] 的
資料夾監看會偶爾紅。[C6] 紅的時候現場是 `selected: 3` 但 `marquees: 0`——框選其實跑了，
是晚一步的監看事件重畫清單把框洗掉。腳本現在會在紅的時候把現場印出來。

# 2026-09-21 — 雙欄右欄換不了磁碟

回報：「開啟雙欄預設在 C，沒辦法便捷地切其他槽。」

右欄本來只能靠三條路換磁碟：先點右欄讓它變作用欄再去側欄按、把麵包屑點開打路徑、
或一路按 ↑。而 ↑ 到磁碟根目錄再按一次會到「本機」，右欄在「本機」不畫磁碟格，
所以看到的是一片空白——等於沒有出口。

- 右欄標頭加一排磁碟鈕（`#exSecondDrives`）：按一下換槽，順便把作用欄切成右欄，
  目前那顆用 `aria-pressed` 標起來。資料跟側欄共用同一份 `disks`。
- 右欄在「本機」時的空畫面改成指路去那排鈕，不再只寫「這個資料夾是空的」。

順手修掉：`#exSecondCmdBar` 只在 `setActivePane()` 時畫，所以剛開雙欄、還沒點過右欄
之前那條指令列是空的。改成跟著 `paintSecondPane()` 一起畫。

地雷：磁碟鈕不壓 `max-width` 的話，四顆鈕會把 `flex-basis: 0` 的麵包屑擠成 0 寬，
右欄窄到 240px 時路徑整個看不見（實測 `crumbW: 0`）。麵包屑另外給 `min-width: 78px`。

驗收：`e2e-explorer-dual-cdp.js` 42 條、`test-explorer.js` 297 條、
`e2e-explorer-cdp.js` 102 條全綠。`e2e-explorer-files-plan-cdp.js` 的「換到自種的三頁 PDF」
在**跑原始碼**時會逾時，把改動前的 master 原始碼放回去跑同樣會紅，不是這次造成的；
那支本來就是寫給打包版跑的（打包版 55 條全過）。

# 2026-09-21 — 全專案 bug 掃描與修復

- [x] 盤點主要模組、既有測試與安全執行範圍
- [x] 分模組追查，新增失敗回歸並最小修復已確認問題
- [x] 跑跨模組回歸、打包與背景 CDP 驗收
- [x] 記錄實際結果及未涵蓋邊界

## Review

修好的問題（每項都先有一支會失敗的回歸，再改）：

- HF 儀表板離開再回來會重開舊輪詢（`hf-dash.js`）
- 朗讀停止後仍留播放監聽與等待工作（`translate-page.js`）
- PDF 快速翻頁被慢一步的舊頁蓋回（`explorer-preview.js`）
- 關閉 PDF 預覽整段中斷：pdfjs 6 的 `PDFDocumentProxy` 沒有 `destroy()`，要走
  `loadingTask.destroy()`；原本丟 TypeError，`closePreview` 半路斷掉、預覽關不掉
- 中文選字按 Enter 誤送出：彈窗、路徑輸入、快速開檔、搜尋／取代、分頁改名、
  工作區改名、側欄改名（`app-dialog.js`／`ws-*.js`／`workspace-page.js`／`chat-sidebar.js`）
- 圖片預覽載入後顯示錯誤的縮放百分比（`image-viewer.js`）
- 複製後清單沒刷新、中文大檔存檔上限按位元組算、Windows 路徑大小寫
  （`workspace/files.js`／`search.js`／`watch.js`／`explorer/fs.js`）
- AGY 串流逾時被當成正常結束（`agy/upstream.js`）
- HF hub 讀 body 前綴在沒有 body 時會炸（`hfmodels/hub.js`）

驗收（2026-09-21）：

- `scripts/test-*.js` 80 支全過（`test-asar-lock` 要用 electron 跑，另計）
- electron：`test-asar-lock` 8、`e2e-agy` 98、`e2e-chat` 195 全過
- 打包版 CDP：`e2e-explorer-files-plan-cdp` 54、`e2e-app-dialog-cdp` 8、
  `e2e-explorer-cdp`、`e2e-ccswitch-gateway` 40 全過

未涵蓋：需要實體麥克風、GPU 感測器與真雲端憑證的路徑（ASR／sysmon／dictation）沒跑。

地雷：

- `node_modules/.bin` 會整個空掉，`vite`／`electron` 就找不到；`npm install` 重建連結即可。
- `e2e-agy`／`e2e-chat` 印完結果不會真的退出，打包前要先清掉殘留的 electron，
  否則 `npm install` 會 EBUSY 卡在 `electron/dist`。
- `e2e-explorer-files-plan-cdp` 的預覽換檔會繞圈，不能假設「下一份」是哪個副檔名。

# 2026-09-21 — 方格檢視縮放、大圖預覽、終端機貼截圖、Ctrl+G 的 PATH

- [x] 方格檢視檔名直書：`.ex-row-name` 在 grid 下改直排，檔名限兩行 ＋ `title` 放完整檔名
- [x] Ctrl+滾輪縮放：`explorer-zoom.js` 純函式級距（清單↔48/64/96/128/180/256），
      `--ex-tile` 驅動版面、`data-tile` 驅動縮圖尺寸，存進 `explorer.json` 的 `tile`
- [x] 縮圖跟著放大：`explorer-icons.js` 的請求尺寸與快取鍵都帶 tile
- [x] 大圖預覽 `image-viewer.js`：空白鍵／側欄預覽圖／右鍵「預覽」開，滾輪縮放、拖曳、
      ←→ 換圖、Esc 關；圖片走 `vi-media://` 的 `~local`（不再卡 2MB）
- [x] 終端機貼上截圖：`terminal/clipboard-image.js` 落成 PNG 後貼路徑，Ctrl+V／Alt+V 都收
- [x] Ctrl+G 的 `editor "voiceink-edit.cmd" not found in PATH`：`shellEnvironment` 的
      `env.PATH = …` 在 Windows 等於另開一個空 PATH，改成就地改本來那個 `Path` 鍵
- [x] 測試：`test-explorer-zoom.js`（新）、`probe-terminal-editor.js` [F][H] 改成會抓到這個 bug、
      `e2e-explorer-cdp.js` [C11]、`e2e-terminal-cdp.js` 貼截圖兩條
- [x] 文件：AGENTS 地雷四條、CONTEXT 架構兩段

Review：
- 根因一（Ctrl+G）：Windows 環境變數不分大小寫，但 `{ ...process.env }` 展開後的鍵是 `Path`，
  `env.PATH = …` 新增的是第二個同名變數，子程序生效的仍是原本那份 → CLI 找不到 shim。
  舊測試讀的是自己寫進去的那個假鍵，所以一直是綠的。
- 根因二（方格直書）：只改了 `.ex-row` 的 flex 方向，沒改裡面那層 `.ex-row-name`。
- 使用者要重新啟動終端機宿主，Ctrl+G 的修正才會生效（宿主活得比 App 久）。

# 2026-09-20 — 檢查更新下載走鏡像（GitHub APAC 過慢）

- [x] `update-mirrors.js`：GitHub Releases 的 `.exe` 先走 gh-proxy／ghfast，最後才官方
- [x] `updater.js` 包住 `httpExecutor.download`；失敗刪掉半截再試下一個
- [x] `latest.yml` 仍只從 GitHub 讀（sha512 信任根不走代理）
- [x] 測試先紅再綠；probe 量鏡像 vs GitHub 的實際速度
- [x] 文件：AGENTS 更新地雷、發行流程不用多一步

# 2026-09-20 — 電腦安裝版 VoiceInk 更新至最新發行版（v1.23.1）

- [x] 調查安裝版檢查更新失敗根因：v1.22.0 差分下載與快取狀態、網路或 Range 請求中斷觸發 error；v1.23.1 已修正關閉差分下載
- [x] 確認安裝檔：`dist/VoiceInk-Setup-1.23.1.exe` SHA-512 與 GitHub Release 完全吻合
- [x] 安全關閉目前背景常駐的 1.22.0 主程序與關聯程序
- [x] 執行 NSIS 靜默安裝更新至 v1.23.1
- [x] 驗證安裝後的執行檔版本（1.23.1.0）、捷徑、app-update.yml
- [x] 啟動新版並驗證檢查更新功能正常（已是最新版本，不報錯）
- [x] 清理暫存檔案與回顧

Review：
- 根因：舊版 v1.22.0 預設開啟差分下載（Differential Download），在進行增量下載時需發送數千次 HTTP Range 請求，若遭遇 GitHub CDN 中斷、超時或快取 blockmap 不一致即觸發 error 事件，且 updater 錯誤提示一律為「檢查更新失敗（無法連線到 GitHub，或這個版本沒有附帶更新資訊）」。
- 處置：下載官方發行 v1.23.1 安裝包（SHA-512 校驗一致），關閉舊版常駐程序後完成 NSIS 靜默安裝。安裝後 `VoiceInk.exe` 版本為 1.23.1.0，新版已內建關閉差分下載改為整包單連線下載，檢查更新確認顯示「已經是最新版本」，後續升級通道恢復正常。

# 2026-09-20 — 檔案總管殼層選單 ＋ Google Drive 綠勾

- [x] sidecar：`IContextMenu` 讀 7-Zip／WinRAR／傳送到；overlay 改 `SHGFI_ADDOVERLAYS`
- [x] 「傳送到」空選單：`CMF_SYNCCASCADEMENU` ＋ IContextMenu3 沒填再退 IContextMenu2
- [x] 玻璃選單合併殼層項（去重 App 自己的開啟／剪下複製）
- [x] 可見列圖示走疊好的殼層圖（Drive 綠勾）；沒 sidecar 降級
- [x] 驗證：`test-explorer-shell.js` 26/0、`test-explorer.js` 186/0；probe 看到 WinRAR／7-Zip／傳送到；Drive `學校的資料` overlay 槽 14、PNG 2038 bytes
# 2026-09-20 — 用量單價、Claude Opus 計價、多硬碟排版

工作樹：`D:\\Workspace\\Personal_Project\\VoiceInk-usage-sysmon`（分支 `feat/usage-sysmon`）

- [x] Gemini 3.8 Flash、Kimi K3 公開單價（測試先紅再綠）
- [x] Claude Opus：核對本機 jsonl（去重後快取讀佔大宗，不是重複加總）；補花費拆帳讓畫面看得出為什麼貴
- [x] 系統監控：虛擬磁區（Google Drive）不進容量總計；多顆實體碟各一卡；磁碟計數器繞回不做差值
- [x] `test-code-usage.js` 158/0、`test-sysmon.js` 188/0、`e2e-sysmon.js` 63/0、`e2e-code-usage.js` 16/0
  未做：`electron:pack` 與打包版 CDP（在工作樹裡改，預覽請用 `npm run dev:sandbox`）

# 2026-09-20 — 合併前審查（上一輪未提交的 34 檔）

- [x] 逐模組審查未提交變更（終端機／HF／系統監控／檔案總管／文件）
- [x] 修：**關思考沒真的關**——`--reasoning` 預設 auto，不寫 `off` 等於沒關（先紅再綠）
- [x] 修：**儀表板 tok/s 永遠是「—」**——router 沒帶 `--metrics`、`/metrics` 要帶 `?model=`、
      欄位名實測是 `tokens_predicted_seconds_total`（三個都缺一不可；`e2e-hfmodels.js` 真的量到 7.4 tok/s）
- [x] 修：**nvidia-smi 卡在啟動不會重開**——看門狗改成 spawn 就武裝，子程序結束時收掉（先紅再綠）
- [x] 修：切回「執行環境」子分頁會再開一條儀表板輪詢鏈（`startDash` 重入）
- [x] 查證後排除：preset 的 `no-mmproj = 1` 安全（router 自己轉成 `--no-mmproj-auto`，不會多送一個 `1`）
- [x] 文件：CLAUDE／AGENTS 補三條實測地雷（reasoning 預設、/metrics 三件事、GPU 看門狗）

Review：17 支 node 測試全綠（terminal 102／links 116／hfmodels 169／sysmon 183／explorer 186／
workspace 251／workspace-ui 127／error-hygiene 85 等）；`probe-terminal-links.js` 6/0、
`probe-terminal-editor.js` 10/0、`e2e-hfmodels.js` 26/0（真的起 router、真的發請求、真的量到速度）。
**未做**：`npm run electron:pack` 與打包版 CDP（審查在 worktree 裡跑，打包預覽要在主工作目錄更新）。

# 2026-09-19 — 系統監控常駐穩定 ＋ HF 模型對標 LM Studio

- [x] 感測器：斷線／卡住無限重拉（指數退避），不再 5 次就停；測試先紅
- [x] nvidia-smi 卡住也重開
- [x] HF 依 GGUF 架構自適應：上下文梯度、視覺、思考、in-checkpoint MTP
- [x] HF 儀表板：GPU VRAM、tok/s、排隊、本機端點、llama log（不送金鑰）
- [x] 模型卡顯示 ctx／KV／視覺／MTP；參數彈窗可設上下文／視覺／思考
- [x] CONTEXT／AGENTS／CLAUDE 對齊；相關測試全綠

# 2026-09-19 — 改善終端機體驗

- [x] 連結掃描：硬換行／折行接起來；`file://`、`www.`、`localhost:埠`；路徑留下行號
- [x] 點網址開內建瀏覽器分頁；點路徑用 App 開（專案內編輯器／樹，其餘走檔案頁）
- [x] AGY Ctrl+G：EDITOR 改短檔名＋PATH，通過 `split(' ')` + `shell: true` 的 spawn
- [x] 降低破圖：WebGL context 掉了重掛、fit 後清 glyph atlas
- [x] 測試先紅再綠：`test-terminal-links.js`、`probe-terminal-editor.js`；再跑 `test-terminal.js`

# 2026-09-15 — 根治專案外殘留


- [x] App：碰使用者任意路徑的模組改用 `raw-fs`（Electron 下＝`original-fs`）；`test-asar-lock.js` 修前 6/8 紅、修後 8/8
- [x] 追出第四個源頭：從 asar `copyFileSync` 會留 `%TEMP%\<uuid>.tmp.*`（累積 609 個）→ 終端機宿主／ffmpeg／GPU 套件改讀再寫；實測 copyFileSync 多 1 個、讀再寫 0 個
- [x] **發現 Node 24（Electron 43）`rmSync` 遞迴會穿過 junction 刪真資料**（純 Node 24 與 Electron 都重現、Node 22 不會）→ `src/main/safe-rm.js`；App 5 處、腳本 94 處換掉；`test-safe-rm.js` 在 Node 22／24 皆 6/0（Node 24 對照組 followed=true）；確認使用者模型 63 檔 6.9GB 完好、`hf-models` 自 9/2 建立後未變動
- [x] 測試暫存：`scripts/lib/test-temp.js`；74 支腳本改用；`test-temp-hygiene.js`（暫存＋遞迴 rmSync 兩條）對修改前版本紅、修改後綠
- [x] 打包：`electron:pack` → `scripts/pack-preview.js`；故意改一個換行會被 asar 比對擋下
- [x] 順手修三支過期測試（`.chat-list-proj`、寫死資料夾名、`dist/` 不存在）
- [x] 文件：CLAUDE／AGENTS（安全底線兩條、打包、測試、驗證表）、CONTEXT、lessons
- [x] 第五個源頭：electron-builder（@electron/get）每次打包在 `%TEMP%` 留空的 `electron-download-*`（183 個）→ `pack-preview.js` 把子程序 TEMP 指進 test-temp 管的資料夾；重打一次 0 → 0
- [x] 清掉既有殘留：空 `electron-download-*` 183 個、asar 中繼檔 612 個
- [x] 最終驗證：29 支單元＋4 支 Electron e2e 全綠；新流程打包（209 支 src 逐檔比對）；打包版 CDP 工作區 179/0、終端機 48/0、聊天 62/0、檔案總管 exit 0；`<uuid>.tmp.*` 612 → 612（修前每跑一次終端機 +7）；`%TEMP%`、磁碟根、`voiceink-tests` 皆零新增

Review：還留著 `D:\vi-build-ime-20260914`（使用者的 VoiceInk 安裝版鎖著，新版裝上後重開 App 才放得掉）；安裝版要等下一次發行才會帶到 `raw-fs` 修正。

# 2026-09-14 — 聊天：併發、側欄資料夾與狀態、對話參數

- [x] main：inflight 改成每對話一格（第二輪拿掉總數上限）、`abortConversation`、`activeConversationIds`；本機模型載入去重
- [x] main：`chat-params.js`（驗證＋轉 API 欄位，沒勾不送）；回覆記 model／ms／tokens
- [x] store：拿掉 `projectId`；資料夾 CRUD、`reorder` 帶 folderId、編輯／刪除／分叉訊息、`toMarkdown`
- [x] IPC／preload：刪 `chat:setProject`，加 folders／params／edit／delete／fork／export；`chatParams` 進 allowlist
- [x] renderer：`chat-sidebar.js`（資料夾、狀態點、⋯ 選單）、`chat-params-panel.js`、串流照對話分開、訊息操作
- [x] 測試：`e2e-chat.js` 新增 P／Q／R／S（P 在舊碼上先紅）→ 185 passed；`test-workspace.js` 235 passed
- [x] 打包版 `e2e-chat-cdp.js`：新增 19 項 UI 斷言全過（57/58）；唯一失敗是既有的「刪除供應商」測試還在 mock `window.confirm`（`e093589` 起已改 `askConfirm`），與本次無關
- [x] 截圖檢查側欄資料夾／狀態點／⋯ 選單／參數彈窗（深色）；修掉彈窗開啟時整塊捲動區的焦點框

### 第二輪（使用者追加）

- [x] 拿掉同時回應上限 8（`e2e-chat.js` 改測 12 個同時放行）
- [x] 資料夾本身拖曳排序（`reorderFolders`＋側欄第二組 list-reorder，拖完不誤觸收合）
- [x] AI 自動取標題（`chat-title.js`；`[T]` 7 項）
- [x] 參數只留 Temperature／Top P／Max tokens／Stop＋上下文則數；舊資料的非通用欄位 sanitize 丟掉
- [x] 新斷言在拿掉改動時紅（6 項 FAIL）→ 還原後 `e2e-chat.js` 194 passed
- [x] CDP 抓到：送出前改的名字會被第一則訊息蓋掉（既有行為，AI 標題讓它更明顯）→ 只在預設「新對話」時定暫定標題；先紅後綠，`e2e-chat.js` 195 passed
- [x] 打包版 `e2e-chat-cdp.js` 61/62（資料夾拖曳、AI 標題、取標題只打一次都過；失敗仍是既有的刪除供應商測試）

### 合併前審查（2026-09-15）

- [x] 全份 diff 逐檔審查（main／store／側欄／聊天頁／參數面板／選單）
- [x] 修：`chat:abort` 空 reqId 會停掉所有對話 → IPC 層擋掉
- [x] 修：`e2e-workspace-cdp.js` [AC] 還在呼叫已刪的 `chat.setProject`；參數鈕提示還寫 Top K
- [x] `e2e-chat.js` 195 passed；`test-workspace.js` 235；`test-error-hygiene.js` 85；`test-markdown.js` 23；`test-ipc-invoke.js` 11
- [x] 修：`e2e-chat-cdp.js`「刪除供應商」還在假裝 `window.confirm`（程式早改 `askConfirm`）→ 真的點彈窗；修前 61/62、修後 62/62
- [x] 打包版（asar 抽三檔與原始碼雜湊一致）`e2e-chat-cdp.js` 62/0、`e2e-workspace-cdp.js` 179/0
- [x] 合併進 master 推送、清理分支

## Review

- CDP 在背景跑時 Chromium 會延後 `<dialog>` 的 `close` 事件，靠它回結果的彈窗（`askInput`）在自動化裡等不到；參數彈窗改成按鈕直接結算。

# 2026-09-13 — 補齊未通過項目

- [x] 發行完成：版本更新至 `v1.21.0`，已提交、推送、合併、打包並建立 GitHub Release

- [x] 更新日期解析先紅再修；`test-sysmon-hotfix-date.js` 通過、`test-sysmon.js` 183/0、真 Electron 取樣 63/0
- [x] 更新監控測試中過期的合併列／多 GPU／畫布父層斷言；打包 `e2e-sysmon-cdp.js` 113/0
- [x] UFFS 0.6.40 真下載、官方 checksum 核對、解壓與 App UAC 安裝流程通過；UffsAccessBroker Running
- [x] 修正真搜尋發現的完整檔名 pattern、is_directory 與 FILETIME 格式；原始 CLI 與本輪檔案 mtime 核對通過
- [x] 最終 packaged 搜尋畫面／NAS IPC 驗證通過，已更新 `dist/win-unpacked` 預覽
- [x] 既有 NAS 分享實際讀取驗證：`probe-explorer-nas.js` 10 項／35 ms，UNC 與 X: 均可讀（唯讀）

本輪 UFFS 正式 ZIP SHA-256：`0e0103a25a98e86f698d0b910f6a4bcc706bde443d56c2f999c2abfb26c7a22a`，與官方 CHECKSUMS.txt 一致。經 App `installBroker()` 安裝到 `%APPDATA%/voiceink/uffs/uffs-windows-x64/`，服務已執行；真 `*.txt` 查詢 200 筆且 truncated=true，待下列格式修正後再驗特定檔名與畫面。
真查已驗：完整 `test-sysmon-hotfix-date.js`、大寫、`*test-sysmon-hotfix-date.js*`、`test-sysmon-hotfix-date.??` 均精準命中一筆；錯誤 `.pdf` 不命中，mtime 與 fs.stat 差 <2ms。含點的一般文字及基本 glob 以跳脫後 regex 避開 UFFS 0.6.40 漏檔；進階 glob（字元集合／大括號／OR／路徑 glob）仍沿用上游語法，未宣稱涵蓋。

Review：本輪新增日期／UFFS 格式／probe userData 回歸先紅再綠，12 支相關 Node 檢查全 exit 0。`e2e-sysmon.js` 真 Electron 63/0；`e2e-sysmon-cdp.js` 113/0。最終 `npm run electron:pack -- --config.directories.output=D:/vi-explorer-review-20260913` exit 0，194 支 JS 與 asar 一致、解包 probe.ps1 與來源逐位元一致。`D:/vi-explorer-review-20260913/probe-explorer-live.js` 在隔離 profile 複製已驗 UFFS binary：畫面一般完整檔名搜尋、mtime 核對、NAS IPC 及原有 explorer 斷言全過。預覽 exe／asar／probe.ps1 與驗收包 SHA-256 一致。尚未測 NAS 遠端寫入與進階 glob；本輪已提交、推送、合併、打包並發行。

# 2026-09-12 — feat/explorer 上游檢查

- [x] 抓取分支並確認本機乾淨；審查檔案操作、下載與畫面流程
- [x] 重現貼上途中剪貼簿改變造成複製變搬移；固定單次貼上的來源與模式，失敗只留剩餘項目
- [x] 重現複製碰到新建同名檔會覆寫；複製及跨磁碟搬移停用強制覆寫
- [x] UFFS 下載寫入失敗改回結構化錯誤；Windows 特殊資料夾改讀系統設定位置
- [x] 舊搜尋回覆失效、過期導航不寫歷史、格狀切回清單恢復排序列
- [x] 相關回歸、打包與隔離背景驗收；系統監控既有失敗另記如下

Review：上述問題均先重現再修復；未提交或推送。`test-explorer.js` 182/0、新增五支回歸均通過；`test-workspace.js` 239/0、`test-workspace-ui.js` 128/0、sysmon resident/lifecycle 通過。
`npm run electron:pack -- --config.directories.output=D:/vi-explorer-review-20260912` exit 0；194 支 source JS 與 asar 完全一致，預覽 `dist/win-unpacked` 的 exe/asar SHA-256 與驗收包一致。
打包背景驗證：explorer CDP 24 項通過；追加真實滑鼠雙擊、格狀切清單通過；workspace CDP 180/0。UFFS 真實下載／UAC、NAS 連線未驗。
系統監控 CDP：15 passed, 1 failed，卡在硬體清單。直接以 PowerShell 執行 `probe.ps1` 輸入 `static 1` 重現 `InstalledOn` DateTime Parse 例外，整個 static 框只剩 `#ERR`；`probe.ps1`／`metrics.js`／`sampler.js` 與 master 無差異，來源與 packaged probe SHA-256 一致。屬既有問題，未擴大修改；此項未通過。

# Git 面板：變更總行數 + 完善最近提交

- [x] 測試先紅：parseLog 作者／numstat；變更總計 DOM；log 主旨不准 ellipsis
- [x] 變更區段標題顯示總 +/−（跟上一次提交比，未追蹤／二進位不算）
- [x] 各分組標題也帶該組總 +/−
- [x] 最近提交：作者、主旨換行、每筆 +/−、點 hash 複製
- [x] `test-workspace.js` 239 passed；`test-workspace-ui.js` 128 passed

# 檔案總管：詳情橫排、側欄自訂、路徑輸入、搜尋排序、右鍵

- [x] 測試先紅：UNC 放行、rankHits、places 合併、inspect、路徑輸入／右鍵來源掃描
- [x] 路徑守衛放行嚴格 UNC；裝置路徑／pipe 仍擋
- [x] 詳情操作鈕在上＋inspect 預覽
- [x] 側欄新增／移除／拖曳排序＋NAS
- [x] 路徑列可輸入；搜尋相關度排序；右鍵補強
- [x] `node scripts/test-explorer.js` 綠（180 passed, 0 failed）
- [x] 沙箱預覽（不動安裝版）

# 系統監控取樣器常駐（加快進頁顯示）

- [x] 回歸測試先紅：再次 `start()` 立刻重送 lastFeed；離頁不呼叫 `stop()`
- [x] main：開機就 `sysmon.start()`；`start()` 重送 lastFeed（順便刷新 gpu／sensors）
- [x] renderer：cooldown／縮到系統匣不停 probe；進頁立刻畫上一筆
- [x] 更新 CDP 斷言、CONTEXT／AGENTS
- [x] 驗證：lifecycle 修復前紅、修復後綠；`test-sysmon-resident.js` 綠；`test-sysmon.js` 183 passed

# 檔案總管審查修復

- [x] `assertMutable` 只擋刪／改名／搬走受保護「那一項」；家目錄可新增／貼上／還原
- [x] `resolveExisting` 回使用者路徑；junction 刪／搬／purge 不跟目標
- [x] 清空回收筒不吃 list 2000 上限；還原先檢查再 mkdir
- [x] UFFS 只跑安裝目錄、checksum 缺就失敗、zip 有上限；temp userData 忽略 force
- [x] renderer：navSeq、監看保留選取、回收筒用 recycleKey、預覽不 toast、複製進自己、搜尋後重畫、拖進回收筒要確認
- [x] sysmon `start()` 空 GPU／感測器不覆蓋 lastFeed
- [x] 測試先紅再綠：家目錄可寫、junction、UFFS 校驗、碰撞檔名 `hello (2).txt`；刪檔用 permanent 不清使用者回收筒

# 檔案頁（檔案總管 + UFFS 整機搜尋）

- [x] main：`explorer/paths.js` 路徑守衛
- [x] main：store／fs／drives／watch
- [x] main：uffs（尋找／搜尋／下載／broker）
- [x] main：index + ipc；接 main.js／preload
- [x] renderer：nav + `#page-explorer` + CSS + `explorer-page.js`
- [x] 測試：`test-explorer.js` 59 passed；`e2e-explorer-cdp.js` 綠；probe 無 UFFS 則 SKIP
- [x] CONTEXT／AGENTS／CLAUDE 對齊
- [x] 驗證：單元測試綠；`electron-builder --win dir --config.npmRebuild=false` 產出 unpacked
- [x] 未提權搜尋不再回空清單；授權鈕看 `broker.installed` 不是 exe 在不在
- [x] 進檔案頁自動下載＋一次 UAC，搜尋即開即用；UAC 按否寫 `uffsAuto: false`
- [x] CDP 暫存 userData／沙箱不自動跳 UAC
- [x] 預設刪除進資源回收筒，可還原／清空；永久刪除另走
- [x] 複製／搬移撞名給唯一名；新增檔案；listDir 排序
- [x] 右鍵選單、Shift／Ctrl+A、拖放、側欄資源回收筒
# 2026-09-14 — AI CLI 中文組字閃爍

- [x] 用 Chromium 組字與連續定位取樣重現背景重畫造成的閃動：舊打包版 40 次取樣／20 次移位，最大 159.85px
- [x] 修正組字定位，保留正常輸入、中文送出與分頁生命週期：CSS 固定位置、組字期間凍結錨點，移除逐幀補救並在關分頁時清理事件
- [x] 驗證：`node scripts/test-terminal-ui.js` 12/0、`node scripts/test-terminal.js` 102/0；`npm run electron:pack -- --config.directories.output=D:/vi-build-ime-20260914` exit 0
- [x] 打包版：`VOICEINK_EXE=D:/vi-build-ime-20260914/win-unpacked/VoiceInk.exe` 下 `node scripts/probe-terminal-ime.js` 13/0（25 次取樣、0 次移位、0px）；`node scripts/e2e-terminal-cdp.js` 48/0
- [x] Review：打包內三支修改檔與來源逐位元組一致；已同步 `dist/win-unpacked`，exe／asar 的 SHA-256 一致；未動正在運行的安裝版
- 邊界：以真 Chromium IME＋模擬 CLI 分段重畫驗證，未操作前景 Windows 原生注音選字窗，也未發行新版本。

# 2026-09-14 — 全代碼庫檢查與修復

- [x] 盤點既有改動、模組與測試，建立本輪基準（58 支本機測試全過；194 支 JS 語法檢查通過）
- [x] 分組追查檔案／工作區、AI、代理／統計／監控、終端機與共用邊界
- [x] 對確認的 bug 先跑失敗回歸，再做最小修復
- [x] 執行本機檢查、打包與隔離背景驗收，記錄結果及未涵蓋範圍

本輪修復：
- 工作區草稿保存原檔 mtime，切專案或重開後仍能擋住外部修改／刪檔；舊草稿缺版本時先比較或明確覆寫。
- 工作區與整機檔案總管可只改檔名大小寫，仍禁止覆蓋另一個項目；磁碟根目錄作為專案時可正常讀取子項。
- HF 下載寫入失敗回傳錯誤、不崩潰；失敗清掉取消監聽；續傳跳過已完成分片，分片／投影檔全部完成才算已安裝。
- 雲端轉錄在最後一段等候期間取消，回覆抵達後不再誤報成功。
- 額度同步保留同步期間的新排序／顯示設定；失敗重試不再延長舊額度的 6 小時期限。
- CC 閘道接受 CRLF 串流；CC／AGY 保留沒有結尾換行的最後一段文字。
- Ctrl+G 來源讀取失敗不死等，寫回失敗回傳非零並保留 .out 編輯內容；TTS 不回送外部錯誤，段落編號收斂為整數。

Review／實際驗證：
- `node dist/audit-20260914/run-final.cjs`：64 支本機 test 全 exit 0（初始基準 58 支全過）。新增回歸及工作區／額度擴充覆蓋上述失敗路徑。
- `node scripts/e2e-ccswitch-gateway.js`：40 passed, 0 failed。
- `node dist/audit-20260914/run-integration.cjs`：真 Electron 聊天 140/0、AGY 98/0、系統取樣器 63/0；聊天／代理上游使用本機測試服務。
- `npm run electron:pack -- --config.directories.output=D:/vi-build-audit-20260914`：exit 0；194 支 source JS 與 asar 逐位元組一致。
- `node dist/audit-20260914/run-packaged.cjs`：9 支全部 exit 0；workspace 180/0、explorer 24 項、terminal 48/0、HF 44 項、CC 125 項、sysmon 113/0、screentime 19/0、visual 77 項、IME 13/0（25 次取樣、0 次移位）。全部使用隔離 userData／隱藏視窗，不操作使用者的安裝版。
- `dist/win-unpacked` 已同步驗收包，exe／asar SHA-256 一致，且預覽包內 194 支 JS 仍與 source 一致。詳細 log、結果 JSON 與 hash 在 `dist/audit-20260914/`。
- 保留進場時六個未提交檔案的既有終端機／輸入法改動；本輪沒有 commit、push 或發行。
- 未涵蓋：真實付費 API、HF 遠端大檔下載／GPU 推論、NAS 寫入、提權風扇／超頻、Windows 原生語音輸入插入、NSIS 安裝更新。上述界線不代表已證實的 bug；本輪確認的 bug 均已修復並驗證。

# 2026-09-15 — 提交上述兩輪、清理專案外殘留

- [x] 審查兩輪未提交改動（無新問題）；`CLAUDE.md`／`AGENTS.md` 組字地雷改成 CSS 固定位置的新做法；`CONTEXT.md` 補變更紀錄
- [x] 刪除專案外殘留：`D:\vi-build-*` 打包輸出、`%TEMP%` 約 260 個測試暫存；剩被其他程式鎖住的 3 個
- [x] `e2e-chat-cdp.js` 收尾改成 taskkill 自己的程序樹＋刪暫存 userData（之前每跑一次留一個 `voiceink-cdp-*`）
- [x] 與聊天那輪合在一起重驗：18 支單元測試全 exit 0、`e2e-ccswitch-gateway.js` 40/0、`e2e-chat.js` 195/0；打包版 `e2e-chat-cdp.js` 62/0、`probe-terminal-ime.js` 13/0、`e2e-terminal-cdp.js` 48/0，`%TEMP%` 無新增；打包輸出驗完已刪
# 2026-09-19 — 接續檔案總管分頁與本機首頁

- [x] 從原始對話與工作樹確認需求、既有改動及中斷點
- [x] 完成分頁新增／切換／關閉、獨立歷史與首頁樣式
- [x] 驗證晚到回覆、首頁操作邊界及原有檔案操作
- [x] 打包並以隔離 userData 背景驗收，記錄結果

Review／實際驗證：
- `node scripts/test-explorer-page-state.js`：修正前首頁晚到造成歷史 `["B","B"]`（預期 `["B"]`）；修正後通過，另涵蓋切頁晚到、關閉分頁、首頁禁止貼上與上一頁失敗保留位置。
- `node scripts/test-explorer.js`：186 passed, 0 failed；`test-explorer-copy-race.js`：2/0；`test-explorer-clipboard.js`：3/0；`test-explorer-places.js`：PASS。
- `npm run electron:pack -- --config.npmRebuild=false`：exit 0，212 支 src 檔案與 asar 一致，更新此工作樹的 `dist/win-unpacked`。沿用根工作樹 node_modules（junction），未新增依賴。
- `node scripts/e2e-explorer-cdp.js`：exit 0，35 項 PASS。實測分頁增刪、獨立歷史、切 App 頁面保留、首頁中鍵另開、Ctrl+T/W、真實磁碟容量、首次預設首頁；深／淺／800px 截圖無水平溢出；分頁操作無未處理 renderer 例外。
- 14 支修改／新增 JS 通過 `node --check`，`git diff --check` 通過；截圖在 `dist/explorer-tabs-qa/`。
- 邊界：分頁不跨 App 重啟還原；本輪未提交、合併或發行。此隔離工作樹未建置 sensors／hook sidecar，未驗證硬體功能與 NAS 寫入；使用者安裝版與根工作樹未改動。
# 2026-09-19 — 捷徑、檔案圖示、滑鼠側鍵

- [x] 資料夾捷徑在目前檔案分頁開啟，失效／循環捷徑顯示錯誤
- [x] 清單與格狀檢視顯示 Windows 圖示，限制同時讀取數量
- [x] 滑鼠側鍵依目前分頁的歷史前進／返回
- [x] 回歸先紅後綠，打包與隔離背景驗收

Review（2026-09-20）：
- `node scripts/test-explorer-shortcuts.js`：修正前失敗（捷徑沒有回傳資料夾目的地）；修正後 PASS，含多層／循環／失效捷徑、路徑列、資料夾圖示與保留檔案捷徑啟動方式。
- `node scripts/test-explorer.js`：186 passed, 0 failed；`node scripts/test-explorer-page-state.js`：PASS。
- `npm run electron:pack -- --config.npmRebuild=false`：exit 0，213 支來源檔與 asar 一致；此工作樹 `dist/win-unpacked` 已更新。
- `node scripts/e2e-explorer-cdp.js`：舊包先在真實 .lnk 解析失敗；新包 44 項 PASS。真實 Windows .lnk 在目前分頁開啟，檔案圖示在 list/grid 均載入，CDP `Input.dispatchMouseEvent` back/forward/back 保留 App 網址，分頁與深淺／窄版回歸全過。
- 截圖改用既有 workspace 探針的 `capturePage({ stayHidden, stayAwake })` 方式，解決隱藏視窗 CDP 截圖等待；圖片在 `dist/explorer-tabs-qa/icons-list.png`／`icons-grid.png`。
- 邊界：未操作實體滑鼠；程式／一般檔案捷徑仍沿用原捷徑開啟，以保留啟動參數。未提交、合併或發行，未改使用者安裝版與主工作樹。

## 2026-09-20 工作區：執行腳本、瀏覽器、Git 面板、diff 切換

- [x] 1 檔案樹可以執行檔案：`.exe`／`.lnk` 走 `shell.openPath`；`.cmd`／`.ps1` 開終端機跑；`.js`／`.py` 仍開編輯器
- [x] 2 內建瀏覽器補上：每個分頁一顆 webview（各自歷史與捲動）、上一頁／下一頁／停止、載入中、錯誤頁、devtools、快捷鍵
- [x] 3 Git 面板：動作鈕跟著側欄寬度換行（180px 也不疊字）；最近提交可展開看變更檔案
- [x] 4 檢視變更不新開分頁：同一個檔案在「編輯 ⇄ 變更」之間就地切換
- [x] 5 回歸：test-workspace.js（parseLog 帶檔案清單）、test-workspace-ui.js（版面／切換契約）

Review：工作在 `.claude/worktrees/ws-browser-git-exec`（分支 `worktree-ws-browser-git-exec`），尚未合併、尚未 `electron:pack`。
`node scripts/test-workspace.js` 260/0；`node scripts/test-workspace-ui.js` 176/0。
`.js`／`.py` 點下去仍開編輯器（右鍵才跑）；`.cmd`／`.ps1` 點下去會開終端機，要改內容走右鍵「開啟」。

# 2026-09-20 — 三工作樹驗收與整合

- [x] 審查 explorer-shell、ws-browser-git-exec、usage-sysmon，驗證各自修改
- [x] 整合變更並解決衝突，打包與隔離背景驗收
- [x] 提交、合併至 master、推送並核對遠端
- [x] 清理已完成分支與工作樹，保留仍在使用的資料

Review（2026-09-20）：

三個工作樹先前被誤刪，從 `dist/merge-qa-20260920/*.patch`（已追蹤檔）、Codex session 的
`Get-Content` 輸出（5 支 JS ＋ `Program.cs`／`ShellMenu.cs`）與 Claude session 的 Write/Edit
重放（其餘 4 支 `.cs`）拼回。`.cs` 那份落後最終版一步，照呼叫端補回 5 個 Win32 宣告
（`CMF_EXPLORE`／`CMF_ITEMMENU`／`CMF_SYNCCASCADEMENU`／`MF_BYPOSITION`／`GetMenuStringW`）。
未追蹤檔另備份在 `dist/merge-qa-20260920/explorer-shell-untracked.tgz`。

三份工作出自 Grok CLI 的三個 session，需求逐項核對過都已落地：殼層右鍵（WinRAR／7-Zip／
傳送到）與 Drive 綠勾、工作區執行檔案與瀏覽器導覽與 Git 面板換行與 diff 就地切換、
Gemini 3.8 Flash 與 Kimi K3 單價與快取花費拆開與多硬碟分卡。

合併只有 `tasks/todo.md` 衝突（兩邊各自的紀錄），程式碼零衝突。

驗證（合併後的 master，打包版走 `dist/win-unpacked`）：
- 單元／整合：test-explorer 186、test-explorer-shell 26、test-workspace 260、
  test-workspace-ui 182、test-sysmon 188、test-code-usage 158、test-ipc-invoke 11、
  test-error-hygiene 85、test-safe-rm 6、test-temp-hygiene 2
- 真流量：e2e-sysmon 63（兩顆 NVMe SMART）、e2e-code-usage 16、
  probe-explorer-shell 實測 WinRAR／7-Zip／傳送到都有子項、
  probe-explorer-shell-icon 拿到 Drive 綠勾（槽 14、171 綠像素）
- 打包版 CDP：e2e-cdp-smoke 22、e2e-explorer-cdp 48、e2e-workspace-cdp 179、
  e2e-sysmon-cdp 114、e2e-usage-cdp 23

`npm run electron:pack` 通過（asar 驗證 216 支 src 檔逐位元組相同）；`resources/shell/`
要先 `npm run build:shell` 才會進預覽包，沒建的話右鍵少殼層那幾項、資料夾維持 emoji。

邊界：未發行（沒有 bump 版本、沒有 tag、沒有 release）。`.claude/worktrees/` 下那兩個
工作樹與它們的分支、以及中轉用的 `feat/merged-three` 已清掉；`VoiceInk-usage-sysmon`
連同 `feat/usage-sysmon` 保留（那份開在專案外，內容已合併，要不要收由你決定）。

# 2026-09-20 — 瀏覽器分頁跨專案停放 ＋ 方格縮圖

- [x] 切走專案時停放瀏覽器 webview（依 projectId+tabId），切回來不重載、不用再按前往
- [x] 方格檢視對圖片／影片／其他檔案類別與資料夾都問殼層縮圖，不再用副檔名白名單
- [x] 關掉分頁或移除專案才收掉 webview
- [x] 清理已合併工作樹 `vi-wt-size`／`vi-wt-attr`／`vi-wt-pending`
- [x] 測試先紅再綠；打包版工作區 CDP 驗切專案瀏覽器還在

Review：
- 切專案時瀏覽器 webview 依 `projectId::tabId` 停放，切回來不重載
- 方格檢視每個可見列都問殼層縮圖（含資料夾）
- 已刪 `vi-wt-size`／`vi-wt-attr`／`vi-wt-pending` 與對應分支
- 驗證：`test-explorer-icons-state.js` 3/0（修前紅）、`test-workspace-ui.js` 185/0（修前 3 紅）、
  `test-workspace.js` 271/0、`test-explorer.js` 295/0、
  打包 asar 217 支一致、打包版工作區 CDP 184/0（含停放斷言）、
  打包版檔案總管 CDP 90/0

# 2026-09-20 — 接續檔案總管三包整合

- [x] 還原交接與確認 merge 中斷點，保留兩方測試
- [x] 三位子代理分別審查資料夾大小、真實屬性與縮圖重試
- [x] 修復確認問題，重建 shell、打包與隔離 CDP 驗收
- [x] 完成三包合併（50cb491）、更新交接
- [x] 清理三個已合併工作樹（`vi-wt-size`／`vi-wt-attr`／`vi-wt-pending` 與對應分支已刪）

Review：
- 巢狀 `readdir`／`lstat` 失敗改標 `incomplete`，不再當成完整大小
- 縮圖：切清單／方格時晚到回覆改走目前佇列；離開檔案頁清掉重試
- `CLAUDE.md` 改成只指向 `AGENTS.md`
- 驗證：`test-explorer-size-errors.js`、`test-explorer-icons-state.js` 2/0、
  `test-explorer-shortcuts.js`、`test-explorer-page-state.js`、
  `test-explorer.js` 295/0、`test-workspace.js` 271/0、
  打包 asar 217 支 src 一致、打包版檔案總管 CDP 90/0、
  打包版工作區 CDP 183/0
# 2026-09-21 — 參考 Files 完成檔案總管五批改進

- [x] 第1批：操作中心（進度、逐筆結果、取消、撞名策略、復原）
- [x] 第2批：分頁瀏覽狀態持久化（選取、捲動、搜尋、排序，含重開還原）
- [x] 第3批：大型資料夾分批載入／虛擬清單，搜尋加類型・大小・日期・位置篩選
- [x] 第4批：Markdown／PDF／影音預覽，空白鍵開、換檔不殘留、關閉釋放、詳情欄收合
- [x] 第5批：雙欄左右獨立狀態與跨欄複製／搬移；批次改名前後預覽與撞名檢查
- [x] 共用接線：`explorer-page.js`、`index.html`、`main.css`、preload／IPC 契約
- [x] 驗收修掉的 5 個真 bug（見下方 Review）
- [x] 回歸：27 支單元測試 0 失敗、`e2e-explorer-cdp.js` 全過、
      `e2e-workspace-cdp.js` 184/0、`test-asar-lock.js` 8/0（`npx electron`）
- [x] packaged CDP：`e2e-explorer-files-plan-cdp.js` 重寫成真的驗五批，53 項全過

Review：

子代理交付時單元測試全綠，但**打包版的檔案頁整頁載不起來**，而他們留下的
「五批打包版回歸」其實是 `e2e-explorer-cdp.js` 的複製品（章節清單 diff 完全相同，
只是多種 2,200 個檔案），沒有一條碰到新功能。那支腳本已重寫成真的走五批的
使用者動作，驗收過程另外挖出 4 個只在真畫面才現形的 bug：

1. **`explorer-operations.js:1` 的 `import '../styles/explorer-operations.css'`**
   ——打包版用 `file://` 直接載原始 ES module，CSS 不是 JS module，
   `explorer-page.js` 整條 import 鏈 `Failed to fetch`，檔案頁完全空白。
   改掛 `index.html` 的 `<link>`；守門加在 `test-explorer-operations-ui.js`
   （掃 `src/renderer/scripts/*.js` 不准 import 非 JS）。
2. **`loadVisiblePages()` 在「要顯示的頁都已載入」時 return 而不重畫**
   ——2,600 筆的資料夾往下捲，DOM 永遠停在最前面 29 列，後面整片空白。
   守門加在 `test-explorer-browse-wiring.js`。
3. **`paintList()` 在 `replaceChildren()` 之後才讀 `scrollTop`**（已被歸零）
   ——虛擬清單每次重畫彈回頂端。改成重畫前先記；`loadDir` 結尾改成無條件把
   `scrollTop` 設回分頁記的值，避免沿用上一個資料夾的位置。
4. **`switchTab` 沒帶 `keepSelection`**——切回分頁選取被清空，正是第 2 批要修的事；
   同時把「拿只載了第一頁的清單去裁選取」改成沒載完就不裁。
5. **`saveSecondPaneState()` 在雙欄沒開時也存**——把預設的「本機」寫進 `paneStates`，
   下次按「雙欄」還原成空的本機而不是目前資料夾。開頭補 `if (!dualPane) return`。

驗收邊界（未做，如實列出）：
- 真 NAS 的複製／搬移／取消沒測（只有本機與 C:→D: 跨磁碟 probe）。
- 打包版的取消驗的是「按得下去＋收在終局狀態＋檔案不壞」；真正的取消語意由
  `test-explorer-operations.js` 與 `probe-explorer-operations-cross-volume.js` 保證
  （同一顆磁碟的搬移是 rename，一瞬間結束，按不到取消）。
- 影音預覽只驗元素掛得起來與關閉後收乾淨，沒驗播放。

---

## 檔案總管：雙欄「根本沒法用」（2026-09-21）

實測證實右欄只是一份唯讀清單：右鍵選單、鍵盤、拖放全部沒綁；上面那排指令列、
狀態列、詳情欄、貼上、新增資料夾、側邊欄的位置／磁碟導覽，一律只對左欄生效。
右欄能做的只有四顆跨欄搬移鈕。

修法是引入**作用欄**（`activePane`）：點過哪一欄，既有那一整套就對那一欄生效，
不另外複製一份右欄專用的流程。

- 右欄補上右鍵選單、方向鍵／Enter／Backspace／Delete／F2、可拖出去、可拖進來。
- `selectedEntries()`／`paintStatus()`／`paintCmdBar()`／`pasteHere()`／`newFolder()`／
  `newFile()`／`openContextMenu()` 改吃作用欄的 cwd 與選取。
- `refreshAfterMutate()` 雙欄時兩邊都重讀。
- 作用欄加外框，看得出指令列現在在操作誰。

順手修掉兩個既有 bug：
1. `onSecondDoubleClick` 用 `.find()` 掃稀疏陣列——大資料夾未載入的頁是洞，
   `find` 不跳洞，雙擊會 TypeError。改成先 `.filter(Boolean)`。
2. `paintSecondPane()` 每次重畫都把「不在已載入列裡」的選取砍掉——大資料夾捲一下
   選取就沒了（左欄沒這個動作）。整段拿掉，裁切交給 `loadSecond`。

地雷：四顆跨欄鈕長在右欄裡，按下去 mousedown 會先把作用欄切成右欄，所以
`copyBetweenPanes` 的來源不能用 `selectedEntries()`，要指名左欄／右欄。

驗收：`node scripts/e2e-explorer-dual-cdp.js` 15 條全綠（跑原始碼時先起 vite，
再用 `VOICEINK_EXE=node_modules/electron/dist/electron.exe`）。

### 後續：把上面「未做」的那五件補完（同日）

- **右欄分頁**：`secondTabs`／`secondActiveId`，每頁自己的路徑、歷史、選取、捲動、排序、
  檢視、搜尋；整組再按左欄分頁存進 `paneStates`。中鍵點資料夾＝開右欄新分頁。
- **麵包屑**：`#exSecondCrumbs`（帶 `data-path` 給測試看）＋點一下變路徑輸入框，
  取代原本用對話框問路徑的作法。
- **圖示檢視**：右欄自己的 `view`／`tile`，☰▦ 兩顆鈕＋Ctrl+滾輪，跟左欄共用
  `explorer-zoom.js` 的級距；列也改成跟殼層要真圖示，不再只有 emoji。
- **整機搜尋**：右欄搜尋框加「範圍」鈕，切到整機就走 UFFS（跟左欄共用篩選條件），
  結果畫在右欄、顯示完整路徑。
- **拖到資料夾列**：右欄的資料夾列各自是放置目標，停 0.7 秒會自己進去。

過程中順手修掉：換資料夾沒把右欄捲動位置歸零，虛擬清單會停在上一個資料夾的位置、
畫出一整片空白。

地雷：
1. 排序的原生 `select` 會被 `custom-select.js` 換成自訂下拉，`.ex-second-sort` 的寬度管不到，
   要改 `.custom-select[data-select-id="exSecondSort"] .custom-select-trigger`——
   不改的話它吃 `min-width: 180px`，右欄標頭會胖到 200px 高。
2. 多一條右欄分頁列之後，測試裡的 `.ex-tab` 會同時選到兩邊，左欄的斷言要寫成
   `#exTabStrip .ex-tab`。
3. 三支 explorer e2e 現在都能跑原始碼（`VOICEINK_EXE` 指到 `electron.exe` ＋先起 vite），
   並在連上 CDP 後把視埠固定成 1280×860；不固定的話詳情欄會被 900px 的 media query
   整個收掉，用實體滑鼠座標的測試也會失準。

驗收：`e2e-explorer-dual-cdp.js` 25 條、`e2e-explorer-files-plan-cdp.js` 53 條、
`e2e-explorer-cdp.js` 102 條全綠。`e2e-explorer-cdp.js` 的 [C8] 資料夾監看偶發時序失敗，
同一份程式碼重跑就過，不是這次改動造成的。

### 再後續：右欄的指令列與篩選面板，外加回收筒還原與 Enter 確認（同日）

- **右欄自己的指令列**：`#exSecondCmdBar` 長在右欄裡，跟 `#exCmdBar` 共用
  `paintCmdBarInto(bar, which)`，選取與「貼上」可不可按都按那一欄算。動作本身仍看作用欄，
  所以 `addCmd()` 的 click 先 `setActivePane(which)` 再跑——不先切的話，站在右欄時按
  左欄的「貼上」會貼到右欄去。
- **右欄自己的篩選面板**：`searchFilters(which)` 只差 id 前綴（`exSearch*`／
  `exSecondSearch*`）。右欄那組 `<details>` 只在整機搜尋時顯示，切回「篩這個資料夾」
  就收起來，免得把窄窄的右欄標頭擠爆（標頭還是 93px）。
- **資源回收筒還原不了（真 bug）**：`recycle.restore()` 檢查父資料夾能不能寫，而磁碟
  根目錄被 `isSystemLocked` 當成鎖住的位置，所以從 `D:\` 刪掉的東西一律 `PROTECTED`。
  實測使用者的回收筒裡 4 筆全是 `D:\` 來的＝整個回收筒等於壞掉。改成只看目的地自己。
  第二層：`mkdir('D:\', { recursive: true })` 吐 `EPERM`，所以父資料夾在就不要補。
- **Enter ＝確定**：`app-dialog.js` 在 `<dialog>` 掛 capture 階段 keydown，Enter 一律
  `close(OK)`。危險彈窗焦點仍停在「取消」，但 Enter 會確定（不 `preventDefault()` 的話
  Enter 會先觸發焦點那顆鈕＝取消）。選字中的 Enter 照樣放行（`isComposing` 或
  `keyCode === 229`）。
- **Claude Code 的終端機**：`~/.claude/settings.json` 的 `"tui"` 從 `fullscreen` 改成
  `default`，開起來就是一般新視窗而不是 Agent View。

驗收：`test-explorer.js` 296 條、`e2e-app-dialog-cdp.js` 10 條、
`e2e-explorer-dual-cdp.js` 35 條、`e2e-explorer-files-plan-cdp.js` 53 條、
`e2e-explorer-cdp.js` 102 條全綠。

地雷：`e2e-explorer-cdp.js` 的 [C8]「資料夾監看有在跑」偶發會紅。這次把改動前的版本
（1bdb439）放回去跑，同樣會紅，所以不是這批改的；改完的版本連兩次 102 全綠。腳本現在
會在紅的時候把當下的清單與磁碟內容印出來，下次不用再從零查。

## 2026-09-23 側欄終端機清單自動收合、AI 記錄標題完整顯示

- [x] 專案列拿掉收合鈕：有還活著（不是 stopped）的終端機就攤開，沒有就收起（`paintProjectStatuses`）
- [x] AI 記錄標題不再兩行截斷；main 端標題上限 80 → 500 字；「接續」疊到標頭右邊，標題吃滿寬度
- Review：`test-workspace-ui` 185、`test-workspace` 276、`e2e-workspace-cdp` 183、`e2e-terminal-cdp` 59 全過；打包版截圖確認標題無截斷、按鈕不壓字
- [x] 對話記錄工具列加「複製路徑」：main 的 `sessionDetail` 多回 `file`（`findSessionFile` 驗過屬於這個專案）；工具列按鈕不折行、標題與附註改省略號並放 `title`

# 2026-10-02 — 自繪媒體選單與播放清單

## 短清單空白區與拖曳閃白修正

### 拖曳流暢度與時間條閃爍
- [x] 補驗 State 借用期間的時間條回呼／繪圖與相同寬度重畫，先確認失敗。
- [x] 合併控制項移動、略過沒有變化的位置；時間條改成獨立且完整的緩衝繪圖。
- [x] 背景驗證進度拖曳、鍵盤、深淺色與短／長清單，打包更新目前入口。
- Review：擴充 `probe-media-queue-resize.js` 修復前 FAIL（slider callback/frame/erase 三項 false、duplicateNoRedraw=false）；額外真測發現 `TBM_SETPOS(false)` 的 thumb 命中區仍在舊位置，改用共用 `position()` 的 redraw=true 後，畫出的圓點與 `TBM_GETTHUMBRECT` 一致。

| Before | After | Why |
| --- | --- | --- |
| 每次拖曳逐個移動、重畫所有控制項、反覆 EnableWindow | DeferWindowPos 合併移動，略過未變位置／啟用狀態／相同寬度 | 減少重複工作；放開 State 借用後即時畫完整一格 |
| 時間條自繪依賴 State，底色與圓點逐步畫到畫面 | 固定主題資料留在控制項；回呼先於借用，GDI 記憶體完整繪圖再 BitBlt | 同步重入保持自繪，清除背景不會先留下空白格 |

- Review：`build:media`、Rust 14/14、`test-media-player.js` PASS；最終 source 深淺色各 84 frames，slider callback/frame/erase/hit 四項 true、duplicateNoRedraw=true、whitePixels=0；同一機器的孤立樣本 layout p95 約 8.16ms（修復前 12.55ms，非整體 FPS 保證）。`probe-media-window.ps1 -ExerciseResize` 深淺色各 44 個真正 WM_MOUSEMOVE 的完整畫面通過，使用本輪 offscreen HWND 與 QA 拖曳旗標，不呼叫 SetCapture；短／空清單底色與時間條保持正確、ownFocusAbsent=true（47 次採樣）。
- Review：`-ExerciseUi -ExerciseMenu` 的進度預覽／放開跳轉／方向與 Page 鍵／自繪選單／控制項版面 PASS；50 筆清單的搜尋／移除／原生捲動與快捷鍵 PASS。焦點驗證另外記錄原視窗是否變動，僅在本輪播放器或 decoder 取得前景時失敗，允許使用者繼續切換自己的視窗。
- Review：`npm run electron:pack` PASS（250 支 src 位元組相同）；packaged `probe-media-ui.js` 8 groups、`probe-media-packaged.js` 3 groups、深淺色各 84 frames 的時間條／清單檢查 PASS。實際安裝版深淺色各 44 張連續拖曳畫面、各 84 frames 的原生繪圖／命中區檢查、進度／選單／鍵盤與 50 筆清單的 10 項操作全過；本輪視窗未取得前景，沒有程序殘留。
- Review：持久開檔入口已更新，manifest 30/30、Windows 關聯 API 150/150 PASS；source／packaged／installed SHA-256 `630c6610fd61cfa7d69ab5eb80aee7ab0c828cfdc616646587d829f5dc58ecbc` 相同。備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/drag-smooth-20261002-084413/`；`git diff --check` PASS，外部打包輸出已移除。仍在 `feat/native-media`，未提交／未發布；實體滑鼠與高 DPI 螢幕的前景手感未驗證。

- [x] 重現四筆清單的空白區及連續調整側欄寬度，補先紅後綠的背景像素驗證。
- [x] 修正重入時的清單底色與重畫順序，保留原生鍵盤／可見列繪圖。
- [x] 建置、打包並更新目前開檔入口，驗證深淺色、短／空／長清單與焦點。
- Review：新 `probe-media-queue-resize.js` 修復前 FAIL（84 frames、160 whitePixels、callbackDark=false）；固定深色回呼排在 State 借用前、清單自行填滿背景、版面移動延後同步清除及略過重複 ShowWindow。修復後深淺色各 84 frames、4/0 items、whitePixels=0、blankDark/callbackDark/eraseDark=true。
- Review：release build、Rust 14/14、`test-media-player.js` PASS；`probe-media-window.ps1 -ExerciseUi -ExerciseMenu` 深淺色四筆清單空白區各 476 點全為 #1c2123，文字與列繪圖完整；50 筆清單捲動、自繪選單、搜尋、Enter、移除及清除全過，focusKept=true。
- Review：`npm run electron:pack` PASS（250 支 src 位元組相同）；packaged 與 installed 的 `probe-media-queue-resize.js` 各深淺色 168 frames 全過；packaged `probe-media-ui.js` 8 groups、`probe-media-packaged.js` 3 groups PASS。實際安裝版深淺色短清單各 476 點深色、選單／進度／鍵盤與焦點全過；全程畫面外 HWND，未操作前景滑鼠。
- Review：持久開檔入口已更新，30/30 manifest hash PASS；source／packaged／installed exe SHA-256 `10d6cefc2af6abde6e9ddd19a7b763454b04c31950867b7b73ee43dca72b1caf` 相同。備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/queue-repaint-20261002-074522/`；Windows 關聯 API 150/150 回讀仍指向持久播放器。仍在 `feat/native-media`，未提交／未發布。

## 檢查後改善

- [x] 修正選單捲動／返回後可見選取、清單與滑桿翻頁快捷鍵，增加先紅後綠的背景驗證。
- [x] 深色清單新增搜尋／加入／移除、完整檔名提示、可調寬度與文字對比；保留原生鍵盤與可見列繪圖。
- [x] 背景保存音量／視窗尺寸／清單寬度，依檔案識別保存續播；多視窗寫入合併。
- [x] 首次安裝／舊版首次更新背景初始化預設關聯；成功才記標記，後續更新保留自選。
- [x] release build／packaged／目前使用入口驗證；安裝掛勾僅背景編譯與隔離驗證，不執行桌面安裝。
- Review（來源）：舊 installed binary 的 queuePageKeys／sliderPageKeys／menuScrollSelection 全 false；新 source 全 true，搜尋／篩選 Enter／移除／清除／focusKept 全 true。`probe-media-ui.js` 7 組通過，影片與音樂各自實測關閉重開後音量 37、820×540、側欄 344、精準續播 6 秒；使用隔離設定且靜音。Rust 14/14、JS 初始化重試／once／有界標記 PASS；設定 history 寫入也限制 512KiB，跨程序鎖與多視窗合併通過。
- Review（最終）：`cargo build --release --locked --manifest-path native/voiceink-probe/Cargo.toml --bin voiceink-media` PASS；同 scope `cargo test` 14/14。`node scripts/test-media-player.js` PASS；`npm run electron:pack` PASS（250 支 src 相同）；packaged `node scripts/probe-media-ui.js` 8/8、`node scripts/probe-media-packaged.js` 3 段 PASS。新增背景工作關閉前完成的回歸先紅後綠，模擬工作不寫登錄檔；播放器視窗與 decoder 先關閉。
- Review（最終）：source／packaged／installed `probe-media-improvements.ps1 -Features` 的 10 項全 true，包含搜尋自繪右鍵與全選；installed 淺色 640×430／50 檔 `probe-media-window.ps1 -ExerciseMenu -ExerciseUi` 的繪圖／鍵盤／捲動／bounds／focusKept 全過。進度 PageUp 真跳轉、選取附註色值對比 5.79；packaged WebP 2/2（12 格真畫面）、損壞檔 4/4 通過。修正 probe 對相對 fixture 路徑未正規化而誤判的問題。
- Review（入口）：source／packaged／installed player SHA-256 `29829ee3ee4e9c69a12d89147215d0e6ebc20368594b7ac64dec53e8aa6a4674` 相同；manifest 30/30、`probe-media-defaults.ps1` Windows API 150/150。最後備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/search-menu-20261002-032432/`；`probe-media-installer.js` NSIS 掛勾與三項產物編譯 PASS，未實際安裝。打包暫存已清除，本輪媒體程序無殘留；未搶焦點／未開設定或 UAC。仍在 `feat/native-media`，未提交／發行；新電腦實裝、實體拖曳與讀屏未驗證。

- [x] 側邊播放清單固定深灰底，即使主視窗淺色；同步容器／列／原生空白 brush／hover／捲軸／收起按鈕與文字對比。
- Review（背景色修正）：舊 installed 截圖色值 `#F8F9F6` 為紅燈；release build、`npm run electron:pack`（250 支 src 相同）PASS。source／installed `probe-media-window.ps1 -Theme light -Width 640 -Height 430 -ExerciseMenu -ExerciseUi` 的 50 檔清單／捲動／hover／Enter／收起／子選單／純畫面／bounds／focusKept 全過，實際 installed 側欄像素為 `#1C2123`。三份 player SHA-256 `ebe719818dabf3a9ff28be66f3e668cfe929a5d25ed27b97af7c786090a9e14a` 相同，manifest 30/30；舊版與 manifest 備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/dark-queue-20261002-014646/`。僅改清單配色，未提交／發行。

- [x] 將更多／右鍵與子選單改成 Rust／GDI 自繪浮窗，保留名稱、鍵盤、深淺色及畫面邊界
- [x] 重設播放清單的標頭、圓角選取／hover、播放狀態與細捲軸，保留大量項目的原生虛擬繪圖
- [x] 背景驗證真繪圖／子選單／操作／小視窗，打包並更新實際點檔案的播放器
- Review：舊 binary 在 customMenu 斷言失敗；新 subclass 初版所有訊息查 LB_* 造成 stack overflow，限定攔截後修復。`npm run build:media`／release build PASS；Rust 4/4；`npm run electron:pack` PASS（250 支 src 相同）。沒有新增依賴、WebView、頁面或系統關聯修改。
- Review：packaged `node scripts/probe-media-ui.js` 圖片／影片／音樂／全螢幕四組 PASS；原生 `probe-media-window.ps1 -ExerciseMenu -ExerciseUi` 深色 640×430 影片、淺色 640×430／50 張圖片、音樂通過。自繪主選單／子選單、Enter 進入／Esc 返回／操作後關閉、倍速／輪播間隔、queueHover／queueWheel／queueEnter／queueClose、原進度／純畫面、bounds／focusKept 通過。PrintWindow 旗標 2 曾漏畫選單列（像素斷言 60 個黑點），自繪 WM_PRINT／WM_PRINTCLIENT 與標準旗標 0 捕捉完整畫面；未使用前景鍵鼠驗收，實體拖曳／讀屏／跨螢幕 DPI 仍未驗證。
- Review：最後淺色捲軸提高對比後重新 release build／pack；更新持久關聯入口並在該 binary 重驗淺色小視窗／50 檔／選單全部通過。source／packaged／installed SHA-256 `b9e37cef99e48864fd9f50a1acd93b675e9a13bdfc87d865666cc5d42bb39999` 相同，manifest 30/30、Windows API 預設 150/150；備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/menus-20261002-012316/`。仍在 `feat/native-media`，未提交／發行；主 worktree 的其他改動保留。

# 2026-10-01 — 原生媒體 UI、操作與快捷鍵改善

## 第二輪：縮窄邊框與操作區

- [x] 移除重複標頭與畫面側邊留白，壓低底部工具列，簡化按鈕外觀
- [x] 改善進度拖曳預覽／放開跳轉，加入 Ctrl+H 純畫面與清楚的選取狀態
- [x] 背景驗證深淺色／小視窗／鍵盤與真 decoder，打包並更新實際關聯入口
- Review：舊已安裝 binary 在 edgeToEdge 斷言失敗；進度滑桿原生步長回讀為 1／2000，修正後 12 秒 fixture 換算為 4167／10000。`npm run build:media` PASS；Rust 4/4、`node scripts/test-media-player.js` PASS。
- Review：`probe-media-window.ps1 -ExerciseUi` 深色影片、淺色 640×430 圖片、音樂通過；畫面貼齊邊緣，工具列實測 80／56 DIP；scrubPreview／seekCommitted／seekKeyboardSteps／cleanView／controlsFit／controlsSeparate／focusKept 通過。純畫面收起並恢復原清單；窄窗 F1 上下排列；播放清單同步暫停狀態。
- Review：`npm run electron:pack` PASS（250 支 src 相同）；packaged `probe-media-ui.js` 四組真操作全過，WebP 2/2（12 格動畫）、損壞檔 4/4、SVG 真轉圖與畫面外繪圖通過。沒有前景鍵鼠／設定頁／UAC；高 DPI 實體螢幕與前景拖曳手感仍未驗證。
- Review：目前預設關聯入口已更新，30/30 manifest hash 通過；source／packaged／installed player SHA-256 `69da96e7f21037c353aaba87e883e7cc6f8c9ddfb60506a76459c3314431b155` 相同。舊版與 manifest 備份 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/slim-ui-20261001-231732/`；已安裝版 640×430 真繪圖／操作回讀通過，Windows 關聯 150/150。仍在 `feat/native-media` 未提交／未發布。

- [x] 參考 ImageGlass／mpv.net／常用播放器，確認原生 UI 與鍵盤的完整資料流
- [x] 精簡 Aurora 工具列、置中播放控制、圖片工具、音樂資訊與清單；保留深淺色、DPI、鍵盤與讀屏
- [x] 統一畫面與控制項快捷鍵，加入說明、圖片輪播、靜音、倍速、截圖與全螢幕收起控制列
- [x] 背景驗證原生操作／真格式／焦點、更新 preview 與目前系統關聯使用的播放器
- Review：`npm run build:media` PASS；Rust 4/4、`test-media-player.js` PASS；`probe-media-ui.js` 的圖片／影片／音樂／全螢幕四組真 decoder 操作在 source、packaged、已安裝 runtime 通過（輪播、動畫暫停、精準跳秒、倍速、逐格、旋轉、截圖、字幕偏移、清單／說明）。
- Review：`probe-media-window.ps1 -ExerciseUi` 深／淺色、640×430 小窗、真 F1、清單與繪圖通過；`focusKept`／`offscreen`／`controlsFit` 為 true。缺少專輯標籤的音樂原先繪圖 access violation，修復後通過；滑桿 25→75 截圖像素檢查在舊 binary 為紅燈，修復後深淺色與已安裝版 `sliderMoves=true`。
- Review：`npm run electron:pack` PASS（250 支 src 逐位元組相同）；`probe-media-packaged.js` 三段 PASS；packaged WebP 2/2（12 格動畫）與損壞檔 4/4。最後 build／pack／持久安裝 player SHA-256 相同，安裝 manifest 30/30 PASS；Windows 實際預設 150/150 維持不變。原 binary 與 manifest 備份在 `%LOCALAPPDATA%/VoiceInk Media/binary-backups/ui-20261001-174945/`。
- Review：全程背景／靜音、沒有前景鍵鼠／設定頁／UAC；source 仍在 `feat/native-media` 未提交、未發行。未新增音樂庫管理、全域媒體鍵、快捷鍵編輯器；高 DPI 螢幕的實際前景手感未驗證。

# 2026-09-26 — VoiceInk 啟動 Codex CLI 彈出外部終端機

- [x] 查明 Codex CLI 0.157.1 的 Windows daemon 行為，確認 `--no-daemon` 可用
- [x] 將 JS／Rust 的 Codex 預設指令改為 `codex --no-daemon`；實際 ConPTY 啟動與設定警告檢查通過
- [x] 修正實際安裝的 npm Codex `bin/codex.js`，Windows 自動補 `--no-daemon`（不重複補旗標）；原檔已備份為 `codex.js.bak-20260926-190841`
- [x] 實測普通 `codex` 在 ConPTY 啟動後帶 `--no-daemon`；version、既有旗標、exec/resume/app-server help 全過
- [ ] 本回覆完成後只重接 Codex 對話 `01a0dd4f-1666-7c20-bfb4-cad301a0daa7`，保留其他三個終端機；執行結果見 `C:/Users/rx595/.codex/codex-no-daemon-migration.json`
- 注意：npm 更新會覆蓋本機 launcher 修正；VoiceInk 原始碼的啟動旗標仍保留作為應用程式端修正。診斷命令已改走 `tty: true` 的 ConPTY，避免 daemon 的非 PTY shell 彈窗。
- Review：`test-terminal.js` 103/103、Rust `voiceink-term` 11/11、`test-terminal-host.js` 通過；`build:probe`、`electron:pack` 通過。打包版 `e2e-terminal-cdp.js` 中途被工具中斷，未取得完整通過結果；其隔離宿主與暫存資料已清理。

# 2026-09-27 — 終端機借鑑 Pebrel：Claude 狀態判定＋hooks＋重開接回

- [x] A（Grok）：`voiceink-probe claude-hook`、`claude-hooks.js`（安裝 exe／settings、監看、歸約）、`VOICEINK_TERMINAL_ID`（JS／Rust 宿主）、`claude --resume`
- [x] B（Grok）：`term-agent.js`（畫面規則＋`mergeState`）、分頁「等你回答」、真實畫面 fixture
- [x] 驗收修正：Esc／Ctrl+C 中斷回 idle（中斷不送 Stop）、焦點／滑鼠回報不算回答；`--user-data-dir` 不寫真的 settings；真 claude 測試改成 `VOICEINK_LIVE_CLAUDE=1` 才跑
- Review：`test-claude-hooks` 68、`test-term-agent` 全過、`test-terminal` 105、`test-terminal-ui` 12、`test-workspace-ui` 183、`test-terminal-links` 125、`test-terminal-host`（Rust／JS）全過、`cargo test` 25＋12；打包版＋真 Claude 驗收 11/11 ＋ 重開接回 2/2

# 2026-09-27 — 發行 v1.35.0

- [x] 重跑 Claude hooks、終端機、工作區與 Rust 回歸；重建 probe sidecar
- [x] 更新預覽包並跑隔離的 packaged terminal CDP
- [x] 同步 package.json、README、CONTEXT 版本，建置正式安裝檔
- [x] 驗證安裝檔、latest.yml、blockmap，提交並發布 GitHub Release
- Review：`test-claude-hooks` 68、`test-term-agent` 全過、`test-terminal` 105、`test-terminal-ui` 12、`test-workspace-ui` 183、`test-terminal-links` 125、`test-terminal-host` 全過、`cargo test` 25＋12；`electron:pack` 比對 246 支 src、packaged terminal CDP 59；`electron:build` 成功；安裝檔 SHA-512 與 `latest.yml` 相符，GitHub 三個資產的 SHA-256 與本機相符，Release 為 Latest。

## 2026-09-27 檔案頁：右鍵對準目標、詳細資訊依類型補齊

- [x] 重現「右鍵內容變成目前資料夾」：選取後按選單鍵／Shift+F10 會清掉選取；首頁卡片按右鍵沒反應
- [x] 修鍵盤右鍵、殼層選單目錄改用選到的東西那一層、首頁卡片右鍵選單
- [x] 詳細資訊：影音（ffmpeg）、文字（編碼／換行／行數）、其他走 Windows 屬性系統（sidecar `props`）
- [x] 體驗：大照片右側預覽、影片第一格縮圖（不抓著檔案）、詳細資訊兩欄排版、首頁容量讀取中
- Review：`test-explorer-details` 5 段全過（含真 ffmpeg）、`test-explorer` 309、zip 35、shell 44、zoom 22、clipboard 3、browse／wiring 過；`electron:pack` 比對 248 支 src；`probe-explorer-menu-target-cdp` 11 項全 PASS；`e2e-explorer-cdp`／dual／files-plan／zip 全過。
# 2026-10-02 — Claude Code 額度卡片消失

- [x] 重現登入來源改變／未連線時，已勾選卡片消失
- [x] 跟隨 Claude 登入資料夾，保留曾連線工具並顯示失敗原因
- [x] 回歸、更新免安裝預覽、隔離背景 CDP 驗證

Review：
- 確認條上預設隱藏 disconnected；登入檔讀不到會讓曾連線的 Claude 消失。新增 `hasConnected` 保存曾連線狀態，仍回報未連線且不保留假額度；明確取消勾選仍隱藏。
- 登入讀取與續期的檔案／兩把鎖／CAS 寫回共同跟隨 `CLAUDE_CONFIG_DIR`，不誤用預設資料夾的另一個帳號。
- `node scripts/test-quota-disconnect.js` 修前 1/4、修後 4/4；`test-usage` 40/40、`test-claude-auth` 7/7、`test-usage-state-race` PASS、`test-error-hygiene` 85/85。
- `npm run electron:pack` 成功，asar 248 支 src 相同；`node scripts/probe-quota-disconnect-cdp.js` 4/4（消失、明確隱藏、重開、恢復來源）。隔離 userData／假憑證／假 HTTP／隱藏視窗，不改使用者的登入或安裝版。
- 未取得另一臺電腦的版本與診斷，不能斷言它的實際觸發原因；未發行、未替換另一臺電腦。
# 2026-10-02 — 額度工具同類問題檢查

- [x] 檢查七家工具的登入位置、未連線與同步設定
- [x] 為確認問題補先失敗的回歸，最小修復
- [x] 相關回歸、打包與隔離背景 CDP 驗收

Review：
- 確認並修復：Codex 額度忽略 `CODEX_HOME`；OpenCode／Ollama 金鑰忽略 `XDG_DATA_HOME` 與 `OPENCODE_AUTH_CONTENT`。只跟隨選用來源，不回讀預設帳號；Codex 憑證仍只讀。
- 原有七家共用 `hasConnected` 已涵蓋登入檔消失／401／403／provider 失敗後保留卡片；明確取消勾選仍隱藏，從未連線仍可隱藏，不回填失效帳號的舊額度。
- `node scripts/test-quota-disconnect.js` 擴充後修前 5/8（3 個來源缺陷），修後 8/8，含真 provider 呼叫流程、環境內容格式／容量邊界；`test-usage` 40/40、`test-usage-state-race` PASS、`test-error-hygiene` 85/85。
- `npm run electron:pack` 成功，asar 248 支 src 與原始碼相同；`node scripts/probe-quota-disconnect-cdp.js` 7/7，新增真 IPC 的 Codex／OpenCode／Ollama 自訂來源、環境登入、來源消失與金鑰拒絕驗收。
- 本輪假憑證／假 HTTP／隔離 userData／隱藏視窗，未發出真額度重置、未改使用者登入；未發行，未驗另一臺電腦或 Codex 作業系統憑證庫登入。

# 2026-10-02 — 檔案圖示誤用 VoiceInk logo

- [x] 查證清單／方格圖示來源與所有呼叫點
- [x] 補先失敗的回歸，排除誤回的 App 圖示並加入類型預設圖
- [x] 相關回歸、重建免安裝預覽、隔離背景 CDP 與截圖驗收

Review：
- 共用 `fileIcon` 過濾一般檔案誤回的 App logo，以及 Windows 通用空白文件圖；`.exe` 保留自己的 logo，真縮圖即使內容是 logo 也保留。圖示讀取失敗回傳 fallback，pending 重試與同步標記照常。
- 左／右欄與虛擬清單共用折角 SVG 預設圖，依文件、程式碼、圖片、影音、壓縮、表格、模型、字型等 14 類區分；未知類型標副檔名，外部字串不直接拼進 SVG。相同 pending 圖不重建 img。
- `node scripts/test-explorer-icon-fallback.js` 修前於「一般檔案不能拿 App logo 當圖示」失敗，修後兩組 PASS（來源、執行檔、空白圖、真縮圖、pending／overlay、12 種類型、安全字串、相同圖不重建）。
- `test-explorer.js` 313/0、`test-explorer-shell.js` 44/0、`test-explorer-icons-state.js` 3/0；shortcuts、page-state、browse-wiring PASS，`git diff --check` 通過。
- `npm run build:shell` 與 `npm run electron:pack` 成功，248 支 src 與 asar 相同；`node scripts/probe-explorer-icon-fallback-cdp.js` 六組 PASS（真 Windows／真 IPC／清單／方格／右欄／主題與例外），`e2e-explorer-dual-cdp.js` 51/0、`probe-explorer-folder-views-cdp.js` 全過（含 Drive 綠勾）。
- 深／淺色截圖在 `dist/qa/explorer-icon-fallback-{dark,light}.png`。背景 GPU 截圖曾有局部缺畫／逾時，最終探針用軟體繪製＋視埠更新，兩張已目視確認完整；全程隱藏視窗，只收本輪 PID，隔離資料已清理。
- 既有無關失敗：`e2e-explorer-cdp.js:722` 仍斷言全域 tile 隨縮放改變，但目前寫進 folderViews（專用 probe 已驗過）；`test-temp-hygiene.js` 指出 HEAD 已存在的 `test-usage.js:824,844` 直接用 os.tmpdir。未擴大修改。
- 已更新免安裝預覽，未替換使用中的安裝版、未發行；未取得使用者發生問題的特定檔案，App logo 情境用真的打包版 logo 模擬殼層回覆驗證。

# 2026-10-02 — 主分支發行 v1.37.3

- [x] 主分支回歸與 sidecar 建置
- [x] 預覽包與隔離 CDP 驗證
- [x] 正式安裝檔與 metadata 完整性驗證
- [x] commit／tag／push／GitHub Release 與遠端資產核對

範圍：僅 master；保留 feat/native-media，不合併、不修改。

Review：15 支主要回歸最終通過；build:shell、build:probe、Rust 25＋14 通過。electron:pack 248 支 src 相同，203 份套件資料無缺漏，designs 不在 asar；ASR CDP 8/0、quota CDP 7/0、icon CDP 六組 PASS、本機 LLM 翻譯 PASS。terminal CDP 前兩輪各一個間歇性失敗，最終單獨完整跑 59/0。electron:build -- --prepackaged dist/win-unpacked 通過，安裝檔 427329691 bytes，latest.yml 版本／大小／SHA-512／blockmap 正確；拆包的 app.asar、VoiceInk.exe、五支 sidecar 與驗證包 SHA-256 一致。未改使用中的安裝版、未執行安裝更新流程。

發布驗收：v1.37.3 tag 與發行提交 c1c42f3 一致，GitHub 為 Latest／非 draft／非 prerelease；三個遠端資產大小與 SHA-256 全 MATCH。feat/native-media 維持 2a16919，未合併或修改。

# 2026-10-02 — 本機升級後 Claude 額度仍消失

- [x] 比對安裝版、真實登入與舊額度資料
- [x] 用本機舊資料形狀補先失敗的回歸，再修復曾連線狀態的遷移
- [x] 相關回歸、免安裝打包與背景 CDP 驗證；備份後修復本機額度顯示資料

查證：安裝版 v1.37.3 的相關程式與 HEAD 相同（僅換行不同）。Claude 2.1.287 的 auth status 回 loggedIn=false；憑證 accessToken／refreshToken 已空，沒有可續期的登入。usage.json 保有 claude: API OK 的歷史，但目前 disconnected／hasConnected=false；先前驗收只涵蓋升級時仍連線的快取，漏掉升級前已失效的舊資料。

Review：
- `usage/store.js` 依既存 Claude API 成功診斷補回 hasConnected；仍保留 disconnected 與空額度，不改輸入物件。已勾選的舊卡片可顯示原因，取消勾選仍隱藏；沒有成功證據的初始帳號不推定曾登入。
- `node scripts/test-quota-disconnect.js` 修前 8/9、修後 9/9；`node scripts/test-usage.js` 40/40；`node scripts/test-usage-state-race.js` PASS。
- 新 CDP 案例先對使用者同版安裝包（隔離 userData／假憑證／隱藏視窗）重現「舊卡片等待逾時」。`npm run electron:pack` 成功，248 支 src 相同；`node scripts/probe-quota-disconnect-cdp.js` 7 passed, 0 failed，卡片以 offsetHeight 驗證實際佔位，含未登入說明、重開、明確隱藏與恢復額度。
- 本機 usage.json 已備份到 `dist/qa/usage-before-claude-repair-20261001185952697.json`，比對未被同步改動後原子替換，僅 Claude hasConnected 改為 true；Claude 登入檔 SHA-256 不變。使用中的安裝版後續同步已保留此旗標。
- 未改使用中的安裝程式、未發行；使用者後續授權提交並推送本次修補。真實 Claude 登入資料已清空，無可用 token，未發出真續期或額度 API；真實額度數字仍待本人完成登入。

# 2026-10-02 — v1.37.4 正式發版與修復安裝版缺更新設定

- [x] 查明 v1.37.3 安裝版缺 app-update.yml 的原因
- [x] 先重現失敗，修正正式打包與不得補檔的更新驗收
- [x] 完整 NSIS 建置、拆包核對更新設定與雜湊、背景 runtime 驗收
- [x] 提交／tag／push、正式 GitHub Release、遠端資產核對；修復本機舊版更新設定

根因：前次 `electron:build -- --prepackaged dist/win-unpacked` 沿用 dir 預覽包，electron-builder 的 doPack 在 prepackaged 時提早返回，未發出 afterPack，PublishManager 因此沒寫 app-update.yml。GitHub v1.37.3 的 latest.yml／exe／blockmap 都存在，但本機 v1.37.3 安裝目錄確實缺 app-update.yml。舊 e2e-update-cdp 自行補檔，掩蓋了實際安裝包缺檔。

Review：
- 改後的 `e2e-update-cdp` 先對本機 v1.37.3 失敗「正式產物缺少 resources/app-update.yml」，`test-updater.js --release` 也先在原預覽包缺檔失敗。正式更新 CDP 不補任何產物檔案，改用隱藏視窗與隔離 userData；開測前關掉測試實例的自動下載與提權功能。
- `electron:build` 共用 pack-preview 的外部輸出／清理與 asar 查核，原生 NSIS 產生 app-update.yml，正式模式阻擋 --prepackaged，驗證更新來源、版本、latest.yml／exe 大小與 SHA-512 後同步回 dist。
- 發現本機 resources 比已安裝 v1.37.3 舊；`git diff v1.37.3 -- native scripts/copy-probe.js` 為空，因此沿用已安裝正式版的五顆元件（逐檔 SHA-256 相同），原本的建置快取備份在 dist/qa/native-before-release-1.37.4。最終 NSIS 也逐檔確認這五顆沒有退版。
- `npm run electron:build` 成功；`node scripts/test-updater.js --release` 全過；usage 40/40、quota 9/9、taskbar identity [A]～[F] 全過。正式安裝檔 427321753 bytes，blockmap 444929 bytes；latest.yml 版本／大小／SHA-512 相符。
- 7-Zip 直接拆正式 exe：224 個檔案與 dist/win-unpacked SHA-256 全相同，含 app-update.yml；248 支 src 與原始碼相同。以拆出的 VoiceInk.exe 跑更新 CDP 7/7（真 GitHub，state=none，沒有補檔），quota CDP 7/7。詳細雜湊在 dist/qa/release-verification-1.37.4.json。
- 本機 v1.37.3 已補入拆包驗過的 app-update.yml，未替換使用中的 exe／asar（前後 SHA-256 相同），未重啟使用者的程序。發布後以安裝目錄的 VoiceInk.exe 跑隱藏／隔離 CDP：7/7，currentVersion=1.37.3、state=available、version=1.37.4。
- v1.37.4 tag 指向 c8ad8359dd7d237c9e67fc4e1ad3c0633ec23de8，已推送 master 與 tag。GitHub 正式 Latest（非 draft／prerelease），三個遠端資產的大小與 SHA-256 全相符；直接讀官方下載網址的 latest.yml 與本機逐位元組相同，tag 的 package.json 版本也一致。Release：https://github.com/RX5950XT/VoiceInk/releases/tag/v1.37.4。

# 2026-10-02 — 檔案圖示仍出現 VoiceInk logo

- [x] 用真實 WAV 圖示檢查漏網原因，補先失敗的回歸
- [x] 修正共用圖示比對，保留執行檔、真縮圖與同步標記
- [x] 驗證相關回歸、重新打包，背景 CDP 驗真檔案與清單／方格／雙欄

## Review

- Windows 回傳的 WAV／App 圖示肉眼相同，原始 BGRA 有 1–4 的色差；原先只比 PNG 字串，對像素稍有差異的 logo 會漏過。改為比同尺寸像素（容許 4 的誤差，忽略完全透明像素的 RGB）。殼層另回不帶標記的底圖，比對時不受綠勾影響；替換預設圖仍保留標記，正常清單圖不重複疊圖。拖曳刪掉繞過共用過濾的第二次 Electron 取圖。
- `node scripts/test-explorer-icon-fallback.js`：色差、拖曳備用圖與重複標記回歸各先失敗，再全部 PASS；涵蓋全部 15 種圖示類型／19 種副檔名、正常 Windows 圖示、執行檔、真縮圖、暫時縮圖、同步標記與外部字串。
- `node scripts/probe-explorer-icon-fallback-cdp.js`：舊包在真正有一像素差異的 PNG 失敗，新包八組 PASS；包含本機真 Windows 圖示、使用者上次資料夾的真 WAV（`VOICEINK_ICON_TARGET`，唯讀）、8 種縮圖尺寸、真 IPC 的色差／標記、清單／方格／雙欄與深淺色截圖。WAV 與類型矩陣本身在舊包也通過，漏網情境以真 logo 修改一個像素重現，未指定的原始故障檔案無法逐一對照。
- `npm run build:shell`、`npm run electron:pack` 成功，248 支 src 與 asar 相同；`test-explorer.js` 313/0、shell 44/0、icons-state 3/0、shortcuts／page-state／browse-wiring／preview-lifecycle PASS；真殼層 probe 14/0（本機未出現 E_PENDING 的情境 SKIP）、拖曳 12/0、雙欄 CDP 51/0、folder-views CDP 全過（含真的 Drive 標記）。語法與 `git diff --check` 通過。
- 已更新 `dist/win-unpacked`；背景實例與外部打包輸出均已收完。深／淺色截圖在 `dist/qa/explorer-icon-fallback-{dark,light}.png`，已目視確認。未替換使用中的安裝版，未 commit／push／發行。

# 2026-10-02 — 資料夾內容縮圖仍帶 VoiceInk logo

- [x] 重現使用者目前資料夾的合成縮圖，補先失敗的回歸
- [x] 保留資料夾內容預覽，讓裡面的圖示共用既有過濾
- [x] 重建殼層與預覽包，驗證真資料夾、照片、空資料夾及雙欄，重開可見預覽

Review：
- 已在使用者預覽的 `X:\Music\ACG BGM\Qualidea Code` 取得含 logo 的資料夾縮圖。根因是 Windows 把外框與內容合成一張圖，先前的整圖比對無法過濾裡面的圖示。
- 資料夾改取 `ICONONLY` 外框，內容透過既有 `fileIcon` 過濾後疊圖；保留真照片／影音縮圖與同步標記，最多兩張，不遞迴子資料夾或捷徑，略過 hidden／system／reparse 項目。殼層最多查看 64 個項目，讀不到時保留外框並回報 `READ_FAILED`。
- `node scripts/test-explorer-icon-fallback.js`：資料夾外框與內容繪製斷言各先失敗，修後四組 PASS；`node scripts/probe-explorer-icon-fallback-cdp.js` 的資料夾斷言也先在舊包失敗，新包十組 PASS（含 `VOICEINK_FOLDER_TARGET` 的真資料夾、兩張內容圖、隱藏檔、照片、空資料夾、左右欄、深淺色與原有檔案類型驗收）。
- `npm run build:shell`、`npm run electron:pack` 成功，248 支 src 與 asar 相同；Explorer 313/0、shell 44/0、icons-state 3/0，shortcuts／page-state／browse-wiring／preview-lifecycle PASS；真殼層 probe 14/0（E_PENDING 未出現的情境 SKIP），dual CDP 51/0、folder-views CDP 全過（含真的 Drive 標記）。語法與 `git diff --check` 通過。
- 深／淺色截圖 `dist/qa/explorer-folder-preview-{dark,light}.png` 已目視確認；真實資料夾修前／修後圖 `dist/qa/explorer-folder-{before,after}.png`。已重新開啟可見預覽（隔離 `voiceink-dev`，PID 53360），確認原本音樂目錄前六個資料夾的內容圖載入；視窗被遮住時曾暫時取消背景節流以驗證，已恢復。安裝版 PID 31148 保留，未 commit／push／發行。
- 使用者授權推送後，rebase 到遠端 v1.37.4；僅 `tasks/todo.md` 追加紀錄衝突，兩邊內容均保留，圖示程式與測試內容不變。整合後圖示回歸四組、Explorer 313/0、quota 9/9、updater 全過；重建預覽包 248 支 src 相同，圖示 CDP 十組、quota CDP 7/7 全過。未發行本次圖示修正的新版本，`feat/native-media` 保留在 2a16919。

# 2026-10-02 — v1.37.5 正式發行

- [x] 核對 master、版本與原生元件，保留 native-media
- [x] 相關回歸、預覽包與背景 CDP 驗收
- [x] 完整 NSIS 建置，拆包驗更新設定、來源與元件雜湊
- [x] 推送版本與 tag，發布三個資產並核對遠端與舊版更新

Review：
- `npm run build:shell`、`npm run electron:pack`、`npm run electron:build` 成功；完整 NSIS，未使用 --prepackaged。其餘四顆元件與目前正式安裝版 SHA-256 相同，沒有退版。
- 圖示回歸四組 PASS、Explorer 313/0、shell 44/0、quota 9/9、taskbar identity 全過；預覽包圖示 CDP 十組、quota CDP 7/7、terminal restart continuity 全過。
- 拆正式 installer 得到 224 檔，逐檔 SHA-256 與 win-unpacked 相同；248 支 src 相同，五顆元件與 resources 相同，無 designs/native/dist/tasks 混入。`test-updater.js --release` 全過；拆包更新 CDP 7/7，圖示 CDP 十組全過。安裝檔 427345924 bytes；latest.yml 版本、大小、SHA-512 正確。證據：dist/qa/release-verification-1.37.5.json。
- 額外 `test-temp-hygiene.js` 有既有誤判：test-usage.js:824/844 的 no-such-local 只是注入與比對假路徑，不建立檔案；該檔與檢查腳本均未改，本次不擴大修改。遞迴 rmSync 檢查通過。
- v1.37.5 tag 與 master 的版本提交 fb9d689 已推送；GitHub Latest、非 draft/prerelease，三個資產大小與官方 SHA-256 相同，直接下載的官方 latest.yml 逐位元組相同，遠端 tag package.json 為 1.37.5。
- 從官方雜湊確認過的 v1.37.4 正式安裝包拆出 App，用隱藏／隔離更新 CDP：7/7，currentVersion=1.37.4、state=available、version=1.37.5。203 份依賴 metadata 未變，其餘四顆元件也與 v1.37.4 官方產物相同。
- 本機目前使用的 v1.37.3 缺 app-update.yml，更新 CDP 因缺檔明確失敗；本次未補檔、替換或重啟該安裝版。新版預覽 PID 40436 已開回 X:\Music\ACG BGM；feat/native-media 維持 2a16919。已清掉本輪解壓與 restart QA 複本，保留雜湊／截圖／正式安裝檔。
- Release：https://github.com/RX5950XT/VoiceInk/releases/tag/v1.37.5。

## 原生媒體彈窗（2026-10-01，feat/native-media）
- [x] Win32/Rust 獨立彈窗＋mpv 解碼子程序；不新增導航頁
- [x] 圖片／動畫／影片／音樂依類型切換控制、播放清單、字幕與基本快捷鍵
- [x] Explorer／工作區／ZIP／MTP 開啟接線、Windows 開啟方式註冊與解除
- [x] 固定解碼器版本及 hash、打包攜帶 runtime
- [x] 真格式矩陣、隱藏視窗操作、兩層當機隔離、資源量測與 packaged 驗收
- [x] 系統預設全面切換：150/150 Windows 關聯 API 回讀指向持久安裝的獨立播放器；全程背景、無設定頁／UAC。
- [x] 預設關聯續作：新舊 Hash 同步、完整備份與還原；還原原本程式 150/150（AssocQueryString，Unknown 表示未設定），再套用 150/150。
- [x] 背景補驗冷門格式、真 RAW、播放清單與損壞檔案；修正 RAW 轉圖期間被誤判已載入，圖片 probe 要等實際畫面尺寸。
- [x] 補驗後更新預覽與獨立播放器，26 檔 hash 回讀相符；建置／同步子程序加 `windowsHide: true`。
- Review：`build:media`、Rust 2 tests、`test-media-player` 全過；既有 workspace 283、UI 183、state 全過，Explorer 313 全過。最終 packaged runtime 真格式／操作矩陣 32/32（含 12 格畫面確認 WebP／GIF／MNG 循環、HEIC／JXL／PSD／SVG、H.264／HEVC／AV1／ProRes 等）；首個 file-loaded 327–563ms（小型 fixture，非第一個像素／跨播放器比較）。
- Review：深淺色與音樂 Win32 背景視窗截圖／清單／縮放／暫停通過、沒有搶焦點；靜態圖片 UI 約 12.5MiB＋decoder 約 108–114MiB，閒置 2 秒樣本 CPU 為 0（每核心）。`electron:pack` src 250 支逐位元組比對；packaged CDP 的 workspace／Explorer／ZIP、文字編輯、路徑守衛、無新增 nav、decoder／UI 當機隔離與主 App 強制結束後仍播放全過。修正 QA readiness 等到頁面與 light theme 初始化後才點按。
- Review：NSIS 安裝／解除掛勾編譯與 exe／blockmap／latest.yml 通過；未執行完整 VoiceInk 安裝、未發布。播放器已獨立安裝至 `%LOCALAPPDATA%/VoiceInk Media/`，26 個檔案 hash 回讀相符；HKCU 註冊→解除→重新註冊實測成功。Windows UserChoice 仍需系統確認；未驗證所有 RAW 變種、實體 MTP、全機安裝模式與 GPL 對外散布完整 source bundle。
- 既有無關失敗：`test-temp-hygiene` 指出未修改的 `test-usage.js:824,844` 兩處 `os.tmpdir()`，主工作樹同樣重現；遞迴 rmSync 守門通過。保留未改。
- 背景續作 Review：`raw:3fr` 修正前因「loaded=true、video=null、仍在轉圖」失敗；修正後六種真 RAW 全過（DNG／CR2／CR3／NEF／ARW／3FR，固定 SHA-256 的 CC0 樣本）。3FR 原圖 7247×5444 成功顯示；該次冷門大圖開啟約 15.5 秒，不宣稱所有格式瞬開。
- 背景續作 Review：`probe-native-media.js` 在最終 packaged runtime 50/50（另加 RAW 6/6）；`probe-media-packaged.js` 三段全過；`electron:pack` 250 支 src 比對通過，原生 exe 的 build／pack hash 相同。全程隱藏、靜音，未重新開啟系統設定。
- 背景續作收尾：Rust 2/2、`test-media-player.js`、`git diff --check` 通過；獨立播放器 26 檔 hash 再次回讀通過，沒有本輪播放器／解碼器／轉圖程序殘留，打包暫存輸出已清除。

- 預設關聯最終 Review：Windows `QueryCurrentDefault`／`AssocQueryString` 與實際 exe 路徑 150/150；新 Hash 150/150；原設定還原 150/150；解除登記還原／移除自身 handler 150/150；最後重新套用 150/150。備份在 `%LOCALAPPDATA%/VoiceInk Media/association-backups/`，最初完整備份 `1790841607894-348` 保留。
- 收尾驗收：`build:media` 通過；Rust 3/3、`test-media-player.js` PASS；`electron:pack` 250 支 src 比對 PASS；`probe-media-packaged.js` 三段 PASS；packaged WebP 2/2（動畫 12 格實際畫面）與損壞檔 4/4；`probe-media-installer.js` NSIS 編譯／三項產物 PASS，未執行前景安裝。build／pack／持久安裝的兩支原生 exe SHA256 相同，持久安裝 30/30 檔 hash PASS，沒有本輪程序殘留。

### 按鈕即時更新與拖曳重畫（2026-10-02）
- [x] 重現狀態更新後未留下按鈕重畫，確認拖動的實際繪圖路徑。
- [x] 修正共用按鈕更新與拖曳繪圖，保留原生鍵盤操作。
- [x] 背景驗證、打包、更新持久播放器，記錄未涵蓋邊界。
- Review：修復前 `probe-media-queue-resize.js` 確實失敗（buttonRefresh=false）；修復後深淺色各 84 格通過，按鈕補畫／時間條／空清單底色通過。`cargo test ... --bin voiceink-media` 14/14；`node scripts/test-media-player.js` PASS。

| Before | After | Why |
| --- | --- | --- |
| 按鈕更新文字時同步繪圖被 State 借用擋住 | 原生訊息處理完後重新標記按鈕重畫 | 不再等滑鼠離開才換圖示 |
| 清單逐列直接畫到畫面 | 清單與捲軸先在記憶體完成，再一次顯示 | 不露出逐列清空的中間畫面 |
| 視窗縮放後只排隊重畫 | 放開 State 後立即畫完本格 | 連續縮放不延後更新控制列 |

- Review：`probe-media-window.ps1 -ExerciseResize` 深淺色各 44 次側欄拖曳＋4 次視窗縮放 PASS；播放／暫停切換不送任何滑鼠事件、不先截圖，讀取真正 WM_DRAWITEM 完成記號，兩方向都 PASS。`-ExerciseUi -ExerciseMenu` 與長清單 `probe-media-improvements.ps1 -Features` 10 項通過；本輪所有視窗均在畫面外，沒有搶焦點。
- 收尾：`npm run electron:pack` 250 支 src 比對通過；packaged 深淺色各 84 格通過。持久安裝版 `-ExerciseResize`：pausePaintWithoutMouse／resizeSliderStable／windowResizePainted／ownFocusAbsent 全 true，44 次拖曳＋4 次視窗縮放。manifest 30/30 hash 通過，播放器 SHA-256 `1ffa9d5e8748a8a29d38ad72e4049f0a9b6b47323198baeb17ccf2db46d421aa`；備份 `binary-backups/button-drag-2026-10-02T05-23-18-874Z`。
- 驗證邊界：未操作使用者的實體滑鼠；背景繪圖與操作通過，不代表已驗證前景拖動手感。此次「拖動」依既有問題先涵蓋側欄寬度與視窗縮放，未更動圖片平移或視窗標題列原生拖動。分支仍為 feat/native-media，未提交、未發布。

### 播放速度滑桿（2026-10-02）
- [x] 倍速按鈕與更多選單改開同一個自繪滑桿浮窗。
- [x] 0.25–4×、0.05× 步長、即時顯示、恢復 1×，保留鍵盤操作。
- [x] 背景驗證真解碼器與深淺色，打包並更新持久播放器。
- Review：修復前 `probe-media-window.ps1 -ExerciseMenu` 明確失敗「播放速度仍是固定選單，沒有滑桿」。修復後深淺色在真正 mpv 回報中確認 0.25／1.35／2.75／4／1×，76 次連續滑動停在最後位置；方向鍵 0.05×、恢復 1×、兩個入口、Esc 通過。`-ExerciseUi` 進度／快捷鍵通過；圖片子選單通過；`probe-media-queue-resize.js` 深淺色各 84 格通過；Rust 14/14、`test-media-player.js` PASS。
- QA 調整：合併 `-ExerciseResize -ExerciseMenu` 會先清空 QA ListBox 再驗 hover，因此該次失敗屬腳本操作順序；分開執行後通過，未據此改產品功能。

| Before | After | Why |
| --- | --- | --- |
| 固定倍速選項、工具列循環切換 | 同一個滑桿浮窗，拖動即調整 | 能連續選到所需倍速 |
| 只提供少數預設值 | 0.25–4×、0.05× 步長、恢復 1× | 細調與還原都直接可用 |
| 解碼器較早回報可能移動圓點 | 最新拖曳值待回報確認 | 快速拖動不被舊回報拉回 |
- 收尾：`npm run electron:pack` 250 支 src 比對 PASS；packaged 淺色、持久安裝深色 `probe-media-window.ps1 -ExerciseMenu`：speedSliderLive／speedSliderBurst／speedSliderKeyboard／speedSliderReset 全 true，未搶焦點。持久播放器已更新，manifest 30/30 SHA-256 PASS；備份 `binary-backups/speed-slider-2026-10-02T06-08-35-224Z`。驗證僅使用本輪畫面外 HWND，實體滑鼠手感未驗證；分支仍 feat/native-media，未提交／未發布。
- 視覺補驗：新增滑桿圓點像素斷言後先失敗（倍速／鍵盤功能雖通過，滑桿被白色覆蓋）。移除速度浮窗新增的 SetWindowRgn 後相同斷言通過；保留既有 DWM 圓角設定。未採用直接繪圖／WM_PRINT 攔截等試驗修法。
- 最終收尾（取代先前中間產物）：打包 250 支 src PASS；最終 installed 深色與 packaged 淺色 `-ExerciseMenu` 全 PASS，滑桿圓點像素斷言通過，已人工檢視背景截圖。安裝 manifest 30/30 PASS；source／packaged／installed SHA-256 `f82baf755dfa98571af42642f9811db2b1fd46dbb9ae3442f0c89ba65fb14192` 三份相同；最終備份 `binary-backups/speed-slider-final-2026-10-02T06-17-53-781Z`。未操作實體滑鼠、未提交、未發布。

### 滑桿拖曳抖動與局部重畫（2026-10-02）
- [x] 重現局部 WM_PAINT 是否裁掉自繪圓點，涵蓋長進度／音量／倍速。
- [x] 在共用滑桿修正重畫範圍與形狀，提升倍速拖曳解析度。
- [x] 背景驗證拖曳、鍵盤與真解碼器，打包並更新實際入口。

| Before | After |
| --- | --- |
| 原生局部重畫會裁掉自繪圓點，長滑桿拖動留下破碎邊緣 | 共用 subclass 在 BeginPaint 前擴大重畫範圍；保留原生命中區與既有一次 BitBlt |
| 倍速 75 格、0.05× 拖動會跳格 | 375 格、0.01× 拖動；方向鍵維持 0.05× |

- Source review：`probe-media-queue-resize.js` 修前斷言 fullSliderPaint=false，修後深／淺色各 120 次局部重畫及 84 格縮放 PASS、白點 0；`probe-media-window.ps1 -ExerciseMenu -ExerciseUi` 真 mpv 倍速相鄰 1.35/1.36×、連續 375 格、鍵盤／重設／seek PASS；Rust 14/14、`test-media-player.js` PASS。未操作實體滑鼠。
- Final review：`npm run electron:pack` PASS、250 支 src 逐位元組比對；installed 深／淺色各 120 次局部重畫 PASS；packaged 淺色倍速／鍵盤／seek PASS，背景截圖已檢視。ownFocusAbsent=true；focusKept=false 只代表本輪開始與結束的其他前景視窗不同。source／packaged／installed SHA-256 `911886f17db7f60b97c626a77266c91b5c02a5cb7f8f2d1603049b05bb685610` 相同、manifest 30/30。備份 `binary-backups/slider-damage-2026-10-02T06-41-43-141Z`；本輪程序及外部打包暫存已收尾。未操作實體滑鼠、未提交或發布。

### 移除點擊虛線框（2026-10-02）
- [x] 找到按鈕、清單、滑桿與倍速重設的 DrawFocusRect；移除虛線，保留現有顏色及圓點大小提示。
- [x] 背景確認滑桿重畫、快捷鍵與倍速。
- [x] 打包並更新實際檔案關聯入口，核對 hash。

| Before | After |
| --- | --- |
| 點擊後出現虛線焦點框 | 移除虛線；按鈕與清單沿用顏色提示，滑桿圓點放大提示焦點 |

- Review：`rg DrawFocusRect native/voiceink-probe/src/bin/voiceink-media` 無匹配；release build PASS；`probe-media-window.ps1 -ExerciseMenu -ExerciseUi` 深色倍速／重設／方向鍵／清單／seek 全 PASS、focusKept=true、ownFocusAbsent=true；實際 installed `probe-media-queue-resize.js` 深／淺色各 120 次局部重畫、84 格縮放 PASS，白點 0。`electron:pack` PASS、250 支 src 一致；source／packaged／installed SHA-256 `0a053ebf6769e587c7f5952811ed0fb2dfcd6ba264251e73a9fe861f85324228` 一致、manifest 30/30。備份 `binary-backups/no-dotted-focus-2026-10-02T06-53-55-721Z`；未操作實體滑鼠、未提交或發布。
