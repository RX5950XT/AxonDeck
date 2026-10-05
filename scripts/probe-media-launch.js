'use strict'
// 真正的啟動選項＋Win32 可見狀態；畫面外、靜音，只收本輪播放器。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { spawn, execFileSync } = require('node:child_process')
const { tempDir } = require('./lib/test-temp')
const root = path.resolve(__dirname, '..')
const resources = process.env.AXONDECK_EXE ? path.join(path.dirname(process.env.AXONDECK_EXE), 'resources') : path.join(root, 'resources')
const source = process.env.AXONDECK_EXE
  ? require('@electron/asar').extractFile(path.join(resources, 'app.asar'), path.join('src', 'main', 'media-player.js')).toString()
  : fs.readFileSync(path.join(root, 'src/main/media-player.js'), 'utf8')
const dir = tempDir('media-visible-')
const probe = path.join(dir, 'window.ps1')
fs.writeFileSync(probe, `param([int]$PlayerPid)
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MediaLaunchWindow {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
}
'@
$script:result=$null
[MediaLaunchWindow]::EnumWindows({ param($h,$p)
 [uint32]$windowPid=0
 [void][MediaLaunchWindow]::GetWindowThreadProcessId($h,[ref]$windowPid)
 $name=New-Object Text.StringBuilder 128
 [void][MediaLaunchWindow]::GetClassName($h,$name,128)
 if ($windowPid -eq $PlayerPid -and $name.ToString() -eq 'AxonDeckMedia') {
  $rect=New-Object MediaLaunchWindow+Rect
  [void][MediaLaunchWindow]::GetWindowRect($h,[ref]$rect)
  $script:result=@{ visible=[MediaLaunchWindow]::IsWindowVisible($h); offscreen=($rect.Right -lt 0 -and $rect.Bottom -lt 0); foreground=([MediaLaunchWindow]::GetForegroundWindow() -eq $h) }
 }
 return $true
},[IntPtr]::Zero) | Out-Null
$script:result | ConvertTo-Json -Compress
`)
const audio = Buffer.alloc(44 + 16000)
audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40)
const file = path.join(dir, '音樂.wav')
fs.writeFileSync(file, audio)
const image = path.join(dir, '圖片.png')
const video = path.join(dir, '影片.mp4')
execFileSync(path.join(resources, 'media/magick.exe'), ['-size', '16x16', 'xc:#78a3b5', image], { windowsHide: true, stdio: 'ignore' })
execFileSync(require('ffmpeg-static'), ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=16x16:rate=4', '-t', '1', '-c:v', 'libx264', video], { windowsHide: true, stdio: 'ignore' })

async function check(hidden, target = file) {
  let child
  const context = { Buffer, module: { exports: {} }, process: { env: {} }, require: (name) => {
    if (name === 'path') return path
    if (name === './raw-fs') return { promises: fs.promises }
    if (name === './media-formats.json') return require('../src/main/media-formats.json')
    if (name === './native-probe') return { resolveProbeExe: () => path.join(resources, 'media/axondeck-media.exe') }
    if (name === 'electron') return { shell: {} }
    if (name === 'child_process') return { spawn: (exe, args, options) => {
      assert.equal(options.windowsHide, hidden, '畫面外模式會略過正常啟動的隱藏行為，另核對啟動選項')
      child = spawn(exe, ['--offscreen', `--probe=${path.join(dir, `${path.basename(target)}-${hidden}.json`)}`, '--probe-wait=20', ...args], options)
      return child
    } }
    throw new Error(name)
  } }
  vm.runInNewContext(source, context)
  try {
    await context.module.exports.openMedia(target, { hidden })
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const window = JSON.parse(execFileSync('powershell', ['-NoProfile', '-File', probe, '-PlayerPid', String(child.pid)], { windowsHide: true, encoding: 'utf8' }).trim())
    console.log(JSON.stringify({ format: path.extname(target), hidden, ...window }))
    assert.ok(window?.offscreen, '驗收視窗必須留在畫面外')
    assert.equal(window.foreground, false, '不得搶焦點')
    assert.equal(window.visible, !hidden, '正常開啟應顯示；明確隱藏時不顯示')
  } finally {
    if (child?.pid) {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* 本輪程序已退出 */ }
    }
  }
}
async function main() {
  for (const target of [file, image, video]) await check(false, target)
  await check(true)
  console.log('PASS 真播放器正常可見／背景隱藏；畫面外且未搶焦點')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
