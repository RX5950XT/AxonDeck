# tasks/todo.md — 進行中與待辦

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。只留最近幾輪；更早的紀錄查 git log（`git log -- tasks/todo.md`）。

## 待辦

- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。

# 2026-10-07 — 檔案頁方格縮圖整片閃爍（像一直重新載入）

> 根因：`paintList()` 整批重建 DOM，而 `explorer-icons.js` 用 pane 物件判過期＋重試預算掛在 element 上。
> 重畫一次就丟掉載入中的縮圖請求、重試預算歸零再要一次；監看／點選又頻繁觸發整批重畫 → 縮圖永遠在「 fallback → 載入 → 被丟掉」循環。

- [x] 量測：vm 回歸測試先紅（重畫中 resolve 要照收、不重複要圖、重試預算跨重畫共用）
- [x] 修 `explorer-icons.js`：載入按快取鍵去重＋遲到結果寫快取並補畫現行列＋重試預算按鍵算（30 秒冷卻）
- [x] 修 `explorer-page.js`：`browseFingerprint`（放 `explorer-browse.js`＋單元測試）；監看 silent 重讀無變化不重畫；選取只就地改列
- [x] 驗收：`run-tests.js` 115/115＋`electron:pack`（asar 269 支一致）＋打包版 `e2e-explorer-cdp` exit 0＋`e2e-explorer-dual-cdp` 52/52

## Review

- 中途改壞一行 `if (pathKey(dirPath) === THIS_PC)`（loadSecond）：`test-explorer-page-state` vm 轉換直接 SyntaxError，修回後綠。教訓：改 `if` 包裝時確認條件行還在。
- 兩個舊 e2e 斷言早已跟不上行為（與本次無關，順手修）：C11 還在看全域 `tile`（v1.37.0 起改存 `folderViews`，todo 早有記錄）；dual [7] 還在等刪除確認框（v1.39.3 起回收筒不問，`git show 629a74f` 確認）。
- dual [7] 卡住時先懷疑自己的改動，重跑必現後才去查 `deleteItems` 確認邏輯＋git 歷史定位——對的順序。

# 2026-10-07 — CC Proxy：CLI搬家、MCP四家、Skills與記憶

> 使用者拍板：版本搬去設定並移除分頁；MCP 四家都讀寫（claude/codex/grok/opencode，agy 先不做）；skills 啟用開關＋記憶檔可編輯。

- [x] 後端 MCP 四家：`mcp-homes.js`（canonical spec↔各家格式；codex/grok TOML 走新依賴；未知鍵原樣保留；codex/claude 停用放 store，grok/opencode 用原生 enabled）。
- [x] 後端 skills＋記憶：`skills.js`（四家 skills 清單讀 SKILL.md、停用用 `.disabled/` 搬移；記憶檔讀寫 CLAUDE.md/AGENTS.md/MEMORY.md，路徑驗證不跳脫）。
- [x] IPC＋preload＋service 接線（`ccswitch:*` 新 channel，白名單測試同步）。
- [x] 前端：設定頁加 CLI 版本區（CC Proxy 移除 version 分頁）；MCP 分頁加四家切換；新增 Skills 與記憶分頁。
- [x] 單元測試（新跑＋舊跑）；`electron:pack`＋打包版 `e2e-ccswitch-cdp`＋smoke。
- [x] TOML 依賴選型已定（見 Review）。

## Review（選型，先記。中途停下換方法不超過兩次）

- Codex：`~/.codex/config.toml` 的 `[mcp_servers.<id>]`（command／args／`env_vars`＋`[.<id>.env]`）；無 enabled 證據→停用放我方 store。
- Grok：`~/.grok/config.toml` 的 `[mcp_servers.<id>]`，stdio 用 `.env`、remote 用 `.headers`，原生 `enabled`。
- OpenCode：`~/.config/opencode/opencode.json` 的 `mcp`（v1 扁平；local／remote＋`environment`＋`enabled`）。
- Grok 記憶是 `~/.grok/MEMORY.md`；codex 記憶用 `~/.codex/AGENTS.md`；`~/.claude/skills` 是 symlink 指到 `~/.agents/skills`（兩邊看到同一份，UI 要標共用）。
- TOML 庫：`smol-toml`（零依賴、parse＋stringify 保鍵序；註解不保留，寫前備份＋原子替換比照既有）。

## Review（驗收）

- 單元：`test-mcp-homes` 31、`test-skills` 28 全過； commit 前全套 `run-tests.js` 115/115。
- 打包版 `e2e-ccswitch-cdp` 144/144（含新的四家路徑、Skills、設定頁 CLI 區）。
- 途中修的三個 bug：canonical 轉換掉 command／url（codex 第一筆讀不到）、http 該吃 headers 不是 env、`test-cli-install` 用註解標記切程式碼（標題改名把它弄斷，已恢復）。
- 教訓：這台有設 `GROK_HOME`，測家目錄的測試一定要把 env 指到暫存；TOML 測試種子要用單引號字串（雙引號反斜線是跳脫）。
- 2026-10-07 續：記憶搬上／Skills 搬下、兩顆「開資料夾」走檔案頁新分頁、共用家藏記憶。`e2e-ccswitch-cdp` 149/149、`run-tests.js` 115/115。長任務（pack／e2e／全套測試）改放後台跑，使用者傳訊息不再被卡。
- 2026-10-07 續：Local SI 子分頁改執行環境／推薦／探索（預設執行環境）。`e2e-hf-cdp` 50/50。
- 2026-10-07 續：發行 v1.42.0（commit a2d0018＋tag 已推；NSIS 三件套已上傳 GitHub release）。

# 2026-10-07 — 執行環境：API 複製、統計改名、推論兩欄

- [x] 啟動卡 API 列：OpenAI／Anthropic URL＋複製、已載入模型 id＋複製（只在執行中顯示）。
- [x] 統計改名：預填充速度／解碼速度／輸入 tokens／輸出 tokens。
- [x] 推論面板內容左右兩欄（窄螢幕自動疊回一欄）。
- [x] `electron:pack`＋打包版 `e2e-hf-cdp.js` 重跑。

## Review

- 複製走 `terminal:clipboardWrite`（main 寫剪貼簿，沒焦點也成），按鈕按完變「已複製」1.2 秒。ID 都沒動，e2e 不用改。
- API／統計只在 router 執行中展開（統計還要已載入模型才有 `/metrics`）；e2e 測不到這段，打包版 50/50 全過只保證沒撞壞舊版面。
- `electron:pack` asar 267 支一致。

# 2026-10-06 — Local SI 模型庫併進執行環境

- [x] 拿掉「模型庫」子分頁，本機模型與資料夾放進「執行環境」。
- [x] 啟動縮成一般按鈕，旁邊選模型載入或卸載；畫面上的載入上限拿掉。
- [x] 「這台機器」改成占用：CPU%、記憶體已用／總量、GPU% 與 VRAM。log 獨立一塊。
- [x] 改 e2e 斷言（三個子分頁、模型卡在執行環境、啟動鈕跟一般按鈕一樣高）。

## Review

- 子分頁剩探索／推薦／執行環境。上面一列是啟動、狀態與載入／卸載，下面左本機模型、右占用，推論與 log 各自一塊。
- 開發預覽量過 1280 與 390：啟動約 39×66、占用有 CPU／記憶體／兩張卡、窄螢幕按鈕沒有被拉高。沙箱 userData，沒碰使用者的模型。打包版 `e2e-hf-cdp.js` 已重跑：50/50 全過；`electron:pack` asar 267 支一致。

# 2026-10-06 — 終端機開了就消失

- [x] 開終端機先掛分頁再等 PTY；還原途中已開的分頁不要被存檔搶回去。
- [x] 對話載入晚回來時，主區已經換成工作區就不再切回聊天。
- [x] 還活著但沒有分頁的終端機補回分頁；側欄圖示點一下打開。

## Review

- 當時 VoiceInk 的 Codex（`t_muwgo930_thhhke`）程序還在終端機宿主裡，`tabsState` 只剩 Grok 那一格，所以側欄有圖示、畫面沒有。之後依要求只關掉這顆，Miroxen 那棵沒動。
- `node scripts/test-terminal-reopen.js` 修前紅（分頁掛在 `terminal.open` 之後），修後通過。另過 `test-chat-image-memory.js`、`test-workspace-ui.js`。隨 v1.41.0 發行。

# 2026-10-06 — 本地模型搬進 Local SI、推論自動、Index-Translate

- [x] 探索模型卡：HTML `<table>` 被剝成直排數字 → `hub.htmlTablesToMarkdown` 先轉成 markdown 表格。
- [x] `models.js`：拿掉 Qwen3.5 0.8B／4B，加 Index-Translate-2B Q4_K_M；舊 key 遷移。
- [x] `local-llm.js`：Index 官方翻譯 prompt；GPU 自動（NVIDIA ≥8GB VRAM 才 GPU，否則 CPU），不再看 `llmGpu`。
- [x] 設定頁「本地模型」整段拿掉；Local SI 新增「推薦」子分頁（ASR 兩顆＋翻譯兩顆）；推論方式／CUDA 環境併進「執行環境」。
- [x] Local SI 自動配置：進頁沒裝執行環境就自動裝建議的那顆。
- [x] 清掉本機 qwen35translate／qwen354b 模型資料夾。
- [x] 最終 router 版重新打包並重跑 packaged CDP：Local SI 51、語音頁 20、smoke 22 全過；打包版 Index → LinguaForge → Index 實際 GPU 翻譯正常。
- [x] 實測 GPU 切模型遇 native context.dispose Access Violation → 改共用 llama-server router；GPU／模擬不合格硬體的真 CPU 翻譯各 5 項通過。
- [x] Index Q4_K_M 下載完成、官方 SHA-256 相符；舊 Qwen 本機資料夾已不存在。

## Review

- `npm run electron:pack` 成功，asar 266 支 src 與原始碼相符；真實 HF 模型卡表格已檢查截圖。
- `npx electron scripts/e2e-local-translate-settings.js` 與 `--cpu` 各通過 5 項實際翻譯／遷移；CPU 是模擬未偵測到合格 GPU，推論本身走真 CPU。未驗實際低 VRAM 電腦與 CUDA router。
- `node scripts/run-tests.js`：110/112；本次新增 safe-rm 引用造成的 `test-download-callers.js` 載入失敗已修正並單獨重跑通過。`test-chat-image-memory.js` 的剝除器不認得 `export { a as b }`，已改成整行拿掉；`node scripts/test-chat-image-memory.js` 通過（快取 6291528 字元）。
- `git diff --check` 通過；隨 v1.41.0 發行。

# 2026-10-06 — 改名 AxonDeck＋新 logo

- [x] 機械改名 VoiceInk → AxonDeck（含 native 路徑、exe、csproj、crate），tasks/ 歷史不動。
- [x] 保留舊名（升級不斷線）：`com.voiceink.app`、userData `%APPDATA%oiceink`、媒體 ProgID `VoiceInk.Media.*`、終端機 host 舊 pipe 前綴、媒體 mutex。
- [x] 舊資料銜接：開機自啟動路徑、Claude hooks 舊標記、HF `voiceink-meta.json`、更新快取、工作列釘選、感測器排程（Grok）、媒體登錄檔與資料夾（Codex）。
- [x] GitHub repo 改名 AxonDeck（舊網址 301，舊版 `releases.atom`／`latest.yml` 實測轉得到）。
- [x] logo：去白底透明 PNG、ico、頂欄 logo＋漸層字、README 橫幅。頂排 SI → Super Intelligence（兩行疊字）。
- [x] Git 面板：暫存的改名（git mv）只顯示 +N 沒有 −N → 暫存 numstat 帶 `-M`、parseNumstat 認改名列。
- [x] 單元 111/111；打包 CDP chat 75、sysmon 114、workspace 196。

## Review

- 機械改名後要逐一找「寫進使用者電腦」的名字：資料夾、登錄檔、排程、hooks、模型 meta 檔、更新快取、開機自啟動路徑；改名但不銜接 = 升級後資料不見或殘留孤兒。
- 測試腳本裡指向「這台電腦真實 userData」的路徑不能跟著改名（真實資料夾仍叫 voiceink）。
- `resources/` 的舊名建置產物不會自己消失，要手動清，否則一起被打包。

# 2026-10-06 — 頂排改名、CC Proxy 精簡、CLI 自動安裝、處理程序、語音頁合併

- [x] 頂排：AI → SI（換 SI 單色圖示）、HF模型 → Local SI。
- [x] CC Proxy：拿掉頁首重新整理（點子分頁即重讀）、「供應商」標題、卡片文字精簡、主模型（兜底）；Opus／Sonnet／Haiku 三格並排、只顯示模型 id；各家預設模型更新；OpenRouter 只列文字＋工具＋一年內。
- [x] CLI 版本：未安裝自動安裝（含環境）、安裝／更新背景靜默（Codex）；Antigravity 版本清單查證。
- [x] 系統監控處理程序：網路欄、欄名總占用％、欄位拖曳換序、程序圖示（Codex）。
- [x] 語音轉文字：檔案轉入＋錄音機合併左右兩欄、錄音拖進轉入區、拿掉最近四筆；即時字幕可切系統聲音／麥克風（Grok）。單元：test-stt-archive 33、ipc-invoke 11、error-hygiene 85、test-dictation 120。未打包、未跑 CDP。
- [x] 打包＋CDP 驗收：ccswitch、sysmon 114、chat 75、smoke 過；捷徑開檔回歸修好（explorer 單元 23）。
- [ ] 重新打包時 pack-preview 報 `src/main/agy/anthropic.js` asar 對不上，待查；stt／recorder CDP 待重跑。

# 2026-10-06 — CC Proxy 改版＋AGY 新模型路由＋單價＋媒體縮圖

- [x] AGY：`claude-opus-5-5` 等帳號裡真的有的 ID 被前綴規則改回 `claude-opus-4-6-thinking` → 先比對即時型錄（同家族同代優先、淘汰跟 replacedBy）。
- [x] 單價：`claude-sonnet-5.5`、`gpt-6.1-sol`。
- [x] CC代理 → CC Proxy；AGY 反代搬成子分頁；閘道開關拿掉改自動開關；AGY 執行中自動加入供應商；設定彈窗收進階設定＋「儲存並啟用」。
- [x] 七家供應商真流量（Codex 子代理）＋真 Claude Code 經閘道／AGY。
- [x] 媒體播放器關聯檔案的 Explorer 縮圖。
- [x] `electron:pack` ＋ `e2e-ccswitch-cdp`／`e2e-agy-cdp`／`e2e-cdp-smoke`。

## Review

- AGY 接 Claude Code 原本整個不能用（不只新模型）：① 工具 schema 有 `anyOf` 時 Claude 模型上游一律 400（對照實驗：同型別 pattern、string|number 都 400，單一 pattern 200）→ 送 Claude 時攤平；② tool_use／tool_result 沒帶 id → 第二輪 400；③ 新 ID 被靜態前綴規則改回舊模型。真 `claude -p`（opus-5-5）純文字回 OK、Bash 工具往返回 hi-from-tool。
- 七家（`probe-ccswitch-claude-e2e.js`）：Grok／Codex／OpenRouter 文字／串流／工具全 200；Ollama 402（方案）、OpenCode Go 403（無訂閱）、Command Code 400（餘額）是帳號阻擋。Codex 子代理修了 OpenCode Go 標頭與 Codex／OpenCode 的「測試」鈕。
- 縮圖：ProgID 沒 `TypeOverlay` 時 Explorer 把預設圖示（App logo）疊在縮圖角落（微軟文件）→ 設空字串。Grok 子代理的 190 行處理器複製沒解到這個症狀，已改回並清掉它在 HKCU 留下的 27 筆預覽處理器副本。
- 驗證：單元 test-ccswitch 263、gateway 60、agy-mappers 57、code-usage 158、usage 40、error-hygiene 85、ipc-invoke 11；e2e-ccswitch-gateway 48；打包版 e2e-ccswitch-cdp 138、e2e-agy-cdp 34、smoke 22；`cargo test --bin voiceink-media` 14。
- 既有：`e2e-agy-cdp.js` 印完 ALL PASS 後 node 不會自己結束。

# 2026-10-04 — 全專案讀碼掃 bug

- [x] 檔案總管（自己讀）：右欄捲動空白、方格虛擬清單、右欄開檔／刪除／改名／捷徑作用到左欄、鍵盤處理兩次、雙欄圖示互搶、搬移先量整棵樹、zip／手機暫存不清、net use 卡主程序。
- [x] Codex（gpt-6.1-sol high）讀 main 兩組、Grok（grok-4.7 high）讀 main＋renderer 兩組，共 61 條，逐條自己讀碼查證後修。
- [ ] 未修（需硬體或判斷）：SATA SMART 用 access=0 開磁碟（要重編 probe＋SATA＋管理員才驗得了）；網頁版 AI 會記住同站非對話頁（對話網址格式不確定，怕擋掉正常對話）；網頁時長寫入失敗不重試（有 busy_timeout，跨小時重試會重複算）；檔案轉錄 validateFilePath 同步 stat（檔案剛由對話框選出）。

## Review

- 主要修正：CC 閘道（OAuth 未處理 rejection／續期覆寫別帳號／重登綁定失效／CLI 憑證被換／上游卡住關不掉／SSE 失敗當成功／Chat 丟圖片／tool_choice）、用量（AGY 晚完成漏算、Grok rewind 重算、o1 被丟）、HF（fit 開成 llama-server、bench 帶不支援的 -c、多卡只用一張、0 MiB 當全空、分片匯入、下載中換資料夾）、效能調整（溫度 null 變 0 不還原、功耗預設被壓半、每核 CO 蓋掉全核、每核鎖頻清不掉）、Git（方括號檔名、無 HEAD 取消暫存）、工作區（NAS 離線卡 main、拖曳殘留、Monaco 首次跳行、PDF／音訊改名、快速開檔串專案、Ctrl+G 換專案丟字）、其他（語音整理丟尾段、熱鍵停用後又掛上、ASR 互卸、聊天新圖被 prune、翻譯預熱互卸、LinguaForge 單行清單、字幕紀錄同步讀、麥克風開兩條、更新連點、hfModelsDir 驗證、OC 拖曳／風扇存檔／登入輪詢／HF 搜尋競態、終端機路徑折行、diff 檔頭誤判、使用時長下一頁）。
- 驗證：相關單元測試全過（code-usage 一條舊預期就是 rewind 重算，改成新預期）；`llama-bench -c` 實測報 invalid parameter；`git --literal-pathspecs checkout` 實測不動到 `a1.js`；`electron:pack` 256 支 src 一致；打包版 `e2e-explorer-dual-cdp`、`e2e-workspace-cdp` 196/196、`e2e-cdp-smoke` 22/22。

# 2026-10-04 — 檔案頁右欄雙擊打不開

- [x] 真滑鼠重現：右欄雙擊檔案不開、資料夾進不去；左欄正常。
- [x] 修 `onSecondListClick` 認 `detail === 2`，拿掉容器上的 dblclick；補真滑鼠回歸 [4b]。

## Review

- 根因：右欄第一下 click 會 `paintSecondPane()` 換掉整批列，第二下的 dblclick 落在拿掉的舊列上，傳不到 `#exSecondList` 的委派監聽。左欄每列自己掛監聽所以沒事。舊測試用合成 dblclick 直接打在列上，從來沒抓到。
- 驗證：`e2e-explorer-dual-cdp.js` 修前 [4b] FAIL、修後 52/52；探針確認右欄雙擊 txt 會開、資料夾會進去；`electron:pack` 256 支 src 一致。
- 既有無關問題：`e2e-explorer-cdp.js` 停在「放大後的大小存得進 explorer.json」（v1.37.0 起大小改存在各資料夾的 `folderViews`，測試還在看全域 `tile`）。

# 2026-10-04 — Grok 網頁版卡 Cloudflare 驗證

- [x] 重現：App 內開 grok.com 一直停在「正在執行安全驗證」並重載。
- [x] 對照實驗找變因、只改 Grok 分區、補單元測試、更新預覽包。

## Review

- 對照實驗（同一 session 設定，只換 UA）：偽裝成 Chrome、縮版號、多帶 `voiceink/x` 都卡住；Electron 原樣識別（含 `Electron/43.4.1`、完整版號）約 8 秒過。Cloudflare 認得出 Electron，偽裝反而被當機器人。
- 修法：`ai-web.js` 新增 `userAgentFor(partition, fallback)`，`persist:ai-grok` 只拿掉 App 名字；其他三家與工作區瀏覽器維持 Chrome 識別（Google 登入要用）。`main.js` 把 partition 傳進 `setupSession`。
- 驗證：`node scripts/test-ai-web.js` PASS（新增 Grok／ChatGPT 兩條）；用改好的 `setupSession` 實開 grok.com 兩次都 8 秒內進首頁；`npm run electron:pack` 驗 256 支 src 與 asar 一致。

# 2026-10-04 — 文件精簡

- [x] AGENTS.md 671 → 190 行、CONTEXT.md 900 → 154 行、lessons.md 243 → 約 150 行、todo.md 1230 → 本檔；刪掉已完成的歷史流水帳、跟 AGENTS 重複的教訓、過時描述（nav「聊天」→「AI」、Grok 需真人點 Cloudflare 等）。

# 2026-10-04 — v1.39.0：AI 入口、網頁對話與記憶體

- AI 頁加入 ChatGPT／Gemini／Claude／Grok 網頁版，每按一次新增一則存進 `chats.json` 的 `web`；對話與資料夾改整列右鍵選單。
- Google 登入：`accounts.google.com` 整頁導覽換非瀏覽器識別走精簡版；Claude 的 Google 登入在 App 內開小視窗。
- 記憶體：網頁藏 5 分鐘或超過 3 則就收；工作區背景瀏覽器分頁閒置 10 分鐘拆。打包 CDP 實測 App 1383MB → 697MB。
- 驗證：test-ai-web／chat-sidebar／image-memory、error hygiene 85/0、IPC 11/0、workspace UI 183/0；打包 CDP chat 74/0、smoke 22/0、workspace 192/0。

# 2026-10-03 — 搜尋記憶體、五種 AI 紀錄與終端機接續（併入 v1.39.0）

- 專案搜尋逐行讀：RSS 峰值 204.9 → 118.4MB；UFFS 閒置 60 秒休眠（943MB → 2MB）。首次載索引峰值仍約 2.6GB。
- 五種 AI 紀錄分頁讀到最後；五種 AI 終端機重開接回原程序或原對話。
- 限制：Antigravity CLI 部分工具結果非明文；多個同工具終端機同時產生對話時無法判定歸屬就不接。

## 既有已知問題（不屬於最近改動）

- `test-temp-hygiene.js` 報 `test-usage.js:824,844` 直接用 `os.tmpdir()`。
# 2026-10-06 — 系統監控處理程序升級

- [x] 實測 Windows 網路來源與權限；沿用感測器 sidecar，不新增 UAC。
- [x] 補取樣器執行檔路徑、網路資料與整機總占用；圖示非同步快取。
- [x] 處理程序表拆檔，加入圖示、總占用、固定名稱欄與可保存的拖曳順序。
- [x] 跑全部 test-sysmon、IPC／錯誤檢查、Rust 測試、build:probe 與 parity。

## Review（處理程序）

- 13 支 test-sysmon 全過（主測試 188/0），IPC 11/0、error-hygiene 85/0、sensors-lifecycle 通過；cargo test 53/0。
- build:probe、build:sensors 成功，resources 更新；Rust／PowerShell parity ALL PASS，含路徑／建立時間。Windows 執行檔別名以實際檔案比對。
- probe-sysmon-network：未提權；ETW 與 SetPerTcpConnectionEStats 都回 5（Access denied），正確回不可讀。ETW x64 ABI、TCP／UDP v4／v6 事件解析通過。probe-sysmon-icons：真 Electron small 圖示 data URI 946 字元。
- 依範圍未打包、未跑 CDP；未跳新 UAC，因此提權 sidecar 的真實吞吐尚未驗證。新增網路只沿用既有 sidecar 啟動方式；收集失敗／過期／事件遺失皆顯示「—」。

# 2026-10-06 — CLI 版本背景安裝與更新

- [x] 查官方安裝方式與 agy manifest（唯讀）；不執行本機安裝／更新。
- [x] main 固定指令、補 Node/npm、重讀 PATH、工具鎖與 10 分鐘逾時。
- [x] 版本列安裝／更新／進度／摘要；移除終端機與 updateCommand IPC。
- [x] mock spawn、CC Proxy、IPC 與錯誤回歸；不打包、不跑 CDP。

## Review（CLI）

- test-cli-install 37/37、test-ccswitch 266/266、test-ccswitch-cli-models 7/7、test-ipc-invoke 11/11、test-error-hygiene 85/85；10 檔語法與指定檔案 diff --check 通過。
- agy 官方 install.ps1 的公開 Windows manifest 回傳 1.2.17；本機 agy --version 同為 1.2.17，update --help 未提供 --check。
- 依本次範圍未實際安裝／更新、未打包／CDP；真實安裝器與權限行為尚未驗證。
