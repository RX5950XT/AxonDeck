# Linux：手機（MTP）

檔案頁的手機在 Linux 與 Windows 走同一套 `mtp:裝置名稱\儲存空間\…` 虛擬路徑，所以 UI（「本機」的裝置卡、瀏覽、複製進出、永久刪除確認、唯讀限制）完全共用。底層換成：

1. **gvfs（優先）**：`gio mount -li` 列出 `mtp://`／`gphoto2://` 磁碟區 → 第一次點進去才 `gio mount`（按需掛載）→ `gio list`／`gio copy`／`gio mkdir`／`gio remove`。需要 `gio`（libglib2.0-bin）與 gvfs 的 MTP 後端：
   - Debian／Ubuntu：`sudo apt install gvfs-backends`
   - Fedora／Arch：`gvfs-mtp`
2. **FUSE 退路**：沒有 gvfs MTP 時用 `simple-mtpfs`（`--list-devices`）或 `jmtpfs`（`-l`）掛到 `$XDG_RUNTIME_DIR/axondeck-mtp/<n>`，之後走一般檔案操作；App 結束時只 `fusermount -u` 自己掛的點。
3. 兩者都沒有：「本機」頁顯示要裝哪個套件。

## 行為

- 手機要解鎖並在通知列選「檔案傳輸」，否則看不到儲存空間。
- 複製出來：資料夾遞迴（`gio copy` 不收資料夾）、撞名自動改 `名稱 (2).ext`，不覆寫。
- 複製進去：同上；手機到手機、貼到裝置那一層（儲存空間上面）會擋下。
- 刪除：一律永久刪除（手機沒有資源回收筒），沿用既有的確認對話框；資料夾遞迴刪除；儲存空間本身不能刪。
- 開檔／預覽：先複製到暫存再交給系統；同一檔大小沒變就重用暫存那份。
- 改名、新增資料夾：維持唯讀（與 Windows 版相同）。
- 單次最多 20000 個項目、32 層。所有外部指令都是絕對路徑、`shell: false`、參數前加 `--`。

## 測試

- `node scripts/test-mtp-linux.js`：解析 `gio mount -li`／`gio list -u` 輸出、指令組裝、偵測順序、整條流程（用 `scripts/fixtures/mtp/fake-gio.js` 這支照 gio 語意寫的假程式走真的子程序）、jmtpfs 退路、缺套件文案。
- **實機尚未測試**：開發用的 Linux 測試機沒有 gio、gvfs、jmtpfs，也接不了手機；真實裝置（Android、相機的 gphoto2）的行為、速度與錯誤訊息仍待驗證。
