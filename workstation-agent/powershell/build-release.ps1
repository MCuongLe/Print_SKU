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
  pnpm install --prod --frozen-lockfile --config.node-linker=hoisted
  if ($LASTEXITCODE -ne 0) {
    throw "Không thể dựng node_modules (pnpm mã $LASTEXITCODE)."
  }
} finally {
  Pop-Location
}

$bundledNodeDir = Join-Path $stageRoot 'node'
New-Item -ItemType Directory -Path $bundledNodeDir -Force | Out-Null
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $bundledNodeDir 'node.exe')

Compress-Archive -LiteralPath $stageRoot -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
