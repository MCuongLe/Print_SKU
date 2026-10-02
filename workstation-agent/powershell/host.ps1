# Tien trinh PowerShell chay thuong truc cua agent (0.8.8, tang toc).
#
# Moi lan agent mo mot powershell.exe MOI de kiem tra may in / do chu / gui du lieu mat 0,4-1,9 giay
# chi de KHOI DONG (do thuc te: printer-status.ps1 ~1,7s, raw-print.ps1 ~0,45s khi mo moi; ~35ms va ~8ms
# khi chay trong mot tien trinh da mo san). Moi lenh in mo 4-5 lan. Script nay giu MOT tien trinh song,
# doc yeu cau JSON moi dong tu stdin, chay dung cac script co san (printer-status.ps1, raw-print.ps1,
# measure-text.ps1) trong cung tien trinh, tra ket qua JSON mot dong tren stdout.
#
# Giao thuc (ca hai chieu CHI chua ky tu ASCII, ky tu khac duoc escape \uXXXX nen khong phu thuoc ma
# hoa console):
#   vao : {"id":"1","script":"printer-status.ps1","args":{"Printer":"...","JobId":5}}
#         {"id":"2","op":"init"}   (nap san module + kieu .NET, KHONG mo may in)
#   ra  : @@READY@@                                  (mot lan khi san sang)
#         @@R@@{"id":"1","ok":true,"out":"<stdout cua script>"}
#         @@R@@{"id":"1","ok":false,"error":"<thong bao loi chua bat>"}
# Chi cac script trong danh sach trang duoc chay. Khong xu ly song song: agent gui tung yeu cau mot.
# Tat ca bang ASCII - khong them ky tu tieng Viet vao file nay.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$writer.AutoFlush = $true
$allowed = @('printer-status.ps1', 'raw-print.ps1', 'measure-text.ps1')
$escape = [System.Text.RegularExpressions.MatchEvaluator]{ param($m) ('\u{0:x4}' -f [int][char]$m.Value) }

function Send-Reply($object) {
  $json = $object | ConvertTo-Json -Compress -Depth 5
  $writer.WriteLine('@@R@@' + [regex]::Replace($json, '[^\x00-\x7F]', $escape))
}

$writer.WriteLine('@@READY@@')
while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $id = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = [string]$req.id
    if ($req.op -eq 'ping') {
      Send-Reply @{ id = $id; ok = $true; out = 'pong' }
    } elseif ($req.op -eq 'init') {
      # Nap san de lenh in dau tien khong phai tra phi khoi dong: module in an (Get-Printer),
      # System.Drawing + mot lan do chu, va kieu HasakiRawPrinter (chi bien dich, khong in).
      Add-Type -AssemblyName System.Drawing
      $bmp = New-Object System.Drawing.Bitmap 1, 1
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $font = New-Object System.Drawing.Font('Arial', [double]12, [System.Drawing.GraphicsUnit]::Pixel)
      $null = $g.MeasureString('0', $font)
      $font.Dispose(); $g.Dispose(); $bmp.Dispose()
      . (Join-Path $PSScriptRoot 'raw-printer-type.ps1')
      $null = Get-Command Get-Printer, Get-PrintJob
      $null = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object -First 1)
      Send-Reply @{ id = $id; ok = $true; out = 'ready' }
    } else {
      $name = [string]$req.script
      if ($allowed -notcontains $name) { throw "script khong duoc phep: $name" }
      $splat = @{}
      if ($null -ne $req.args) { foreach ($p in $req.args.PSObject.Properties) { $splat[$p.Name] = $p.Value } }
      $out = & (Join-Path $PSScriptRoot $name) @splat | Out-String
      Send-Reply @{ id = $id; ok = $true; out = $out }
    }
  } catch {
    Send-Reply @{ id = $id; ok = $false; error = [string]$_.Exception.Message }
  }
}
