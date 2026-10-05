using System;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace AxonDeckShell
{
    /// <summary>
    /// 檔案「內容 › 詳細資料」那一頁：用 Windows 屬性系統讀指定的屬性（相片 EXIF、文件頁數、
    /// 程式版本…）。值交給 PSFormatForDisplay 排版（「1/125 秒」「f/1.8」「ISO-100」），
    /// 跟檔案總管看到的一模一樣。要哪些屬性由 JS 給（標準名稱），沒有值的不回；整支失敗回空陣列。
    /// </summary>
    internal static class Properties
    {
        private const int MaxNames = 96;
        private const int GPS_BESTEFFORT = 0x40;
        private const ushort VT_EMPTY = 0;

        public static void Write(JsonElement root, Utf8JsonWriter w)
        {
            w.WriteStartArray("props");
            string path = root.TryGetProperty("path", out JsonElement p) && p.ValueKind == JsonValueKind.String ? p.GetString() : null;
            if (!string.IsNullOrEmpty(path) && root.TryGetProperty("names", out JsonElement names) && names.ValueKind == JsonValueKind.Array)
            {
                IPropertyStore store = null;
                try
                {
                    Guid iid = typeof(IPropertyStore).GUID;
                    // 不帶 GPS_OPENSLOWITEM：雲端硬碟的佔位檔不要為了看詳情整個下載下來
                    if (SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, GPS_BESTEFFORT, ref iid, out store) == 0 && store != null)
                    {
                        int n = 0;
                        foreach (JsonElement name in names.EnumerateArray())
                        {
                            if (n++ >= MaxNames) break;
                            if (name.ValueKind == JsonValueKind.String) WriteOne(store, name.GetString(), w);
                        }
                    }
                }
                catch
                {
                    // 沒有屬性處理常式、檔案被鎖：回目前為止拿到的
                }
                finally
                {
                    if (store != null) Marshal.ReleaseComObject(store);
                }
            }
            w.WriteEndArray();
        }

        private static void WriteOne(IPropertyStore store, string name, Utf8JsonWriter w)
        {
            if (string.IsNullOrEmpty(name) || PSGetPropertyKeyFromName(name, out PROPERTYKEY key) != 0) return;
            PROPVARIANT value = new PROPVARIANT();
            try
            {
                if (store.GetValue(ref key, out value) != 0 || value.vt == VT_EMPTY) return;
                if (PSFormatForDisplayAlloc(ref key, ref value, 0, out IntPtr text) != 0 || text == IntPtr.Zero) return;
                string shown = Marshal.PtrToStringUni(text);
                Marshal.FreeCoTaskMem(text);
                if (string.IsNullOrWhiteSpace(shown)) return;
                w.WriteStartObject();
                w.WriteString("name", name);
                // 格式化結果常夾著方向控制字元（「‪4032 x 3024‬」），JS 那邊統一拿掉
                w.WriteString("value", shown);
                w.WriteEndObject();
            }
            catch
            {
                // 單一屬性壞掉不影響其他
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROPVARIANT
        {
            public ushort vt;
            public ushort r1, r2, r3;
            public IntPtr a;
            public IntPtr b;
        }

        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PROPERTYKEY key);
            [PreserveSig] int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
            [PreserveSig] int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
            [PreserveSig] int Commit();
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid iid, out IPropertyStore store);

        [DllImport("propsys.dll", CharSet = CharSet.Unicode)]
        private static extern int PSGetPropertyKeyFromName(string name, out PROPERTYKEY key);

        [DllImport("propsys.dll", CharSet = CharSet.Unicode)]
        private static extern int PSFormatForDisplayAlloc(ref PROPERTYKEY key, ref PROPVARIANT value, int flags, out IntPtr text);

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PROPVARIANT value);
    }
}
