param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('instrumentation', 'seven-hour')]
  [string]$Stage,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[A-Za-z0-9._-]+$')]
  [string]$Namespace,

  [Parameter(Mandatory = $true)]
  [ValidateSet('direct', 'non_direct')]
  [string]$AccountPrecision,

  [ValidateRange(0, 2)]
  [int]$MaxRecoveryAttempts = 2,

  [string]$SoakResultPath,

  [string]$R10ResultPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$campaignDir = Join-Path $env:APPDATA '@nemesis\desktop\nemesis-data\evidence-campaigns'
$activePointerPath = Join-Path $campaignDir 'active-campaign.json'
$healthPolicy = 'runtime-health-v2:5s-runtime:30s-renderer:384mb-3x:512mb-hard:10m-10pct:30m-2pct:component-ttl:15s-lease'
$healthPolicyHash = [Convert]::ToHexString(
  [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($healthPolicy))
).ToLowerInvariant()
$stageDurationMs = if ($Stage -eq 'instrumentation') { 2 * 60 * 60 * 1000 } else { 7 * 60 * 60 * 1000 }
if ([string]::IsNullOrWhiteSpace($SoakResultPath)) {
  $SoakResultPath = Join-Path $workspaceRoot 'output\reports\nemesis-gap-closure-r10-2026-07-15\soak\production-soak-result.json'
}

function Read-JsonHashtable([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
  catch { return $null }
}

function Write-DurableJson([string]$Path, [object]$Value) {
  $directory = Split-Path -Parent $Path
  if ($directory) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
  $temporary = "$Path.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 30))
  $stream = [IO.FileStream]::new($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally {
    $stream.Dispose()
  }
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-Control([string]$Path, [string]$Command, [string]$RunId) {
  Write-DurableJson $Path @{
    schemaVersion = 2
    command = $Command
    runId = $RunId
    requestedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

function Get-ProductionArtifactFingerprint {
  $artifactRoots = @(
    (Join-Path $repoRoot 'apps\desktop\dist'),
    (Join-Path $repoRoot 'apps\desktop\dist-electron'),
    (Join-Path $repoRoot 'apps\global-event-alpha\dist'),
    (Join-Path $repoRoot 'apps\global-event-alpha\dist-electron')
  )
  $files = @($artifactRoots | ForEach-Object {
    if (Test-Path -LiteralPath $_) { Get-ChildItem -LiteralPath $_ -File -Recurse }
  } | Sort-Object FullName)
  if ($files.Count -eq 0) { throw 'The frozen production artifact is missing. Run the production soak first.' }
  $rows = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative|$($file.Length)|$hash"
  }
  $aggregate = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes(($rows -join "`n")))
  ).ToLowerInvariant()
  return @{
    hash = $aggregate
    fileCount = $files.Count
    entryHash = (Get-FileHash -LiteralPath $mainEntry -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Assert-PassingSoak([string]$Path, [string]$Commit, [hashtable]$Artifact) {
  $soak = Read-JsonHashtable $Path
  if ($null -eq $soak) { throw "A readable passing 45-minute production soak result is required: $Path" }
  if ($soak.schemaVersion -ne 2 -or $soak.runType -ne 'production-stress-soak' -or $soak.passed -ne $true) {
    throw "Production soak result is not a passing schema-v2 stress soak: $Path"
  }
  if ([string]$soak.gitCommit -ne $Commit) { throw 'Production soak commit does not match frozen HEAD.' }
  if ([double]$soak.requestedDurationMinutes -lt 45 -or [double]$soak.actualDurationMinutes -lt 44.5) {
    throw 'Production soak did not complete the required 45-minute duration.'
  }
  if ($soak.devToolsDisabled -ne $true -or [int]$soak.configuredTrackedTickers -ne 500) {
    throw 'Production soak did not prove DevTools-disabled, 500-ticker configuration.'
  }
  if (([string]$soak.productionArtifactHash -ne [string]$Artifact.hash) -or
    ([string]$soak.productionEntryHash -ne [string]$Artifact.entryHash) -or
    ([int]$soak.productionArtifactFileCount -ne [int]$Artifact.fileCount)) {
    throw 'Current production artifact differs from the exact artifact that passed the soak. Re-run the soak; do not rebuild here.'
  }
  return $soak
}

function Assert-CleanR10Unlock([string]$Path, [string]$Commit, [hashtable]$Soak) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw 'Seven-hour monitoring requires -R10ResultPath pointing to the clean passing schema-v2 r10 result.'
  }
  $result = Read-JsonHashtable $Path
  if ($null -eq $result) { throw "The r10 result is unreadable: $Path" }
  $manifest = $result.manifest
  $reasons = @($result.reasons)
  if ($result.schemaVersion -ne 2 -or $result.passed -ne $true -or $null -eq $manifest) {
    throw 'Seven-hour monitoring remains locked because r10 did not produce a passing schema-v2 result.'
  }
  if ($manifest.schemaVersion -ne 2 -or $manifest.stage -ne 'instrumentation' -or $manifest.status -ne 'passed') {
    throw 'Seven-hour monitoring remains locked because the r10 manifest is not a finalized passing instrumentation run.'
  }
  if (([string]$result.runId -ne [string]$manifest.runId) -or
    ([string]$result.runId -notmatch '(^|[-_.])r10($|[-_.])')) {
    throw 'Seven-hour monitoring remains locked because the supplied result is not the matching r10 run.'
  }
  if ([string]$manifest.gitCommit -ne $Commit) { throw 'The r10 commit does not match frozen HEAD.' }
  if ([int]$manifest.restartOrdinal -ne 0 -or [string]$result.runId -match '-recovery-' -or [string]$manifest.runId -match '-recovery-') {
    throw 'Seven-hour monitoring remains locked because r10 used a restart or recovery namespace.'
  }
  if ($reasons.Count -gt 0 -or $result.uncleanShutdown -eq $true -or $result.invalidated -eq $true) {
    throw 'Seven-hour monitoring remains locked because r10 was not clean.'
  }
  if ([double]$manifest.startedAt -lt [double]$Soak.finishedAt) {
    throw 'Seven-hour monitoring remains locked because r10 predates the required production soak.'
  }
}

function Get-ProcessMarker([object]$Row) {
  try { return ([DateTime]$Row.CreationDate).ToUniversalTime().Ticks.ToString() }
  catch { return '' }
}

function New-ProcessCapture([int]$RootProcessId) {
  $capture = @{ Markers = @{}; Order = [Collections.Generic.List[int]]::new() }
  $root = Get-CimInstance Win32_Process -Filter "ProcessId = $RootProcessId" -ErrorAction SilentlyContinue
  if ($null -ne $root) {
    $capture.Markers[$RootProcessId] = Get-ProcessMarker $root
    $capture.Order.Add($RootProcessId)
  }
  return $capture
}

function Update-ProcessCapture([hashtable]$Capture) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CreationDate)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $all) {
      $pidValue = [int]$row.ProcessId
      if ($Capture.Markers.ContainsKey($pidValue)) { continue }
      if ($Capture.Markers.ContainsKey([int]$row.ParentProcessId)) {
        $Capture.Markers[$pidValue] = Get-ProcessMarker $row
        $Capture.Order.Add($pidValue)
        $changed = $true
      }
    }
  }
}

function Get-LiveCapturedProcessIds([hashtable]$Capture) {
  $live = [Collections.Generic.List[int]]::new()
  foreach ($pidValue in @($Capture.Order)) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    if ($null -ne $row -and (Get-ProcessMarker $row) -eq [string]$Capture.Markers[$pidValue]) { $live.Add($pidValue) }
  }
  return @($live)
}

function Stop-CapturedProcessTree([hashtable]$Capture) {
  Update-ProcessCapture $Capture
  for ($index = $Capture.Order.Count - 1; $index -ge 0; $index -= 1) {
    $pidValue = $Capture.Order[$index]
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    if ($null -ne $row -and (Get-ProcessMarker $row) -eq [string]$Capture.Markers[$pidValue]) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }
}

function Wait-ForCapturedExit([hashtable]$Capture, [DateTimeOffset]$Deadline) {
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    Update-ProcessCapture $Capture
    if (@(Get-LiveCapturedProcessIds $Capture).Count -eq 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return @(Get-LiveCapturedProcessIds $Capture).Count -eq 0
}

function Wait-ForSidecarState(
  [Diagnostics.Process]$Process,
  [hashtable]$Capture,
  [string]$Path,
  [string[]]$States,
  [DateTimeOffset]$Deadline
) {
  while ([DateTimeOffset]::UtcNow -lt $Deadline) {
    Update-ProcessCapture $Capture
    $Process.Refresh()
    $sidecar = Read-JsonHashtable $Path
    if ($null -ne $sidecar -and $States -contains [string]$sidecar.state) { return $sidecar }
    if ($Process.HasExited) { return @{ state = 'process-exited'; exitCode = $Process.ExitCode } }
    Start-Sleep -Seconds 2
  }
  return @{ state = 'supervisor-timeout' }
}

function Clear-ActivePointer([string]$RunId) {
  $pointer = Read-JsonHashtable $activePointerPath
  if ($null -ne $pointer -and [string]$pointer.evidenceNamespace -eq $RunId) {
    Remove-Item -LiteralPath $activePointerPath -Force -ErrorAction SilentlyContinue
  }
}

function Mark-UncleanShutdown(
  [string]$RunId,
  [string]$SidecarPath,
  [string]$ResultPath,
  [string]$Reason
) {
  $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $result = Read-JsonHashtable $ResultPath
  if ($null -eq $result) { $result = @{ schemaVersion = 2; runId = $RunId; reasons = @() } }
  $result.passed = $false
  $result.uncleanShutdown = $true
  $result.externallyInvalidatedAt = $now
  $result.reasons = @(@($result.reasons) + $Reason | Select-Object -Unique)
  Write-DurableJson $ResultPath $result

  $runtime = Read-JsonHashtable $SidecarPath
  if ($null -eq $runtime) { $runtime = @{ schemaVersion = 2; runId = $RunId } }
  $runtime.state = 'invalidated'
  $runtime.restartable = $false
  $runtime.uncleanShutdown = $true
  $runtime.reason = $Reason
  $runtime.updatedAt = $now
  Write-DurableJson $SidecarPath $runtime
  Write-DurableJson (Join-Path $campaignDir "$RunId.unclean-shutdown.json") @{
    schemaVersion = 2
    runId = $RunId
    at = $now
    reason = $Reason
  }
}

Push-Location $repoRoot
try {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) { throw 'Evidence campaign requires a clean worktree. Commit or archive changes first.' }
  $commit = (git rev-parse HEAD).Trim()
  if (-not $commit) { throw 'Unable to resolve the frozen git commit.' }
  if (!(Test-Path -LiteralPath $mainEntry)) { throw "Frozen production entry point is missing: $mainEntry" }
  if (!(Test-Path -LiteralPath $electronExe)) { throw "Electron launcher is missing: $electronExe" }

  $artifact = Get-ProductionArtifactFingerprint
  $soak = Assert-PassingSoak $SoakResultPath $commit $artifact
  if ($Stage -eq 'seven-hour') { Assert-CleanR10Unlock $R10ResultPath $commit $soak }
  New-Item -ItemType Directory -Path $campaignDir -Force | Out-Null

  $parentRunId = $Namespace
  for ($restartOrdinal = 0; $restartOrdinal -le $MaxRecoveryAttempts; $restartOrdinal += 1) {
    $runId = if ($restartOrdinal -eq 0) { $Namespace } else { "$Namespace-recovery-$restartOrdinal" }
    $sidecarPath = Join-Path $campaignDir "$runId.runtime.json"
    $runtimeLedgerPath = Join-Path $campaignDir "$runId.runtime.jsonl"
    $controlPath = Join-Path $campaignDir "$runId.control.json"
    $resultPath = Join-Path $campaignDir "$runId.result.json"
    Remove-Item -LiteralPath $sidecarPath, $controlPath -Force -ErrorAction SilentlyContinue

    $env:NEMESIS_EVIDENCE_CAMPAIGN_STAGE = $Stage
    $env:NEMESIS_EVIDENCE_NAMESPACE = $runId
    $env:NEMESIS_EVIDENCE_PARENT_RUN_ID = $parentRunId
    $env:NEMESIS_EVIDENCE_RESTART_ORDINAL = [string]$restartOrdinal
    $env:NEMESIS_EVIDENCE_SCHEMA_VERSION = '2'
    $env:NEMESIS_EVIDENCE_PREFLIGHT = 'true'
    $env:NEMESIS_EVIDENCE_RUNTIME_SIDECAR = $sidecarPath
    $env:NEMESIS_EVIDENCE_RUNTIME_LEDGER = $runtimeLedgerPath
    $env:NEMESIS_EVIDENCE_CONTROL = $controlPath
    $env:NEMESIS_HEALTH_POLICY_HASH = $healthPolicyHash
    $env:NEMESIS_GIT_COMMIT = $commit
    $env:NEMESIS_KALSHI_ACCOUNT_PRECISION = $AccountPrecision
    $env:NEMESIS_DEVTOOLS = 'false'
    Remove-Item Env:VITE_DEV_SERVER_URL -ErrorAction SilentlyContinue

    Write-Host "Launching preflight for '$runId' from the exact production artifact that passed soak $SoakResultPath"
    $mainEntryArg = '"' + $mainEntry + '"'
    $process = Start-Process -FilePath $electronExe -ArgumentList @($mainEntryArg) -WorkingDirectory $desktopRoot -PassThru
    $capture = New-ProcessCapture $process.Id
    try {
      $preflightDeadline = [DateTimeOffset]::UtcNow.AddMinutes(20)
      $preflight = Wait-ForSidecarState $process $capture $sidecarPath @('preflight-ready', 'invalidated', 'finalized') $preflightDeadline
      if ($preflight.state -ne 'preflight-ready') {
        if (!(Wait-ForCapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10)))) { Stop-CapturedProcessTree $capture }
        Clear-ActivePointer $runId
        if ($restartOrdinal -lt $MaxRecoveryAttempts -and $preflight.restartable -ne $false) {
          Write-Warning "Preflight '$runId' ended as '$($preflight.state)'; starting an isolated recovery attempt."
          continue
        }
        throw "Preflight '$runId' failed as '$($preflight.state)'."
      }

      Write-Control $controlPath 'start-campaign' $runId
      $activeDeadline = [DateTimeOffset]::UtcNow.AddMilliseconds($stageDurationMs + 5 * 60 * 1000)
      $terminal = Wait-ForSidecarState $process $capture $sidecarPath @('closeout-ready', 'invalidated', 'finalized') $activeDeadline
      if ($terminal.state -eq 'closeout-ready') {
        Write-Control $controlPath 'finalize' $runId
        $terminal = Wait-ForSidecarState $process $capture $sidecarPath @('invalidated', 'finalized') ([DateTimeOffset]::UtcNow.AddSeconds(30))
      }
      if ($terminal.state -eq 'finalized') {
        if (!(Wait-ForCapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(30)))) {
          $reason = 'unclean_shutdown: finalized NEMESIS process tree did not exit within 30 seconds'
          Mark-UncleanShutdown $runId $sidecarPath $resultPath $reason
          Stop-CapturedProcessTree $capture
          Clear-ActivePointer $runId
          throw "Finalized run '$runId' did not exit cleanly within 30 seconds."
        }
        Clear-ActivePointer $runId
        $result = Read-JsonHashtable $resultPath
        if ($null -eq $result -or $result.schemaVersion -ne 2) { throw "Finalized run '$runId' did not produce a readable schema-v2 result." }
        if ($result.passed -ne $true) {
          [Console]::Error.WriteLine("Evidence attempt '$runId' finalized as FAIL: $(@($result.reasons) -join '; ')")
          exit 2
        }
        Write-Host "Evidence attempt '$runId' finalized as PASS. A finalized result will not be restarted."
        exit 0
      }

      if (!(Wait-ForCapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10)))) { Stop-CapturedProcessTree $capture }
      Clear-ActivePointer $runId
      if ($restartOrdinal -lt $MaxRecoveryAttempts -and $terminal.restartable -ne $false) {
        Write-Warning "Attempt '$runId' invalidated; starting an isolated recovery namespace."
        continue
      }
      throw "Evidence attempt '$runId' ended as '$($terminal.state)'."
    } finally {
      Update-ProcessCapture $capture
      if (@(Get-LiveCapturedProcessIds $capture).Count -gt 0) { Stop-CapturedProcessTree $capture }
      Clear-ActivePointer $runId
    }
  }
  throw "Evidence campaign exhausted $MaxRecoveryAttempts recovery attempts."
} finally {
  Pop-Location
}
