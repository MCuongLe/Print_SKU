param(
  [string]$InstallDir = 'C:\PrintSKUAgent',
  [string]$TaskName = 'Print SKU UID Agent'
)
$ErrorActionPreference = 'Stop'
$current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Hãy chạy PowerShell bằng Run as administrator.' }

$source = Split-Path -Parent $PSScriptRoot
$installedNode = Join-Path $InstallDir 'node\node.exe'

# 0.8.9: task tự chạy lại mỗi 5 phút nên phải TẮT task trước khi chép đè — không thì agent cũ có thể
# bật lại giữa lúc robocopy chạy và giữ khóa node.exe. Register-ScheduledTask bên dưới bật lại task.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Stop-ScheduledTask -TaskName $TaskName
}
$agentProcesses = { Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $installedNode } }
$deadline = (Get-Date).AddSeconds(30)
while ((& $agentProcesses) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
& $agentProcesses | Stop-Process -Force

if ((Resolve-Path $source).Path -ne (Resolve-Path $InstallDir -ErrorAction SilentlyContinue).Path) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  robocopy $source $InstallDir /E /XD logs preview temp config /XF .env /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Không chép được agent, robocopy mã $LASTEXITCODE" }
}

$configDir = Join-Path $InstallDir 'config'
$configFile = Join-Path $configDir '.env'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
if (-not (Test-Path $configFile)) {
  Copy-Item -LiteralPath (Join-Path $InstallDir '.env.example') -Destination $configFile
  Write-Warning "Đã tạo $configFile. Hãy nhập SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY và PRINT_AGENT_TOKEN trước khi chạy task."
}

$node = $installedNode
if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
$entry = Join-Path $InstallDir 'src\cli.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`" service --env `"$InstallDir\config\.env`"" -WorkingDirectory $InstallDir
# 0.8.9: ngoài "khi Windows khởi động", task còn chạy khi có người đăng nhập và cứ 5 phút một lần.
# Agent đang chạy thì Task Scheduler bỏ qua (IgnoreNew) nên không bao giờ có hai bản; agent chết (lỗi,
# bị diệt, tự thoát khi vòng quét đứng) thì chậm nhất 5 phút sau có lại. Sự cố 06–07/10/2026: chỉ có
# trigger khởi động nên agent chết lúc 20:21 nằm im tới khi có người bật tay sáng hôm sau.
$triggers = @(
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -AtLogOn),
  (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5))
)
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
$content = Get-Content -Raw -LiteralPath $configFile
if ($content -match '(?m)^SUPABASE_URL=[ \t]*https://' -and $content -match '(?m)^SUPABASE_PUBLISHABLE_KEY=[ \t]*[^ \t\r\n]+' -and $content -match '(?m)^PRINT_AGENT_TOKEN=[ \t]*[^ \t\r\n]+') {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Đã cài và khởi động $TaskName tại $InstallDir (chạy khi khởi động, khi đăng nhập và kiểm tra mỗi 5 phút)"
} else {
  # Không tắt thì trigger 5 phút sẽ chạy agent thiếu cấu hình rồi báo lỗi mãi.
  Disable-ScheduledTask -TaskName $TaskName | Out-Null
  Write-Output "Đã đăng ký $TaskName nhưng TẮT task vì queue URL/token còn trống. Nhập $configFile rồi chạy lại script này."
}
