# tasks/todo.md — 進行中與待辦

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。只留最近幾輪；更早的紀錄查 git log（`git log -- tasks/todo.md`）。

## 待辦

- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。

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
