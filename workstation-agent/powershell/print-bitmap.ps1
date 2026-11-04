# In cac trang PNG (PHIEU THEO DOI XA VAI A4, agent 0.11.0) qua DRIVER Windows.
#
# May in laser host-based (HP LaserJet Professional P1102w) KHONG nhan TSPL/RAW nhu may tem TSC: phai ve anh
# qua System.Drawing.Printing.PrintDocument de driver tu dung du lieu cho may. Moi tep PNG la mot trang A4
# NGANG 300 dpi (3508 x 2480) da chua san le an toan; script ve anh phu kin trang giay (bu le cung HardMargin).
#
# So ban: tu lap lai ca bo trang (collate) trong MOT tai lieu thay vi dat PrinterSettings.Copies - driver
# "Microsoft Print to PDF" va mot so driver host-based bo qua Copies, lap tay thi ket qua giong nhau moi may.
#
# -OutputFile chi dung khi thu tren may dev voi may in ao (Microsoft Print to PDF): in ra tep, khong hoi ten.
# Agent KHONG bao gio truyen tham so nay.
#
# Ket qua: mot dong JSON {ok, jobId, pages, copies, sheets, printer} hoac {ok:false, code, message}.
# jobId = Id cua job trong spooler tim theo DocumentName (thu toi ~2s); khong thay thi null (agent bo buoc
# cho spooler, bao "chua xac nhan" nhu khi job TSC bien mat qua nhanh).
# Chay duoc ca trong PowerShell thuong truc (host.ps1, phai co trong $allowed) lan mo moi. Chi ky tu ASCII:
# thong bao loi tieng Viet co dau dung o printer.mjs theo `code`.
param(
  [Parameter(Mandatory = $true)][string]$Printer,
  [Parameter(Mandatory = $true)][string]$Files,
  [int]$Copies = 1,
  [string]$DocName = 'PrintSKU xa-vai',
  [string]$OutputFile = ''
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.Drawing

$images = New-Object 'System.Collections.Generic.List[System.Drawing.Image]'
$doc = $null
$code = 'PRINT_FAILED'
try {
  if ($Copies -lt 1 -or $Copies -gt 5) { throw "Copies out of range: $Copies" }
  $paths = @($Files -split '\|' | Where-Object { $_ })
  if ($paths.Count -eq 0) { $code = 'FILE_MISSING'; throw 'no page files' }
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path)) { $code = 'FILE_MISSING'; throw "missing page file: $path" }
  }
  foreach ($path in $paths) { $images.Add([System.Drawing.Image]::FromFile($path)) }

  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.PrinterSettings.PrinterName = $Printer
  if (-not $doc.PrinterSettings.IsValid) { $code = 'PRINTER_INVALID'; throw "printer not found: $Printer" }
  if ($OutputFile) {
    $doc.PrinterSettings.PrintToFile = $true
    $doc.PrinterSettings.PrintFileName = $OutputFile
  }
  $a4 = $doc.PrinterSettings.PaperSizes | Where-Object { $_.Kind -eq [System.Drawing.Printing.PaperKind]::A4 } | Select-Object -First 1
  if ($null -eq $a4) { $code = 'NO_A4'; throw 'driver does not offer A4 paper' }
  $doc.DefaultPageSettings.PaperSize = $a4
  $doc.DefaultPageSettings.Landscape = $true
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins 0, 0, 0, 0
  $doc.OriginAtMargins = $false
  $doc.PrinterSettings.Copies = 1
  $doc.DocumentName = $DocName
  # Khong hien hop thoai "dang in trang x" (agent chay nen, khong co nguoi bam).
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

  $state = @{ index = 0; total = $images.Count * $Copies; images = $images }
  $doc.add_PrintPage({
    param($sender, $e)
    $img = $state.images[$state.index % $state.images.Count]
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    # Goc toa do Graphics nam o le cung (vung in duoc); lui lai HardMargin de anh khop dung mep giay.
    $hx = [single]$e.PageSettings.HardMarginX
    $hy = [single]$e.PageSettings.HardMarginY
    $bounds = $e.PageBounds
    $g.DrawImage($img, (New-Object System.Drawing.RectangleF (-$hx), (-$hy), ([single]$bounds.Width), ([single]$bounds.Height)))
    $state.index++
    $e.HasMorePages = ($state.index -lt $state.total)
  }.GetNewClosure())
  $doc.Print()

  $jobId = $null
  $deadline = (Get-Date).AddSeconds(2)
  do {
    $found = @(Get-PrintJob -PrinterName $Printer -ErrorAction SilentlyContinue | Where-Object { $_.DocumentName -eq $DocName }) | Select-Object -Last 1
    if ($found) { $jobId = [int]$found.Id; break }
    Start-Sleep -Milliseconds 200
  } while ((Get-Date) -lt $deadline)

  @{ ok = $true; jobId = $jobId; pages = $images.Count; copies = $Copies; sheets = $state.index; printer = $Printer } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; code = $code; message = [string]$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
} finally {
  foreach ($img in $images) { $img.Dispose() }
  if ($null -ne $doc) { $doc.Dispose() }
}
