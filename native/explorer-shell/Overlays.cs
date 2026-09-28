using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace VoiceInkShell
{
    /// <summary>
    /// 圖示重疊（icon overlay）——Google Drive 的綠勾／雲朵／同步中，OneDrive、
    /// TortoiseSVN 也都是這一套。
    ///
    /// 誰畫什麼由登錄檔的 `ShellIconOverlayIdentifiers` 決定，每個處理常式拿到一個
    /// 1～15 的槽位；`SHGetFileInfo` 會把槽位編號放在 `iIcon` 的最高位元組，
    /// 0 ＝這個路徑沒有任何重疊。
    ///
    /// **不要想自己把那張小圖單獨挖出來**：`IImageList::GetOverlayImage` 在這台
    /// Windows 11 上不管傳哪個槽位都回同一個索引（實測 8～15 全回 1，畫出來是
    /// 一張通用文件圖示），而「空白圖＋INDEXTOOVERLAYMASK」取回來整張是透明的。
    /// 正解是讓殼層自己疊：`SHGFI_ADDOVERLAYS` 回來的就是檔案總管畫在畫面上的那張。
    /// </summary>
    internal static class Overlays
    {
        /// <summary>回傳這個路徑的重疊槽位；問不到就當成 0（沒有重疊），不是錯誤。</summary>
        public static int IndexOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return 0;
            SHFILEINFOW info = new SHFILEINFOW();
            // **一定要配 SHGFI_ICON**：`SHGFI_OVERLAYINDEX` 是「修飾 SHGFI_ICON」的旗標，
            // 跟 `SHGFI_SYSICONINDEX` 一起用會安靜地一律回 0（實測 Google Drive 的路徑
            // 用 SYSICONINDEX 拿到 0、用 ICON 拿到 12）。代價是每問一次配一個 HICON，
            // 所以要立刻 DestroyIcon，不然列一個資料夾就漏幾百個控制代碼。
            uint flags = Native.SHGFI_ICON | Native.SHGFI_OVERLAYINDEX | Native.SHGFI_SMALLICON;
            IntPtr result = Native.SHGetFileInfoW(path, 0, ref info,
                (uint)Marshal.SizeOf<SHFILEINFOW>(), flags);
            if (result == IntPtr.Zero) return 0;
            if (info.hIcon != IntPtr.Zero) Native.DestroyIcon(info.hIcon);
            int slot = (info.iIcon >> 24) & 0xFF;
            return slot <= 15 ? slot : 0;
        }

        /// <summary>
        /// 單獨那顆同步標記（給方格縮圖疊在左下角；縮圖本身不帶重疊）。沒有就回 null。
        /// 回來的是整張 overlay 畫布（標記本身就畫在畫布左下），renderer 照比例蓋上去即可。
        ///
        /// 不從槽位反推圖：上面說過殼層的圖庫給不出來。改成跟檔案總管一樣直接問處理常式：
        /// 登錄檔名稱排序後前 15 個（其餘殼層根本不載）、`IsMemberOf` 認的裡面取優先權最高的，
        /// 再照它給的圖示檔＋索引抽出指定大小。先用槽位擋掉沒有重疊的路徑，
        /// 一般資料夾就不用把每個處理常式都問一輪。
        /// </summary>
        public static Bgra BadgeOf(string path, bool dir, int size)
        {
            if (IndexOf(path) == 0) return null;
            IShellIconOverlayIdentifier best = null;
            int bestPriority = int.MaxValue;
            foreach (IShellIconOverlayIdentifier handler in Handlers())
            {
                try
                {
                    if (handler.IsMemberOf(path, dir ? SFGAO_FOLDER : 0) != 0) continue;
                    int priority;
                    if (handler.GetPriority(out priority) != 0) priority = 100;
                    if (priority < bestPriority)
                    {
                        best = handler;
                        bestPriority = priority;
                    }
                }
                catch (COMException)
                {
                    // 處理常式自己出錯就當它不認這個路徑
                }
            }
            return best == null ? null : Extract(best, size);
        }

        private const uint SFGAO_FOLDER = 0x20000000;
        private const uint ISIOI_ICONINDEX = 0x2;
        private const int MaxHandlers = 15;
        private const string OverlayKey = @"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\ShellIconOverlayIdentifiers";
        private static List<IShellIconOverlayIdentifier> _handlers;

        private static List<IShellIconOverlayIdentifier> Handlers()
        {
            if (_handlers != null) return _handlers;
            _handlers = new List<IShellIconOverlayIdentifier>();
            using (RegistryKey root = Registry.LocalMachine.OpenSubKey(OverlayKey))
            {
                if (root == null) return _handlers;
                string[] names = root.GetSubKeyNames();
                Array.Sort(names, StringComparer.OrdinalIgnoreCase);
                for (int i = 0; i < names.Length && i < MaxHandlers; i++)
                {
                    IShellIconOverlayIdentifier handler = Create(root, names[i]);
                    if (handler != null) _handlers.Add(handler);
                }
            }
            return _handlers;
        }

        private static IShellIconOverlayIdentifier Create(RegistryKey root, string name)
        {
            try
            {
                using (RegistryKey key = root.OpenSubKey(name))
                {
                    Guid clsid;
                    if (!Guid.TryParse(key?.GetValue(null) as string, out clsid)) return null;
                    Type type = Type.GetTypeFromCLSID(clsid, false);
                    return type == null ? null : Activator.CreateInstance(type) as IShellIconOverlayIdentifier;
                }
            }
            catch (Exception)
            {
                // 沒裝好或只有 32 位元的處理常式：殼層自己也載不起來，略過
                return null;
            }
        }

        private static Bgra Extract(IShellIconOverlayIdentifier handler, int size)
        {
            const int cch = 520;
            IntPtr buffer = Marshal.AllocCoTaskMem(cch * 2);
            try
            {
                int index;
                uint flags;
                if (handler.GetOverlayInfo(buffer, cch, out index, out flags) != 0) return null;
                string file = Marshal.PtrToStringUni(buffer);
                if (string.IsNullOrEmpty(file)) return null;
                if ((flags & ISIOI_ICONINDEX) == 0) index = 0;
                IntPtr large, small;
                if (Native.SHDefExtractIconW(file, index, 0, out large, out small, (uint)size | (16u << 16)) != 0) return null;
                if (small != IntPtr.Zero) Native.DestroyIcon(small);
                if (large == IntPtr.Zero) return null;
                try
                {
                    return Pixels.FromIcon(large);
                }
                finally
                {
                    Native.DestroyIcon(large);
                }
            }
            catch (COMException)
            {
                return null;
            }
            finally
            {
                Marshal.FreeCoTaskMem(buffer);
            }
        }

        /// <summary>這個路徑在檔案總管裡實際長的樣子（32×32，含疊上去的同步標記）。</summary>
        public static Bgra IconOf(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            SHFILEINFOW info = new SHFILEINFOW();
            uint flags = Native.SHGFI_ICON | Native.SHGFI_ADDOVERLAYS | Native.SHGFI_LARGEICON;
            IntPtr result = Native.SHGetFileInfoW(path, 0, ref info,
                (uint)Marshal.SizeOf<SHFILEINFOW>(), flags);
            if (result == IntPtr.Zero || info.hIcon == IntPtr.Zero) return null;
            try
            {
                return Pixels.FromIcon(info.hIcon);
            }
            finally
            {
                Native.DestroyIcon(info.hIcon);
            }
        }
    }
}
