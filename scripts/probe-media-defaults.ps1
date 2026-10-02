param([switch]$Baseline, [string]$Output, [string]$ExpectedExe)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
[ComImport, Guid("4e530b0a-e611-4c77-a3ac-9031d022281b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IApplicationAssociationRegistration {
  [PreserveSig] int QueryCurrentDefault([MarshalAs(UnmanagedType.LPWStr)] string ext, int type, int level, out IntPtr value);
}
public static class MediaAssociationProbe {
  public static string Default(string ext) {
    var api = (IApplicationAssociationRegistration)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("591209c7-767b-42b2-9fba-44ee4615f2c7")));
    IntPtr value; try { if(api.QueryCurrentDefault(ext,0,1,out value)!=0)return ""; try {return Marshal.PtrToStringUni(value);} finally {Marshal.FreeCoTaskMem(value);} }
    finally {Marshal.ReleaseComObject(api);}
  }
  [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)]
  private static extern int AssocQueryString(uint flags, uint kind, string association, string extra, StringBuilder value, ref uint count);
  public static string Query(string ext, uint kind) {
    uint count = 32768; var value = new StringBuilder((int)count);
    return AssocQueryString(0, kind, ext, null, value, ref count) == 0 ? value.ToString() : "";
  }
}
'@
$formats = Get-Content (Join-Path $PSScriptRoot '../src/main/media-formats.json') -Raw | ConvertFrom-Json
$entries = foreach ($kind in $formats.PSObject.Properties) {
  foreach ($extension in $kind.Value) {
    $ext = '.' + $extension
    $progId = [MediaAssociationProbe]::Default($ext)
    $executable = [MediaAssociationProbe]::Query($progId, 2)
    [pscustomobject]@{ extension=$ext; progId=$progId; executable=$executable; expected=('VoiceInk.Media.'+$kind.Name); matches=($progId -eq ('VoiceInk.Media.'+$kind.Name) -and (-not $ExpectedExe -or $executable -eq $ExpectedExe)) }
  }
}
if ($Output) { $entries | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $Output -Encoding UTF8 }
$failed = @($entries | Where-Object { -not $_.matches })
Write-Output "Windows association API: $($entries.Count-$failed.Count)/$($entries.Count) VoiceInk Media"
if (-not $Baseline -and $failed.Count -gt 0) { $failed | Select-Object -First 8 extension,progId; throw 'Default associations mismatch' }
