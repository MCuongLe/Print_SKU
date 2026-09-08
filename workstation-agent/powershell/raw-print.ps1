param(
  [Parameter(Mandatory = $true)][string]$File,
  [Parameter(Mandatory = $true)][string]$Printer
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
if (-not (Test-Path -LiteralPath $File)) { throw "Không tìm thấy file TSPL" }

if (-not ('HasakiRawPrinter' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HasakiRawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
}
'@
}

$handle = [IntPtr]::Zero
$jobId = 0
try {
  if (-not [HasakiRawPrinter]::OpenPrinter($Printer, [ref]$handle, [IntPtr]::Zero)) { throw "OpenPrinter lỗi $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $info = New-Object HasakiRawPrinter+DOCINFO
  $info.pDocName = 'Print SKU UID Agent'
  $info.pDataType = 'RAW'
  $jobId = [HasakiRawPrinter]::StartDocPrinter($handle, 1, $info)
  if ($jobId -le 0) { throw "StartDocPrinter lỗi $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  if (-not [HasakiRawPrinter]::StartPagePrinter($handle)) { throw "StartPagePrinter thất bại" }
  $bytes = [IO.File]::ReadAllBytes($File)
  $written = 0
  if (-not [HasakiRawPrinter]::WritePrinter($handle, $bytes, $bytes.Length, [ref]$written) -or $written -ne $bytes.Length) { throw "WritePrinter chỉ nhận $written/$($bytes.Length) byte" }
  [HasakiRawPrinter]::EndPagePrinter($handle) | Out-Null
  [HasakiRawPrinter]::EndDocPrinter($handle) | Out-Null
  @{ ok = $true; jobId = $jobId; bytes = $written; printer = $Printer } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; jobId = $jobId; message = $_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
} finally {
  if ($handle -ne [IntPtr]::Zero) { [HasakiRawPrinter]::ClosePrinter($handle) | Out-Null }
}
