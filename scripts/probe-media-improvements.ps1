param(
  [string]$Runtime = (Join-Path $PSScriptRoot '../resources/media'),
  [string]$File = (Join-Path $PSScriptRoot '../dist-media-qa/ui-v4/many-images/image-00.png'),
  [string]$Output = (Join-Path $PSScriptRoot '../dist-media-qa/improvements'),
  [switch]$Features
)
$ErrorActionPreference = 'Stop'
# 沿用既有背景 HWND / PrintWindow 工具，略過它的執行區。
$source = Get-Content (Join-Path $PSScriptRoot 'probe-media-window.ps1') -Raw
$start = $source.IndexOf('$ErrorActionPreference')
$end = $source.IndexOf('$Runtime = [IO.Path]::GetFullPath($Runtime)')
if ($start -lt 0 -or $end -le $start) { throw '找不到背景測試共用工具' }
Invoke-Expression $source.Substring($start,$end-$start)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MediaEditProbe {
 [DllImport("user32.dll", EntryPoint="SendMessageW", CharSet=CharSet.Unicode)]
 public static extern IntPtr Text(IntPtr h,uint message,IntPtr w,string text);
}
'@
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force $Output | Out-Null
$Theme = 'dark'
$foregroundBefore = [MediaWindowProbe]::GetForegroundWindow()
$report = Join-Path $Output 'state.json'
$playerArgs = @('--offscreen','--theme=dark',"--probe=`"$report`"",'--probe-wait=24','--',"`"$File`"")
$playerProcess = Start-Process (Join-Path ([IO.Path]::GetFullPath($Runtime)) 'axondeck-media.exe') -ArgumentList $playerArgs -WindowStyle Hidden -PassThru
$checks = [ordered]@{}
try {
  Start-Sleep -Milliseconds 1000
  $script:mediaHandle = [IntPtr]::Zero
  [void][MediaWindowProbe]::EnumWindows({ param($h,$p)
    [uint32]$windowPid=0; [void][MediaWindowProbe]::GetWindowThreadProcessId($h,[ref]$windowPid)
    $name=New-Object Text.StringBuilder 128; [void][MediaWindowProbe]::GetClassName($h,$name,128)
    if ($windowPid -eq $playerProcess.Id -and $name.ToString() -eq 'AxonDeckMedia') { $script:mediaHandle=$h; return $false }
    return $true
  },[IntPtr]::Zero)
  if ($script:mediaHandle -eq [IntPtr]::Zero) { throw '找不到本輪播放器' }
  [void][MediaWindowProbe]::SetWindowPos($script:mediaHandle,[IntPtr]::Zero,0,0,640,430,0x16)
  [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]102,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  $queue=[MediaWindowProbe]::GetDlgItem($script:mediaHandle,111)
  $title=New-Object Text.StringBuilder 512
  [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$title,512); $before=$title.ToString()
  [void][MediaWindowProbe]::PostMessage($queue,0x100,[IntPtr]0x22,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 250
  [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$title,512)
  $checks.queuePageKeys = ($before -eq $title.ToString() -and [MediaWindowProbe]::SendMessage($queue,0x188,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0)
  if ($before -ne $title.ToString()) { [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]104,[IntPtr]::Zero); Start-Sleep -Milliseconds 200 }
  $checks.sliderPageKeys = $true
  foreach ($id in @(110)) {
    $slider=[MediaWindowProbe]::GetDlgItem($script:mediaHandle,$id)
    [void][MediaWindowProbe]::SendMessage($slider,0x405,[IntPtr]::Zero,[IntPtr]20)
    [void][MediaWindowProbe]::PostMessage($slider,0x100,[IntPtr]0x22,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$title,512)
    $checks.sliderPageKeys = ($checks.sliderPageKeys -and $before -eq $title.ToString() -and [MediaWindowProbe]::SendMessage($slider,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 20)
    if ($before -ne $title.ToString()) { [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]104,[IntPtr]::Zero); Start-Sleep -Milliseconds 200 }
  }
  [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]103,[IntPtr]::Zero)
  Start-Sleep -Milliseconds 150
  $menu=Find-OwnedMenu
  if ($menu -eq [IntPtr]::Zero) { throw '找不到自繪選單' }
  [void][MediaWindowProbe]::SendMessage($menu,0x20a,[IntPtr](-7864320),[IntPtr]::Zero)
  Save-NativeWindow $menu 'menu'
  $bitmap=[Drawing.Bitmap]::FromFile((Join-Path $Output 'menu-dark.png'))
  $highlight=0
  try { for ($y=48;$y -lt $bitmap.Height-30;$y++) { $c=$bitmap.GetPixel(16,$y); if ($c.R -eq 40 -and $c.G -eq 59 -and $c.B -eq 68) { $highlight++ } } }
  finally { $bitmap.Dispose() }
  $checks.menuScrollSelection = ($highlight -gt 0)
  [void][MediaWindowProbe]::PostMessage($menu,0x100,[IntPtr]0x1b,[IntPtr]::Zero)
  if ($Features) {
    $search=[MediaWindowProbe]::GetDlgItem($script:mediaHandle,241)
    if ($search -eq [IntPtr]::Zero) { throw '沒有清單搜尋欄' }
    [void][MediaEditProbe]::Text($search,0x0c,[IntPtr]::Zero,'image-03')
    Start-Sleep -Milliseconds 300
    $checks.queueSearch = ([MediaWindowProbe]::SendMessage($queue,0x18b,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 1)
    [void][MediaWindowProbe]::SendMessage($queue,0x186,[IntPtr]::Zero,[IntPtr]::Zero)
    [void][MediaWindowProbe]::PostMessage($queue,0x100,[IntPtr]0x0d,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$title,512)
    $checks.filteredEnter = $title.ToString().StartsWith('image-03')
    [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]240,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    $checks.queueRemove = ([MediaWindowProbe]::SendMessage($queue,0x18b,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 0 -and (Test-Path (Join-Path ([IO.Path]::GetDirectoryName($File)) 'image-03.png')))
    [void][MediaEditProbe]::Text($search,0x0c,[IntPtr]::Zero,'')
    Start-Sleep -Milliseconds 350
    $checks.searchClear = ([MediaWindowProbe]::SendMessage($queue,0x18b,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 49)
    [void][MediaEditProbe]::Text($search,0x0c,[IntPtr]::Zero,'image')
    [void][MediaWindowProbe]::SendMessage($search,0x7b,$search,[IntPtr](-1))
    Start-Sleep -Milliseconds 150
    $editMenu=Find-OwnedMenu
    $checks.searchCustomMenu = ($editMenu -ne [IntPtr]::Zero)
    if (-not $checks.searchCustomMenu) { throw '搜尋欄未使用自繪選單' }
    Save-NativeWindow $editMenu 'search-menu'
    [void][MediaWindowProbe]::PostMessage($editMenu,0x111,[IntPtr]1004,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    $checks.searchSelectAll = ([MediaWindowProbe]::SendMessage($search,0xb0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -eq 327680)
    [void][MediaEditProbe]::Text($search,0x0c,[IntPtr]::Zero,'')
    Start-Sleep -Milliseconds 350
    Save-NativeWindow $script:mediaHandle 'queue'
  }
  $checks.focusKept = ($foregroundBefore -eq [MediaWindowProbe]::GetForegroundWindow())
  $checks | ConvertTo-Json | Set-Content (Join-Path $Output 'checks.json')
  $checks | ConvertTo-Json -Compress
  if ($checks.Values -contains $false) { throw '改善驗證有失敗項目' }
  [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x10,[IntPtr]::Zero,[IntPtr]::Zero)
  if (-not $playerProcess.WaitForExit(5000)) { throw '播放器未正常結束' }
  if ($playerProcess.ExitCode -ne 0) { throw '播放器退出失敗' }
} finally { if (-not $playerProcess.HasExited) { Stop-Process -Id $playerProcess.Id -Force } }
