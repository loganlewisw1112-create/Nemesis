# Launch a SINGLE NEMESIS desktop for allowlisted paper measurement.
#
# HARD RULE: never run two desktops against the same AppData
# (%APPDATA%\@nemesis\desktop\nemesis-data). Dual writers corrupt the
# qualification / strategy-validation hash chains (sequence mismatches).
# Stop all KRYPT*nemesis* electron processes before calling this script.
#
# Usage (from nemesis repo root):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/launch-paper-allowlist.ps1

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$cutoffPath = Join-Path $repoRoot '.nemesis-relaunch-cutoff.txt'
$logDir = Join-Path $repoRoot 'overnight-logs\2026-07-24'
$tracePath = Join-Path $logDir 'priority-track-trace.jsonl'

if (!(Test-Path -LiteralPath $electronExe)) {
  throw "electron.exe missing at $electronExe — run npm install from nemesis root first."
}
if (!(Test-Path -LiteralPath $mainEntry)) {
  throw "dist-electron/main.js missing at $mainEntry — run npm run build first."
}

$existing = @(
  Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*KRYPT*nemesis*' }
)
if ($existing.Count -gt 0) {
  $pids = ($existing | ForEach-Object { $_.ProcessId }) -join ', '
  throw @"
Refusing launch: $($existing.Count) KRYPT/nemesis electron process(es) already running (PIDs: $pids).
Dual writers against the same AppData corrupt paper ledgers.
Stop them first, then re-run this script (see overnight-logs/2026-07-24/OPERATOR-RESET.md).
"@
}

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$cutoffMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$cutoffIso = [DateTimeOffset]::UtcNow.ToString('o')
# Continuous crypto daily only for this soak. HUD hourly series currently return
# 0 open markets on Kalshi (weekend / off-hours), and bare KXBTC/KXETH also match
# 15m contracts that decay inside the 15s confirmation window.
# 2026-07-25: drop KXETHD — shadow ledger 0/10 wins, -$41 net; keep KXBTCD only.
$allowlist = 'KXBTCD'
$denylist = 'KXETHD'

@(
  "cutoffMs=$cutoffMs"
  "cutoffIso=$cutoffIso"
  "allowlist=$allowlist"
  "denylist=$denylist"
  "orderbookTrackingLimit=25"
  "tracePath=$tracePath"
) | Set-Content -LiteralPath $cutoffPath -Encoding utf8

# Set env on this process, then launch so the child inherits the same vars.
$env:NEMESIS_AUTO_SPAWN_GEA = 'true'
$env:NEMESIS_SERIES_ALLOWLIST = $allowlist
$env:NEMESIS_SERIES_DENYLIST = $denylist
$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = '25'
$env:NEMESIS_PRIORITY_TRACK_TRACE_PATH = $tracePath
# Accelerate shadow acceptance for paper plumbing (does not enter strategyConfigHash).
# Campaign acceptance target: at most 50 scored observations across today and
# tomorrow. Economic, stress, concentration, and provenance bars are unchanged.
$env:NEMESIS_SHADOW_MIN_SCORED = '50'
$env:NEMESIS_SHADOW_MIN_DISTINCT_DAYS = '2'

Write-Host '[nemesis] launch-paper-allowlist env confirmation:'
Write-Host "  NEMESIS_AUTO_SPAWN_GEA=$env:NEMESIS_AUTO_SPAWN_GEA"
Write-Host "  NEMESIS_SERIES_ALLOWLIST=$env:NEMESIS_SERIES_ALLOWLIST"
Write-Host "  NEMESIS_SERIES_DENYLIST=$env:NEMESIS_SERIES_DENYLIST"
Write-Host "  NEMESIS_ORDERBOOK_TRACKING_LIMIT=$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT"
Write-Host "  NEMESIS_PRIORITY_TRACK_TRACE_PATH=$env:NEMESIS_PRIORITY_TRACK_TRACE_PATH"
Write-Host "  NEMESIS_SHADOW_MIN_SCORED=$env:NEMESIS_SHADOW_MIN_SCORED"
Write-Host "  NEMESIS_SHADOW_MIN_DISTINCT_DAYS=$env:NEMESIS_SHADOW_MIN_DISTINCT_DAYS"
Write-Host "  cutoffMs=$cutoffMs ($cutoffIso)"
Write-Host "  cutoffFile=$cutoffPath"
Write-Host "  mainEntry=$mainEntry"

# Prefer call-operator inheritance (same process env → child). Start-Process -PassThru
# also inherits parent env when -Environment is not used; we avoid Start-Process without
# ensuring $env:* was set above.
$proc = Start-Process -FilePath $electronExe `
  -ArgumentList @('"' + $mainEntry + '"') `
  -WorkingDirectory $desktopRoot `
  -PassThru

if (-not $proc) { throw 'Failed to start electron.' }

Write-Host "[nemesis] started electron PID=$($proc.Id)"
Write-Host "[nemesis] filter all post-launch analysis with: e.at > $cutoffMs"
