# Do be rong that (px) cua nhieu chuoi bang GDI+ (System.Drawing), cung engine ma
# cac phan mem thiet ke tem chuyen nghiep (vd BarTender) dung. Nhan vao file JSON de
# tranh loi escape ky tu tieng Viet/dau nhay tren dong lenh; tra ket qua qua file JSON
# thu hai (khong qua stdout) de tranh van de encoding cua console PowerShell.
#
# Da hieu chinh ngay 24/09/2026: so voi be rong THAT duoc ve ra qua sharp/SVG (bo may
# in tem thuc su dung), GDI+ voi StringFormat.GenericTypographic lech duoi 1%, va luon
# bao RONG HON mot chut (huong an toan — khong lam tran dong khi dung so nay de quyet
# dinh xuong dong).
param(
  [Parameter(Mandatory = $true)][string]$InputFile,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [string]$FontFamily = "Arial"
)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Drawing
  $request = Get-Content -LiteralPath $InputFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $texts = @($request.texts)
  $sizes = @($request.sizes)

  $bmp = New-Object System.Drawing.Bitmap 1, 1
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $fmt = [System.Drawing.StringFormat]::GenericTypographic

  $results = New-Object System.Collections.Generic.List[object]
  foreach ($size in $sizes) {
    $font = New-Object System.Drawing.Font($FontFamily, [double]$size, [System.Drawing.GraphicsUnit]::Pixel)
    foreach ($t in $texts) {
      $measured = $g.MeasureString([string]$t, $font, [int]::MaxValue, $fmt)
      $results.Add([PSCustomObject]@{ text = $t; size = $size; width = [math]::Round($measured.Width, 2) })
    }
    $font.Dispose()
  }
  $g.Dispose(); $bmp.Dispose()

  @{ ok = $true; results = $results } | ConvertTo-Json -Compress -Depth 5 |
    Out-File -LiteralPath $OutputFile -Encoding UTF8 -NoNewline
} catch {
  @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress |
    Out-File -LiteralPath $OutputFile -Encoding UTF8 -NoNewline
  exit 1
}
