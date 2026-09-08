param(
  [string]$InstallDir = 'C:\PrintSKUAgent',
  [string]$TaskName = 'Print SKU UID Agent'
)
$ErrorActionPreference = 'Stop'
$current = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $current.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Hãy chạy PowerShell bằng Run as administrator.' }

$source = Split-Path -Parent $PSScriptRoot
if ((Resolve-Path $source).Path -ne (Resolve-Path $InstallDir -ErrorAction SilentlyContinue).Path) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  robocopy $source $InstallDir /E /XD logs preview temp config /XF .env | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Không chép được agent, robocopy mã $LASTEXITCODE" }
}

$configDir = Join-Path $InstallDir 'config'
$configFile = Join-Path $configDir '.env'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
if (-not (Test-Path $configFile)) {
  Copy-Item -LiteralPath (Join-Path $InstallDir '.env.example') -Destination $configFile
  Write-Warning "Đã tạo $configFile. Hãy nhập SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY và PRINT_AGENT_TOKEN trước khi chạy task."
}

$node = Join-Path $InstallDir 'node\node.exe'
if (-not (Test-Path $node)) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
$entry = Join-Path $InstallDir 'src\cli.mjs'
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`" service --env `"$InstallDir\config\.env`"" -WorkingDirectory $InstallDir
$startup = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $startup -Settings $settings -Principal $principal -Force | Out-Null
$content = Get-Content -Raw -LiteralPath $configFile
if ($content -match '(?m)^SUPABASE_URL=[ \t]*https://' -and $content -match '(?m)^SUPABASE_PUBLISHABLE_KEY=[ \t]*[^ \t\r\n]+' -and $content -match '(?m)^PRINT_AGENT_TOKEN=[ \t]*[^ \t\r\n]+') {
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Đã cài và khởi động $TaskName tại $InstallDir"
} else {
  Write-Output "Đã đăng ký $TaskName nhưng chưa khởi động vì queue URL/token còn trống."
}
