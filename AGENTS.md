# AxonDeck — 專案規範與 AI 作業守則

> 規則正文；`CLAUDE.md` 只是入口。現況與架構見 [CONTEXT.md](./CONTEXT.md)，判斷原則見 [tasks/lessons.md](./tasks/lessons.md)。
> 「地雷」每一條都實際改壞過；細節查 git log。

## 專案

Windows Electron AI 工作台。Vanilla JS + Vite（無框架），Electron 43.4.1（內建 Node 24）、腳本用系統 Node 22。
nav 九頁（可拖曳排序）：SI（`data-page="chat"`：Local 對話、網頁版 AI、專案工作區、終端機同一頁）｜Telegram｜檔案｜CC Proxy｜語音轉文字｜翻譯｜系統監控｜Local SI（`hfmodels`）｜設定。額度是工作區底下那條；AGY 反代與用量統計是 CC Proxy 的子分頁。EdgeTTS 跟翻譯頁的模型按鈕同一排，展開浮在內容上。

## 指令

```bash
npm run electron:dev     # 開發（vite + electron）
npm run dev:sandbox      # 沙箱實例（%APPDATA%\axondeck-dev），不干擾使用中那份
npm run electron:pack    # 免安裝預覽 → dist/win-unpacked（UI／功能改完必跑；打到磁碟根→驗 asar→同步→清理）
npm run electron:build   # 正式 NSIS（pack-preview --release），只在發版時打
npm run build:probe      # Rust：axondeck-probe.exe＋axondeck-term.exe → resources/probe/
npm run build:shell      # .NET 殼層 sidecar → resources/shell/（改 C# 後必跑）
npm run build:sensors / build:hook / build:media   # 感測器 sidecar／熱鍵退路／原生媒體 runtime
```

`resources/{sensors,hook,shell,probe,media}/` 不進版控；沒建也打得起來，只是對應功能降級。打包前關掉 `dist/win-unpacked/AxonDeck.exe`。

### 發行流程（漏一步舊版就永遠檢查不到更新，而且不報錯）
```bash
# 1) bump package.json version（不可與既有 tag 重複）＋ README 版本行
git commit -am "feat: 發行 vX.Y.Z — <一句話>" && git tag vX.Y.Z && git push && git push --tags
npm run electron:build
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."   # 不可 --draft／--prerelease
gh release upload vX.Y.Z dist/AxonDeck-Setup-X.Y.Z.exe dist/AxonDeck-Setup-X.Y.Z.exe.blockmap dist/latest.yml
```

缺 `.exe` → 下載 404；缺 `latest.yml` → 「沒有附帶更新資訊」。發版禁止 `--prepackaged`（會少 `app-update.yml`），要拆安裝檔確認有它。

## 作業守則

1. 動手前讀 CONTEXT.md 找模組、讀本檔該模組地雷；追完整條資料流與所有 caller，修根因。
2. 改動最小。非簡單任務先把可勾選計畫寫進 `tasks/todo.md`。
3. 完成前附驗證指令與實際輸出；新回歸測試要先在修復前紅過一次。同一修法失敗兩次就換方法。
4. mock 全綠證明不了對面長什麼樣：整合功能另留 `probe-*.js` 打真流量。
5. 刪功能時一起掃「定義／exports／IPC 白名單／preload／renderer 呼叫點」。
6. Commit：`<type>: <繁中描述>`（feat／fix／refactor／docs／test／chore／perf／ci）；**只在使用者要求時** commit／push。

## 慣例

- kebab-case 檔名、camelCase 變數、UPPER_SNAKE 常數；Renderer ESM、Main／Preload CJS；函數 <50 行、檔案 <800 行。
- 設定走 electron-store IPC，**key 僅 allowlist**；聊天／終端機／工作區／檔案總管／AGY／語音輸入紀錄／用量統計各有獨立 store。`hfToken`、`agyEnabled`、`ocControl` 刻意不進 allowlist。
- 模組 IPC 外殼 `src/main/ipc-invoke.js`（主視窗守衛＋`{ ok, data|error }`），**handler 各模組逐一列舉**。
- 兩窗 `sandbox: true`；CSP 的 `font-src data:`、`worker-src blob:`（Monaco）與 `img/media/connect-src vi-media:` 不可拿掉。
- 不准用 `window.confirm/prompt/alert`，一律 `app-dialog.js` 的 `askConfirm`／`askInput`／`showAlert`。

## 地雷

### 安全與檔案系統（跨模組）
- 遞迴刪除一律 `safe-rm.js` 的 `removeTreeSync`（腳本用 `test-temp.js`）：Node 24 的 `rmSync({recursive})` 會穿過 junction 刪掉對面真資料。守門 `test-temp-hygiene.js`。
- 碰使用者任意路徑用 `raw-fs.js`（＝`original-fs`）：Electron `fs` 碰過 `.asar` 就鎖到關 App。App 自己的資源不要用它讀。
- 雲端錯誤只記狀態摘要；上游 body／token／`error.message` 不進 console／IPC／UI。代理只透傳 429，其餘 502。回歸 `test-error-hygiene.js`。
- 不收 renderer 給的網址（上游位址由 main 從 store 取）；圖片只收 `data:` URI（防 SSRF）。外部 CLI 憑證只讀不寫，唯一例外是 Claude 的 `~/.claude/.credentials.json`。
- 工作區檔案只走 `workspace/files.js` 的 `resolveIn`（`{ projectId, relPath }`＋分隔符比對＋兩邊 `realpathSync.native`）；整機檔案走 `explorer/paths.js` 的 `resolveAbs`。
- git 一律 `spawn(..., { shell: false })`＋陣列參數＋`GIT_TERMINAL_PROMPT=0`；stderr 不透傳（含遠端 URL／token）。
- 主程序不准對可能是網路路徑的東西做同步 I/O（NAS 睡著 → AppHang）；一律 `fs.promises`＋逾時（`drives.js` 的 `withTimeout`）。
- 從 asar 複製檔案用 `writeFileSync(to, readFileSync(from))`：`fs.cpSync` 讀不了 asar、`copyFileSync` 會在 `%TEMP%` 留中繼檔。外部程序執行不了 asar 內檔案，要 `asarUnpack`＋`app.asar.unpacked`。
- 系統工具指名 `%SystemRoot%\System32`（PATH 上的 MSYS `whoami`／`icacls` 會被抓到）。改 PATH 要就地改原鍵名並把大小寫不同的同名鍵收成一個。

### 打包／建置
- 保留 `asar.smartUnpack: false`；`asarUnpack` 含 sherpa-onnx*、`@node-llama-cpp/win-x64`、`@reflink`、`.ps1`、`uiohook-napi`、`@lydell/node-pty*`。新增產物資料夾要排除（漏排 `native/` 曾讓打包失敗）。
- asar 被別的程式抓著（Orca 連 `%TEMP%` 都監看）或打包中動到被打包的檔案（含把 log 導進專案）→ asar 安靜錯位、exit 0。`electron:pack` 已處理（打到磁碟根、逐檔比對）；不要手動 `--config.directories.output`。
- `electron:pack` 中途失敗會留下壞 `dist/win-unpacked`：整個刪掉重打。worktree 打包要實體 `node_modules`（junction 會漏 node-pty 原生檔）。
- NSIS warning 會被當錯誤（`installer.nsh` 安裝／解除安裝各編譯一次，只在 `customInstall` 用的 `Var` 會報 6001）；別把 `tail` 的 exit code 當建置成功。
- 更新：`disableDifferentialDownload` 必須開（GitHub 逐段序列下載慢 36 倍）；`nsis.artifactName` 不能改回預設；`.exe` 走 `update-mirrors.js` 鏡像、`latest.yml` 只從 GitHub 讀。回歸 `test-updater.js`。
- 手動「重新啟動並安裝」不可改回 `/S`（兩三分鐘沒畫面，使用者重開機會把 App 弄沒）；結束 App 時的 `installOnQuit` 保留靜默；Windows 關機／登出不開安裝程式。`installOnQuit()` 要在 `app.exit(0)` 前一行。
- `app.setAppUserModelId('com.voiceink.app')` 要在搶鎖前；改 AUMID 會讓開機自啟動值變孤兒（`migrateLoginItemName`）。更新後捷徑變白紙由 `installer.nsh` 的 `customInstall` 重寫。
- v1.40 由 VoiceInk 改名 AxonDeck。刻意留舊名（改了升級會斷）：`com.voiceink.app`（NSIS 解除安裝 GUID、捷徑 AUMID、開機自啟動值名）、userData 已有 `%APPDATA%oiceink` 就沿用（設定裡存絕對路徑）、媒體 ProgID `VoiceInk.Media.*`（UserChoice 雜湊綁 ProgID）。GitHub repo 已改名 AxonDeck，舊網址（含舊版 App 的 `releases.atom`／`latest.yml`）靠 GitHub 自動轉址——**永遠不要再建名為 VoiceInk 的 repo**，否則轉址失效、舊版收不到更新。其餘舊名殘留由各模組啟動時清掉（Claude hooks、更新快取、工作列釘選、感測器排程、媒體登錄檔）。

### 啟動與常駐
- `whenReady` 立刻建窗不 await store；重模組第一次用到才 require。
- 常駐三件套：`requestSingleInstanceLock()`；沒搶到用 `app.quit()`；`whenReady` 也 `if (!hasInstanceLock) return`。`--terminal-admin-host=` 要攔在搶鎖前。
- 不可關 `setBackgroundThrottling`（`document.hidden` 會恆 false）。
- `before-quit`：`workspace:flushDrafts` 排在終端機 `disconnect()` 前；`agy.shutdown()` 不是 `stop()`；風扇交還排在 `sensors.stop()` 前。

### AI 頁：聊天與網頁版 AI
- model 與訊息歷史所有權在 main；模型要對「目前這組供應商」驗證。
- `chat.send` 的 inflight 佔位（每對話一格的 Map）要跟守衛同一同步區塊；`chat:abort` 一定帶 reqId。renderer 串流照 conversationId 分開。
- 取樣參數只送 temperature／top_p／max_tokens／stop 且沒勾不送；thinking 關閉時完全不帶 `reasoning_effort`；串流用首 token 60s＋閒置 120s 雙計時器，中斷仍存已收內容。
- 重新生成在上游成功前不得 `dropTrailingAssistant`；`chats.json` 讀改寫走 `withStore`；側欄順序＝陣列順序；`chatProviders` sanitize 遇壞網址保留該筆只清 `apiUrl`；`__local` 要過濾掉。`markdown.js` 零 innerHTML，`INLINE_SRC` 每次 `new RegExp`。
- 網頁版 AI：網址只收該站網域、擋登入／OAuth／授權碼（`ai-web.js` 的 `safeUrl`）。UA 偽裝成 Chrome 給 Google 登入用。**Grok 的 Cloudflare 擋 Electron（怎麼換 UA、點勾選框都無限重來）**：`grok-clearance.js` 碰到 `cf-mitigated: challenge` 就開系統 Edge／Chrome 過驗證，把 `cf_clearance` 連同它的 UA 帶回 `persist:ai-grok`（通行證綁 UA）。除錯埠必須給固定號碼，用 `0` 一律不放行。

### 專案工作區
- 三份清單要對齊：`ipc.js` 用到的 `service.X`、`main.js` 逐一列舉白名單、preload；`module.exports` 列未定義名字＝載入期 ReferenceError 而單元測試全綠。回歸 `test-workspace.js` [Q]（explorer／AGY／sysmon／usage 同一條）。
- 存檔帶開檔 mtime（`STALE` 提示條，草稿不動）；同檔寫入排隊；草稿上限 4MB、讀寫上限 50MB；存檔後重讀現在內容。
- 開分頁每次 await 後核對 `projectSwitch` 並重新 `findTab`；改名／搬檔要 `retargetTabs`；切專案要 `disposeModelsExcept`。
- 大檔：Monaco 停手 300ms 才 `getValue()`、`stash()` 先 `flushChange()`；`showTab` 用 `modelText` 比對不 `getValue()`。Monaco 只能走 AMD `min/vs`。
- 媒體不讀內容不轉 base64：走 `vi-media://<token>/` 協定（自解 Range）；`registerSchemesAsPrivileged` 在 ready 前；Electron 沒 PDF 檢視器，用 pdf.js。
- 行首是 `(` 的那行會接到上一行（沒分號）；型別轉換先存變數。
- `git status --porcelain=v2 -b -z`（欄位依位置）；`git log` 用 `%x1f` 不混 `-z`；跟分支比要比 `merge-base`；`--numstat` 配 `--no-renames`。暫存區／變更的行數分開算（`--cached` vs `diff`）。
- 內建瀏覽器：`webviewTag` 只開主視窗、guest 不掛 preload；每分頁一顆 webview，換專案停放不拆；要自寫 `webview[hidden] { display: none }`。
- 外部拖入一律複製不搬移，先量再複製、超上限整批拒絕；`dragover` 要放行外部檔案。搜尋四個上限（200 命中／8000 檔／1MB／15 秒）缺一不可。
- 資料夾監看一次只看一個專案；`.git` 底下的變動只當「Git 狀態變了」；事件要合併；監看不起來安靜退回手動。
- AI 記錄要掃 `CLAUDE_CONFIG_DIR`／`CODEX_HOME` 與其他工作台 home，照 `agent + id` 去重；「讀過」「改過」分開。恢復指令是 main 固定表，session id 卡 `^[A-Za-z0-9_-]{6,64}$`。

### 檔案總管
- 整機搜尋不准自己 walk，只代跑 `<userData>/uffs/` 的 UFFS（checksum 缺就失敗）；CDP／沙箱的 `uffsAuto` 關掉。
- 刪／改名／搬移擋磁碟根、`%SystemRoot%`、家目錄本身（`assertMutable`）；預設丟資源回收筒；撞名產 `name (2).ext`；回收筒強制釘選。
- 「開資料夾」一律走 App 檔案頁（`openInFilesPage`），不叫 `shell.showItemInFolder`。
- ZIP／手機（MTP）是虛擬路徑（`zip-ops.js`／`mtp.js`，`index.js` 每入口先問）；ZIP 唯讀、擋 zip-slip；MTP 只能永久刪除、全走殼層 sidecar。
- 殼層 sidecar 主執行緒要跑訊息迴圈；pidl 用 `LPArray`；IContextMenu3 不做事退回 v2；縮圖用 `IShellItemImageFactory`（測試要斷言縮圖≠類型圖示）。
- 列目錄先排序再截斷（`MAX_STAT` 10000）；點開頭在 Windows 不等於隱藏，不准加回 `startsWith('.')`。
- 點一下就重畫的清單不能靠容器上的 `dblclick`（舊列被換掉，事件傳不到容器）：在 click 裡認 `event.detail === 2`。回歸要用真滑鼠（`Input.dispatchMouseEvent`），合成的 dblclick 永遠綠。
- 虛擬清單：`paintList()` 前先記 `scrollTop`；框選與就地改名期間不准重畫；捲到已載入頁也要重畫；稀疏陣列先 `.filter(Boolean)`。
- 拖到別的程式只有 `webContents.startDrag`（跟 HTML5 DnD 不能並存，CDP 不可呼叫它）；`dropEffect` 一律 `setDropEffect`。
- Ctrl+滾輪要 `{ passive: false }`；縮圖快取鍵帶尺寸；影片縮圖抓完要放掉 `<video>`（不然檔案被鎖）；插拔裝置靠 `hookWindowMessage(0x0219)`，不輪詢。

### 終端機
- PTY 在 App 外的獨立宿主（優先 Rust `axondeck-term.exe`，退路 Electron 版）；**改終端機行為要兩邊一起改**（`host.rs`↔`host.js` 逐條對應）。`before-quit` 只 `disconnect()`。
- 宿主活得比 App 久：auth 回報 `runtime`，跟 `runtimeName()` 對不上就是舊宿主（要重開才生效）。
- 環境不沿用宿主繼承的：Rust 用 `CreateEnvironmentBlock`；濾掉 `CLAUDECODE`／`CLAUDE_CODE_*`；從 Claude Code 裡開 App 驗收也要先拿掉它們。
- 狀態＝宿主結束 → Claude hook → 畫面 → 靜默（`term-agent.js` 的 `mergeState`）；hook 說 idle 最弱。hook exe 的 stdout 一個字都不能寫；`--user-data-dir` 時不寫真的 `~/.claude/settings.json`。畫面規則照 `scripts/fixtures/term-agent/` 真實畫面校正。
- 忙碌判定 OSC 133（帶 history id 比大小）＋靜默雙軌；無標記的 cmd 不套「送出後一直算運行中」。
- 輸入法：組字期間用 CSS 變數＋`!important` 釘錨點（`term-ime.js`），不要改回每幀 JS 擺位；textarea 用透明色藏不用 `opacity: 0`；`.term-host` 用 `overflow: clip`。
- 用 WebGL renderer（DOM 版游標會亂閃）；`onContextLoss` 要 dispose 重掛；Unicode 11 要 load 後再 `activeVersion = '11'`；`.xterm-viewport` 要 `background-color: transparent` 與 `scrollbar-width: none`。
- 不要攔截 CLI 滑鼠模式（`term-mouse.js` 只把 Ctrl+滾輪留給字級）；Shift+拖曳仍是本地選取；必須給 `linkHandler`（OSC 8）。
- 剪貼簿一律跟 main 要（`navigator.clipboard` 沒焦點會 reject）；截圖落檔貼路徑；有選取 Ctrl+C／右鍵＝複製。Shift+Enter 送 `\x1b\r`。
- 切回終端機走 `fitAndSync`；分割不搬 DOM、每格各自 fit；狀態變動就地改那一列不 `renderList()`。標題／cwd 欄位叫 `osTitle`／`liveCwd`；連結：`provideLinks` 是整份緩衝區 1-based 列號、x 是 cell 欄位；路徑先問 main 存不存在再畫底線。
- Ctrl+G 橋接：batch 只能 ASCII、路徑不出 batch；`EDITOR=notepad` 不算使用者選過；`EDITOR`／`VISUAL` 都要蓋；存檔不收分頁、關分頁才放走；放走過的請求進忽略名單。
- 桌布：store 只存檔名、renderer 轉 `blob:`（CSS 塞 data URI 超過約 2M 字元會安靜失效）；強度下限 10；管理員終端機用 `Start-Process -Verb RunAs` 開 host；host 模式 userData 指到暫存。

### HF模型／本地 LLM／翻譯
- Breeze-TTS-2 Q8 走獨立 `breeze-server`，不可送進 llama router／preset。模型下載連帶安裝 `breezeruntime`，兩者以固定 SHA-256 校驗；移除任一者前先停 Breeze。參考音訊由 main 對話框選取，renderer 只持 token；聲音收藏在 `userData/breeze-tts/voices`，不隨模型移除。
- 推論一律 llama-server router 模式；關思考明寫 `reasoning = off`；`/metrics` 要 `--metrics` 且帶 `?model=`。
- 記憶體配置交給 `llama-fit-params`（主動寫死 `gpu-layers` 等於關掉它）；KV 用 GGUF 的 `key_length／value_length`；`safeValue` 不准清中括號；`readConfig` 不在清單的 modelId 回空字串不退回第一顆。關思考用 `reasoning: { exclude: true }`。
- LinguaForge 一段約 2000 字（ctx 8192）；清單標記仍逐行剝掉再貼回。zhtw `repeatPenalty: false`、重試前還原 history；不要用 regex 剝前綴當修復。

### ASR／語音輸入／錄音
- `asr-select.js` 是本地 ASR 唯一選擇點；`model-scope.js` 是三子分頁模型唯一解析點。本地 GPU ASR 只能走 llama-server 且要帶 `--device`；三支 ASR 都套 `s2twp`。
- 焦點在自己視窗時不走剪貼簿（`insertIntoOwnWindow`）；自動化測試一律把 `insert` 換成 stub。
- 右 Alt 只能用低階鍵盤 hook；HUD `focusable: false`＋`showInactive()`；`await` rAF 一定配逾時（視窗被遮住 rAF 不跑）。
- 整理：失敗退回原文；字典送前送後各套一次、單趟掃描；本地逐段結果用空行接不用 `joinSegments`。
- 錄音與字幕邊錄邊 append，不在 renderer 累積；檔名只收 `rec-<13 位毫秒>.webm`／`live-<13 位毫秒>`。

### CC Proxy／AGY反代
- 轉換閘道沒有手動開關：`ccswitch/index.js` 的 `activateProvider` 依目標路由自動開（gateway）／關（直連、官方訂閱），開機由 `autoStartGateway` 接續。切到 `agy` 那家時 AGY 沒開就先 `start()`；AGY 只在執行中才自動播種成供應商。
- AGY 模型映射要先查即時型錄（`catalog.snapshot`）：靜態前綴規則會把 `claude-opus-5-5` 之類帳號裡真的有的新 ID 改寫回 `claude-opus-4-6-thinking`（別人帳號上已下架 → 報錯）。
- 改 `~/.claude/settings.json` 只動我們管的 `env` 鍵，切換先清前一家；壞檔拋錯；寫入前備份＋原子替換。MCP 在 `~/.claude.json`，只改 `mcpServers`。
- `providers.routeFor()` 是路由唯一推導點；內建供應商不吃自訂 Base URL。Codex Responses 要 `store: false`、不送 `max_output_tokens`／`temperature`。
- 1M 上下文＝模型名加 `[1m]`，閘道仍要 `stripContextMarker`。CLI 更新用各自的 updater。
- 模型只有 Opus／Sonnet／Haiku 三格（`MODEL_FIELDS`），不再寫 `ANTHROPIC_MODEL`（仍在 `claude-settings.js` 管理清單裡，切換會清掉）；舊檔的 `model` 只拿來補三格。OpenRouter 掃描走 `keepOpenRouterModel`（純文字輸出＋工具＋一年內，排除 `:batch`）。
- AGY 送 Claude 模型：工具 schema 不能有 `anyOf`（`gemini.schemaFor` 攤平）、functionCall／functionResponse 要帶 id，少一樣 Claude Code 就整個 400。
- AGY：憑證只讀；續期靠代跑 `agy models`（`stdio: 'ignore'`，`execFile` 會卡 stdin）；`mustRefresh` 只有 401 能設；端點順序 sandbox → daily → prod；function schema 走白名單並修三種型別錯。

### 用量統計與額度
- 游標 key 跟著檔案走（session 會搬進 `archived_sessions`）。Codex fork 的開頭重播一筆都不收（到第一個 `turn_context`）。
- 加錯差十倍：Codex 用 `last_token_usage`；Claude 串流照 `message.id` 去重；Grok ticks 一律 1 USD = 1e10。快取讀／寫分開計價；沒單價回 `null` 不是 0；改 `normalizeModel` 要 `RULES_VERSION` +1。
- `mergeExpectedWindows` 只能由 `usage/index.js` 呼叫，空窗不 merge（會生出假的 100%）。
- Claude token 自己續（`usage/claude-auth.js`）：兩把鎖、鎖內重讀、CAS 寫回、原子替換；額度 API 要報 `claude-code/<版本>` UA，429 不重試並冷卻。Grok／Antigravity 靠代跑 CLI 續期並確認 token 真的換了。
- Codex 重置兌換只走官方 `codex app-server`，測試絕不真的兌換。Grok `tier: 1`＝SuperGrok，其他不猜。

### 系統監控／風扇／效能調整
- 一律 `Win32_PerfRawData_*`（配 `Timestamp_Sys100NS` 差值）；GPU 引擎 key 含 LUID＋索引；不顯示 Idle。
- 取樣優先 Rust `axondeck-probe.exe`，退路 `probe.ps1`；兩邊格式完全一致，改任一邊跑 `probe-native-probe-parity.js`；`usage.rs` 改了跑 `probe-usage-native-parity.js`。probe 是 GUI 子系統（不掛 conhost）。
- 取樣器開機常駐、沒人看走 `idle()`；nvidia-smi 看門狗從 spawn 就武裝。
- 感測器 sidecar：只有它提權、AboveNormal＋Highest、斷線指數退避一直重拉；看門狗不算 `_inCommand`、只交還不結束；寫管道 `lock (writer)`；管道 `PipeOptions.Asynchronous`。硬碟溫度排除 `Warning|Critical` 門檻值。
- 風扇手動 PWM 會留在晶片：`minPwm` ≥20、5 秒看門狗、目標值每秒重送。效能調整卡住要還原、≥95°C 立刻還原、開機不自動套用、CDP 不准按套用。
- 讀不到值不可用 0 佔位；有 `LIMIT` 的清單不拿來算總數。

### UI／CSS
- `themes.css` 沒有 `--surface`／`--accent`／`--border`（是 `--surface-glass`／`--accent-primary`／`--border-color`）；打錯不報錯，回歸量 computed 顏色。
- 用 `el.hidden` 收合的元素若 CSS 寫了 `display`，要自補 `[hidden] { display: none }`；`<dialog>` 的 `display` 要帶 `[open]`。斷言量 `offsetHeight`。
- `backdrop-filter` 會偷走 `position: fixed` 基準；程式改 `<select>.value` 要 `syncCustomSelects()`。
- renderer JS 不准 `import './x.css'`（打包版用 `file://` 直接載 ES module，整條 import 鏈死掉）。
- 禁用左側強調條／裝飾條；值不准 ellipsis（用 `overflow-wrap: anywhere`）；hover 才出現的操作等於沒有。

### 測試（CDP／e2e）
- 在這個 App 裡開發這個 App 一律 `npm run dev:sandbox`（寫沙箱前先 `rm` 目的地，免得跟著連結寫回真資料）。
- 暫存一律 `scripts/lib/test-temp.js`；CDP 用暫存 `--user-data-dir`，只 `taskkill /PID /T` 自己 spawn 的 pid（先 taskkill 再 `child.kill()`），**禁止 `/IM AxonDeck.exe`**。
- 只用 `[data-id]` 指涉自己建的東西；同時只跑一支 CDP；主視窗用 `/index\.html/` 挑；開頭關 `sysmonSensors`。
- 用 node `spawn({ detached: true })` 開測試實例（PowerShell `Start-Process` 會被連帶收掉）；`npx electron <script>` 要補 `app.setPath('userData', ...)`；UI 斷言等「量得到尺寸」不睡固定時間；批次 sed 改識別字後逐條看 `git diff`。

## 驗證方式

純函式用 `node scripts/<x>.js`；需要 Electron 用 `npx electron`；打包版 UI 先 `electron:pack` 再跑 CDP（吃 `AXONDECK_EXE`）。
全部單元測試一次跑：`node scripts/run-tests.js [檔名關鍵字]`（`test-*.js`，檔頭寫 `npx electron` 的自動改用 Electron）。`scripts/` 前綴：`test-` 單元、`e2e-` 整條流程／打包版 CDP、`probe-` 真上游或真硬體排查、`bench-` 效能量測。

| 範圍 | 主要腳本 |
|---|---|
| AI 頁／聊天 | `test-ai-web.js` `test-chat-sidebar.js` `test-markdown.js` `e2e-chat.js` `e2e-chat-cdp.js` |
| 工作區 | `test-workspace*.js` `e2e-workspace-cdp.js`；Monaco／大檔 `probe-workspace-perf.js` `probe-workspace-bigfile.js` |
| 檔案總管 | `test-explorer*.js` `e2e-explorer-cdp.js` `e2e-explorer-dual-cdp.js` `probe-explorer-shell.js` `probe-explorer-uffs.js` |
| 終端機 | `test-terminal*.js` `test-term-agent.js` `test-claude-hooks.js` `e2e-terminal-cdp.js`；宿主 `probe-terminal-restart.js` `probe-terminal-host-version.js`；IME `probe-terminal-ime.js` |
| CC Proxy／閘道 | `test-ccswitch*.js` `e2e-ccswitch-cdp.js`；真上游 `probe-ccswitch-*.js` |
| AGY | `test-agy-mappers.js` `e2e-agy.js` `e2e-agy-cdp.js` `probe-agy-upstream.js` |
| 用量／額度 | `test-code-usage.js` `test-usage.js` `test-claude-auth.js` `e2e-usage-cdp.js`；`probe-usage-native-parity.js` |
| 系統監控 | `test-sysmon*.js` `e2e-sysmon-cdp.js` `e2e-sysmon-disk-cdp.js` `cargo test` |
| 語音／ASR | `test-dictation.js` `e2e-dictation.js` `test-stt-archive.js` `e2e-stt-cdp.js` `e2e-recorder-cdp.js` |
| HF模型 | `test-hfmodels.js` `e2e-hfmodels.js` `probe-hf-router.js` |
| 原生媒體 | `test-media-player.js` `cargo test --bin axondeck-media` `probe-native-media.js` `probe-media-packaged.js` |
| 跨模組 | `test-error-hygiene.js` `test-ipc-invoke.js` `test-updater.js` `test-temp-hygiene.js` `test-safe-rm.js` `e2e-cdp-smoke.js` `e2e-visual-cdp.js` |

標註會跳 UAC／搶焦點的：`e2e-sysmon-sensors.js`、`probe-terminal-admin-elevate.js`（UAC）；`probe-terminal-flicker.js`、`probe-dictation-live.js`、`e2e-app-dialog-cdp.js`（搶前景）；`probe-claude-refresh.js --force` 會真的續 Claude 登入。
