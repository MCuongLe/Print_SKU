param(
  [Parameter(Mandatory = $true)][string]$Printer,
  [int]$JobId = 0
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
try {
  $p = Get-Printer -Name $Printer
  $jobs = @(Get-PrintJob -PrinterName $Printer -ErrorAction SilentlyContinue)
  $target = if ($JobId -gt 0) { @($jobs | Where-Object { $_.ID -eq $JobId }) } else { @() }
  $blockedWords = 'Offline|Error|PaperOut|PaperJam|DoorOpen|UserIntervention|NotAvailable|Paused'
  $status = [string]$p.PrinterStatus
  $targetStatus = ($target | ForEach-Object { [string]$_.JobStatus }) -join ','
  $blocked = $p.WorkOffline -or ($status -match $blockedWords) -or ($targetStatus -match $blockedWords)
  # Retained: máy in đã in xong nhưng hàng đợi giữ lại bản ghi. Không phải lỗi,
  # nhưng job sẽ không bao giờ tự biến mất nên phải coi là đã in xong.
  $retained = ($targetStatus -match 'Retained') -and -not ($targetStatus -match 'Printing|Spooling')
  $pagesPrinted = 0
  $totalPages = 0
  if ($target.Count -gt 0) {
    $pagesPrinted = [int]($target | Measure-Object -Property PagesPrinted -Sum).Sum
    $totalPages = [int]($target | Measure-Object -Property TotalPages -Sum).Sum
  }
  @{
    ok = $true
    blocked = [bool]$blocked
    code = $(if ($blocked) { 'PRINTER_BLOCKED' } else { 'READY' })
    message = $(if ($blocked) { "Máy in: $status; job: $targetStatus" } else { 'sẵn sàng' })
    jobs = $jobs.Count
    targetPresent = ($target.Count -gt 0)
    targetStatus = $targetStatus
    targetRetained = [bool]$retained
    targetPagesPrinted = $pagesPrinted
    targetTotalPages = $totalPages
    printer = $p.Name
  } | ConvertTo-Json -Compress
} catch {
  @{ ok = $false; blocked = $true; code = 'PRINTER_NOT_FOUND'; message = $_.Exception.Message; jobs = -1 } | ConvertTo-Json -Compress
  exit 1
}
