# Linux：App 內媒體播放器

Windows 用獨立的 `axondeck-media.exe`（Win32 視窗＋內建 mpv）。Linux 沒有那份原生播放器，改在 AxonDeck 裡開一扇播放視窗（`src/main/media-linux/`、`src/renderer/pages/media-player.html`）。

## 怎麼選後端

每一首自己選，順序固定：

1. **HTML5**（`<video>`／`<audio>`）：Chromium 能播的容器（mp4／m4v／mov／webm／mkv／ogv／mp3／wav／flac／ogg／opus／m4a／aac…）。路徑不直接給 renderer，走 `axd-player://` 協定（跟工作區的 `vi-media://` 分開：只送目前播放清單裡的檔案，網址是隨機 id）。
2. **mpv**（有裝才用）：JSON IPC（`--input-ipc-server`）遙控。畫面在 mpv 視窗，AxonDeck 播放頁同步進度、可遙控、管播放清單。socket 放在 0700 暫存資料夾。
3. **ffplay**（有裝才用）：交出去播，沒有遙控。
4. **系統預設程式**（`xdg-open`／`shell.openPath`）：最後手段。

容器對了、畫面編碼不支援（例如 HEVC 的 mp4）時，內建播放器會回報錯誤，改走 2～4。

## 跟 Windows 對齊的功能

- 播放／暫停、進度條、音量、靜音、速度（0.5～2×）
- 同資料夾同種類（影片／音訊）當播放清單，自然排序；`.m3u`／`.m3u8`／`.pls`／`.cue` 只收本機路徑（網址、註解、巢狀清單丟掉）
- 重複（關／整份／這一首）、隨機
- 同名字幕：`.srt`／`.vtt`（內建轉成 `<track>`）；`.ass`／`.ssa` 要 mpv 才看得到樣式
- 快捷鍵比照 Windows 原生播放器（空白鍵、方向鍵、PgUp／PgDn、R／L、V／C、J／K、A、S…）

圖片仍走原本的圖片檢視／系統開啟，不進這扇視窗。

## 測試

- `node scripts/test-media-player-linux.js`：plan／protocol／真的 mpv JSON IPC（ffmpeg 產生 avi／wma）
- `npx electron --no-sandbox scripts/e2e-media-player-linux.js`：真的 Electron 視窗＋真的 mpv＋ffmpeg 樣品（H.264、VP9、HEVC、avi、flac、wma、.m3u8、字幕、快捷鍵、沒有 mpv 時的 ffplay／系統開啟）。需要顯示伺服器。

開發用的測試機沒有音訊裝置（ALSA 會抱怨），不影響畫面與遙控驗證。
