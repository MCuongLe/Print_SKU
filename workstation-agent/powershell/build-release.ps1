param(
  [string]$OutputDir = (Join-Path (Split-Path -Parent $PSScriptRoot) 'release'),
  [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source
)

$ErrorActionPreference = 'Stop'
$agentRoot = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $agentRoot 'VERSION')).Trim()
$stageRoot = Join-Path $OutputDir "PrintSKUAgent-$version"
$zipPath = "$stageRoot.zip"

if (Test-Path -LiteralPath $stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null

foreach ($directory in @('src', 'powershell')) {
  Copy-Item -LiteralPath (Join-Path $agentRoot $directory) -Destination $stageRoot -Recurse
}
foreach ($file in @('.env.example', 'package.json', 'pnpm-lock.yaml', 'README.md', 'VERSION')) {
  Copy-Item -LiteralPath (Join-Path $agentRoot $file) -Destination $stageRoot
}

Push-Location $stageRoot
try {
  # Copy package files into the release instead of hard-linking them from the
  # pnpm store. Hard links can carry store ACLs that make package.json
  # unreadable after the ZIP is extracted on another Windows workstation.
  pnpm install --prod --frozen-lockfile --config.node-linker=hoisted --config.package-import-method=copy
  if ($LASTEXITCODE -ne 0) {
    throw "Không thể dựng node_modules (pnpm mã $LASTEXITCODE)."
  }
} finally {
  Pop-Location
}

$bundledNodeDir = Join-Path $stageRoot 'node'
New-Item -ItemType Directory -Path $bundledNodeDir -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $bundledNodeDir 'node.exe')

# Include the matching static page and additive queue migration for deployment.
$repoRoot = Split-Path -Parent $agentRoot
$deploymentDir = Join-Path $stageRoot 'deployment'
New-Item -ItemType Directory -Path $deploymentDir -Force | Out-Null
foreach ($migration in @('supabase\print_queue_v4_fabric_relaxation_handwritten.sql', 'supabase\print_queue_v5_realtime_wake.sql', 'supabase\warehouse_location_v1.sql', 'supabase\warehouse_location_v2_optional_name.sql')) {
  $source = Join-Path $repoRoot $migration
  if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $deploymentDir }
}
Copy-Item -LiteralPath (Join-Path $repoRoot 'index.html') -Destination $deploymentDir

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
