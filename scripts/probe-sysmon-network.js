'use strict'

// 無 UAC、無硬體控制。測試真正的 ETW API 與 EStats 權限，並驗 manifest / x64 ABI。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const dir = tempDir('sysmon-network-')
fs.copyFileSync(path.join(__dirname, '../native/sysmon-sensors/ProcessNetwork.cs'), path.join(dir, 'ProcessNetwork.cs'))
fs.writeFileSync(path.join(dir, 'probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><PlatformTarget>x64</PlatformTarget></PropertyGroup></Project>')
const abiDir = path.join(dir, 'abi')
fs.mkdirSync(path.join(abiDir, 'src'), { recursive: true })
fs.writeFileSync(path.join(abiDir, 'Cargo.toml'), '[package]\nname="sysmon-etw-abi"\nversion="0.1.0"\nedition="2024"\n[dependencies]\nwindows={version="=0.62.2",features=["Win32_System_Diagnostics_Etw","Win32_System_Time","Win32_Security"]}\n')
fs.writeFileSync(path.join(abiDir, 'src/main.rs'), String.raw`
use std::mem::{size_of, offset_of};
use windows::Win32::System::Diagnostics::Etw::{EVENT_TRACE_LOGFILEW, EVENT_TRACE_PROPERTIES, EVENT_RECORD};
fn main() {
  assert_eq!(size_of::<EVENT_TRACE_PROPERTIES>(), 120);
  assert_eq!(size_of::<EVENT_TRACE_LOGFILEW>(), 448);
  assert_eq!(offset_of!(EVENT_TRACE_LOGFILEW, LoggerName), 8);
  assert_eq!(offset_of!(EVENT_TRACE_LOGFILEW, Anonymous1), 28);
  assert_eq!(offset_of!(EVENT_TRACE_LOGFILEW, BufferCallback), 400);
  assert_eq!(offset_of!(EVENT_TRACE_LOGFILEW, EventsLost), 416);
  assert_eq!(offset_of!(EVENT_TRACE_LOGFILEW, Anonymous2), 424);
  assert_eq!(offset_of!(EVENT_RECORD, UserDataLength), 86);
  assert_eq!(offset_of!(EVENT_RECORD, UserData), 96);
  println!("PASS Windows SDK ETW x64 ABI");
}`)
const abi = spawnSync('cargo', ['run', '--offline', '--quiet', '--manifest-path', path.join(abiDir, 'Cargo.toml')],
  { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
if (abi.status !== 0) throw new Error(`ETW ABI failed: ${abi.stderr}`)
console.log(abi.stdout.trim())
fs.writeFileSync(path.join(dir, 'Program.cs'), String.raw`
using System;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Threading;
using VoiceInkSensors;

class Probe {
  [StructLayout(LayoutKind.Sequential)] struct TcpRow { public uint state, localAddr, localPort, remoteAddr, remotePort; }
  [DllImport("iphlpapi.dll")] static extern uint SetPerTcpConnectionEStats(ref TcpRow row, int type, ref int rw, uint version, uint size, uint offset);
  static uint Port(int port) { return (uint)(((port & 255) << 8) | (port >> 8)); }
  static void Main() {
    var type = typeof(ProcessNetwork);
    if (Marshal.SizeOf(type.GetNestedType("Logfile", BindingFlags.NonPublic)) != 448) throw new Exception("ABI");
    using var network = new ProcessNetwork();
    var warmup = new StringBuilder(); network.AppendJson(warmup);
    using var listener = new TcpListener(IPAddress.Loopback, 0); listener.Start();
    using var client = new TcpClient(); client.Connect(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
    using var server = listener.AcceptTcpClient();
    var local = (IPEndPoint)client.Client.LocalEndPoint;
    var remote = (IPEndPoint)client.Client.RemoteEndPoint;
    var row = new TcpRow { state = 5, localAddr = BitConverter.ToUInt32(local.Address.GetAddressBytes()), localPort = Port(local.Port), remoteAddr = BitConverter.ToUInt32(remote.Address.GetAddressBytes()), remotePort = Port(remote.Port) };
    int enabled = 1;
    uint statsCode = SetPerTcpConnectionEStats(ref row, 1, ref enabled, 0, 4, 0);
    var bytes = new byte[64000]; client.GetStream().Write(bytes); server.GetStream().ReadExactly(bytes);
    using var udpServer = new UdpClient(new IPEndPoint(IPAddress.Loopback, 0));
    using var udpClient = new UdpClient();
    udpClient.Send(new byte[2048], 2048, (IPEndPoint)udpServer.Client.LocalEndPoint);
    IPEndPoint endpoint = null; udpServer.Receive(ref endpoint);
    Thread.Sleep(2200);
    var live = new StringBuilder(); network.AppendJson(live);
    bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
    Console.WriteLine(JsonSerializer.Serialize(new { elevated, statsCode, etw = JsonDocument.Parse(live.ToString()).RootElement, pid = Environment.ProcessId }));
    // 合成事件驗解析本體，不取代上方的真 API 證據。
    var record = Marshal.AllocHGlobal(112); var data = Marshal.AllocHGlobal(8);
    try {
      Marshal.Copy(new byte[112], 0, record, 112);
      Marshal.StructureToPtr(new Guid("7dd42a49-5329-4832-8dfd-43d979153a88"), IntPtr.Add(record, 24), false);
      Marshal.WriteInt16(record, 86, 8); Marshal.WriteIntPtr(record, 96, data);
      Marshal.WriteInt32(data, 0, 77); Marshal.WriteInt32(data, 4, 1024);
      var onEvent = type.GetMethod("OnEvent", BindingFlags.NonPublic | BindingFlags.Instance);
      var dictionary = (System.Collections.IDictionary)type.GetField("_bytes", BindingFlags.NonPublic | BindingFlags.Instance).GetValue(network);
      foreach (short id in new short[] {10, 11, 26, 27, 42, 43, 58, 59}) { Marshal.WriteInt16(record, 40, id); onEvent.Invoke(network, new object[]{record}); }
      if ((ulong)dictionary[(uint)77] != 8192) throw new Exception("TCP/UDP PID/size");
      Marshal.WriteInt16(record, 40, 14); onEvent.Invoke(network, new object[]{record});
      if ((ulong)dictionary[(uint)77] != 8192) throw new Exception("retransmit counted twice");
      Console.WriteLine("PASS ETW TCP/UDP IPv4/IPv6 payload, ignores retransmit");
    } finally { Marshal.FreeHGlobal(record); Marshal.FreeHGlobal(data); }
  }
}`)
const run = spawnSync('dotnet', ['run', '--project', path.join(dir, 'probe.csproj'), '-c', 'Release', '--verbosity', 'quiet'],
  { encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })
if (run.status !== 0) throw new Error(`network probe failed: ${run.error?.code || run.stderr || run.stdout}`)
const json = run.stdout.split(/\r?\n/).find((line) => line.startsWith('{"elevated"'))
const result = JSON.parse(json)
if (!result.elevated) {
  assert.equal(result.statsCode, 5, '一般權限 EStats 收集被拒絕')
  assert.equal(result.etw.available, false, 'ETW 失敗不可回報 0')
  assert.equal(result.etw.code, 5, '一般權限 ETW 被拒絕')
} else {
  assert.equal(result.etw.available, true)
  assert.ok(result.etw.pids[result.pid] > 0, '真實 TCP/UDP 流量要出现在該 PID')
}
console.log(JSON.stringify({ elevated: result.elevated, estatsCode: result.statsCode, etwAvailable: result.etw.available, etwCode: result.etw.code }))
console.log(run.stdout.split(/\r?\n/).find((line) => line.startsWith('PASS ')))
