# tasks/todo.md — 進行中與待辦

> 非簡單任務先在這裡列可勾選計畫，完成後補 Review。只留最近幾輪；更早的紀錄查 git log（`git log -- tasks/todo.md`）。

## 待辦

- [ ] 打包版實際登入一次 Grok（目前只驗到通過 Cloudflare、進到首頁）。

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
