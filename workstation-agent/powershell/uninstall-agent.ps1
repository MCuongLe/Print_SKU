param([string]$TaskName = 'Print SKU UID Agent')
$ErrorActionPreference = 'SilentlyContinue'
Stop-ScheduledTask -TaskName $TaskName
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
Write-Output "Đã gỡ Scheduled Task $TaskName. Dữ liệu trong C:\PrintSKUAgent vẫn được giữ lại."
