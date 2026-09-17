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
# Date the log dir per launch. A hardcoded folder silently merged runs together,
# which made post-hoc cutoff filtering the only thing separating them.
$logDir = Join-Path $repoRoot ('overnight-logs\' + (Get-Date -Format 'yyyy-MM-dd'))
$tracePath = Join-Path $logDir 'priority-track-trace.jsonl'
$orderbookTracePath = Join-Path $logDir 'orderbook-stream-trace.jsonl'
$connectorWarnPath = Join-Path $logDir 'connector-warns.jsonl'

if (!(Test-Path -LiteralPath $electronExe)) {
  throw "electron.exe missing at $electronExe — run npm install from nemesis root first."
}
if (!(Test-Path -LiteralPath $mainEntry)) {
  throw "dist-electron/main.js missing at $mainEntry — run npm run build first."
}

# Stale-build guard. A previous session spent hours testing a theory against a
# bundle that predated the fix; never debug a build you have not proven. These
# markers are string literals and class members, which esbuild preserves —
# plain internal function names get renamed and would false-alarm here.
$builtMain = Get-Content -LiteralPath $mainEntry -Raw
$requiredMarkers = @(
  'NEMESIS_ORDERBOOK_TRACE_PATH'  # Phase 0: durable data-plane ledger
  'superviseDataPlane'            # Phase 1: unconditional recovery supervisor
  'admitted-socket-dead'          # Phase 2: split priority-track outcomes
  'data plane DEGRADED'           # Phase 3: fail-closed degraded latch
  'setRepairPriority'             # P2: candidate-first snapshot repair
  'shadowContaminationBlocked'    # P1.5: degraded shadows excluded from the gate
)
foreach ($marker in $requiredMarkers) {
  if ($builtMain -notmatch [regex]::Escape($marker)) {
    throw "Refusing launch: dist-electron/main.js is missing '$marker' — the build is stale. Run 'npm run build' first."
  }
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
  "shadowMinScored=50"
  "shadowMinObservationDays=1"
  "tracePath=$tracePath"
  "orderbookTracePath=$orderbookTracePath"
  "connectorWarnPath=$connectorWarnPath"
) | Set-Content -LiteralPath $cutoffPath -Encoding utf8

# Set env on this process, then launch so the child inherits the same vars.
$env:NEMESIS_AUTO_SPAWN_GEA = 'true'
$env:NEMESIS_SERIES_ALLOWLIST = $allowlist
$env:NEMESIS_SERIES_DENYLIST = $denylist
$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = '25'
$env:NEMESIS_PRIORITY_TRACK_TRACE_PATH = $tracePath
# Data-plane forensics. Without these the orderbook socket's own state is
# recoverable only from a console, which is how a 7.9h dead socket went unseen.
$env:NEMESIS_ORDERBOOK_TRACE_PATH = $orderbookTracePath
$env:NEMESIS_CONNECTOR_WARN_TRACE_PATH = $connectorWarnPath
# Accelerate shadow acceptance for paper plumbing (does not enter strategyConfigHash).
# Campaign acceptance target: 50 scored observations over at least 1 elapsed
# day. Economic, stress, concentration, and provenance bars are unchanged.
$env:NEMESIS_SHADOW_MIN_SCORED = '50'
$env:NEMESIS_SHADOW_MIN_DISTINCT_DAYS = '1'
$env:NEMESIS_SHADOW_MIN_OBSERVATION_DAYS = '1'

Write-Host '[nemesis] launch-paper-allowlist env confirmation:'
Write-Host "  NEMESIS_AUTO_SPAWN_GEA=$env:NEMESIS_AUTO_SPAWN_GEA"
Write-Host "  NEMESIS_SERIES_ALLOWLIST=$env:NEMESIS_SERIES_ALLOWLIST"
Write-Host "  NEMESIS_SERIES_DENYLIST=$env:NEMESIS_SERIES_DENYLIST"
Write-Host "  NEMESIS_ORDERBOOK_TRACKING_LIMIT=$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT"
Write-Host "  NEMESIS_PRIORITY_TRACK_TRACE_PATH=$env:NEMESIS_PRIORITY_TRACK_TRACE_PATH"
Write-Host "  NEMESIS_ORDERBOOK_TRACE_PATH=$env:NEMESIS_ORDERBOOK_TRACE_PATH"
Write-Host "  NEMESIS_CONNECTOR_WARN_TRACE_PATH=$env:NEMESIS_CONNECTOR_WARN_TRACE_PATH"
Write-Host "  NEMESIS_SHADOW_MIN_SCORED=$env:NEMESIS_SHADOW_MIN_SCORED"
Write-Host "  NEMESIS_SHADOW_MIN_DISTINCT_DAYS=$env:NEMESIS_SHADOW_MIN_DISTINCT_DAYS"
Write-Host "  NEMESIS_SHADOW_MIN_OBSERVATION_DAYS=$env:NEMESIS_SHADOW_MIN_OBSERVATION_DAYS"
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
