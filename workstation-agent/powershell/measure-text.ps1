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
  # GenericTypographic mac dinh BO QUA khoang trang cuoi chuoi: token "phu " bi
  # do nhu "phu", tong token hut ca be rong dau cach (10-15% moi dong, do that
  # 30/09/2026). Bat MeasureTrailingSpaces de token tinh ca dau cach; dong/so
  # luong/ngay deu da trim nen khong doi.
  $fmt = [System.Drawing.StringFormat]::GenericTypographic.Clone()
  $fmt.FormatFlags = $fmt.FormatFlags -bor [System.Drawing.StringFormatFlags]::MeasureTrailingSpaces

  $results = New-Object System.Collections.Generic.List[object]
  foreach ($size in $sizes) {
    $font = New-Object System.Drawing.Font($FontFamily, [double]$size, [System.Drawing.GraphicsUnit]::Pixel)
    foreach ($t in $texts) {
      $measured = $g.MeasureString([string]$t, $font, [int]::MaxValue, $fmt)
      $results.Add([PSCustomObject]@{ text = $t; size = $size; width = [math]::Round($measured.Width, 2) })
    }
    $font.Dispose()
  }
  # Nhom do them trong cung tien trinh (so luong, ngay o day tem SKU - co chu rieng);
  # moi dong ket qua mang chi so nhom 'group' de phia Node tach rieng.
  # @() boc NGOAI ca bieu thuc if: PowerShell 5.1 bung mang 1 phan tu thanh doi
  # tuong don, .Count cua no rong nen vong lap khong chay (loi that 30/09/2026).
  $extra = @(if ($request.PSObject.Properties['extra']) { $request.extra })
  for ($i = 0; $i -lt $extra.Count; $i++) {
    $group = $extra[$i]
    if ($null -eq $group) { continue }
    foreach ($size in @($group.sizes)) {
      $font = New-Object System.Drawing.Font($FontFamily, [double]$size, [System.Drawing.GraphicsUnit]::Pixel)
      foreach ($t in @($group.texts)) {
        $measured = $g.MeasureString([string]$t, $font, [int]::MaxValue, $fmt)
        $results.Add([PSCustomObject]@{ group = $i; text = $t; size = $size; width = [math]::Round($measured.Width, 2) })
      }
      $font.Dispose()
    }
  }
  $g.Dispose(); $bmp.Dispose()

  @{ ok = $true; results = $results } | ConvertTo-Json -Compress -Depth 5 |
    Out-File -LiteralPath $OutputFile -Encoding UTF8 -NoNewline
} catch {
  @{ ok = $false; message = $_.Exception.Message } | ConvertTo-Json -Compress |
    Out-File -LiteralPath $OutputFile -Encoding UTF8 -NoNewline
  exit 1
}
