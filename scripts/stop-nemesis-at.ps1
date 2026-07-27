# Deterministic, self-verifying stop for a NEMESIS paper run.
#
# WHY: the 2026-07-26 run was requested to stop at 03:00:00 PDT and actually
# stopped at 04:41:25 PDT -- 101 minutes late -- because the stop depended on an
# agent heartbeat that drifted. A stop that can drift 100 minutes cannot bound an
# unattended run. This script owns its own deadline, kills nothing but
# KRYPT/nemesis electron processes, verifies afterwards, and writes a receipt
# recording requested vs actual so the drift is a measured number, never a guess.
#
# Usage (from nemesis repo root; run it in its own console, detached from any agent):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/stop-nemesis-at.ps1 -At '2026-07-28 03:00:00'
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/stop-nemesis-at.ps1 -AfterMinutes 480
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/stop-nemesis-at.ps1 -AfterMinutes 0 -DryRun
#
# Exit codes: 0 = clean stop (or nothing matched, or dry run); 2 = processes
# survived; 3 = unexpected failure. The receipt is written in every case.

[CmdletBinding()]
param(
  # Local wall-clock deadline. Required unless -AfterMinutes is given.
  [datetime]$At,

  # Relative deadline in minutes from script start. 0 stops immediately.
  [ValidateRange(0, 10080)]
  [int]$AfterMinutes,

  # Defaults to overnight-logs/<deadline yyyy-MM-dd>/stop-receipt.json under the repo root.
  [string]$ReceiptPath,

  # Report what would be killed and exit without killing anything.
  [switch]$DryRun,

  # How long to wait for a polite stop before escalating to -Force.
  [ValidateRange(0, 600)]
  [int]$GraceSeconds = 20
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot

$hasAt = $PSBoundParameters.ContainsKey('At')
$hasAfter = $PSBoundParameters.ContainsKey('AfterMinutes')
if (-not $hasAt -and -not $hasAfter) {
  throw 'Specify a deadline: -At <DateTime> (local) or -AfterMinutes <int>.'
}
if ($hasAt -and $hasAfter) {
  throw 'Specify exactly one of -At or -AfterMinutes, not both — an ambiguous deadline is how drift starts.'
}

$startedAt = Get-Date
$deadline = if ($hasAt) { $At } else { $startedAt.AddMinutes($AfterMinutes) }

if (-not $ReceiptPath) {
  $ReceiptPath = Join-Path $repoRoot ('overnight-logs\{0}\stop-receipt.json' -f $deadline.ToString('yyyy-MM-dd'))
}

# Exactly the matcher scripts/launch-paper-allowlist.ps1 refuses to launch over,
# and the one in .claude/skills/nemesis-ops/SKILL.md. Never a bare electron
# match: the machine runs other Electron apps.
function Get-NemesisElectronProcess {
  return @(
    Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like '*KRYPT*nemesis*' }
  )
}

function ConvertTo-ProcessRow($Process) {
  return [pscustomobject]@{
    pid         = [int]$Process.ProcessId
    commandLine = [string]$Process.CommandLine
  }
}

function Write-StopReceipt {
  param(
    # IDictionary, not hashtable: the receipt is an ordered dictionary and casting
    # it to hashtable would scramble the field order in the JSON.
    [Parameter(Mandatory = $true)][System.Collections.IDictionary]$Receipt
  )
  $directory = Split-Path -Parent $ReceiptPath
  if ($directory -and -not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  ($Receipt | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $ReceiptPath -Encoding utf8
  Write-Host "[nemesis-stop] receipt: $ReceiptPath"
}

Write-Host "[nemesis-stop] requested stop : $($deadline.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "[nemesis-stop] now            : $($startedAt.ToString('yyyy-MM-dd HH:mm:ss'))"
Write-Host "[nemesis-stop] receiptPath    : $ReceiptPath"
Write-Host "[nemesis-stop] dryRun         : $DryRun"
Write-Host "[nemesis-stop] graceSeconds   : $GraceSeconds"

# Bounded sleeps rather than one long one: re-reading the clock every cycle means
# a system clock change (or a resume from sleep) is absorbed instead of extending
# the run, and the operator gets progress instead of a silent process.
$pollSeconds = 15
$lastReport = [datetime]::MinValue
while ($true) {
  $remaining = ($deadline - (Get-Date)).TotalSeconds
  if ($remaining -le 0) { break }
  if (((Get-Date) - $lastReport).TotalSeconds -ge 60 -or $remaining -le 60) {
    Write-Host ("[nemesis-stop] waiting… {0:N0}s remaining" -f $remaining)
    $lastReport = Get-Date
  }
  $sleepSeconds = [Math]::Max(1, [Math]::Min($pollSeconds, [Math]::Ceiling($remaining)))
  Start-Sleep -Seconds $sleepSeconds
}

$actual = Get-Date
$driftSeconds = [Math]::Round(($actual - $deadline).TotalSeconds, 3)
Write-Host ("[nemesis-stop] deadline reached at {0} (drift {1}s)" -f $actual.ToString('yyyy-MM-dd HH:mm:ss'), $driftSeconds)

$receipt = [ordered]@{
  script         = 'scripts/stop-nemesis-at.ps1'
  requestedAt    = $deadline.ToString('o')
  actualAt       = $actual.ToString('o')
  driftSeconds   = $driftSeconds
  dryRun         = [bool]$DryRun
  graceSeconds   = $GraceSeconds
  matchedBefore  = 0
  matchedPids    = @()
  matchedProcesses = @()
  remainingAfter = 0
  remainingPids  = @()
  escalated      = $false
  exitCode       = 0
  message        = ''
}

$exitCode = 0
try {
  $matched = Get-NemesisElectronProcess
  $matchedRows = @($matched | ForEach-Object { ConvertTo-ProcessRow $_ })
  $matchedPids = @($matchedRows | ForEach-Object { $_.pid })
  $receipt.matchedBefore = $matchedRows.Count
  $receipt.matchedPids = $matchedPids
  $receipt.matchedProcesses = $matchedRows

  if ($matchedRows.Count -eq 0) {
    # Not a silent success: a stop that found nothing means the run ended by some
    # other means, and that is a fact the receipt has to carry.
    $receipt.message = 'No KRYPT/nemesis electron processes matched at the deadline. Nothing to stop — the run had already ended or never started.'
    Write-Host "[nemesis-stop] WARNING: $($receipt.message)"
    $receipt.exitCode = 0
    Write-StopReceipt -Receipt $receipt
    exit 0
  }

  Write-Host "[nemesis-stop] matched $($matchedRows.Count) process(es): $($matchedPids -join ', ')"
  foreach ($row in $matchedRows) { Write-Host "[nemesis-stop]   PID $($row.pid) :: $($row.commandLine)" }

  if ($DryRun) {
    # Hard boundary: nothing below this point runs in a dry run.
    $receipt.remainingAfter = $matchedRows.Count
    $receipt.remainingPids = $matchedPids
    $receipt.message = 'Dry run — no process was stopped.'
    Write-Host "[nemesis-stop] $($receipt.message)"
    $receipt.exitCode = 0
    Write-StopReceipt -Receipt $receipt
    exit 0
  }

  foreach ($row in $matchedRows) {
    # -Confirm:$false, never -Force on the first pass: give the app its own
    # shutdown path so ledgers flush. Individual failures are expected (a child
    # can exit when its parent goes) and must not abort the sweep.
    Stop-Process -Id $row.pid -Confirm:$false -ErrorAction SilentlyContinue
  }

  $graceDeadline = (Get-Date).AddSeconds($GraceSeconds)
  $survivors = Get-NemesisElectronProcess
  while ($survivors.Count -gt 0 -and (Get-Date) -lt $graceDeadline) {
    Start-Sleep -Seconds 1
    $survivors = Get-NemesisElectronProcess
  }

  if ($survivors.Count -gt 0) {
    $receipt.escalated = $true
    $survivorPids = @($survivors | ForEach-Object { [int]$_.ProcessId })
    Write-Host "[nemesis-stop] $($survivors.Count) process(es) survived $GraceSeconds s — escalating to -Force: $($survivorPids -join ', ')"
    foreach ($survivorPid in $survivorPids) {
      Stop-Process -Id $survivorPid -Force -Confirm:$false -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    $survivors = Get-NemesisElectronProcess
  }

  $remainingPids = @($survivors | ForEach-Object { [int]$_.ProcessId })
  $receipt.remainingAfter = $survivors.Count
  $receipt.remainingPids = $remainingPids

  if ($survivors.Count -gt 0) {
    # A surviving writer against %APPDATA%\@nemesis\desktop\nemesis-data is the
    # dual-writer hazard the launch script refuses over, so this must be loud.
    $exitCode = 2
    $receipt.message = "STOP INCOMPLETE: $($survivors.Count) KRYPT/nemesis electron process(es) still running (PIDs: $($remainingPids -join ', ')). Do NOT relaunch until these are gone."
    Write-Host "[nemesis-stop] $($receipt.message)"
  } else {
    $receipt.message = "Stopped $($matchedRows.Count) KRYPT/nemesis electron process(es); 0 remain."
    Write-Host "[nemesis-stop] $($receipt.message)"
  }
} catch {
  $exitCode = 3
  $receipt.message = "Unexpected failure: $($_.Exception.Message)"
  Write-Host "[nemesis-stop] $($receipt.message)"
}

$receipt.exitCode = $exitCode
Write-StopReceipt -Receipt $receipt
exit $exitCode
