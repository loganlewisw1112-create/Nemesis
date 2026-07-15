param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('instrumentation', 'seven-hour')]
  [string]$Stage,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Namespace,

  [Parameter(Mandatory = $true)]
  [ValidateSet('direct', 'non_direct')]
  [string]$AccountPrecision
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
Push-Location $repoRoot
try {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) {
    throw 'Evidence campaign requires a clean worktree. Commit or archive changes first.'
  }
  $commit = (git rev-parse HEAD).Trim()
  if (-not $commit) { throw 'Unable to resolve the frozen git commit.' }

  $env:NEMESIS_EVIDENCE_CAMPAIGN_STAGE = $Stage
  $env:NEMESIS_EVIDENCE_NAMESPACE = $Namespace
  $env:NEMESIS_GIT_COMMIT = $commit
  $env:NEMESIS_KALSHI_ACCOUNT_PRECISION = $AccountPrecision
  $env:NEMESIS_DEVTOOLS = 'false'
  Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue

  Write-Host 'Building the frozen production application...'
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed with exit code $LASTEXITCODE." }
  if (!(Test-Path -LiteralPath $mainEntry)) { throw "Production entry point is missing: $mainEntry" }
  if (!(Test-Path -LiteralPath $electronExe)) { throw "Electron launcher is missing: $electronExe" }
  Write-Host "Starting $Stage evidence run '$Namespace' at commit $commit"
  Write-Host 'Do not change code, settings, schemas, thresholds, or the evidence namespace while this process is running.'
  Push-Location $desktopRoot
  try {
    & $electronExe $mainEntry
    if ($LASTEXITCODE -ne 0) { throw "NEMESIS exited with code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
} finally {
  Pop-Location
}
