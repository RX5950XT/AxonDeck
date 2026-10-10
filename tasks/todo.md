# tasks/todo.md — 進行中與待辦

# 2026-10-10 — 發行 v1.44.0

- [x] 全套回歸、版號與 README、commit＋tag＋push。
- [x] 正式 NSIS 建置、拆安裝檔確認 app-update.yml、GitHub release＋三件套。
- [x] 交接文件（CONTEXT 版本與版本表）。

## Review（v1.44.0 發行）

- `node scripts/run-tests.js` 131/131。版號 1.43.0→1.44.0＋README 版本行，commit `f09b0bc`＋tag 已推。
- `npm run electron:build` 通過：asar 284 支一致、app-update.yml／latest.yml 驗證通過並同步 dist。拆安裝檔內層 app-64.7z 確認含 `resources/app-update.yml`。GitHub Release v1.44.0 已公開，三件套（安裝檔 453MiB、blockmap、latest.yml）大小與本機相同。
- 發版前關掉自己開的打包預覽（PID 13364 整棵）；正式安裝版 PID 27356 未動。未重開預覽。

# 2026-10-10 — 補驗並推送剩餘修改

- [x] 盤點全部剩餘修改與相互引用，保留使用者的 App、模型和終端機。
- [x] 全部單元測試與受影響的打包版功能驗證通過，補驗錄音下載與翻譯長文。
- [x] 提交剩餘已驗證修改、推送並確認遠端一致與工作區狀態。

## Review（剩餘修改）

- 納入全部剩餘終端機標題／狀態／翻頁鍵、2000 字翻譯與 router 設定、CUDA／Vulkan 環境判斷、Skills／記憶合卡、錄音下載，以及相關測試與文件。先前限定只推最後一項，已依使用者修正擴回全部剩餘修改。
- `node scripts/run-tests.js` 128/128；新增 `test-hf-recommend-download.js` 先紅（只下載模型、漏掉 runtime）、修正 `hf-recommend.js` 讀 `{ ok, data }` 並處理失敗後全綠；`test-download-callers.js`、`test-temp-hygiene.js`、新增長文分組與輸出上限斷言皆通過。
- 打包版 `e2e-ccswitch-cdp.js` 149/0、`e2e-terminal-cdp.js` 68/0、`e2e-recorder-cdp.js` 41/0（下載與原檔逐位元組相同）。所有測試用獨立 profile，只收自己的程序；使用者的預覽與終端機宿主／shell 保留。
- `npx electron scripts/e2e-local-translate-settings.js` GPU 7 案、`--cpu` 5 案通過：兩顆真實模型 file/live；GPU 額外翻譯 1634 字／8 段並驗所有段落標記。未以這項檢查宣稱語意逐句正確；未重新下載大型 runtime。
- 沿用 `pack-preview.js --config.npmRebuild=false`，僅在記憶體改 PREVIEW 目的地為 `dist/remaining-push-qa`，結束碼 0、279 支 src 一致。修正後打包版 `AXONDECK_EXE=... node scripts/e2e-hf-cdp.js` 51/0。未重開使用者預覽、未發行安裝檔；推送前驗暫存區與遠端 HEAD。

# 2026-10-10 — 錄音字幕對齊與兩邊混音

- [x] 統一兩個按鈕大小，對齊按鈕、狀態與音源列。
- [x] 字幕也支援三種音源，共用混音取得與釋放流程，保留原字幕麥克風降噪。
- [x] 驗證字幕混音 PCM 到字幕與停止/失敗清理；打包、版面驗證並更新預覽。

## Review（錄音字幕對齊與兩邊混音）

- 兩顆開始按鈕共用 64px 高與內距，錄音音量計移入狀態列；按鈕、狀態與音源列對齊。兩個唯讀代理檢查版面與掃描，無新增問題。
- 字幕補上 both，設定讀寫驗證同步；兩邊共用音源取得與混音釋放，字幕保留既有麥克風降噪。啟動與停止時鎖住控制，部分取得失敗也釋放已開來源。
- `node scripts/test-recording-audio.js` 8 案、`test-vad.js` 11/0、`test-stt-archive.js` 33、`node scripts/run-tests.js dictation` 2/2；`test-temp-hygiene.js` 通過。
- 最後打包版 `node scripts/e2e-recorder-cdp.js` 40/0、`node scripts/e2e-stt-cdp.js` 32/0：三種音源錄檔頻率、字幕 16kHz PCM／VAD／ASR IPC 到畫面與紀錄、音源持久化、停止／拒絕清理、不同寬度對齊皆通過。字幕回字使用本機測試伺服器，未測雲端辨識準確度或實體麥克風收音。
- `npm run electron:pack -- --config.npmRebuild=false` 結束碼 0、279 支 src 一致。已更新沙箱預覽 PID 60380；實量兩顆按鈕約 327.88×64px、y=227.08，截圖已檢視。使用者終端機保留，未 commit/push。
- 推送前逐段排除其他功能的未提交改動；從暫存區匯出獨立副本，混音 8 案、模型 scope 35/0、終端機 UI 14/0、VAD 11/0、archive 33 與 Vite build 皆通過。提交範圍含同頁介面所需的共用語音設定，不含其他終端機標題、翻譯長度、runtime 或 CC 修改。

# 2026-10-10 — 合併語音功能卡與錄音音源

- [x] 三組上下合卡，內部水平分隔線，欄間縮到 12px。
- [x] 錄音音源支援麥克風、系統聲音、兩者混音；記住選擇並完整釋放裝置。
- [x] 音源失敗與混音測試、打包版三欄／錄音驗證，更新預覽。

## Review（功能合卡與錄音音源）

- 三個 `.stt-column` 合併上下各兩區，用 subgrid 對齊分隔線；欄間 12px，窄版依功能堆疊。兩個唯讀代理分別查版面與掃描；拖放回饋被 reset 蓋住，打包版先紅 29/1，補 scoped 底色後綠 30/0。
- `recAudioSource` 加入 store allowlist、讀寫驗證與 UI 同步，預設 mic；system 使用既有 main loopback，both 用兩路各半混成單一音訊軌，不播放到喇叭。錄音中鎖住音源；取得另一音源失敗時釋放已開來源，停止後也關閉混音 context。
- `node scripts/test-recording-audio.js` 7 案通過（單音源、混音、權限拒絕、無系統音訊、context 啟動失敗、非法值與釋放）；`node scripts/test-stt-archive.js` 33；`node scripts/run-tests.js dictation` 2/2；`test-temp-hygiene`、`git diff --check` 通過。
- 最後打包版 `node scripts/e2e-recorder-cdp.js` 28/0：Chromium 假麥克風錄成 opus、播放/轉錄/拖放/刪除；440Hz/880Hz 各路及混音的實際錄檔經 ffmpeg 解碼量頻率，記住音源、鎖定、非法值、拒絕後釋放皆通過。`node scripts/e2e-stt-cdp.js` 30/0，四種視窗寬度的分組、等寬、12px 間距、長度、捲動與拖放底色通過。
- 另以無假媒體 flags 的隔離 packaged 實例驗證 Windows 系統擷取：1 條 live audio，停止後全部 ended；不存任何聲音。實體麥克風收音未測，混音內容以已知測試音源驗證。
- `npm run electron:pack -- --config.npmRebuild=false` 結束碼 0、279 支 src 一致；預覽重開 PID 18252。畫面實量三組各 365px 寬/715px 高、分隔線與 12px 欄距；截圖已檢視。原終端機宿主與 shell 保留，未 commit/push。

# 2026-10-10 — 語音頁三欄與紀錄加長

- [x] 三個開始區與三種紀錄各排等寬三欄，移除字幕底下提示。
- [x] 語音輸入紀錄改名，紀錄與個人字典加高。
- [x] 打包、量寬高與捲動，更新已開的預覽。

## Review（三欄與紀錄加長）

- 三個操作區等寬同列、三種紀錄等寬同列（至少 440px）；語音輸入紀錄與字典等寬、至少 560px。900px 以下單欄，整頁可捲動。HTML 與視覺順序一致，鍵盤焦點由上往下。
- 字幕兩行提示與專用更新函式已移除；引用提示當初始化條件的兩支測試同步改用共用模型選單。
- 依 skill 用兩個唯讀代理分別檢視版面與機械掃描，detector 前後皆無命中。保留既有 18/20/10px 內距及無頁面標題的設計，避免擴大此次排列需求。
- `npm run electron:pack -- --config.npmRebuild=false` 結束碼 0，278 支 src 與原始碼相同。`node scripts/e2e-stt-cdp.js` 最後打包版 29/0，1440/1000/760/560px 等寬、高度、無橫向溢出與真滾輪到底皆通過；`node scripts/run-tests.js dictation` 2/2；`git diff --check` 通過。
- `node scripts/probe-asr-key-cdp.js` 兩次皆在初始化回報 `Promise was collected`，未進入斷言；此額外探針尚未驗證，未擴大改啟動流程。未重測真錄音與字幕音訊擷取。
- 已重開沙箱預覽 PID 56224、顯示語音頁；實量三個紀錄各 357px 寬/440px 高，字典與語音輸入紀錄各 560px 高；上下截圖已檢視。原安裝版 PID 27356、宿主 35608/30864、shell 11180/56728 保留。未 commit/push。

# 2026-10-10 — 語音頁放寬與終端機空白

- [x] 查語音頁高度限制、終端機載入與既有工作階段，保留其他未提交改動。
- [x] 語音頁改成較寬、較長、可上下捲動；補上切回同尺寸終端機仍需重畫的缺口。
- [x] 相關回歸、打包版真操作與大小檢查，記錄結果。

## Review（語音頁與終端機空白）

- 語音頁由三欄改兩欄，模型列橫跨頂端；紀錄區至少 280px、字典區至少 320px，整頁上下捲動，900px 以下改單欄。音量條固定原本的 6px，窄視窗提示文字可換行。
- `fitAndSync` 原本遇到欄列數沒變就跳過畫布重畫。現在每次切回都重畫，尺寸沒變仍不送 PTY resize、不清 texture atlas。單元回歸修復前紅、修復後綠；打包實測沿用原 xterm、保留捲動位置。
- `node scripts/run-tests.js terminal` 14/14；`node scripts/run-tests.js dictation` 2/2；`node scripts/test-model-scope.js` 35/0。語音頁 `node scripts/e2e-stt-cdp.js` 27/0，1440／1000／760／560px 真滾輪到底、不橫向溢出；深淺色截圖已檢視。測試的設定分區假設同步現有四區，未改設定頁。
- 終端機完整 CDP 曾有 5 個焦點／背景時序失敗；加入唯讀焦點診斷、相同流程重測後 68/0（hidden=true、焦點仍在 xterm）。不以一次通過宣稱這些偶發現象已修復。側欄標題斷言改從 main 讀即時 OSC 名稱，配合既有未提交的標題功能。
- `e2e-terminal-conversation-cdp.js` 28/0；三種 shell 提示字元、真正空畫面、切換後新輸出通過；五家真 CLI 啟動、切換、縮放通過，未送 AI 提問。`probe-terminal-native-scroll.js` 五家真 CLI 原生啟動通過。
- 隔離版 restart/update 探針通過：App 完全結束、替換自己的安裝副本、重開後原 shell PID 與持續輸出都保留；明確刪除才結束 shell。探針暫存改走 `test-temp`，只收自己的 App／host／shell。
- 安裝版 App PID 27356、宿主 PID 35608、Codex shell PID 11180 均保留；唯讀連線與畫面有文字。原本「突然全空白」尚未重現，不能認定已找到完整根因。未 commit／push、未替換安裝版。
- 兩次打包被 asar 比對擋住（AGY 檔未改）；改用已建好的相依套件、跳過重建後通過。清掉臨時探針後 `npm run electron:pack -- --config.npmRebuild=false` 結束碼 0，278 支 src 逐檔相同，已同步 `dist/win-unpacked`。

# 2026-10-10 — 終端機分頁標題與側欄即時狀態

- [x] 回歸先紅：Grok 事件尾端歸成 working／waiting／idle；通用 OSC `grok` 讓給對話標題。
- [x] 分頁顯示 `generated_title`（沒有就 `session_summary`）；使用者改過的名字、有意義的 OSC 標題仍優先。
- [x] 側欄與分頁狀態跟 `events.jsonl` 的回合與權限，不跟整支程序一直轉。
- [x] 相關測試通過。不重開終端機宿主，不 commit。

## Review（分頁標題與側欄狀態）

- 分頁原先用 OSC 標題。Grok 全程報 `grok`，所以蓋掉 `summary.json` 的對話標題。現在通用名稱讓路，使用者改過的名字與有意義的 OSC 標題仍優先。
- 側欄轉圈是宿主把整支 CLI 當成一條還沒結束的指令。現在看該對話 `events.jsonl` 的回合與權限，經既有的 `terminal:agent` 就地改圖示。`updates.jsonl` 不讀。
- `node scripts/test-terminal-activity.js` 先因找不到模組失敗，補上後全數 PASS。`node scripts/run-tests.js terminal` 14/14。`npm run electron:pack` 結束碼 0，asar 278 支 src 與原始碼相同。安裝版仍開著，沒重開終端機宿主，畫面還沒在那扇窗上量過。未 commit。

# 2026-10-10 — Claude 切對話即時改綁

- [x] pid 檔已更新時，同一秒再寫入的舊 jsonl 不得蓋過。
- [x] pid 檔停在舊 id、jsonl 晚兩秒以上時，仍改綁較新的那份。
- [x] 回歸先紅再綠，然後打包重開預覽；不重開終端機宿主。

## Review（Claude 切對話）

- 這支 Claude 的 `/resume` 會改 `sessions/<pid>.json`。離開的 jsonl 晚了約 50ms，舊邏輯一直綁在剛離開的那份。
- 現在 pid 檔有效就用它；只有 pid 檔停住、專案 jsonl 晚兩秒以上，才改看較新的紀錄。
- 回歸先紅（實際綁到舊 id）再綠。`npm run electron:pack` 結束碼 0，asar 275 支 src 與原始碼相同。預覽重開後，store 的對話前綴已與 pid 檔相同。宿主與那支 Claude 沒關。未 commit。

# 2026-10-10 — Claude 改綁、Codex 少停頓、OpenCode 一顆按鈕、Grok 滾軸、AGY 清單

- [x] Claude：這個目錄只有一支時，改綁程序開始後較新的專案 jsonl。
- [x] Codex：同一句只出現一次時從畫面底部停住，框線不擋定位。
- [x] OpenCode：拿掉終端機裡的第二顆對話按鈕，側欄那顆改成單一圖示。
- [x] Grok：啟動與恢復改回 `--minimal --no-alt-screen`。
- [x] AGY：這次程序已證實的對話庫，工作區路徑不同也綁定並讀得出來。
- [x] 測試通過後打包並重開預覽；不重開正在跑的終端機宿主。

## Review（五項對話紀錄）

- Claude 的 `/resume` 不改 `sessions/<pid>.json`。這個目錄只有一支 Claude 時，改綁程序開始後較新的專案 jsonl。
- Codex 同一句只從畫面底部找到最新一份就停；框線 `│` 不再讓定位失敗後整段重播。
- OpenCode 右上角兩顆是 AxonDeck 的 `☷`（這個字本身像兩顆）加上外掛又畫一顆。側欄改 `☰`，外掛按鈕拿掉。隔離真 CLI 探針通過。
- Grok 改回 `--minimal --no-alt-screen`。探針：一般緩衝區、滑鼠回報關閉。單獨 `--fullscreen` 仍會進 alternate screen。
- AGY 工作區路徑和終端機目錄不同時，仍綁定這次程序的對話庫，導覽讀得到；專案頁的完整記錄仍拒絕別的目錄。
- `node scripts/run-tests.js terminal` 13/13。`cargo test --bin axondeck-term` 14 通過。`npm run electron:pack` 結束碼 0，asar 275 支 src 與原始碼相同。預覽已重開。未重開終端機宿主，未 commit。

# 2026-10-10 — 跳轉停在該則、Grok 全螢幕、OpenCode 捲動、AGY 清單、不攔截滑鼠

- [x] 最後一則也停在該則，額度中斷後的輸出留在下面；Codex 重複命中不再整段重播。
- [x] 不攔截 CLI 滑鼠模式；全螢幕仍留對話清單，只收起 AxonDeck 捲軸。
- [x] Grok 改 `--fullscreen --no-alt-screen`，先確認不進 alternate screen。
- [x] OpenCode 側欄點列寫跳轉檔，外掛把內部捲軸移到該則。
- [x] AGY 這次 log 沒有串流代碼時，用這個目錄的 `last_conversations.json`。
- [x] 測試、交接、打包並重開預覽。

## Review（跳轉停在該則）

- 點最後一則停在該則開頭，後面的輸出留在下面。Codex 畫面裡同一句多一份時直接跳第一份，不再整段重播。
- Grok 啟動與恢復是 `grok --fullscreen --no-alt-screen`。旗標探測：這個組合不進 alternate screen；單獨 `--fullscreen` 會進去。
- OpenCode 點清單會把內部捲軸移到該則。`node scripts/probe-opencode-native-navigation.js` 通過。1.18.35 的回答沒有節點 ID，同一提問內用第一行唯一吻合。
- AGY 這次 log 沒有串流代碼時，用這個目錄的 `last_conversations.json`。
- 滑鼠模式不再攔截；Ctrl+滾輪仍改字級。`node scripts/probe-terminal-mouse.js` 13 項通過。
- `npm run electron:pack` 結束碼 0，asar 275 支 src 與原始碼相同。`node scripts/e2e-terminal-conversation-cdp.js` 28 項通過。未 commit。已運行的 OpenCode／Grok 要重開那一格才吃到新外掛與全螢幕旗標；宿主若提示版本不符，不要自動重開，否則會關掉正在跑的終端機。

# 2026-10-09 — 五家 resume 後清單與跳轉

- [x] 回歸先失敗：全螢幕 alternate buffer 被當成沒有這則訊息；Grok 的 system-reminder 被當成提問。
- [x] 跳轉改搜目前畫面；導覽略過 system-reminder。
- [x] 打包後用隔離實例確認 OpenCode 跳轉與 Grok 清單第一列是測試提問。Codex／AGY 跳轉、五家改綁已在目前打包版量過。

## Review（五家 resume 與跳轉）

- 隔離打包版、既有測試專案、沒有新提問。Codex A↔B 1.4／1.8 秒，標題是對話名稱；點提問後畫面停在該則，並標成目前列。OpenCode B→A 1.0／1.7 秒，標題 `OC | 對話名稱`。Grok B→A 1.3／1.4 秒；清單第一列現在是測試提問，點了之後標成目前列，提問還在第 16 列。Antigravity B→A 0.9／1.4 秒，點了之後標成目前列，提問在第 8 列。
- OpenCode 點列時，全螢幕緩衝區裡沒有那則提問文字，所以仍顯示找不到。它的畫面只留著回答。
- Claude 的 `/resume` 會列出其他專案的真實對話，這次沒有代按。
- `node scripts/test-terminal-conversation.js` 先紅（全螢幕被當成沒有訊息、system-reminder 被收成提問）後綠。`npm run electron:pack` 結束碼 0，asar 274 支 src 與原始碼相同。未 commit。

# 2026-10-09 — Codex 標題只有資料夾名稱時無法跳轉

- [x] 回歸先失敗：忙碌圖示讓標題對不上；資料夾名稱要改綁這次執行期間更新的紀錄。
- [x] 去掉忙碌圖示後再對標題；對不上時，單一 Codex 終端機改綁這次開始後唯一較新的紀錄。
- [x] 相關測試通過後打包，只換使用者正在看的預覽；安裝版不關，不送新提問，不 commit。

## Review（Codex 跳轉）

- 根因：Codex 預設 OSC 標題是忙碌圖示加資料夾名稱，對不到對話名稱。被接回的紀錄已在啟動基準裡，也不會當成新 ID。Miroxen 三筆已知紀錄只有一筆在啟動後約 11 秒有寫入，終端機仍是未綁定。
- 修復前 `node scripts/test-terminal-agent-resume.js` 失敗，實際停在 `another-codex-session`。修復後同一支兩行 PASS；`node scripts/run-tests.js terminal-session-switch` 1/1。
- `npm run electron:pack` 結束碼 0，asar 274 支 src 與原始碼相同。預覽重開為 PID 52152（`dist\win-unpacked`、`axondeck-dev`，視窗可見）。安裝版 PID 42652 與預覽宿主 PID 51212 仍在。沒有再送 Codex 提問，未 commit。真的 Codex 畫面沒有點選跳轉。

# 2026-10-09 — 同終端機 resume 即時切換對話紀錄

- [x] 回歸：掃描進行中又來的查詢要看到換過的標題，而且只補掃一次。
- [x] 改綁寫入成功才通知該分頁重讀；寫入被拒不通知。
- [x] 面板關著的使用中分頁也換成新的一段。
- [x] 先看到回歸失敗，再跑相關測試；把含這次修正的預覽開給使用者。

## Review（同終端機 resume）

- 根因：進行中的掃描會把舊標題交給後到的查詢；改綁寫入後也沒通知分頁。面板關著時那一次刷新落空，清單就停在上一段。
- 修復前 `node scripts/test-terminal-agent-resume.js` 失敗：實際仍是 `ses_first12345`。修復後同一支通過；`node scripts/run-tests.js terminal-session-switch` 1/1。
- `npm run electron:pack` 結束碼 0，asar 274 支 src 與原始碼相同，已更新 `dist\win-unpacked`。預覽改開這份，userData 仍是 `%APPDATA%\axondeck-dev`（PID 43436，視窗可見）。安裝版 PID 42652 沒關。沒有再送 Claude／Codex／Antigravity 提問，未 commit。

# 2026-10-09 — 五家真實訊息與 CLI 內切換

- [x] 隔離 App 與測試目錄，五家送出短訊息並量測清單更新。
- [x] 經 CLI 原生 resume 選單切另一段，再驗清單及後續回答。
- [x] 有失敗先留重現，修根因並驗相關測試及打包；記錄真實限制。

## Review（五家真實訊息與 CLI 內切換）

- 隔離包是這次打好的 `dist/win-unpacked`。安裝版與 `dist/terminal-bottom` 預覽沒有關。沒有改產品程式，也沒有 commit。
- 清單面板開著時，用各家自己的選單切到另一段，側邊清單會換成那段的提問與回答：Codex `/resume` 第一段 496ms、換段 2620ms；Grok `/resume` 752ms、2736ms；OpenCode `/sessions` 493ms、1735ms；Antigravity `/resume` 1355ms、2153ms。Grok 的 OSC 標題全程停在 `grok`，改綁靠 `active_sessions.json`。Antigravity 標題仍是 PowerShell，改綁靠 cli log。
- 新提問：Codex 的使用者那列約 2 秒進清單，模型回用量限制，下次可試是 10 月 10 日凌晨 2:09，沒有再送。Claude 的使用者那列約 5 秒進清單（session `8834486b-9359-4781-befe-fa3c6869f388`），記錄裡的回答是每週額度，台北時間 10 月 11 日凌晨 3 點重置；`stop_reason` 為 `stop_sequence`，導覽清單不收這則。沒有打開使用者其他的 Claude 對話。Antigravity 畫面是額度用完，只切換既有的兩段，沒有再送新提問。
- 面板關著時，OpenCode 的標題先變、session id 後到，關著的清單不會自己重畫；滑入或面板維持開著才會在約 1 秒內跟上。這次量到的更新都是面板開著的結果。

# 2026-10-09 — 接續五家清單與捲軸驗收

- [x] 讀取 Grok 交接並核對現有程式與打包產物。
- [x] 補齊五家清單提問跳轉、最新項目置底與續輸入的打包版檢查。
- [x] 跑相關單元、真 CLI 與隔離打包版驗收，記錄覆蓋範圍及限制。

## Review（接續驗收）

- 本輪只補 `e2e-terminal-conversation-cdp.js` 五家逐一真滑鼠點選：提問出現在可見畫面、最新項目令 viewport 與捲軸同時到底、同一 xterm 接收未送出的輸入。沒有再改產品程式。
- `AXONDECK_EXE=dist/terminal-bottom/AxonDeck.exe node scripts/e2e-terminal-conversation-cdp.js`：28 passed, 0 failed。包含五家拖曳／滾輪、長文、重複提問、切回位置、持續輸出與窄畫面。測試使用隔離 userData 與五家格式樣本，HostClient 回應替身；不冒充五家真實長對話驗收。
- 現有 terminal-bottom asar 的 266 支 src JS／MJS／CSS 與目前來源逐檔完全一致，因此沿用該包驗收。`node scripts/run-tests.js terminal`：11/11；`test-ai-session-live.js`、`test-workspace-agent-list.js`、`test-workspace-agents-full.js`、`probe-terminal-fullscreen-mouse.js` 全過；語法與 `git diff --check` 通過。
- `probe-opencode-native-navigation.js` 真 CLI／ConPTY 40 則匯入訊息通過：提問／回答跳轉、最新置底、拖曳／滾輪、草稿與續輸入。`probe-grok-native-navigation.js` 通過一般緩衝區與草稿檢查；`probe-terminal-native-scroll.js` 五家真 CLI 啟動／旗標／畫面模式通過。
- 未送出新的 AI 提問，Claude／Codex／Grok／Antigravity 的真實長對話未逐筆點選；Antigravity 仍依賴本機既有 `altScreenMode: never`。保留使用中的安裝版與預覽視窗，未 commit／push。

# 2026-10-09 — 全螢幕 CLI 原生捲動與對話導覽

- [x] 分別驗證 OpenCode、Grok、Claude／Codex／Antigravity 的原生捲軸與指定訊息跳轉入口。
- [x] 接上已證實可用的原生操作，修正 AxonDeck 攔截滑鼠的衝突；保留既有對話及全螢幕功能。
- [x] 驗證捲軸拖曳、滾輪、即時跳轉、重開紀錄與可繼續輸入；沒有控制入口的工具明確記錄限制，不製造假定位。
- [x] 查驗證據、跑受影響測試及隔離打包驗收，更新交接與結果。

## Review（全螢幕原生捲動）

- OpenCode 維持全螢幕。宿主用 `OPENCODE_TUI_CONFIG` 載入 `opencode/navigation.mjs`：原生捲軸常駐，右上角滑入列出已保存的提問／最終回答，依訊息 ID 直接跳。1.18.35 的回答沒有標 ID，只接受同一提問內唯一且完全相同的 Markdown。`node scripts/probe-opencode-native-navigation.js` 通過：跳到第一則與最後回答、拖曳、滾輪、草稿還在且可繼續輸入。
- Grok Build 1.0.50 的命令面板搜尋 jump 是 No matches，沒有原生輪次跳轉。正式啟動維持 `--minimal --no-alt-screen`（不進 alternate screen、不開滑鼠回報），捲軸與清單仍由 AxonDeck 畫在一般緩衝區。`--fullscreen` 會進 alternate screen 並打開滑鼠回報，因此不採用。`node scripts/probe-grok-native-navigation.js` 通過。
- Claude／Codex／Antigravity 同樣停在一般緩衝區（Claude 環境變數、Codex `--no-alt-screen`、本機 AGY `altScreenMode: never`）。`node scripts/probe-terminal-native-scroll.js`：五家只有 OpenCode 進入 alternate screen。
- 全螢幕且 CLI 自己收滑鼠時，AxonDeck 收起右緣捲軸與導覽，點擊／拖曳／滾輪交給 CLI；Shift＋拖曳仍是本地選取。`node scripts/probe-terminal-fullscreen-mouse.js` 通過。
- `node scripts/run-tests.js terminal` 11/11。隔離包 `dist/terminal-native-nav` asar 273 支 src 與原始碼相同；該 exe 的 `e2e-terminal-conversation-cdp.js` 23/23。沒有替換正在跑的 `dist/win-unpacked`（user-data 在 `%APPDATA%\axondeck-preview`）與安裝版。未 commit／push。

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。只留最近幾輪；更早的紀錄查 git log（`git log -- tasks/todo.md`）。

# 2026-10-08 — 導覽只捲動運行中的 CLI

- [x] 移除保存文字替換畫面的分支，保留單一可輸入終端機。
- [x] 一般緩衝區直接定位，全螢幕沿 CLI 滾輪定位；無法定位明確提示。
- [x] 先重現錯誤，再驗打包版真點選、捲動與輸入，接回原程序。

## Review（只捲動原 CLI）

- 使用者明確修正：選單是捲動運行中的 CLI，不是替換成紀錄文字。刪除 term-history.js、第二個 xterm、唯讀模式／回到目前輸出按鈕及相關 CSS；清單仍讀正式紀錄，但只控制原 CLI。
- 一般畫面依實際文字定位，相同提問完整保留時按出現次序；全螢幕經原 SGR 滾輪逐段查找，最多 20 秒，操作／切格／換 session 可取消。CLI 已清除、重複而無法確認、未公開可捲動畫面時提示找不到，不重畫保存文字。
- 抓到 refreshTerminalPage 經 app.js:948 呼叫 scrollToBottom 的真實堆疊；移除切換入口和頁面更新的強制置底，尺寸同步仍保留。
- 舊包新增「不得產生第二份畫面」斷言先紅；新版 dist/terminal-live-navigation 的 e2e-terminal-conversation-cdp.js 22/22，包括原 CLI 真滑鼠、重複提示詞、切回位置、鍵盤／語音續輸入、全螢幕原畫面查找與分割。
- node scripts/run-tests.js terminal 9/9；新增全螢幕定位／取消檢查的 test-terminal-conversation.js 通過，最後 test-terminal-ui.js 13/13。probe-terminal-agents-restart-cdp.js 六項通過，五家真 ConPTY 在 App 重開後仍是原 PID／輸出與可輸入畫面。探針改用實際 xterm 尺寸，文字比對忽略雙寬字換行空白。
- 最新包 asar 271 支 src 與來源一致。已關閉本輪舊預覽，原資料不重建；目前使用者保留的 OpenCode 真 CLI 上下拖曳、提問與回答點選均可見對應原文字，僅一顆可輸入 xterm，PTY PID 49024 保留。Codex 分頁已由使用者移除，沒有重建。新版預覽已開啟。
- 未 commit／push。

# 2026-10-08 — 五家捲軸同步與直接定位

- [x] 使用者接受原生捲動版面；五家模式已確認，移除逐段捲動搜尋。
- [x] 滾輪／捲軸共用實際列號；點選同一次事件直接跳轉，不用虛構百分比。
- [x] 補齊舊對話辨識與清單；使用者同意在同一終端機補回保存紀錄，原 CLI 保留輸入。

## Review（原生捲動）

- 新啟動與 resume 參數回歸先紅後綠；terminal 10/10 支、程序辨識測試、Rust 14/14 通過。build:probe 與打包完成，asar 272 支 src 一致。
- 打包版 e2e-terminal-conversation-cdp 23/23（五家真滑鼠滾輪／捲軸位置一致、同步跳轉、完整長文補回、原 CLI 輸入、分割）；restart probe 6 項、JS／Rust host 真 ConPTY 與 PowerShell/cmd 指令守衛通過。
- probe-terminal-native-scroll：五家已安裝真 CLI 不帶 alt screen，參數均接受，未送 AI 提問；尚未把這項啟動煙霧測試當成五家真長對話完整驗收。
- 經使用者批准重啟並接回原 Claude／OpenCode；修掉 Claude 預設 home 錯設 CLAUDE_CONFIG_DIR 造成首次啟動畫面的問題（JS／Rust 同步，先紅後綠）。Antigravity 設定只改 altScreenMode，原檔備份 settings.json.axon-native-scroll-1791468456553.bak。
- 經使用者另行同意，保存紀錄先補到同一 xterm 上方，下方保留原 PTY。CLI 內換對話或畫面紀錄遺失時，先排隊即時輸出，再取原 PTY 快照補回；seq 去重與暫停排隊回歸先紅後綠，test-terminal-ui 14/14。CLI 硬換行定位亦先紅後綠。
- 舊包 e2e 在未重播訊息跳轉失敗；最新包 23/23 全過，最新 packaged restart probe 6 項全過。預覽改用 dist/terminal-restored-history，沿用 dist/terminal-history-qa/user-data。真實 Claude 47/47、OpenCode 2/2 選單項目同事件完成跳轉；真滑鼠驗第一個回答、滾輪同步，沒有發送 SGR 捲動指令。兩顆 xterm 仍可輸入，PTY PID 5708／48992 在更新畫面前後不變。
- 最新預覽已 showInactive 開啟；未改安裝版、未 commit／push。50000 列緩衝上限仍適用；五家未送出新的 AI 提問，真長對話逐筆點選驗的是目前兩家，另外三家以真 CLI 啟動及五家格式／ConPTY／重開整合測試涵蓋。

## 待辦

- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。

# 2026-10-08 — 修復實際 CLI 接續入口失效

- [x] 用預覽原有的 OpenCode／Codex 接續狀態重現，不預先填入對話 ID。
- [x] 從 CLI 回報的明確對話標題與正式索引辨識目前對話，重名不猜；捲軸不依賴清單才能操作。
- [x] 打包驗原始失敗入口、真拖曳與訊息點選，新預覽沿用原資料位置與原程序。

## Review（實際 CLI 接續入口）

- 根因：CLI 自己選回舊對話不會產生新 ID，原 tracker 只找新 ID；Codex 的正式命名另在 session_index.jsonl。改用同 agent／cwd 的唯一明確標題，已綁定後切對話也重新辨識；重名不猜。
- 全螢幕拖曳沿用 CLI SGR 滾輪，不因已有紀錄就換成短篇紀錄畫面；放開與後續重畫不重設位置。CLI 未回報絕對位置時，range 僅表示相對操作位置。
- `node scripts/run-tests.js terminal` 9/9、`node scripts/test-workspace-agents-full.js` 五家格式通過；最新 `dist/terminal-history-fixed` 的 `e2e-terminal-conversation-cdp.js` 22/22、`npx electron scripts/probe-terminal-mouse.js` 13/13。此前同修正的 `probe-terminal-agents-restart-cdp.js` 六項通過。asar 272 支來源一致。
- 原預覽未綁定的兩個終端機實測：OpenCode／Codex 各出現提問與回答；真滑鼠上下拖曳均改變實際 CLI 畫面，點提問／回答均在可見區讀到對應文字。原 PTY PID 49024／40524 保留，新預覽已開啟，資料仍在 terminal-history-qa/user-data。
- 本輪打包事故：舊 robocopy /MIR 清掉預覽 user-data，並沿 models junction 刪除真實本機模型。已恢復原 host 連線與兩分頁 metadata，設定從正式資料複製；原始對話檔與 CLI 程序未刪。六組已登錄模型／runtime 重新下載完成，四組 GGUF 檔案以官方 SHA256／大小驗證，runtime 必要檔案存在。無法保證預覽專屬設定逐項與事故前完全一致。
- pack-preview 加 /XJ 與排除 user-data；`node scripts/test-pack-preview-data.js` 修復前紅、修復後綠，真 robocopy 驗證 metadata 與 junction 目標保留。未 commit／push。

# 2026-10-08 — 真實終端機紀錄跳轉與捲軸回彈

- [x] 先重現全螢幕捲軸放開回到中間，改用實際可捲動紀錄。
- [x] 選單只列提示詞／最終回答，點選直接捲到終端機內；移除預覽區與獨立閱讀器。
- [x] 沿用已保存的 session id 與原始紀錄重建索引，驗切回／重啟仍可跳轉。
- [x] 打包驗五家捲軸、重複／長對話、持續輸出與分割畫面，保留運行中的 CLI。

## Review（真實紀錄跳轉與捲軸回彈）

- 舊打包版先紅：拖動全螢幕捲軸後放開會回到 50。改為依真正的 viewportY/baseY 定位；全螢幕與已清除的訊息由正式紀錄分頁載進同區域的 xterm，原 CLI 緩衝區與程序保留，回到目前輸出即可繼續使用。
- 移除獨立預覽／閱讀器／重讀按鈕；每輪提問與最終回答各自點選跳轉。索引從已保存的 session id 重建，重複文字按來源 cursor 區分。另先紅再修復舊紀錄焦點仍可把語音文字貼到隱藏 CLI 的問題。
- `node scripts/run-tests.js terminal` 9/9；最後修改另跑 `node scripts/test-terminal-conversation.js` 通過。隔離 `pack-preview.js` 產生 `dist/terminal-history-qa`，asar 272 支 src 與來源一致；該 exe 的 `e2e-terminal-conversation-cdp.js` 20/20、`probe-terminal-ime.js` 13/13。包含五家真滑鼠捲動、放開／持續輸出不回彈、重複／跨頁長文末尾、切換、無輸入送往 CLI、560／900／1440px 分割及刪除清理；展開截圖 `navigation.png` 已目視確認。
- `AXONDECK_EXE=dist/terminal-history-qa/AxonDeck.exe node scripts/probe-terminal-agents-restart-cdp.js` 六項 PASS：五家真 ConPTY（以本機假 CLI 接住，不呼叫登入 API）、關 App 再開仍保留原 PID／輸出、不重送指令，五家索引與訊息跳轉仍可還原；宿主消失後仍按原 session id 接續。`git diff --check` 通過。

# 2026-10-08 — 導覽與捲軸同欄

- [x] 右上角只留導覽按鈕，滑入展開、離開收合，移除釘選與叉叉。
- [x] 五家 AI 共用常駐捲軸，一般畫面拖曳捲動，全螢幕畫面沿用 CLI 的滾輪處理。
- [x] 打包後驗真滑鼠、五家捲動、分割畫面與原有跳轉。

## Review（導覽與捲軸同欄）

- 移除獨立輪次按鈕列、叉叉與釘選；滑鼠離開即收合，不被按鈕焦點擋住，鍵盤仍可展開／Escape 收合。右側共用 range 捲軸與導覽同欄；一般畫面讀實際 viewportY/baseY，全螢幕 SGR 畫面沿用 term-mouse 的 CLI 滾輪事件，放開回中間，不猜 CLI 內部位置。
- 新 CDP 斷言先在舊包失敗（仍有叉叉）；`node scripts/run-tests.js terminal` 9/9 支通過。沿用 pack-preview 流程產出 `dist/terminal-scrollbar-qa`，asar 271 支 src 與原始碼相同。
- `AXONDECK_EXE=dist/terminal-scrollbar-qa/AxonDeck.exe` 的 `node scripts/e2e-terminal-conversation-cdp.js` 最終 24/24：五家真拖曳上下捲動、右上角同欄、滑入／離開／點擊不釘選、全螢幕上下 SGR、提問／回答跳轉、長文、重畫、即時更新、分割窄畫面與刪除清理。截圖只保留收合後入口與捲軸；曾嘗試顯示隱藏測試窗拍展開圖，但視窗尺寸變動使截圖操作失敗，改回隔離隱藏驗收後全綠。
- 打包版 `node scripts/probe-terminal-ime.js` 13/13，`npx electron scripts/probe-terminal-mouse.js` 13/13，`git diff --check` 通過。已用獨立 dist/user-data 開啟更新後預覽（PID 42056，主視窗 AxonDeck）；未替換使用中的安裝版／win-unpacked，未 commit／push。

# 2026-10-08 — 終端機對話導覽

- [x] 沿用五家 AI 正式紀錄，依終端機 ID 驗證所有權；排除思考／工具／過程訊息並保留分頁。
- [x] 右側常駐入口，滑入展開每輪提示詞與最終回答；點擊跳到 xterm，舊畫面不可定位時讀唯讀紀錄。
- [x] 驗證重複提示詞、長文分頁、即時更新、分割／切分頁／清理與鍵盤操作。
- [x] 單元測試、打包、隔離 CDP 真滑鼠與截圖驗收。

## Review（對話導覽）

- `terminal:conversation` 只收 terminal id／cursor，main 取已綁定的 agent/session/cwd 並沿用所有權驗證與 256KB 分頁。導覽保留每段最多 1800 字預覽，全文按來源 cursor 分頁讀；不保存工具結果。Claude 看 `stop_reason=end_turn`，Codex 排除非 final channel／phase；五家都排除思考與工具。
- `term-conversation.js` 每格獨立、滑入或鍵盤展開、點擊提問／回答跳轉。xterm markers 隨捲動追蹤，定位前驗文字；重複提示詞不能唯一定位、已清除或備用畫面時，直接開該輪完整唯讀紀錄。沒有已驗證 session id 時不猜對話。
- 新測試先在舊碼紅（缺少對話解析）；`node scripts/run-tests.js` 118/118，最後定位／Claude 結束旗標調整另跑 `test-terminal-conversation` 與 `test-workspace-agents-full` 全綠。`git diff --check` 通過。
- 沿用 `pack-preview.js`，只在記憶體將 PREVIEW 改成 `dist/terminal-conversation-qa`；asar 270 支 src 與來源一致。該 exe 的 `e2e-terminal-conversation-cdp` 16/16、`probe-terminal-ime` 13/13，真滑鼠、實際 viewportY、長文末尾、即時 IPC、CLI 重畫、900／560px 分割與清理皆驗；截圖 `dist/terminal-conversation-qa/navigation.png` 已目視確認。
- 既有完整 `e2e-terminal-cdp` 65 passed／1 failed：唯一失敗是舊 nav 數量預期 10、實際 9（本次未動 nav）。貼上／圖片／語音／9000 字／背景輸出／跨專案分頁均通過。PTY 與 JS／Rust 宿主未改；使用中的安裝版與 win-unpacked 未替換；本輪未 commit／push／發版。

# 2026-10-08 — 專案側邊 Git 狀態一次看懂＋提交紀錄加到 30 筆

- [x] main `git.js`：`LOG_LIMIT = 30`（`parseLog` 上限與 `log -n` 同一個數字）；`status()` 多回 `unpushed`（有上游＝ahead，沒有上游＝`rev-list --count HEAD --not --remotes`，失敗回 0）
- [x] renderer：分支列加 `●N 未提交`／`↑N 未推送`／`↓N 待拉`／`無上游` 四顆 chip；四組標題加狀態說明（不斷 e2e 按字找的 `變更`／`最近提交`）；log 見底加「只列出最近 30 筆」
- [x] 回歸：`test-workspace.js`（上限 30、截斷、unpushed 三路）＋`test-workspace-ui.js`（新 [F4] 9 項）；新斷言先在舊碼紅過（主檔 3 FAIL、UI 檔 9 FAIL）再綠
- [x] 全套 `run-tests.js` 116/116；真 repo 實測：23 改＋1 新增分組正確、log 回 30 筆、unpushed 為 0（與遠端同步）

## Review

- 中途用 Edit 改到 `parseLog` 的 `%x1f` 分隔判斷（新字串的跳脫被吃掉變空字串，整段 log 解析全滅）。修法：含跳脫／控制字元的行一律走暫存腳本按行處理、分隔符改 `String.fromCharCode(31)` 共用 `sep`——跟 `tasks/lessons.md` 既有那條一致，以後照做。
- e2e 沒重跑（`electron:pack`＋`e2e-workspace-cdp`）：改動只加 chip／title／尾註，所有 e2e 按字找的文字與 ID 都沒動；要發版前再跑一次打包版確認。

# 2026-10-08 — Local SI 推薦模型名稱

- [x] 移除推薦模型名稱的 CPU／GPU 標籤，確認本地選單只列推薦模型。
- [x] 驗證 NVIDIA 8GB 自動判斷與模型／執行環境分離。
- [x] 使用者選擇 0.6B 換 GGUF：兩顆 ASR 共用 router，保留設定 key；真音訊驗 GPU／CPU。
- [x] 重打包並跑 Local SI CDP。
- [ ] 同步 `dist/win-unpacked`：已開啟的 `axondeck-preview` 鎖住 exe，待使用者決定是否關閉。

## Review（Local SI 推薦模型）

- `test-settings-consistency` 15/15、`test-asr-router`、`test-model-scope`、`test-hfmodels` 178/178、dictation 2/2 支、error-hygiene 85/85、temp-hygiene 與 diff --check 通過。推薦名稱檢查修前紅、修後綠。
- `probe-asr-auto.js` 來源與打包 asar 各驗 GPU／CPU：0.6B／1.7B 都正確轉出繁中並保留另一 scope 模型；CPU 是模擬沒有合格裝置，推論本身真 CPU。
- 0.6B 官方 GGUF 與 mmproj 已下載到原模型資料夾，兩份官方 SHA256 相符；舊 ONNX 未覆寫。原設定 key 保留。
- `electron:pack` asar 269 支 src 一致、打包版 `e2e-hf-cdp` 51/51；同步預覽 exe 因另一份已開啟預覽被鎖而等待，安裝版未動。
- 既有 `e2e-stt-cdp` 19/20：唯一失敗是設定分區仍預期 3 個，現況含 CLI 版本為 4 個；與本次修改無關，未改該預期。

# 2026-10-08 — 檔案頁右鍵「複製圖片」（貼進對話框）

- [x] main `explorer:copyImage`：`resolveExisting` 驗路徑＋副檔名白名單（SVG 除外）＋20MB 上限＋讀檔逾時 10 秒；`raw-fs` 讀檔、`nativeImage.createFromBuffer`→`clipboard.writeImage`；ipc／preload／main 白名單三份對齊
- [x] renderer：`explorer-dnd.js` 有 `act.copyImage` 才列「複製圖片」；`explorer-page.js` `canCopyImage`（單一本機點陣圖，壓縮檔／手機／回收筒不給）＋成功 toast 提示去對話框 Ctrl+V
- [x] 回歸 `scripts/test-explorer-copy-image.js`（14 項：成功寫剪貼簿一次＋6 種拒絕＋選單列不列＋三份清單＋呼叫點）
- [x] `run-tests.js explorer` 24/24、`test-ipc-invoke`、`test-error-hygiene`、`test-temp-hygiene` 全綠

## Review

- 對話框本來就吃剪貼簿圖片（`chat-page.js onPaste`→`addAttachments`），所以只要把圖寫進系統剪貼簿圖片格，不用改聊天頁。
- `paths.fail` 的訊息是代碼（message＝code），測試要斷 `userMessage`，斷 message 會只看到 `BAD_PATH`。

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

# 2026-10-08 — 終端機重複貼上

- [x] 追查鍵盤與右鍵貼上，新增會先失敗的重現。
- [x] 最小修正重複觸發，保留文字、圖片與連續貼上。
- [x] 跑相關回歸、打包與隔離 CDP 驗證。

## Review（重複貼上）

- 根因：xterm custom key handler 的 return false 不會取消 Chromium 原生 paste；App 非同步貼上與原生貼上各送一次。補 preventDefault，Ctrl+V／Ctrl+Shift+V／Alt+V 忽略 repeat；再次按鍵仍能貼上相同內容。未改 PTY 傳送與 JS／Rust 宿主。
- 修復前 test-terminal-ui 新斷言失敗；舊包真按鍵加一次 repeat 送出 4 份文字。修復後 `node scripts/run-tests.js terminal` 8/8 支、`node scripts/test-terminal-ui.js` 13/13、指定檔案 `git diff --check` 通過。
- 使用既有 pack-preview 流程，只在記憶體把 PREVIEW 改為 dist/terminal-paste-qa，保留正在使用的 win-unpacked；asar 269 支 src 比對通過，另驗 terminal-page.js 與 source 完全一致。
- `AXONDECK_EXE=dist/terminal-paste-qa/AxonDeck.exe` 跑 e2e-terminal-cdp：真按鍵、repeat、再次貼同樣內容、真右鍵、文字／圖片／直接語音插入皆通過。完整首輪 64 passed／2 failed：nav 既有預期 10、實際 9；9000 字斷言誤抓舊畫面數字，補本測試畫面清理。
- 最後以 Node Module 執行同支 CDP 的建立／貼上／9000 字區段，保留 finally 清理，33 passed／1 failed；唯一失敗是無關的 nav 數量。7 條新增真操作斷言與 9000 字皆通過。使用者同時複製文字曾干擾重跑，新增測試固定本實例 service.clipboardText，原生 paste 仍讀真正系統剪貼簿，收尾還原。
- 測試自己的程序已收掉。未替換現行安裝版／正在執行的預覽版，未 commit／push／發版。
# 2026-10-10 — 專案 AI 紀錄緊湊排版

- [x] 確認分頁、工具片段與完整文字的資料流。
- [x] 合併概況／工具統計／翻頁為置頂區塊，連續工具紀錄可展開。
- [x] 驗證分組與即時更新、工作區回歸、打包版全文與置頂／展開操作。

## Review（AI 紀錄排版）

- 文字依原順序完整顯示；連續工具片段合併，保留換行與接續標記。同頁更新保留概況／工具區的展開狀態，工具內容變動會重畫；換頁重新收合。
- `node scripts/test-ai-session-live.js` 通過；`node scripts/test-workspace-ui.js` 192/192；`node scripts/test-temp-hygiene.js` 通過。新增分組測試修改前先失敗。
- `npm run electron:pack` 成功，275 支 src 的 asar 內容一致，更新 dist/win-unpacked。`node scripts/probe-workspace-agents-cdp.js`：五家全文 SHA-256 一致（Claude 8 頁、其餘各 5 頁），真滑鼠前後翻頁／滾輪置頂／展開、鍵盤收合、深淺主題 320–1000px 無橫向溢出、同頁追加保留展開、換頁重收合與專案隔離通過；expanded.png 已目視確認。
- `node scripts/run-tests.js workspace` 8/10 支通過；既有 test-workspace-state 的檔案樹通知失敗，以及 test-workspace 的三項舊契約失敗（Codex 指令少算 --no-alt-screen、detail caller 預期 3 處而實際 4 處）。涉及的四份來源與 HEAD 一致，未擴大修改。
- 未新增依賴、未修改安裝版／真實使用者資料，未 commit／push／發版。

# 2026-10-10 — AI 紀錄完整單頁與合併工具列

- [x] 自動接起全部紀錄，移除使用者翻頁；末段增量更新、保留捲動與展開。
- [x] 標題／接續／複製路徑併入置頂概況；資訊靠左緊排。
- [x] 驗證跨段全文／工具統計／更新／取消，隔離打包與真 UI 操作。

## Review（完整單頁）

- IPC 保留每段上限，renderer 自動逐批接完，不設全文段數上限；更新只取代末段。統計累計全文，檔案若後來改過，就從只讀清單移除。移除翻頁 UI／caller／舊讀取計畫；CONTEXT.md 同步說明。
- 標題／接續／複製路徑搬入同一塊置頂區域，來源／時間放進概況；摘要直接顯示提問與工具總數，欄位／工具統計靠左緊排。換對話重收合，同對話更新保留展開與閱讀位置，停在末尾才跟著新內容。
- `node scripts/test-ai-session-live.js` 通過：先紅再綠，含 45 段自動接完、末段不重複、取消、壞游標、全文統計與閱讀位置。`test-workspace-ui.js` 192/192、`test-temp-hygiene.js` 與語法／diff 檢查通過。
- 使用既有 pack-preview 流程，僅在記憶體改預覽目的地為 dist/ai-session-preview，275 支 src 的 asar 內容一致。該 exe 的 `probe-workspace-agents-cdp.js` 五家單頁全文 SHA-256 一致（Claude 166 個片段、其餘各 18 個片段）；無上下頁、320–1000px／深淺主題、置頂／按鈕／展開／鍵盤／更新／隔離全部通過。overview-expanded.png、expanded.png 已目視確認。
- 全工作區仍 8/10 支通過：既有 test-workspace-state 的檔案樹通知失敗、test-workspace 的兩項 Codex 接續指令舊預期失敗（289/2）；移除翻頁 caller 後，原 detail caller 數量檢查恢復通過。
- 另開使用 axondeck-ai-session-preview 獨立資料的新版預覽（PID 23104），已顯示使用者截圖中的真 Codex 紀錄，19 個文字片段、載入完成／無錯誤／工具列合併均確認；原預覽與安裝版保留。未新增依賴、未 commit／push／發版。

# 2026-10-10 — AI 紀錄長標題與搜尋

- [x] 長標題使用短摘要，完整標題可展開；操作按鈕另排一列。
- [x] Ctrl+F 搜尋目前紀錄，標示命中、前後跳轉、展開工具內容，保留即時更新。
- [x] 驗證搜尋／長標題，打包版真鍵盤與滑鼠驗收，開啟新版預覽。

## Review（長標題與搜尋）

- 長標題以 40 字摘要呈現，原生 details 可展開完整文字；按鈕另排一列。同一份紀錄更新保留標題展開與搜尋焦點，切換紀錄清除搜尋並回到開頭。
- 搜尋對話文字、工具名稱與工具全文；大小寫不敏感，符號照原文查找。Enter／F3 下一筆、Shift+Enter／Shift+F3 上一筆，循環跳轉、命中工具自動展開，Esc 關閉。使用 CSS Highlight 標示目前命中，不改動對話原文。
- `test-ai-session-find.js` 先紅再綠；`test-ai-session-live.js`、`test-temp-hygiene.js`、語法／diff 檢查通過；`test-workspace-ui.js` 192/192。
- 沿用 pack-preview 流程更新 dist/ai-session-find-preview，276 支 src 與 asar 一致。該 exe 的 `probe-workspace-agents-cdp.js` 通過五家全文 SHA-256、超過第一段的末尾搜尋、真鍵盤／滑鼠搜尋、跳轉／展開／焦點／更新／無結果／關閉、深淺主題 320–1000px 與長標題完整展開。新增換紀錄檢查先重現捲動位置沿用，再修復並完整通過。
- search.png 已目視確認；獨立 profile axondeck-ai-session-find-preview，原預覽與安裝版保留。未修改正式安裝版，未新增依賴，未 commit／push／發版；本輪未重跑全工作區套件。

# 2026-10-10 — 右側 AI 紀錄複製路徑

- [x] 每筆紀錄在接續旁加入「複製」，沿用已驗證的紀錄路徑與剪貼簿 IPC。
- [x] 驗證按鈕不開啟對話、五家路徑正確、窄側欄無重疊。
- [x] 打包、更新隔離預覽，記錄結果。

## Review（側欄複製）

- 每筆紀錄的接續／複製並排，複製取 main 已確認專案歸屬的紀錄路徑，再走既有 clipboardWrite IPC；換專案後忽略晚到的讀取，不開啟對話。標頭預留按鈕位置，標題保留整行寬度。
- `test-workspace-ui.js` 192/192、`test-temp-hygiene.js`、兩支語法與 diff 檢查通過。`npm run electron:pack` 完成，276 支 src 與 asar 一致，更新 dist/win-unpacked。
- `probe-workspace-agents-cdp.js` 新檢查先在原打包版失敗（0/5 複製按鈕），修改後五家真格式／真滑鼠／真 IPC 的路徑、不開對話與 260／320px 無重疊全部通過；既有全文／搜尋／置頂／更新／隔離檢查亦通過。剪貼簿最末端使用攔截並還原的 service，保留使用者系統剪貼簿；sidebar-copy.png 已目視確認。
- 使用既有 axondeck-ai-session-find-preview 隔離 profile 開啟新版；正式安裝版與使用者資料保留，未新增 IPC／依賴，未 commit／push／發版。本輪未重跑完整工作區套件。

# 2026-10-10 — v1.43.0 正式發行

- [x] 確認 master／遠端／版本與變更範圍；更新版本及發行說明。
- [x] 全部單元回歸、必要原生建置與打包版實際驗收。
- [x] 正式 NSIS 建置、拆包確認更新設定與檔案完整性。
- [x] 提交、tag、推送與 GitHub Release；核對遠端三件套與更新入口。

## Review（v1.43.0 發行前）

- 版本 1.43.0，master 與 origin 同在 `0ca83b9`，tag 仍停在 v1.42.0。終端機換頁／換專案保留捲動位置，舊測試改成這個預期；不把捲軸拉回最底，對話跳轉才留得住。
- `node scripts/run-tests.js` 126/126。`npm run electron:pack` asar 276 支 src 與原始碼相同。`node scripts/e2e-terminal-cdp.js` 67/67。
- `npm run electron:build` 通過：安裝檔、blockmap、latest.yml 與 app-update.yml 一致。GitHub Release v1.43.0 已公開，三件套大小與本機相同。

# 文字轉語音 / Breeze-TTS-2 Q8（2026-10-10）

- [x] 確認官方與 Q8 執行環境能力、API 與授權。
- [x] Local SI 推薦與專用執行環境：下載、校驗、依賴與移除。
- [x] 新增文字轉語音頁，接聲音設計、克隆、指導、保存聲音與實驗性變聲。
- [x] 後端輸入驗證、取消、串流、播放及 WAV 匯出。
- [x] 真 Q8 推論、受影響測試與隔離打包版 CDP 驗收，更新交接文件。

## Review（文字轉語音）

- 上方新增文字轉語音頁；四種模式：聲音設計、語音克隆、語氣指導、實驗性變聲。支援中英文字、發聲標記、所有對應取樣參數、收藏／移除聲音、取消與 WAV 匯出。前三種邊生成邊播，變聲等整段完成再播放。
- Local SI 推薦 Q8_0 模型，下載自動處理獨立 v0.1.0 runtime，兩者校驗固定 SHA-256；不混入 llama router／ASR／翻譯選單。自動 NVIDIA ≥8GB + Vulkan，否則 CPU。模型首次生成才載入，移除模型先停止自己的 server，聲音收藏保留。
- `test-breeze-models.js` 新檢查先紅再綠；`test-breeze-tts.js`、`test-hf-recommend-download.js`、`test-hfmodels-download-errors.js`、`test-hfmodels-install.js` 通過；`test-hfmodels.js` 178/0、`test-error-hygiene.js` 85/0、`test-ipc-invoke.js` 11/0、`test-settings-consistency.js` 15/0、`test-temp-hygiene.js` 與語法／diff 檢查通過。
- `npx electron scripts/probe-breeze-tts.js` 真 Q8 四種模式、聲音收藏重啟後重用、取消後再生成全部通過；輸出為 24kHz 非靜音 WAV。`npm run electron:pack` 通過，284 支 src 與 asar 完全一致，更新 dist/win-unpacked。
- `BREEZE_QA_CACHE=D:\axondeck-breeze-qa-cache node scripts/e2e-speech-cdp.js` 43/43，含真正打包版設計／收藏聲音克隆、播放排程、匯出；Vulkan 設計 5.02 秒生成 3.7 秒音訊，克隆 1.42 秒生成 2.2 秒音訊。1440／1000／760px 深淺主題皆無溢出，截圖已目視確認；只使用隔離 userData，未修改安裝版或使用者資料，自己的 server 已結束。
- `node scripts/e2e-hf-cdp.js` 51/51；修正測試過早點擊尚未載入的頁面。`node scripts/e2e-cdp-smoke.js` 19/22：新導航及五顆推薦模型通過；既有三項翻譯預期仍按 600 字分段／1908 字必須多段，實作既有上限為 2000 字且翻譯成功。此輪 translate-page.js 僅檔頭註解改名，未擴大修改既有失敗。
- Grok 中途將 29 檔推到 master `e5e1900`；本輪保留該提交，補齊本機驗收腳本與紀錄，未再次 commit／push／發版。未做人工聽感或克隆相似度評分，未跑真 CPU 推論；變聲是上游實驗功能，官方模型與本機輸出限研究及非商用。

# 2026-10-10 — 清理舊打包與測試資料

- [x] 核對刪除範圍、使用中程序與連結；保護正式資料及唯一模型。
- [x] 清除舊打包、下載包、測試快取與重複 runtime；保留紀錄與目前預覽。
- [x] 比對清理前後占用、保護檔案及預覽狀態，記錄結果。

## Review（清理）

- 使用者明確要求清理後，以 `scripts/lib/test-temp.js` 的 `removeTree` 清除 435 個已核對目標，無失敗；扣除硬連結後檔案量減少 45,889,321,144 bytes（42.74 GiB）。`dist` 從 41.81 降至 2.17 GiB，18 份打包副本剩目前 `win-unpacked` 一份；保留 v1.43.0 安裝檔、blockmap、latest.yml、尚未確認可丟棄的來源 patch，以及各舊 profile 的設定／紀錄。
- Breeze QA 目錄刪除根層模型硬連結、重複 runtime、ZIP、音訊輸出及截圖，只留目前 preview-user-data（3.67 GiB）。正式／預覽 llama CUDA 全部 55 檔 SHA-256 一致後，將預覽副本改為 junction 到正式模型，無再次下載。
- 正式六個 GGUF、唯一 Breeze Q8、目前預覽 exe／asar 共九檔清理前後 SHA-256 一致。正式 App PID 27356、目前預覽 PID 36308 與三個仍運行的舊終端機 host／子程序均保留；舊 profile 中的聊天、錄音、收藏聲音與終端機資料不視為快取。
- `node scripts/test-safe-rm.js` 6/6；清理後真預覽 preload／IPC 確認 Breeze 模型、Breeze runtime 與共用 llama CUDA 已安裝，頁面 ready。未重跑語音推論，未 commit／push／發版。

# 2026-10-10 — 預覽接回正式資料

- [x] 將唯一 Breeze 模型及 runtime 校驗後移入正式模型資料夾。
- [x] 沿用既有 dev-sandbox，複製正式設定／專案／聊天並共用正式模型，重開打包預覽。
- [x] 驗證五顆推薦模型、設定隔離、視窗顯示；清除本輪舊 QA profile。

## Review（預覽資料來源）

- Breeze Q8 與 runtime 共 35 檔從 D 槽 QA profile 移入 `%APPDATA%/voiceink/models`，逐檔 SHA-256 比對後才移除來源；Q8 雜湊同固定 registry，無重新下載、無模型副本。
- `node scripts/dev-sandbox.js --packed --with-chats --no-launch` 沿用既有 `%APPDATA%/axondeck-dev`，複製正式設定／專案／聊天，models／hf-models junction 共用 `%APPDATA%/voiceink`；關掉會影響正式 App 的 AGY、語音輸入、感測器及 UFFS。正式 PID 27356 保留。
- 打包預覽 PID 9808 顯示在主螢幕前景，真 main／preload／UI 確認模型根目錄 realpath 指回正式資料，五顆推薦模型均顯示已下載，Breeze runtime 與 llama CUDA 完整。設定選擇沿用正式值，設定檔 realpath 不指向正式檔。
- 本輪 D:/axondeck-breeze-qa-cache 已清除；目前只有正式模型實體與既有沙箱連結。未重跑語音推論，未修改 production 程式碼，未 commit／push／發版。

# 2026-10-10 — Local SI 執行環境排版

- [x] 平行檢查版面與 layout detector，量打包版狀態散落／按鈕折行。
- [x] 固定執行環境狀態／操作欄，調整 Token 與窄畫面排列。
- [x] 打包、量深淺主題與不同寬度，重開沿用正式資料的預覽。

## Review（執行環境排版）

- 執行環境改成文字／狀態／操作三欄，狀態與按鈕固定對齊；Token 另列並讓輸入框隨剩餘空間伸縮，儲存／移除保持單行。640px 以下文字與操作分列。
- 平行版面審查與 layout detector 通過（無命中）；`git diff --check` 通過。`npm run electron:pack` 成功，asar 284 支來源檔逐一比對通過。
- 真打包版 CDP 檢查深／淺主題各 1200、1000、900、640px，共 8 組通過：狀態對齊、按鈕不折行、列無溢出、Token 可輸入；已檢視截圖並清除截圖檔。
- 新預覽 PID 30084 已顯示並聚焦，沿用 axondeck-dev；模型 realpath 為正式 voiceink/models，未新增模型副本。本次只調整排版，未重跑模型推論，未 commit／push。

# 2026-10-10 — 語音標記完整分組

- [x] 查官方與量化版標記文件，平行檢查版面與 detector。
- [x] 補齊文件列出的標記，同類中英文相鄰，延伸語氣獨立一列。
- [x] 驗證標記插入、模式收合、深淺主題及窄畫面，打包重開正確預覽。

## Review（語音標記分組）

- 官方四類中英共八個標記，加上 HoppouAI 文件列出的 whispering／gasp／nervous chuckle，共 11 個；每類中英相鄰，延伸語氣獨立並註明效果依台詞而異。模型接受開放描述，提示可直接輸入其他標記。
- 版面審查與 detector 以兩個隔離子代理平行執行；只修標記區間距與層級。標題及類別清楚分層，類別 16/24px、按鈕 8px 間距，44px 點擊高度；自動轉單欄，沒有新增卡片或依賴。
- 新回歸先在舊打包版確認缺標記失敗；切換模式覆蓋提示也先紅後修。`node scripts/e2e-speech-cdp.js` 最終 63/63：11 種插入／取代選取與字數、模式收合與提示、既有 IPC 流程、四種宽度深淺主題皆通過。UI fixture 不代表語音效果實測。
- `npm run electron:pack` 成功，asar 284 支來源檔比對通過；`git diff --check` 與最終 layout detector 通過（[]）。已檢視真打包版截圖並清除檔案。
- 預覽 PID 32924 已顯示並聚焦文字轉語音頁，沿用 axondeck-dev，模型 realpath 指向正式 voiceink/models。未新增模型副本、未重跑模型推論、未 commit／push。

# 2026-10-10 — 語音標記中英配對與緊湊排列

- [x] 查量化版 webui，確認另外列出 yawn／whispers，釐清開放描述詞彙。
- [x] 九類全部中英配對，刪除重複標題、語言前綴與額外提示，緊湊成對換行。
- [x] 驗證插入、窄畫面与深淺主題，打包並重開預覽。

## Review（紧湊中英配對）

- 量化版 webui/index.html 的 footer 另列 (yawn)／(whispers)，加上原有七類共九組；延伸類補中文描述，18 個按鈕皆有獨立 data-event。中文延伸描述屬開放詞彙，並非官方固定清單或已保證的聲音效果。
- ui-craft → impeccable quieter：刪掉畫面標題、分類名、語言前綴與重複提示，保留 aria-label 與延伸標記 tooltip；flex-wrap 只換整組，8/12px 間距，每組中英以 1px 分隔。真預覽 1200px 約兩列、99px 高。
- 新中英配對回歸先在舊版失敗；`node scripts/e2e-speech-cdp.js` 最終 78/78，含18種插入／選取替換、四種寬度深淺主題、不溢出與配對不拆行、模式與既有 IPC 流程。未逐一推論中文延伸聲音。
- `npm run electron:pack` 成功，asar 284 支來源檔比對通過；layout detector []、git diff --check 通過。已檢視截圖並清除檔案。
- 預覽 PID 38044 已顯示聚焦文字轉語音，沿用 axondeck-dev 並共用正式 voiceink/models；未新增模型副本，未 commit／push。

# 2026-10-10 — 四種語音模式操作排版

- [x] 清楚呈現四模式用途、選取狀態與鍵盤切換。
- [x] 調整錄音／聲音／語氣的輸入順序，變聲只顯示適用設定。
- [x] 打包驗證四模式及深淺主題、窄視窗，重開正確資料預覽。
- [x] 模式列改窄（內距／字級／間距收緊）。
- [x] 生成上限預設改 30000。
- [x] 參考音逐字稿自動辨識填入，失敗退回手動。

## Review（四種語音模式操作排版）

- 四顆模式改四欄卡片（標題＋一句用途），選中底色區分；鍵盤 Home／End／方向鍵切換只留一格 Tab 停駐，`aria-selected`、`aria-labelledby` 與生成按鈕文字（變聲顯示「開始變聲」）同步。變聲把原錄音選取放最前、逐字稿標選填，參考聲音標籤改「換成誰的聲音」；不適用的取樣欄位整列收合。
- `node scripts/e2e-speech-cdp.js` 117/117：沿用上一輪打包版（產品碼 pack 後未再動，只改測試檔），新斷言（順序、鍵盤同步、進階欄位收合、四模式×五寬度×深淺主題）全過即證明 dist 與原始碼同步。UI fixture，不代表語音效果實測。
- `node scripts/run-tests.js breeze` 2/2、`hfmodels` 3/3；`node scripts/e2e-hf-cdp.js` 51/51；`node scripts/e2e-cdp-smoke.js` 19/22，三項 FAIL 皆為既有翻譯分段預期（600 字分段／1908 字多段），本輪未動翻譯邏輯，不擴大修改。`git diff --check` 通過。未 commit／push。

# 2026-10-10 — 模式列改窄＋上限預設＋逐字稿自動辨識

## Review（改窄與自動辨識）

- 模式列收窄：卡片內距 12/16→8/12px、間距 5→2px、標題 15→14px、列下距 24→16px；窄版內距同步收緊。e2e 原有高度下限（≥44px）仍通過。
- 生成上限預設 2048→30000（上限本來就是 30000，只改預設值一行）。
- 選參考音後，前 120 秒轉 16k 單聲道，用檔案轉錄同一顆 ASR 自動辨識逐字稿並填入，可再改；模型沒下載、格式不支援、失敗或逾時（180 秒）都退回手動填寫，後端缺稿錯誤訊息同步改白話。上游 server 有參考音就一定要逐字稿，所以不是拿掉欄位，而是自動補上。
- `test-breeze-tts.js` 先紅（多選一次清掉舊暫存，後面用舊 id 全滅）後綠：補 asr-select 替身，斷言逐字稿帶入、變聲原錄音不辨識、16k 轉換、簡轉繁、失敗退回、缺稿訊息。`node scripts/e2e-speech-cdp.js` 118/118（含新增自動填入斷言）。`npm run electron:pack` asar 284 支一致並同步 dist；`git diff --check` 通過。未 commit／push。新增 `probe-breeze-transcript.js`：真 Q8 生成 6.8 秒出 3.7 秒音訊，真 ASR 3.5 秒辨出逐字稿並轉繁體，PASS；只讀正式模型、暫存 userData、隨機埠，不影響使用中的 App。預覽已重開（PID 13364，dist 打包版＋axondeck-dev）。
