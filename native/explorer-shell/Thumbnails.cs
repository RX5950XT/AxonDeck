using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace VoiceInkShell
{
    /// <summary>
    /// 真正的檔案縮圖（照片／影片／PDF 預覽），不是 SHGetFileInfo 的類型圖示。
    ///
    /// 先用 THUMBNAILONLY | INCACHEONLY 問「快取裡已經有真縮圖了嗎」：有就直接給，
    /// 那一定是最終的圖。沒有（殼層還在現生，GetImage 回 E_PENDING 之類的失敗碼）就退回
    /// RESIZETOFIT | BIGGERSIZEOK 拿一張能先顯示的，複製一份進快取之後再探一次
    /// ——這一次命中就不是暫時的了（PNG 這種檔案本身就是圖的走這條）。
    /// 兩次都沒命中才標 pending，讓 renderer 稍後再問一次。
    /// **不要在這裡 Sleep 等它生好**：sidecar 只有一條 stdin 迴圈，睡下去整排圖示都卡住。
    /// </summary>
    internal static class Thumbnails
    {
        public const int DefaultSize = 96;
        public const int MinSize = 16;
        /// <summary>跟 shell.js toPng 同一個上限：再大就變成 IPC 裡幾百 KB 的 base64。</summary>
        public const int MaxSize = 256;

        public static int ClampSize(int size)
        {
            if (size < MinSize) return DefaultSize;
            if (size > MaxSize) return MaxSize;
            return size;
        }

        static Bgra Take(IntPtr hbmp, bool pending)
        {
            if (hbmp == IntPtr.Zero) return null;
            try
            {
                Bgra image = Pixels.FromBitmap(hbmp);
                if (image != null) image.Pending = pending;
                return image;
            }
            finally
            {
                Native.DeleteObject(hbmp);
            }
        }

        static IntPtr Ask(IShellItemImageFactory factory, SIZE sz, int flags)
        {
            IntPtr hbmp;
            int hr = factory.GetImage(sz, flags, out hbmp);
            if (hr == 0 && hbmp != IntPtr.Zero) return hbmp;
            if (hbmp != IntPtr.Zero) Native.DeleteObject(hbmp);
            return IntPtr.Zero;
        }

        public static Bgra Of(string path, int size, bool iconOnly = false)
        {
            if (string.IsNullOrEmpty(path)) return null;
            int edge = ClampSize(size);
            Guid iid = Guids.IShellItemImageFactory;
            IntPtr unk;
            int hr = Native.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out unk);
            if (hr != 0 || unk == IntPtr.Zero) return null;
            object com = Marshal.GetObjectForIUnknown(unk);
            Marshal.Release(unk);
            try
            {
                IShellItemImageFactory factory = com as IShellItemImageFactory;
                if (factory == null) return null;
                SIZE sz = new SIZE { cx = edge, cy = edge };
                if (iconOnly) return Take(Ask(factory, sz, Native.SIIGBF_ICONONLY | Native.SIIGBF_BIGGERSIZEOK), false);
                int probe = Native.SIIGBF_RESIZETOFIT | Native.SIIGBF_BIGGERSIZEOK
                    | Native.SIIGBF_THUMBNAILONLY | Native.SIIGBF_INCACHEONLY;
                IntPtr real = Ask(factory, sz, probe);
                if (real != IntPtr.Zero) return Take(real, false);

                int flags = Native.SIIGBF_RESIZETOFIT | Native.SIIGBF_BIGGERSIZEOK;
                IntPtr shown = Ask(factory, sz, flags);
                if (shown == IntPtr.Zero)
                {
                    shown = Ask(factory, sz, Native.SIIGBF_ICONONLY | Native.SIIGBF_BIGGERSIZEOK);
                    if (shown == IntPtr.Zero) return null;
                    return Take(shown, true);
                }

                // fallback 可能已經把 PNG 這種「檔案本身就是圖」寫進快取；再探一次，有真縮圖就不標 pending。
                real = Ask(factory, sz, probe);
                if (real != IntPtr.Zero)
                {
                    Native.DeleteObject(shown);
                    return Take(real, false);
                }
                return Take(shown, true);
            }
            finally
            {
                Marshal.ReleaseComObject(com);
            }
        }

        /// <summary>內容另外取圖，避免 Windows 把檔案關聯的 App logo 合成進資料夾縮圖。</summary>
        public static void WriteEntries(string path, Utf8JsonWriter w)
        {
            bool unavailable = false;
            w.WriteStartArray("entries");
            try
            {
                int scanned = 0, shown = 0;
                // ponytail: 最多看前 64 個項目、預覽 2 個；大量隱藏檔時保留空外框，不掃完整資料夾。
                foreach (FileSystemInfo info in new DirectoryInfo(path).EnumerateFileSystemInfos())
                {
                    if (scanned++ >= 64 || shown >= 2) break;
                    FileAttributes attrs = info.Attributes;
                    if ((attrs & (FileAttributes.Hidden | FileAttributes.System | FileAttributes.ReparsePoint)) != 0) continue;
                    w.WriteStartObject();
                    w.WriteString("name", info.Name);
                    w.WriteBoolean("dir", (attrs & FileAttributes.Directory) != 0);
                    w.WriteEndObject();
                    shown++;
                }
            }
            catch { unavailable = true; }
            w.WriteEndArray();
            if (unavailable) w.WriteString("previewError", "READ_FAILED");
        }
    }
}
