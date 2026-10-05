param(
  [string]$Runtime = (Join-Path $PSScriptRoot '../resources/media'),
  [string]$File,
  [string]$Output,
  [string]$Theme = 'dark',
  [switch]$ExerciseUi,
  [switch]$ExerciseMenu,
  [switch]$ExerciseResize,
  [int]$Width = 0,
  [int]$Height = 0
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MediaWindowProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out Rect r);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref Point p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr rect, bool erase);
  [DllImport("user32.dll")] public static extern bool GetUpdateRect(IntPtr h, IntPtr rect, bool erase);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr GetProp(IntPtr h, string name);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
}
'@
function Get-SliderThumbX([IntPtr]$Control, [int]$Value) {
  [void][MediaWindowProbe]::SendMessage($Control, 0x405, [IntPtr]::Zero, [IntPtr]$Value)
  [void][MediaWindowProbe]::InvalidateRect($Control, [IntPtr]::Zero, $false)
  $r = New-Object MediaWindowProbe+Rect
  [void][MediaWindowProbe]::GetWindowRect($Control, [ref]$r)
  $bitmap = New-Object Drawing.Bitmap ($r.Right-$r.Left), ($r.Bottom-$r.Top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc()
  try { [void][MediaWindowProbe]::PrintWindow($Control, $dc, 2) }
  finally { $graphics.ReleaseHdc($dc) }
  $accent = if ($Theme -eq 'dark') { @(120,163,181) } else { @(61,106,125) }
  $pixels = @()
  for ($x=0; $x -lt $bitmap.Width; $x++) {
    $color = $bitmap.GetPixel($x, [int]($bitmap.Height/2)-4)
    if ($color.R -eq $accent[0] -and $color.G -eq $accent[1] -and $color.B -eq $accent[2]) { $pixels += $x }
  }
  $graphics.Dispose(); $bitmap.Dispose()
  if ($pixels.Count -eq 0) { throw '滑桿沒有畫出圓點' }
  return ($pixels | Measure-Object -Average).Average
}
function Find-OwnedMenu {
  $script:popupHandle = [IntPtr]::Zero
  [void][MediaWindowProbe]::EnumWindows({ param($h,$p)
    [uint32]$windowPid = 0; [void][MediaWindowProbe]::GetWindowThreadProcessId($h,[ref]$windowPid)
    $name = New-Object Text.StringBuilder 128; [void][MediaWindowProbe]::GetClassName($h,$name,128)
    if ($windowPid -eq $playerProcess.Id -and $name.ToString() -eq 'AxonDeckMediaMenu') { $script:popupHandle = $h; return $false }
    return $true
  },[IntPtr]::Zero)
  return $script:popupHandle
}
function Find-MenuButton([IntPtr]$Menu,[string]$Label) {
  $script:rowHandle = [IntPtr]::Zero
  [void][MediaWindowProbe]::EnumChildWindows($Menu,{ param($h,$p)
    $name = New-Object Text.StringBuilder 256; [void][MediaWindowProbe]::GetWindowText($h,$name,256)
    if ($name.ToString().StartsWith($Label)) { $script:rowHandle=$h; return $false }
    return $true
  },[IntPtr]::Zero)
  if ($script:rowHandle -eq [IntPtr]::Zero) { throw "找不到自繪選單項目：$Label" }
  return $script:rowHandle
}
function Save-NativeWindow([IntPtr]$Handle,[string]$Name) {
  Assert-OwnedBackground
  $r=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetWindowRect($Handle,[ref]$r)
  $bitmap=New-Object Drawing.Bitmap ($r.Right-$r.Left),($r.Bottom-$r.Top)
  $graphics=[Drawing.Graphics]::FromImage($bitmap); $dc=$graphics.GetHdc()
  try {
    # 自繪 popup 使用 PrintWindow 標準旗標；2 在畫面外截圖可能漏掉 child surface。
    if ($Name -eq 'menu' -or $Name -eq 'submenu') { [void][MediaWindowProbe]::PrintWindow($Handle,$dc,0) }
    else { [void][MediaWindowProbe]::PrintWindow($Handle,$dc,2) }
  } finally { $graphics.ReleaseHdc($dc) }
  if ($Name -eq 'queue-content') {
    $seek=[MediaWindowProbe]::GetDlgItem($Handle,109)
    if ([MediaWindowProbe]::IsWindowVisible($seek)) {
      $seekRect=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetWindowRect($seek,[ref]$seekRect)
      $accent=if ($Theme -eq 'dark') { @(120,163,181) } else { @(61,106,125) }
      $ink=0; $y=[int](($seekRect.Top+$seekRect.Bottom)/2)-$r.Top-4
      for ($x=$seekRect.Left-$r.Left;$x -lt $seekRect.Right-$r.Left;$x++) {
        $color=$bitmap.GetPixel($x,$y)
        if ($color.R -eq $accent[0] -and $color.G -eq $accent[1] -and $color.B -eq $accent[2]) { $ink++ }
      }
      if ($ink -lt 4) { throw '拖曳畫面缺少時間條圓點' }
      $color=$bitmap.GetPixel($seekRect.Left-$r.Left+2,$seekRect.Top-$r.Top+2)
      $background=if ($Theme -eq 'dark') { @(17,20,23) } else { @(238,243,240) }
      if ($color.R -ne $background[0] -or $color.G -ne $background[1] -or $color.B -ne $background[2]) { throw "時間條底色閃回系統樣式：$color" }
    }
    $queue=[MediaWindowProbe]::GetDlgItem($Handle,111)
    $child=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetWindowRect($queue,[ref]$child)
    $crop=New-Object Drawing.Rectangle ($child.Left-$r.Left),($child.Top-$r.Top),($child.Right-$child.Left),($child.Bottom-$child.Top)
    $cropped=$bitmap.Clone($crop,$bitmap.PixelFormat); $graphics.Dispose(); $bitmap.Dispose()
    $bitmap=$cropped; $graphics=[Drawing.Graphics]::FromImage($bitmap); $Handle=$queue
  }
  $bitmap.Save((Join-Path $Output "$Name-$Theme.png"),[Drawing.Imaging.ImageFormat]::Png)
  $missing=0
  if ($Name -eq 'queue-content') {
    $count=[MediaWindowProbe]::SendMessage($Handle,0x18b,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
    $row=[MediaWindowProbe]::SendMessage($Handle,0x1a1,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
    $samples=0
    for ($y=$count*$row+8;$y -lt $bitmap.Height-8;$y+=13) {
      for ($x=12;$x -lt $bitmap.Width-16;$x+=17) {
        $color=$bitmap.GetPixel($x,$y); $samples++
        if ($color.R -ne 28 -or $color.G -ne 33 -or $color.B -ne 35) { throw "播放清單空白區底色錯誤：$color at $x,$y" }
      }
    }
    $metrics.queueBlankDarkPixels=$samples
  }
  if ($Name -eq 'menu' -or $Name -eq 'submenu') {
    $speed=[MediaWindowProbe]::GetDlgItem($Handle,243)
    if ($speed -ne [IntPtr]::Zero) {
      $sliderRect=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetWindowRect($speed,[ref]$sliderRect)
      $accent=if ($Theme -eq 'dark') { @(120,163,181) } else { @(61,106,125) }
      $thumbPixels=0; $y=$sliderRect.Top-$r.Top+[int](($sliderRect.Bottom-$sliderRect.Top)/2)-4
      for ($x=$sliderRect.Left-$r.Left;$x -lt $sliderRect.Right-$r.Left;$x++) {
        $color=$bitmap.GetPixel($x,$y)
        if ($color.R -eq $accent[0] -and $color.G -eq $accent[1] -and $color.B -eq $accent[2]) { $thumbPixels++ }
      }
      if ($thumbPixels -lt 4) { throw '倍速滑桿沒有畫出圓點或被白底蓋掉' }
    }
    $scale=[MediaWindowProbe]::GetDpiForWindow($Handle)/96
    for ($y=[int](48*$scale);$y -lt $bitmap.Height-[int](30*$scale);$y+=4) {
      $color=$bitmap.GetPixel([int](16*$scale),$y)
      if ($color.R -eq 0 -and $color.G -eq 0 -and $color.B -eq 0) { $missing++ }
    }
  }
  $graphics.Dispose(); $bitmap.Dispose()
  if ($missing -gt 8) { throw '選單有未繪製的黑色空白列' }
}
function Assert-OwnedBackground {
  [uint32]$foregroundPid=0
  [void][MediaWindowProbe]::GetWindowThreadProcessId([MediaWindowProbe]::GetForegroundWindow(),[ref]$foregroundPid)
  $script:focusSamples++
  if ($foregroundPid -eq $playerProcess.Id -or ($decoderProcess -and $foregroundPid -eq $decoderProcess.ProcessId)) { throw '本輪播放器或 decoder 搶到焦點' }
}
$Runtime = [IO.Path]::GetFullPath($Runtime)
$File = [IO.Path]::GetFullPath($File)
$Output = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Force $Output | Out-Null
$foregroundBefore = [MediaWindowProbe]::GetForegroundWindow()
$script:focusSamples=0
$reportPath = Join-Path $Output "window-$Theme.json"
$playerArgs = @('--offscreen', "--theme=$Theme", "--probe=`"$reportPath`"", $(if ($ExerciseResize) { '--probe-wait=25' } else { '--probe-wait=12' }), '--', "`"$File`"")
$playerProcess = Start-Process (Join-Path $Runtime 'axondeck-media.exe') -ArgumentList $playerArgs -WindowStyle Hidden -PassThru
try {
  Start-Sleep -Milliseconds 1200
  $script:mediaHandle = [IntPtr]::Zero
  [MediaWindowProbe]::EnumWindows({ param($h, $p)
    [uint32]$windowPid = 0
    [void][MediaWindowProbe]::GetWindowThreadProcessId($h, [ref]$windowPid)
    $class = New-Object Text.StringBuilder 128
    [void][MediaWindowProbe]::GetClassName($h, $class, 128)
    if ($windowPid -eq $playerProcess.Id -and $class.ToString() -eq 'AxonDeckMedia') { $script:mediaHandle = $h; return $false }
    return $true
  }, [IntPtr]::Zero) | Out-Null
  if ($script:mediaHandle -eq [IntPtr]::Zero) { throw '找不到測試視窗' }
  Assert-OwnedBackground
  if ($Width -gt 0 -and $Height -gt 0) {
    [void][MediaWindowProbe]::SetWindowPos($script:mediaHandle, [IntPtr]::Zero, 0, 0, $Width, $Height, 0x16)
    Start-Sleep -Milliseconds 200
  }
  $windowRect = New-Object MediaWindowProbe+Rect
  [void][MediaWindowProbe]::GetWindowRect($script:mediaHandle, [ref]$windowRect)
  $bitmap = New-Object Drawing.Bitmap ($windowRect.Right-$windowRect.Left), ($windowRect.Bottom-$windowRect.Top)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $dc = $graphics.GetHdc()
  try {
    [void][MediaWindowProbe]::PrintWindow($script:mediaHandle, $dc, 2)
  }
  finally { $graphics.ReleaseHdc($dc) }
  $bitmap.Save((Join-Path $Output "window-$Theme.png"), [Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $bitmap.Dispose()
  $decoderProcess = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($playerProcess.Id) AND Name='mpv.exe'" | Select-Object -First 1
  if (-not $decoderProcess) { throw '找不到本輪 decoder' }
  $nativeBefore = Get-Process -Id $playerProcess.Id
  $decoderBefore = Get-Process -Id $decoderProcess.ProcessId
  $nativeCpu = $nativeBefore.TotalProcessorTime.TotalMilliseconds
  $decoderCpu = $decoderBefore.TotalProcessorTime.TotalMilliseconds
  Start-Sleep -Milliseconds 2000
  $nativeAfter = Get-Process -Id $playerProcess.Id
  $decoderAfter = Get-Process -Id $decoderProcess.ProcessId
  $metrics = [ordered]@{
    nativeMiB = [math]::Round($nativeAfter.WorkingSet64/1MB, 2)
    decoderMiB = [math]::Round($decoderAfter.WorkingSet64/1MB, 2)
    nativeCpuCorePercent = [math]::Round(($nativeAfter.TotalProcessorTime.TotalMilliseconds-$nativeCpu)/2000*100, 2)
    decoderCpuCorePercent = [math]::Round(($decoderAfter.TotalProcessorTime.TotalMilliseconds-$decoderCpu)/2000*100, 2)
    focusKept = ([MediaWindowProbe]::GetForegroundWindow() -eq $foregroundBefore)
    offscreen = ($windowRect.Right -lt 0 -and $windowRect.Bottom -lt 0)
  }
  # 用真正的 Win32 控制，背景測試清單／縮放，不送全域滑鼠鍵盤。
  [void][MediaWindowProbe]::SendMessage($script:mediaHandle, 0x111, [IntPtr]102, [IntPtr]::Zero)
  $metrics.queueShown = (([MediaWindowProbe]::GetWindowLong([MediaWindowProbe]::GetDlgItem($script:mediaHandle, 111), -16) -band 0x10000000) -ne 0)
  Start-Sleep -Milliseconds 100
  Save-NativeWindow $script:mediaHandle 'queue-content'
  if ($ExerciseResize) {
    $play=[MediaWindowProbe]::GetDlgItem($script:mediaHandle,105)
    foreach ($toggle in 1..2) {
      $label=New-Object Text.StringBuilder 128
      [void][MediaWindowProbe]::GetWindowText($play,$label,128)
      $expected=if ($label.ToString().StartsWith('暫停')) { 2 } else { 1 }
      [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]105,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 300
      # 不送滑鼠離開、不截圖強迫重畫；只讀實際 WM_DRAWITEM 完成後的記號。
      if ([MediaWindowProbe]::GetProp($play,'AxonDeckPaintedPause').ToInt64() -ne $expected) { throw '播放／暫停圖示沒有自行更新' }
    }
    $metrics.pausePaintWithoutMouse=$true
    $playLabel=New-Object Text.StringBuilder 128
    [void][MediaWindowProbe]::GetWindowText([MediaWindowProbe]::GetDlgItem($script:mediaHandle,105),$playLabel,128)
    if ($playLabel.ToString().StartsWith('暫停')) { [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]105,[IntPtr]::Zero) }
    Start-Sleep -Milliseconds 200
    $client=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetClientRect($script:mediaHandle,[ref]$client)
    $scale=[MediaWindowProbe]::GetDpiForWindow($script:mediaHandle)/96
    $widths=@(240..520 | Where-Object { ($_-240)%28 -eq 0 }); $reverse=$widths.Clone(); [array]::Reverse($reverse)
    $metrics.resizeFrames=0
    # 只在 --probe 畫面外實例設定拖曳旗標；不呼叫 SetCapture、不碰滑鼠。
    [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x8007,[IntPtr]1,[IntPtr]::Zero)
    try {
      foreach ($empty in @($false,$true)) {
        if ($empty) { [void][MediaWindowProbe]::SendMessage([MediaWindowProbe]::GetDlgItem($script:mediaHandle,111),0x184,[IntPtr]::Zero,[IntPtr]::Zero) }
        foreach ($width in @($widths)+@($reverse)) {
          $x=$client.Right-[int]($width*$scale)
          [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x200,[IntPtr]1,[IntPtr](($x -band 0xffff) -bor (100 -shl 16)))
          if ([MediaWindowProbe]::GetUpdateRect($script:mediaHandle,[IntPtr]::Zero,$false)) { throw '側欄拖動後主畫面仍未重畫' }
          Save-NativeWindow $script:mediaHandle 'queue-content'; $metrics.resizeFrames++
        }
      }
    } finally { [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x8007,[IntPtr]::Zero,[IntPtr]::Zero) }
    if ($metrics.resizeFrames -ne 44) { throw '未完成連續拖曳畫面驗證' }
    $metrics.resizeSliderStable=$true
    foreach ($windowWidth in @(1060,980,900,1060)) {
      [void][MediaWindowProbe]::SetWindowPos($script:mediaHandle,[IntPtr]::Zero,0,0,$windowWidth,880,0x16)
      if ([MediaWindowProbe]::GetUpdateRect($script:mediaHandle,[IntPtr]::Zero,$false)) { throw '視窗縮放後主畫面仍未重畫' }
      Save-NativeWindow $script:mediaHandle 'queue-content'
    }
    $metrics.windowResizePainted=$true
  }
  if ($ExerciseMenu) {
    $queue=[MediaWindowProbe]::GetDlgItem($script:mediaHandle,111)
    $metrics.queueRowDips=[math]::Round([MediaWindowProbe]::SendMessage($queue,0x1a1,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64()*96/[MediaWindowProbe]::GetDpiForWindow($queue),1)
    if ($metrics.queueRowDips -ne 62) { throw '播放清單仍是舊版列高' }
    [void][MediaWindowProbe]::SendMessage($queue,0x200,[IntPtr]::Zero,[IntPtr]0x00140014)
    $metrics.queueHover=([MediaWindowProbe]::GetProp($queue,'AxonDeckQueueHover').ToInt64() -eq 1)
    if (-not $metrics.queueHover) { throw "清單 hover 沒有更新：hover=$([MediaWindowProbe]::GetProp($queue,'AxonDeckQueueHover').ToInt64()) top=$([MediaWindowProbe]::SendMessage($queue,0x18e,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64()) point=$([MediaWindowProbe]::SendMessage($queue,0x1a9,[IntPtr]::Zero,[IntPtr]0x00140014).ToInt64())" }
    $count=[MediaWindowProbe]::SendMessage($queue,0x18b,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64()
    $area=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetClientRect($queue,[ref]$area)
    if ($count*62*[MediaWindowProbe]::GetDpiForWindow($queue)/96 -gt $area.Bottom) {
      [void][MediaWindowProbe]::SendMessage($queue,0x20a,[IntPtr](-7864320),[IntPtr]::Zero)
      $metrics.queueWheel=([MediaWindowProbe]::SendMessage($queue,0x18e,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -gt 0)
      if (-not $metrics.queueWheel) { throw '長清單不能捲動' }
      Save-NativeWindow $script:mediaHandle 'queue-scroll'
      [void][MediaWindowProbe]::SendMessage($queue,0x197,[IntPtr]::Zero,[IntPtr]::Zero)
    }
    $metrics.customQueueScroll=(([MediaWindowProbe]::GetWindowLong($queue,-16) -band 0x200000) -eq 0)
    if (-not $metrics.customQueueScroll) { throw '播放清單仍使用預設系統捲軸' }
    [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]103,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 200
    $popup=Find-OwnedMenu
    if ($popup -eq [IntPtr]::Zero) { throw '更多選單不是自繪浮窗' }
    $r=New-Object MediaWindowProbe+Rect; [void][MediaWindowProbe]::GetWindowRect($popup,[ref]$r)
    if ($r.Right -ge 0 -or $r.Bottom -ge 0) { throw '選單離開背景 QA 區域' }
    Save-NativeWindow $popup 'menu'
    $isImage=([IO.Path]::GetExtension($File) -match '^\.(png|webp|svg)$')
    $branch=if ($isImage) { '輪播間隔' } else { '播放速度' }
    $row=Find-MenuButton $popup $branch
    # 真實 row hover → 子選單鍵盤 Enter；僅送本轮自有 HWND。
    [void][MediaWindowProbe]::PostMessage($row,0x200,[IntPtr]::Zero,[IntPtr]0x00100020)
    Start-Sleep -Milliseconds 100
    [void][MediaWindowProbe]::PostMessage($row,0x100,[IntPtr]0x0d,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    if (-not $isImage) {
      $popup=Find-OwnedMenu
      $speedSlider=[MediaWindowProbe]::GetDlgItem($popup,243)
      if ($speedSlider -eq [IntPtr]::Zero) { throw '播放速度仍是固定選單，沒有滑桿' }
      foreach ($value in @(0,110,111,250,375,75)) {
        [void][MediaWindowProbe]::SendMessage($speedSlider,0x405,[IntPtr]1,[IntPtr]$value)
        [void][MediaWindowProbe]::SendMessage($popup,0x114,[IntPtr]5,$speedSlider)
        Start-Sleep -Milliseconds 180
        $expected=($value+25)/100.0
        $text=New-Object Text.StringBuilder 128; [void][MediaWindowProbe]::GetWindowText([MediaWindowProbe]::GetDlgItem($script:mediaHandle,114),$text,128)
        if ($text.ToString() -ne "播放速度 $expected×") { throw "滑桿倍速未送到解碼器：$text，預期 $expected" }
      }
      foreach ($value in 0..375) {
        [void][MediaWindowProbe]::SendMessage($speedSlider,0x405,[IntPtr]1,[IntPtr]$value)
        [void][MediaWindowProbe]::SendMessage($popup,0x114,[IntPtr]5,$speedSlider)
      }
      Start-Sleep -Milliseconds 250
      if ([MediaWindowProbe]::SendMessage($speedSlider,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -ne 375) { throw '快速拖曳後倍速滑桿位置倒跳' }
      [void][MediaWindowProbe]::SendMessage($speedSlider,0x405,[IntPtr]1,[IntPtr]75)
      [void][MediaWindowProbe]::SendMessage($popup,0x114,[IntPtr]5,$speedSlider)
      Start-Sleep -Milliseconds 180
      [void][MediaWindowProbe]::PostMessage($speedSlider,0x100,[IntPtr]0x27,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 180
      if ([MediaWindowProbe]::SendMessage($speedSlider,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -ne 80) { throw '倍速滑桿方向鍵沒有微調 0.05' }
      $reset=[MediaWindowProbe]::GetDlgItem($popup,219)
      [void][MediaWindowProbe]::SendMessage($popup,0x111,[IntPtr]219,$reset)
      Start-Sleep -Milliseconds 180
      if ([MediaWindowProbe]::SendMessage($speedSlider,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt64() -ne 75) { throw '恢復 1× 沒有更新滑桿' }
      Save-NativeWindow $popup 'submenu'
      [void][MediaWindowProbe]::PostMessage($popup,0x100,[IntPtr]0x1b,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]114,[IntPtr]::Zero)
      $popup=Find-OwnedMenu
      if ([MediaWindowProbe]::GetDlgItem($popup,243) -eq [IntPtr]::Zero) { throw '工具列倍速按鈕沒有開啟滑桿' }
      [void][MediaWindowProbe]::PostMessage($popup,0x100,[IntPtr]0x1b,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 100
      $metrics.speedSliderLive=$true; $metrics.speedSliderBurst=$true; $metrics.speedSliderKeyboard=$true; $metrics.speedSliderReset=$true
    } else {
    [void](Find-MenuButton $popup '返回上一層')
    Save-NativeWindow $popup 'submenu'
    [void][MediaWindowProbe]::PostMessage($popup,0x100,[IntPtr]0x1b,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    $row=Find-MenuButton $popup $branch
    [void][MediaWindowProbe]::PostMessage($popup,0x111,[IntPtr]([MediaWindowProbe]::GetDlgCtrlID($row)),[IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    $row=Find-MenuButton $popup '5 秒'
    [void][MediaWindowProbe]::PostMessage($popup,0x111,[IntPtr]([MediaWindowProbe]::GetDlgCtrlID($row)),[IntPtr]::Zero)
    Start-Sleep -Milliseconds 150
    if ((Find-OwnedMenu) -ne [IntPtr]::Zero) { throw '確認操作後選單沒有關閉' }
    }
    $metrics.customMenu=$true; $metrics.menuKeyboard=$true; $metrics.submenuAction=$true
    [void][MediaWindowProbe]::PostMessage($script:mediaHandle,0x111,[IntPtr]103,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    $popup=Find-OwnedMenu
    [void][MediaWindowProbe]::PostMessage($popup,0x100,[IntPtr]0x1b,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    if ((Find-OwnedMenu) -ne [IntPtr]::Zero) { throw 'Esc 沒有關閉主選單' }
    $metrics.menuDismiss=$true
    if ($count -gt 3) {
      $before=New-Object Text.StringBuilder 256; [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$before,256)
      [void][MediaWindowProbe]::SendMessage($queue,0x186,[IntPtr]3,[IntPtr]::Zero)
      [void][MediaWindowProbe]::PostMessage($queue,0x100,[IntPtr]0x0d,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 200
      $after=New-Object Text.StringBuilder 256; [void][MediaWindowProbe]::GetWindowText($script:mediaHandle,$after,256)
      $metrics.queueEnter=($before.ToString() -ne $after.ToString())
      if (-not $metrics.queueEnter) { throw '清單 Enter 沒有開啟選取檔案' }
    }
    [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]238,[IntPtr]::Zero)
    $metrics.queueClose=(-not [MediaWindowProbe]::IsWindowVisible($queue))
    if (-not $metrics.queueClose) { throw '清單關閉按鈕失效' }
    [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]102,[IntPtr]::Zero)
  }
  [void][MediaWindowProbe]::SendMessage($script:mediaHandle, 0x111, [IntPtr]105, [IntPtr]::Zero)
  [void][MediaWindowProbe]::SendMessage($script:mediaHandle, 0x111, [IntPtr]105, [IntPtr]::Zero)
  if ($ExerciseUi) {
    $surface = [MediaWindowProbe]::GetDlgItem($script:mediaHandle, 120)
    $surfaceRect = New-Object MediaWindowProbe+Rect
    [void][MediaWindowProbe]::GetWindowRect($surface, [ref]$surfaceRect)
    $origin = New-Object MediaWindowProbe+Point
    $origin.X = $surfaceRect.Left; $origin.Y = $surfaceRect.Top
    [void][MediaWindowProbe]::ScreenToClient($script:mediaHandle, [ref]$origin)
    $formats = Get-Content (Join-Path $PSScriptRoot '../src/main/media-formats.json') -Raw | ConvertFrom-Json
    $isAudio = $formats.audio -contains ([IO.Path]::GetExtension($File).TrimStart('.').ToLowerInvariant())
    if (-not $isAudio) {
      $metrics.edgeToEdge = ($origin.X -eq 0 -and $origin.Y -eq 0)
      if (-not $metrics.edgeToEdge) { throw '畫面還有重複標頭或側邊留白' }
      $client = New-Object MediaWindowProbe+Rect
      [void][MediaWindowProbe]::GetClientRect($script:mediaHandle,[ref]$client)
      $dockPixels = $client.Bottom-($surfaceRect.Bottom-$surfaceRect.Top)
      $isImage = $formats.image -contains ([IO.Path]::GetExtension($File).TrimStart('.').ToLowerInvariant())
      $expectedDock = if ($isImage) { 56 } else { 80 }
      $metrics.dockDips = [math]::Round($dockPixels*96/[MediaWindowProbe]::GetDpiForWindow($script:mediaHandle),1)
      if ([math]::Abs($metrics.dockDips-$expectedDock) -gt 1) { throw "工具列高度沒有縮窄：$($metrics.dockDips)" }
    }
    $seekControl = [MediaWindowProbe]::GetDlgItem($script:mediaHandle, 109)
    if ([MediaWindowProbe]::IsWindowVisible($seekControl)) {
      $playLabel=New-Object Text.StringBuilder 128
      [void][MediaWindowProbe]::GetWindowText([MediaWindowProbe]::GetDlgItem($script:mediaHandle,105),$playLabel,128)
      if ($playLabel.ToString().StartsWith('暫停')) { [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]105,[IntPtr]::Zero) }
      Start-Sleep -Milliseconds 200
      [void][MediaWindowProbe]::SendMessage($seekControl, 0x405, [IntPtr]::Zero, [IntPtr]7500)
      [void][MediaWindowProbe]::SendMessage($script:mediaHandle, 0x114, [IntPtr]5, $seekControl)
      Start-Sleep -Milliseconds 400
      $preview = New-Object Text.StringBuilder 128
      [void][MediaWindowProbe]::GetWindowText([MediaWindowProbe]::GetDlgItem($script:mediaHandle,112),$preview,128)
      $held = [MediaWindowProbe]::SendMessage($seekControl,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
      # 本次 12 秒 fixture：拖到 75% 必須預覽 0:09，decoder 更新不能把圓點拉回去。
      $metrics.scrubPreview = ($held -eq 7500 -and $preview.ToString().StartsWith('0:09 / 0:12'))
      if (-not $metrics.scrubPreview) { throw "進度拖曳沒有保留預覽時間：$held $preview" }
      [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x114,[IntPtr]4,$seekControl)
      [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x114,[IntPtr]8,$seekControl)
      Start-Sleep -Milliseconds 400
      [void][MediaWindowProbe]::GetWindowText([MediaWindowProbe]::GetDlgItem($script:mediaHandle,112),$preview,128)
      $metrics.seekCommitted = $preview.ToString().StartsWith('0:09 / 0:12')
      if (-not $metrics.seekCommitted) { throw "放開進度條後沒有精準跳轉：$preview" }
      $lineStep = [MediaWindowProbe]::SendMessage($seekControl,0x418,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
      $pageStep = [MediaWindowProbe]::SendMessage($seekControl,0x416,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32()
      $metrics.seekKeyboardSteps = ([math]::Abs($lineStep-4167) -le 1 -and $pageStep -eq 10000)
      if (-not $metrics.seekKeyboardSteps) { throw "滑桿鍵盤步長不是 5 秒／30 秒：$lineStep / $pageStep" }
      [void][MediaWindowProbe]::PostMessage($seekControl,0x100,[IntPtr]0x21,[IntPtr]::Zero)
      Start-Sleep -Milliseconds 300
      $metrics.seekPageKeys = ([MediaWindowProbe]::SendMessage($seekControl,0x400,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0)
      if (-not $metrics.seekPageKeys) { throw '進度條 PageUp 未交給原生跳轉' }
    }
    [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]237,[IntPtr]::Zero)
    Start-Sleep -Milliseconds 100
    $metrics.cleanView = (-not [MediaWindowProbe]::IsWindowVisible([MediaWindowProbe]::GetDlgItem($script:mediaHandle,105)) -and -not [MediaWindowProbe]::IsWindowVisible([MediaWindowProbe]::GetDlgItem($script:mediaHandle,111)))
    if (-not $metrics.cleanView) { throw '純畫面沒有收起控制項及清單' }
    [void][MediaWindowProbe]::SendMessage($script:mediaHandle,0x111,[IntPtr]237,[IntPtr]::Zero)
    $metrics.cleanViewRestored = ([MediaWindowProbe]::IsWindowVisible([MediaWindowProbe]::GetDlgItem($script:mediaHandle,105)) -and [MediaWindowProbe]::IsWindowVisible([MediaWindowProbe]::GetDlgItem($script:mediaHandle,111)))
    if (-not $metrics.cleanViewRestored) { throw '純畫面沒有恢復原本控制項及清單' }
    $volumeControl = [MediaWindowProbe]::GetDlgItem($script:mediaHandle, 110)
    if ([MediaWindowProbe]::IsWindowVisible($volumeControl)) {
      $originalVolume = [MediaWindowProbe]::SendMessage($volumeControl, 0x400, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
      $low = Get-SliderThumbX $volumeControl 25
      $high = Get-SliderThumbX $volumeControl 75
      [void][MediaWindowProbe]::SendMessage($volumeControl, 0x405, [IntPtr]::Zero, [IntPtr]$originalVolume)
      [void][MediaWindowProbe]::InvalidateRect($volumeControl, [IntPtr]::Zero, $false)
      $metrics.sliderMoves = ($high-$low -gt 20)
      if (-not $metrics.sliderMoves) { throw '滑桿圓點沒有跟著值移動' }
    }
    $metrics.controlsFit = $true
    $controlRects = @()
    foreach ($id in @(101,102,103,104,105,106,107,108,109,110,111,113,114,115,116,117,118,119,238,239,240,241)) {
      $control = [MediaWindowProbe]::GetDlgItem($script:mediaHandle, $id)
      if ([MediaWindowProbe]::IsWindowVisible($control)) {
        $r = New-Object MediaWindowProbe+Rect
        [void][MediaWindowProbe]::GetWindowRect($control, [ref]$r)
        if ($r.Left -lt $windowRect.Left -or $r.Top -lt $windowRect.Top -or $r.Right -gt $windowRect.Right -or $r.Bottom -gt $windowRect.Bottom) { $metrics.controlsFit = $false }
        $controlRects += @{id=$id; rect=$r}
      }
    }
    if (-not $metrics.controlsFit) { throw '控制項超出視窗' }
    $metrics.controlsSeparate = $true
    for ($i=0; $i -lt $controlRects.Count; $i++) {
      for ($j=$i+1; $j -lt $controlRects.Count; $j++) {
        $a=$controlRects[$i].rect; $b=$controlRects[$j].rect
        if ($a.Left -lt $b.Right -and $a.Right -gt $b.Left -and $a.Top -lt $b.Bottom -and $a.Bottom -gt $b.Top) { throw "控制項互相重疊：$($controlRects[$i].id) / $($controlRects[$j].id)" }
      }
    }
    foreach ($view in @('queue', 'help')) {
      if ($view -eq 'help') {
        # 按鈕有焦點時，F1 仍走主迴圈；只送本輪 HWND，不碰全域鍵盤。
        [void][MediaWindowProbe]::PostMessage([MediaWindowProbe]::GetDlgItem($script:mediaHandle, 105), 0x100, [IntPtr]0x70, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 250
      }
      $bitmap = New-Object Drawing.Bitmap ($windowRect.Right-$windowRect.Left), ($windowRect.Bottom-$windowRect.Top)
      $graphics = [Drawing.Graphics]::FromImage($bitmap); $dc = $graphics.GetHdc()
      try { [void][MediaWindowProbe]::PrintWindow($script:mediaHandle, $dc, 2) }
      finally { $graphics.ReleaseHdc($dc) }
      $bitmap.Save((Join-Path $Output "$view-$Theme.png"), [Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose(); $bitmap.Dispose()
    }
  }
  $metrics.focusKept = ($metrics.focusKept -and [MediaWindowProbe]::GetForegroundWindow() -eq $foregroundBefore)
  # 使用者可以繼續切換自己的視窗；只把本輪程序取得前景視為搶焦點。
  Assert-OwnedBackground; $metrics.ownFocusAbsent=$true; $metrics.focusSamples=$script:focusSamples
  if (-not $metrics.offscreen -or -not $metrics.queueShown) { throw "背景原生視窗檢查失敗：$($metrics | ConvertTo-Json -Compress)" }
  $metrics | ConvertTo-Json | Set-Content (Join-Path $Output "metrics-$Theme.json")
  $metrics | ConvertTo-Json -Compress | Write-Output
  $playerProcess.WaitForExit($(if ($ExerciseResize) { 30000 } else { 20000 })) | Out-Null
  if (-not $playerProcess.HasExited) { throw '播放器沒有正常結束' }
} finally {
  if (-not $playerProcess.HasExited) { Stop-Process -Id $playerProcess.Id -Force -ErrorAction SilentlyContinue }
}
