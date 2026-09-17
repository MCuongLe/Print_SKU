# Dò xem có đọc ngược được trạng thái thật từ máy in qua Windows Spooler không.
#
# Đây là THÍ NGHIỆM, không phải tính năng. Nó gửi lệnh truy vấn thời gian thực
# của TSPL2 rồi thử ReadPrinter. Kết quả quyết định P3 có khả thi hay không:
# nếu đọc được byte trạng thái thì agent biết chắc máy hết giấy / bung nắp,
# thay vì chỉ suy đoán từ hàng đợi Windows.
#
# Lệnh gửi đi là lệnh truy vấn, không phải dữ liệu tem, nên bình thường máy
# không in ra gì. Vẫn nên chạy lúc nhìn được máy in.
param(
  [string]$Printer = 'TSC PE200 (Copy 1)',
  [int]$TimeoutMs = 3000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Write-Output "=== Cổng và cấu hình hai chiều ==="
$p = Get-Printer -Name $Printer
Write-Output ("Cổng     : {0}" -f $p.PortName)
Write-Output ("Driver   : {0}" -f $p.DriverName)
$port = Get-PrinterPort -Name $p.PortName -ErrorAction SilentlyContinue
if ($port) { Write-Output ("Loại cổng: {0}" -f $port.Description) }
$key = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers\$Printer"
if (Test-Path $key) {
  $attr = (Get-ItemProperty -Path $key -Name Attributes -ErrorAction SilentlyContinue).Attributes
  # PRINTER_ATTRIBUTE_ENABLE_BIDI = 0x0800
  if ($null -ne $attr) {
    Write-Output ("Hai chiều: {0} (Attributes = 0x{1:X})" -f $(if ($attr -band 0x0800) { 'BẬT' } else { 'TẮT' }), $attr)
  }
}

if (-not ('HasakiPrinterProbe' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HasakiPrinterProbe {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string name, out IntPtr handle, IntPtr defaults);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true, CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr handle, int level, [In] DOCINFO info);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr handle);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr handle, byte[] bytes, int count, out int written);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ReadPrinter(IntPtr handle, byte[] bytes, int count, out int read);
}
'@
}

# TSPL2 real-time: <ESC>!? trả 1 byte trạng thái; <ESC>!S trả trạng thái chi tiết.
$queries = @(
  @{ Name = '<ESC>!?'; Bytes = [byte[]](0x1B, 0x21, 0x3F) },
  @{ Name = '<ESC>!S'; Bytes = [byte[]](0x1B, 0x21, 0x53) }
)

foreach ($q in $queries) {
  Write-Output ""
  Write-Output ("=== Thử lệnh {0} ===" -f $q.Name)
  $handle = [IntPtr]::Zero
  try {
    if (-not [HasakiPrinterProbe]::OpenPrinter($Printer, [ref]$handle, [IntPtr]::Zero)) {
      throw "OpenPrinter lỗi $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $info = New-Object HasakiPrinterProbe+DOCINFO
    $info.pDocName = 'Hasaki printer probe'
    $info.pDataType = 'RAW'
    $jobId = [HasakiPrinterProbe]::StartDocPrinter($handle, 1, $info)
    [HasakiPrinterProbe]::StartPagePrinter($handle) | Out-Null
    $written = 0
    [HasakiPrinterProbe]::WritePrinter($handle, $q.Bytes, $q.Bytes.Length, [ref]$written) | Out-Null
    [HasakiPrinterProbe]::EndPagePrinter($handle) | Out-Null
    [HasakiPrinterProbe]::EndDocPrinter($handle) | Out-Null
    Write-Output ("Đã gửi {0} byte (spool job {1})" -f $written, $jobId)

    $buffer = New-Object byte[] 64
    $read = 0
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    $got = $false
    while ((Get-Date) -lt $deadline) {
      if ([HasakiPrinterProbe]::ReadPrinter($handle, $buffer, $buffer.Length, [ref]$read) -and $read -gt 0) {
        $hex = ($buffer[0..($read - 1)] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
        Write-Output ("ĐỌC ĐƯỢC {0} byte: {1}" -f $read, $hex)
        $got = $true
        break
      }
      Start-Sleep -Milliseconds 200
    }
    if (-not $got) {
      Write-Output ("Không đọc được gì (ReadPrinter lỗi {0})" -f [Runtime.InteropServices.Marshal]::GetLastWin32Error())
    }
  } catch {
    Write-Output ("Lỗi: {0}" -f $_.Exception.Message)
  } finally {
    if ($handle -ne [IntPtr]::Zero) { [HasakiPrinterProbe]::ClosePrinter($handle) | Out-Null }
  }
}

Write-Output ""
Write-Output "Chạy lại phép dò này khi máy in ĐANG hết giấy để so byte trạng thái."
