param([string]$InstallDir = 'C:\PrintSKUAgent', [string]$TaskName = 'Print SKU UID Agent')
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$taskInfo = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
$processes = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'PrintSKUAgent.+cli\.mjs.+service' })
$log = Join-Path $InstallDir 'logs\agent.log'
[ordered]@{
  installDirExists = Test-Path -LiteralPath $InstallDir
  taskState = $task.State
  lastTaskResult = $taskInfo.LastTaskResult
  processCount = $processes.Count
  processIds = @($processes.ProcessId)
  logFile = $log
  logUpdatedAt = $(if (Test-Path $log) { (Get-Item $log).LastWriteTime } else { $null })
} | ConvertTo-Json
if (Test-Path $log) { Get-Content -LiteralPath $log -Encoding UTF8 -Tail 30 }
