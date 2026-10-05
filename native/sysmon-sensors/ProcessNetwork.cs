using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace VoiceInkSensors
{
    // ETW 只在既有 sidecar 的權限內開啟，沒有 RunAs、排程安裝或驅動。
    // 不儲存位址／封包內容；只收 manifest 的 PID 與 size，含 TCP/UDP、IPv4/IPv6。
    public sealed class ProcessNetwork : IDisposable
    {
        private static readonly Guid Provider = new Guid("7dd42a49-5329-4832-8dfd-43d979153a88");
        private readonly object _gate = new object();
        private readonly Dictionary<uint, ulong> _bytes = new Dictionary<uint, ulong>();
        private readonly EventCallback _eventCallback;
        private readonly BufferCallback _bufferCallback;
        private readonly string _name = "voiceink-network-" + Guid.NewGuid().ToString("N");
        private ulong _session;
        private ulong _consumer = ulong.MaxValue;
        private IntPtr _properties;
        private Thread _thread;
        private volatile bool _running;
        private bool _ready;
        private uint _error;
        private long _from = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        private long _lastClock = Stopwatch.GetTimestamp();

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate void EventCallback(IntPtr record);
        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate uint BufferCallback(IntPtr logfile);

        // Windows SDK evntrace.h/evntcons.h 的 x64 ABI。只宣告需要的欄位；Size 保留其餘欄位。
        [StructLayout(LayoutKind.Explicit, Size = 448)]
        private struct Logfile
        {
            [FieldOffset(8)] public IntPtr LoggerName;
            [FieldOffset(28)] public uint Mode;
            [FieldOffset(400)] public IntPtr BufferCallback;
            [FieldOffset(424)] public IntPtr EventCallback;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "StartTraceW")]
        private static extern uint StartTrace(out ulong session, string name, IntPtr properties);
        [DllImport("advapi32.dll")]
        private static extern uint EnableTraceEx2(ulong session, ref Guid provider, uint control, byte level,
            ulong anyKeyword, ulong allKeyword, uint timeout, IntPtr parameters);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "OpenTraceW", SetLastError = true)]
        private static extern ulong OpenTrace(ref Logfile logfile);
        [DllImport("advapi32.dll")]
        private static extern uint ProcessTrace([In] ulong[] handles, uint count, IntPtr start, IntPtr end);
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "ControlTraceW")]
        private static extern uint ControlTrace(ulong session, string name, IntPtr properties, uint control);
        [DllImport("advapi32.dll")]
        private static extern uint CloseTrace(ulong handle);

        public ProcessNetwork()
        {
            _eventCallback = OnEvent;
            _bufferCallback = OnBuffer;
            if (IntPtr.Size != 8) { _error = 50; return; }
            try { Start(); }
            catch { _error = 50; Dispose(); }
        }

        private void Start()
        {
            byte[] name = Encoding.Unicode.GetBytes(_name + "\0");
            int length = 120 + name.Length;
            _properties = Marshal.AllocHGlobal(length);
            Marshal.Copy(new byte[length], 0, _properties, length);
            Marshal.WriteInt32(_properties, 0, length); // WNODE_HEADER.BufferSize
            Marshal.WriteInt32(_properties, 40, 2); // system time
            Marshal.WriteInt32(_properties, 44, 0x20000); // WNODE_FLAG_TRACED_GUID
            Marshal.WriteInt32(_properties, 48, 64); // KB per buffer
            Marshal.WriteInt32(_properties, 52, 4);
            Marshal.WriteInt32(_properties, 56, 64); // bounded at 4 MB
            Marshal.WriteInt32(_properties, 64, 0x100); // EVENT_TRACE_REAL_TIME_MODE
            Marshal.WriteInt32(_properties, 68, 1); // flush once per second
            Marshal.WriteInt32(_properties, 116, 120); // LoggerNameOffset
            Marshal.Copy(name, 0, IntPtr.Add(_properties, 120), name.Length);
            _error = StartTrace(out _session, _name, _properties);
            if (_error != 0) { _session = 0; return; }
            Guid provider = Provider;
            _error = EnableTraceEx2(_session, ref provider, 1, 4, 0x30, 0, 0, IntPtr.Zero);
            if (_error != 0) { Dispose(); return; }
            IntPtr logger = Marshal.StringToHGlobalUni(_name);
            try
            {
                var logfile = new Logfile {
                    LoggerName = logger, Mode = 0x10000100, // EVENT_RECORD | REAL_TIME
                    BufferCallback = Marshal.GetFunctionPointerForDelegate(_bufferCallback),
                    EventCallback = Marshal.GetFunctionPointerForDelegate(_eventCallback)
                };
                _consumer = OpenTrace(ref logfile);
            }
            finally { Marshal.FreeHGlobal(logger); }
            if (_consumer == ulong.MaxValue) { _error = (uint)Marshal.GetLastWin32Error(); Dispose(); return; }
            _running = true;
            ulong consumer = _consumer;
            _thread = new Thread(() => {
                uint rc = ProcessTrace(new[] { consumer }, 1, IntPtr.Zero, IntPtr.Zero);
                lock (_gate) { if (_running) _error = rc == 0 ? 6u : rc; _running = false; }
            }) { IsBackground = true, Name = "ProcessNetwork" };
            _thread.Start();
        }

        private uint OnBuffer(IntPtr logfile)
        {
            // 遺失任何事件就停用本次資料，不能拿不完整計數冒充 0。
            if (Marshal.ReadInt32(logfile, 416) != 0) lock (_gate) { _error = 234; }
            return 1;
        }

        private void OnEvent(IntPtr record)
        {
            try
            {
                var provider = Marshal.PtrToStructure<Guid>(IntPtr.Add(record, 24));
                if (provider != Provider) return;
                ushort id = (ushort)Marshal.ReadInt16(record, 40);
                if (!IsTransfer(id)) return;
                if (Marshal.ReadByte(record, 42) != 0 || (ushort)Marshal.ReadInt16(record, 86) < 8)
                { lock (_gate) { _error = 13; } return; }
                IntPtr data = Marshal.ReadIntPtr(record, 96);
                if (data == IntPtr.Zero) { lock (_gate) { _error = 13; } return; }
                Record((uint)Marshal.ReadInt32(data, 0), (uint)Marshal.ReadInt32(data, 4));
            }
            catch { lock (_gate) { _error = 13; } }
        }

        public static bool IsTransfer(ushort id)
        {
            return id == 10 || id == 11 || id == 26 || id == 27
                || id == 42 || id == 43 || id == 58 || id == 59;
        }

        private void Record(uint pid, uint bytes)
        {
            lock (_gate)
            {
                if (!_bytes.ContainsKey(pid) && _bytes.Count >= 8192) { _error = 234; return; }
                _bytes.TryGetValue(pid, out ulong value);
                _bytes[pid] = value + bytes;
            }
        }

        public void AppendJson(StringBuilder sb)
        {
            lock (_gate)
            {
                long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                long clock = Stopwatch.GetTimestamp();
                double seconds = (clock - _lastClock) / (double)Stopwatch.Frequency;
                bool available = _running && _ready && _error == 0 && seconds > 0;
                sb.Append("{\"available\":").Append(available ? "true" : "false")
                  .Append(",\"code\":").Append(_error).Append(",\"from\":").Append(_from)
                  .Append(",\"t\":").Append(now).Append(",\"pids\":{");
                bool first = true;
                if (available) foreach (var pair in _bytes)
                {
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append('"').Append(pair.Key).Append("\":")
                      .Append((pair.Value / seconds).ToString("0.###", CultureInfo.InvariantCulture));
                }
                sb.Append("}}");
                _bytes.Clear();
                _ready = true;
                _from = now;
                _lastClock = clock;
            }
        }

        public void Dispose()
        {
            _running = false;
            if (_session != 0) { ControlTrace(_session, _name, _properties, 1); _session = 0; }
            if (_consumer != ulong.MaxValue) { CloseTrace(_consumer); _consumer = ulong.MaxValue; }
            _thread?.Join(2000);
            if (_properties != IntPtr.Zero) { Marshal.FreeHGlobal(_properties); _properties = IntPtr.Zero; }
            GC.KeepAlive(_eventCallback);
            GC.KeepAlive(_bufferCallback);
        }
    }
}
