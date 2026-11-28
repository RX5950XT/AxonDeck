# AxonDeck todo
最後更新：2026-11-27

> 交接、現況、待辦都在本檔（嚴格 ≤100 行）；規則與地雷見 [AGENTS.md](../AGENTS.md)，判斷原則見 [lessons.md](./lessons.md)，功能說明見 README。壓縮前的完整歷史：`git log -- CONTEXT.md tasks/todo.md`。

## 現況（交接）

- AxonDeck（v1.40 前叫 VoiceInk）：Windows Electron AI 工作台，Vanilla JS＋Vite，Electron 43.7.5；目前 v1.87.0（2026-11-28）。資料在 `%APPDATA%/axondeck/`（舊安裝沿用 `voiceink`）。
- 九頁 `data-page`：`chat`（SI：Agent／Chat／Browser，主區 `setChatPaneMode('chat'|'workspace'|'web'|'browser'|'telegram'|'tools')`）、`explorer`、`stt`、`translate`、`speech`、`imagegen`（iframe Miroxen）、`sysmon`、`hfmodels`（Local SI）、`settings`。導覽順序 localStorage `navOrder`，圖示 `ws-tool-icons.js`。SI 版面由 `si-layout.js` 管：標題列兩顆收合左右側欄（localStorage），專案模式額度條搬進 `#termMain` 底、四顆入口 `#quotaDock` 搬到右側欄底（右欄收起／≤900px 回條上），抽屜高度由 `fitDrawer` 量成蓋滿上方那塊。原 CC Proxy 頁已拆：供應商／用量統計是額度條抽屜、MCP／Skills 是 `tools` 主畫面、AGY 與 CLI 版本在設定頁，邏輯仍在 `ccswitch-page.js`。
- GPU 可重建圖片快取預設 64 MiB（`main.js` 的 `force-gpu-mem-discardable-limit-mb`，啟動參數可覆寫）；未做長時重度媒體回歸。

### 跨模組架構
- 每頁一個 WebContentsView（`page-windows.js`），主視窗外殼是 `index.html?host=1`；`app.js` 先 import `page-content.js` 移除非本頁 `.page`，外置對話框用 `data-page-content`。maximize／restore 要重設 view 尺寸；外殼標題列不設拖曳區。
- 預載：第一頁好了 8 秒後依序載最近 7 天用過的頁（config `pageUse`）；量切頁用 `probe-page-switch.js`。
- 跨頁動作一律 `openInFilesPage`／`openUrlInApp`／`switchPage`；main 推送用 `sendToPages` 廣播給每個 `index.html`。滑鼠側鍵 `nav-history.js`＋main `pages.history`（回歸 `e2e-side-nav-cdp.js`）。
- 子程序（git、worktree、procs-json）走 utilityProcess `proc-broker.js`；IPC 外殼 `ipc-invoke.js`（`{ ok, data|error }`），`lint-ipc.js` 擋三清單對不上。
- CDP 測試三坑：切頁獨立一個 eval（`scripts/lib/page-cdp.js`）；模擬推送要廣播每個 `index.html`；`--hidden` 視窗不畫，量測先 `showInactive()`。
- 設定頁雲端分區把整份 `providerDraft` 寫回 `cloudProviders`：頁面 hidden 時有未存修改要立刻存，否則舊草稿蓋掉別頁寫入。
- 共用小工具（新寫的別再抄一份）：獨立 electron-store 檔用 `serial-store.js`（懶載入＋排隊寫）；帶 `code`／`userMessage` 的錯誤用 `user-error.js` 的 `fail`；PowerShell 路徑與單引號跳脫用 `powershell.js`；本機反代的鑑權／啟停／SSE／自我測試在 `local-proxy-http.js`（`createProxyServer` 路由表）；AGY／Grok 設定頁骨架是 renderer `proxy-page.js`。

### 模組地圖（`src/main/` 除非註明）
- 聊天／網頁 AI／瀏覽器：`chat*.js`、`ai-web.js`（`SITES`／`CHAT_PATHS`）、`grok-clearance.js`、`browser-*.js`、`crx-*.js`、`web-context-menu.js`；renderer `chat-*.js`、`ai-web-page.js`、`browser-page.js`、`webview-warm.js`。
- 工作區與終端機：`workspace/`（files `resolveIn`、git、agents、agent-context、worktree、media `vi-media://`、office-convert）、`terminal/`（service 門面→獨立宿主／Rust `axondeck-term`）。
- 檔案頁：`explorer/`（fs、recycle、uffs、zip、mtp、dir-sizes、media-thumbs、shell sidecar）；編輯器 `editor-window.js`／`big-text.js`；原生播放器 `native/axondeck-probe/src/bin/axondeck-media/`。
- 額度與供應商：`usage/`（七家額度、claude-accounts、quota-watch／alerts／warmup）、`codeusage/`（Rust `usage-scan`、parsers、pricing `RULES_VERSION = 16`）、`ccswitch/`（providers、mcp、toml-edit、gateway）、`agy/`（設定頁「反向代理」，埠 8788；`server.js` 依模型名分流，`grok-*` 交給 `grokproxy/server.js` 的處理函式，日誌兩家各一份由 `merged-logs.js` 合併顯示）。
- 本地推論：`hfmodels/`（hub、gguf、fit、download、presets、runtime router、archs）、`models.js`（固定版本＋SHA-256）、`local-llm-router.js`、`asr-select`。
- 翻譯：`glossary.js`、`screen-translate/`、`pdf-translate/`（worker.py 隔離 Python）；語音：`breeze-tts/`、`cloud-tts/`、`dictation/`、`file-transcribe`、`live-pipeline.js`（renderer）。
- 其他：`miroxen/`、`sysmon/`（Rust 取樣器＋LHM 提權 sidecar）、`screentime/`、`app-installer/`、`updater.js`。原生：`native/axondeck-probe`（Rust）、`explorer-shell`／`sysmon-sensors`（.NET）、`dictation-hook`。

### 各模組重點決策（細節查 git log 與 AGENTS 地雷）
- 網頁版 AI：分區 `persist:ai-<site>`，`setupSession` 偽裝 Chrome；Grok 借 Edge／Chrome 拿 `cf_clearance`，其他看到 challenge 改回原 UA 重載。閒置 1 小時釋放 webview（有草稿／生成中／上翻／出聲不收）；`pollAiWebStatus` 抓停止鈕；`installRenderBoost` 先量高度再加 `content-visibility`。
- 內建瀏覽器：最近 2 顆 `.webview-warm` 透明疊放（display:none 丟圖塊），背景 1 小時 `sleepIdle`。擴充功能只限 `persist:wsbrowser`，商店頁自補 `webstorePrivate`／`management`（要定義成不可改）；擴充快速鍵 `crx-commands.js`、網頁與外殼快捷鍵 `browser-shortcuts.js`（含頁內尋找／縮放）；管理頁 `axon-extensions://`（「我的擴充功能」與「鍵盤快速鍵」獨立兩頁）。
- 工作區：檔案樹與檔案頁共用剪貼簿（`pasteAny` 比系統剪貼簿簽章），拖曳走 `explorer.startDrag`。AI 記錄五家（OpenCode 2 讀 `session_v2`，用量兩表合讀）。終端機 PTY 在獨立宿主，重開只斷線；WebGL 最多 8 個，不可切走就 dispose。
- 編輯器：一檔一窗、存檔帶 mtime、暫存檔再 rename；>256MB 唯讀分段；HTML 預覽走不開 CORS 的 `vi-preview://`；改 `editor-formats.json` 要重編 `axondeck-media.exe` 並升 marker（現在 '4'）。
- 檔案頁：>300 項改 Rust `list-dir`；縮圖 mpv／magick＋`thumb-cache`（512 MB）；預設關聯寫 UserChoice＋Latest Hash，備份在 `association-backups/`。
- 額度／用量：quota-watch 5 分鐘 tick、30 分鐘同步；記憶體一律算獨占量。用量游標記 `contrib`、刪檔進 `archive`；三份 SQLite 來源走 worker（`readAllInWorker`，AGY CLI 對話檔 27GB 在主程序讀會凍住 App）；Grok 子代理預設跳過（`resolveSubagents`），Claude resume／fork 跨檔去重。AGY：歷史工具呼叫附 `thoughtSignature`；生圖不可帶 `maxOutputTokens`；`USER_AGENT` 須報 `antigravity/cli/x.y.z`。Gemini 池（Neon／Carbon／Argon／Hydrogen／3.8 Flash，2026-11-24 起 Argon 不再獨立）與 Claude 池各有 5h＋週兩道，額度說明照抄上游 group description（介面不出現 GPT：池名寫 Claude、GPT-OSS 從說明濾掉）；隱藏 3.1-flash-lite／3-flash／2.5-flash 整條線（`isHiddenModel`）；Argon／3.8 Flash／GPT-OSS 上游預告 11/30 下架；單模型 quotaInfo 是「卡住它的那道」，靠重置時間分 5h／週；prod 端點是另一組舊額度，以 sandbox／daily 為準；連線測試用 hydrogen-low。 Grok（同一個反代端點）：上游 `cli-chat-proxy.grok.com` 只收 Responses 串流（chat/completions 403），Chat／Anthropic 本機轉換；憑證讀 `~/.grok/auth.json`；`<模型>-<強度>` 別名對 `reasoning.effort`；402＝週額度用完；日誌 `grok-proxy-logs.db`（`agy/logs.js` 的 `createLogStore`）；測試 `test-grok-proxy.js`。
- Local SI：llama.cpp 固定 b11913＋Unlimited-OCR-2 疊加包（HF `RX5950XT/Unlimited-OCR-2-GGUF` 的 `llama.cpp-bin/`）；推論一律 llama-server router；NVIDIA ≥8184 MiB 用 GPU；`archs.js` 升 llama 要重抄；`MOE_ARCHS` 新架構要補。
- 翻譯：PDF worker 逐頁 PP-DocLayoutV3→翻譯→替換；OCR 只能單序列（`parallel = 1`、`special = on`）；掃描擦字用蓋色矩形；`pdfruntime` 固定 Python 3.12.12／Paddle 3.3.1／PyMuPDF 1.28.2，`--require-hashes`。`node-edge-tts` 固定 1.2.11。
- 文字轉語音：Breeze 只聽 loopback 隨機埠、不進 router；每句過 `audio-clean.js`（runaway 換種子重做 ≤2 次）；串流 `speech-stream.js`；版本最多 50。
- 語音轉文字：即時字幕每次重辨識整句、停頓定稿；值格式 `local:<key>`／`cloud:<設定 id>:<模型 id>`。
- 系統監控：取樣器看著時 2 秒、沒人看 30 秒；處理程序分應用程式／背景（`apps.rs`），記憶體欄＝私有工作集。
- Telegram：住在 SI 主區，排隊載（`loadInTurn`）、卡住 60 秒重載、閒置 1 小時第一格以外導 about:blank。webview 滑鼠按下時 main 補 `host.focus()+guest.focus()`：點訊息文字不會換焦點格、視窗回前景 Electron 把焦點給外殼，Ctrl+C／`role:'copy'` 會打錯格。
- 更新／發版：`electron:build` 走 `pack-preview.js --release`（lint→磁碟根 NSIS→驗 asar／`app-update.yml`／latest.yml→同步回 dist）；步驟見 AGENTS「發行流程」。

## 待辦

### 需要真帳號或真硬體才驗得了
- [ ] Claude 官方訂閱多帳號：「登入新帳號」與切換未用第二個真帳號走過。
- [ ] 打包版實際登入一次 Grok；DeepSeek、Meta AI 真實登入與停止鈕標籤。
- [ ] 真 MTP 手機裝置；SATA SMART access=0（重編 probe＋SATA 碟＋管理員）；網路欄提權 sidecar 真實吞吐。
- [ ] LibreOffice 轉 PDF 實機驗（這台只有 MS Office）。
- [ ] 真 Breeze 模型邊生成邊播放聽感；即時字幕在真翻譯模型下的中途翻譯。
- [ ] Telegram 真的最小化再還原、使用者自己的群組聊天室。

### 需要取捨
- [ ] 感測器交接檔沒 ACL（同帳號程序可導到假管道）；`Oc.Reset` 忽略 SMU 回傳值。
- [ ] Monaco 首載競態。
- [ ] 網頁版 AI 會記住同站非對話頁。
- [ ] 久未使用功能頁回收 renderer、擴充功能延後到第一次開瀏覽器才載；Browser 模式側欄 0.16s 寬度動畫未拿掉。

### 依賴
- [ ] `concurrently`→9.2.5／`shell-quote`→1.11.0（critical，只影響 `electron:dev`；發佈滿兩週再升）。
- [ ] monaco-editor 0.55→0.57（含 dompurify XSS 修正，需驗工作區編輯器）。
- [ ] electron-builder 傳遞相依（只影響建置期）。

### 既有失敗／未確認
- [ ] 終端機「突然全空白」未重現，根因未確認。
- [ ] 用量整份重讀會少算 Antigravity（實測 39622→38015 次）：v1.85.4 前 `agy-logs.db` 自動刪 30 天前的列（已拿掉，AGY／Grok 反代日誌改永久保留、只剩手動清空），10/27 以前那段已刪，`keepOrphans` 只補整小時沒新資料的格，跟 CLI 同小時就補不回。
- [ ] `probe-asr-key-cdp.js`（改走 `followMainPage`）、`probe-explorer-icon-fallback-cdp.js`（改用 `.reg` 當系統圖示）已照新架構改，未在打包版實跑。

## 已知問題／刻意不處理

- 使用者決定維持：不全面拿掉毛玻璃、Telegram 不共用程序、不改 Tauri、CDP 腳本不全面改 Playwright。
- 不做：PDF 中文避頭尾（MuPDF 已照 UAX#14）、換較小 PP-DocLayout（漏公式／誤判標題）、`edge-tts` 試聽打斷朗讀（設計如此）、Edge cookie 匯入（app-bound 加密）。
- 驗證覆蓋：轉換閘道只有 Codex 對真上游驗過；HF 大模型、CUDA 執行環境未實裝驗；Grok／Claude Google 登入只驗到登入頁。
- 限制：原生媒體不支援 DRM／MIDI、CUE 不分軌；PDF 翻譯複雜排版仍需人核對；終端機緩衝 50000 列、Grok 無輪次跳轉；Antigravity CLI 部分工具結果非明文；變聲是上游實驗功能、TTS 限研究非商用；網路欄未提權顯示「—」；Codex `--no-daemon` 修正會被 npm 更新覆蓋；安裝檔 NotSigned。
