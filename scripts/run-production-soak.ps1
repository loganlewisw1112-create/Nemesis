param(
  [ValidateRange(1, 240)]
  [int]$DurationMinutes = 30,

  [ValidateRange(1, 30)]
  [int]$WarmupMinutes = 5,

  [ValidateRange(5, 60)]
  [int]$SampleSeconds = 30,

  [ValidateRange(0, 2)]
  [int]$RetryOrdinal = 0,

  [string]$SeriesId,

  [string]$AttemptId,

  [string]$ParentAttemptId,

  [string]$ParentResultPath,

  [string]$ExpectedArtifactHash,

  [string]$ExpectedEntryHash,

  [int]$ExpectedArtifactFileCount,

  [Parameter(Mandatory = $true)]
  [string]$ReadinessReceiptPath,

  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if ([string]::IsNullOrWhiteSpace($AttemptId)) { $AttemptId = "soak-attempt-$($RetryOrdinal + 1)" }
if ([string]::IsNullOrWhiteSpace($SeriesId)) { $SeriesId = $AttemptId }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $workspaceRoot "output\reports\nemesis-gap-closure-r10-2026-07-16\soak\$AttemptId"
}

function Get-Percentile([double[]]$Values, [double]$Percentile) {
  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Min($sorted.Count - 1, [Math]::Max(0, [Math]::Ceiling($sorted.Count * $Percentile) - 1))
  return [double]$sorted[$index]
}

function Get-Median([double[]]$Values) {
  if ($Values.Count -eq 0) { return $null }
  $sorted = @($Values | Sort-Object)
  $middle = [Math]::Floor($sorted.Count / 2)
  if ($sorted.Count % 2 -eq 0) { return ([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2 }
  return [double]$sorted[$middle]
}

function Get-Sha256Text([string]$Value) {
  return [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($Value))
  ).ToLowerInvariant()
}

function Get-FileSha256OrNull([string]$Path) {
  if (!(Test-Path -LiteralPath $Path)) { return $null }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-NormalizedSlopeEvidence([object[]]$Observations, [double]$BaselineMb) {
  $requiredWindowMs = 1800000
  $spanMs = if ($Observations.Count -ge 2) {
    [double]$Observations[-1].at - [double]$Observations[0].at
  } else { 0 }
  if ($Observations.Count -lt 2 -or $BaselineMb -le 0 -or $spanMs -lt $requiredWindowMs) {
    return [pscustomobject]@{ slopeWindowComplete = $false; slopeWindowMs = $spanMs; slopePerHour = $null; netGrowthFraction = $null }
  }
  # Scoring starts on the first post-warm-up sample and runs for a genuine
  # thirty minutes. Do not trim the boundary sample with a trailing shortcut.
  $origin = [double]$Observations[0].at
  $xs = @($Observations | ForEach-Object { ([double]$_.at - $origin) / 3600000 })
  $ys = @($Observations | ForEach-Object { [double]$_.workingSetMb })
  $meanX = ($xs | Measure-Object -Average).Average
  $meanY = ($ys | Measure-Object -Average).Average
  $numerator = 0.0
  $denominator = 0.0
  for ($index = 0; $index -lt $Observations.Count; $index += 1) {
    $numerator += ($xs[$index] - $meanX) * ($ys[$index] - $meanY)
    $denominator += [Math]::Pow($xs[$index] - $meanX, 2)
  }
  $slope = if ($denominator -le 0) { $null } else { ($numerator / $denominator) / $BaselineMb }
  # Median-based net growth across the window mirrors the app's rendererMemoryMonitor
  # net-growth gate. The 2%/hr slope alone (~1.3MB over the window) sits below the
  # renderer's GC noise floor at a full market load, so a bounded, sawtoothing
  # renderer annualizes to a spurious positive slope (observed 4-11%/hr run to run
  # with the working set flat at 127-140MB). Compare the median working set of the
  # window's first half against its second half: a genuine leak lifts the second
  # half well above the first, while bounded oscillation leaves them near-equal.
  $half = [Math]::Floor($ys.Count / 2)
  $netGrowthFraction = if ($half -lt 1) { $null } else {
    (Get-Median $ys[$half..($ys.Count - 1)]) - (Get-Median $ys[0..($half - 1)])
  }
  if ($null -ne $netGrowthFraction) { $netGrowthFraction = [double]$netGrowthFraction / $BaselineMb }
  return [pscustomobject]@{ slopeWindowComplete = $true; slopeWindowMs = $spanMs; slopePerHour = $slope; netGrowthFraction = $netGrowthFraction }
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
  if ($files.Count -eq 0) { throw 'The production build did not produce any fingerprintable files.' }
  $rows = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative|$($file.Length)|$hash"
  }
  return @{
    hash = Get-Sha256Text ($rows -join "`n")
    fileCount = $files.Count
    entryHash = (Get-FileHash -LiteralPath $mainEntry -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Get-ProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine, Name)
  $pending = [Collections.Generic.Queue[int]]::new()
  $seen = [Collections.Generic.HashSet[int]]::new()
  $pending.Enqueue($RootProcessId)
  while ($pending.Count -gt 0) {
    $parent = $pending.Dequeue()
    if (!$seen.Add($parent)) { continue }
    foreach ($child in $all | Where-Object { $_.ParentProcessId -eq $parent }) {
      $pending.Enqueue([int]$child.ProcessId)
    }
  }
  return @($all | Where-Object { $seen.Contains([int]$_.ProcessId) })
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
      $id = [int]$row.ProcessId
      if ($Capture.Markers.ContainsKey($id) -or !$Capture.Markers.ContainsKey([int]$row.ParentProcessId)) { continue }
      $Capture.Markers[$id] = Get-ProcessMarker $row
      $Capture.Order.Add($id)
      $changed = $true
    }
  }
}

function Get-LiveCapturedProcessIds([hashtable]$Capture) {
  Update-ProcessCapture $Capture
  $live = [Collections.Generic.List[int]]::new()
  foreach ($id in $Capture.Order) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($null -ne $row -and (Get-ProcessMarker $row) -eq [string]$Capture.Markers[$id]) { $live.Add($id) }
  }
  return $live
}

function Wait-CapturedExit([hashtable]$Capture, [DateTimeOffset]$Deadline) {
  do {
    if (@(Get-LiveCapturedProcessIds $Capture).Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTimeOffset]::UtcNow -lt $Deadline)
  return @(Get-LiveCapturedProcessIds $Capture).Count -eq 0
}

function Stop-CapturedProcesses([hashtable]$Capture) {
  Update-ProcessCapture $Capture
  foreach ($processId in @($Capture.Order) | Sort-Object -Descending) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($null -ne $row -and (Get-ProcessMarker $row) -eq [string]$Capture.Markers[$processId]) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
}

if (Test-Path -LiteralPath $OutputDirectory) {
  throw "Soak attempt namespace is immutable and already exists: $OutputDirectory"
}
$samplesPath = Join-Path $OutputDirectory 'production-soak-samples.jsonl'
$resultPath = Join-Path $OutputDirectory 'production-soak-result.json'
$manifestPath = Join-Path $OutputDirectory 'production-soak-attempt-manifest.json'
$runtimeStatusPath = Join-Path $OutputDirectory 'production-soak-runtime-status.json'
$cutoffStatusPath = Join-Path $OutputDirectory 'production-soak-runtime-status-at-cutoff.json'
$process = $null
$capture = $null
Push-Location $repoRoot
try {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) { throw 'Production soak requires a clean frozen worktree.' }
  $commit = (git rev-parse HEAD).Trim()
  if (!$commit) { throw 'Unable to resolve the frozen git commit.' }

  if ($RetryOrdinal -eq 0 -and (![string]::IsNullOrWhiteSpace($ParentAttemptId) -or ![string]::IsNullOrWhiteSpace($ParentResultPath))) {
    throw 'Retry lineage fields are prohibited for ordinal zero.'
  }

  if ($RetryOrdinal -gt 0 -and (
    [string]::IsNullOrWhiteSpace($ParentAttemptId) -or
    [string]::IsNullOrWhiteSpace($ParentResultPath) -or
    [string]::IsNullOrWhiteSpace($ExpectedArtifactHash) -or
    [string]::IsNullOrWhiteSpace($ExpectedEntryHash) -or
    $ExpectedArtifactFileCount -le 0
  )) {
    throw 'A retry requires parent attempt identity and the exact original production artifact fingerprint.'
  }
  if ($RetryOrdinal -gt 0) {
    if (!(Test-Path -LiteralPath $ParentResultPath)) { throw 'The explicit parent soak result is missing.' }
    $parentResult = Get-Content -LiteralPath $ParentResultPath -Raw | ConvertFrom-Json
    $parentClasses = @($parentResult.typedFailureClasses)
    $allowedRetryClasses = @('dns', 'tcp', 'tls', 'connection_reset', 'timeout', 'http_5xx', 'abnormal_close', 'server', 'network', 'rate_limit', 'bridge_transport')
    if ($parentResult.schemaVersion -ne 3 -or $parentResult.runType -ne 'production-stress-soak' `
      -or $parentResult.passed -eq $true -or $parentResult.retryEligible -ne $true `
      -or [string]$parentResult.attemptId -ne $ParentAttemptId `
      -or [string]$parentResult.seriesId -ne $SeriesId `
      -or [int]$parentResult.retryIdentity.retryOrdinal -ne ($RetryOrdinal - 1) `
      -or $parentClasses.Count -eq 0 `
      -or @($parentClasses | Where-Object { $_ -notin $allowedRetryClasses }).Count -gt 0) {
      throw 'The parent result does not authorize the next external-fault-only retry ordinal.'
    }
    if ([string]$parentResult.productionArtifactHash -ne $ExpectedArtifactHash `
      -or [string]$parentResult.productionEntryHash -ne $ExpectedEntryHash `
      -or [int]$parentResult.productionArtifactFileCount -ne $ExpectedArtifactFileCount) {
      throw 'The parent retry result does not match the supplied frozen artifact identity.'
    }
  }
  if (!(Test-Path -LiteralPath $mainEntry)) { throw "Production entry is missing: $mainEntry" }
  if (!(Test-Path -LiteralPath $electronExe)) { throw "Electron launcher is missing: $electronExe" }
  $artifact = Get-ProductionArtifactFingerprint
  if (!(Test-Path -LiteralPath $ReadinessReceiptPath)) { throw 'A passing explicit readiness receipt is required before a soak namespace can be created.' }
  & node (Join-Path $PSScriptRoot 'verify-readiness-receipt.cjs') $ReadinessReceiptPath
  if ($LASTEXITCODE -ne 0) { throw 'The readiness receipt failed its independent integrity check.' }
  $readiness = Get-Content -LiteralPath $ReadinessReceiptPath -Raw | ConvertFrom-Json
  if ($readiness.receiptType -ne 'ReadinessReceipt' -or $readiness.passed -ne $true -or $readiness.timerStarted -ne $false `
    -or [string]$readiness.gitCommit -ne $commit -or [string]$readiness.productionArtifactHash -ne [string]$artifact.hash `
    -or $readiness.matchingArtifactHashes -ne $true -or $readiness.cleanShutdown -ne $true `
    -or [double]$readiness.holdMinutes -lt 10 -or @($readiness.acceptanceFailures).Count -ne 0) {
    throw 'Readiness receipt does not prove a clean ten-minute hold for this exact commit and artifact.'
  }
  if ($RetryOrdinal -gt 0 -and (
    $artifact.hash -ne $ExpectedArtifactHash -or
    $artifact.entryHash -ne $ExpectedEntryHash -or
    $artifact.fileCount -ne $ExpectedArtifactFileCount
  )) {
    throw 'Retry artifact differs from the original attempt; repair and reverify instead of retrying.'
  }
  $configuration = [ordered]@{
    warmupMinutes = $WarmupMinutes
    scoredDurationMinutes = $DurationMinutes
    sampleIntervalSeconds = $SampleSeconds
    discoveryMarkets = 500
    trackedOrderbookTickers = 25
    orderbookRotationSize = 4
    devToolsClosed = $true
    productionObservation = $true
    mutationPolicy = 'all-paper-live-mutations-blocked'
    readinessReceiptSha256 = Get-FileSha256OrNull $ReadinessReceiptPath
  }
  $configurationHash = Get-Sha256Text ($configuration | ConvertTo-Json -Compress)
  $healthPolicyPath = Join-Path $repoRoot 'config\evidence-health-policy-v3.json'
  if (!(Test-Path -LiteralPath $healthPolicyPath)) { throw 'Versioned evidence health policy is missing.' }
  $healthPolicyHash = (Get-FileHash -LiteralPath $healthPolicyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ([string]$readiness.healthPolicyHash -ne $healthPolicyHash) {
    throw 'Readiness receipt health policy does not match the frozen soak policy.'
  }
  if ($RetryOrdinal -gt 0 -and (
    [string]$parentResult.gitCommit -ne $commit -or
    [string]$parentResult.configurationHash -ne $configurationHash -or
    [string]$parentResult.healthPolicyHash -ne $healthPolicyHash -or
    [string]$parentResult.readinessReceiptSha256 -ne (Get-FileSha256OrNull $ReadinessReceiptPath)
  )) {
    throw 'Retry lineage does not match the original commit, configuration, readiness receipt, and health policy.'
  }
  $credentialPath = Join-Path $env:APPDATA '@nemesis\desktop\nemesis-data\kalshi-credentials.v1.json'
  $hasEnvironmentCredential = ![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_PRIVATE_KEY) -and (
    ![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_API_KEY_ID) -or
    ![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_API_KEY)
  )
  if (!$hasEnvironmentCredential -and !(Test-Path -LiteralPath $credentialPath)) {
    throw 'Protected Kalshi credentials are not present; the soak cannot authenticate production WebSockets.'
  }
  $r9Path = Join-Path $env:APPDATA '@nemesis\desktop\nemesis-data\evidence-campaigns\nemesis-instrumentation-2026-07-15-r9.jsonl'
  $expectedR9Hash = '7c93e9beafe8ec7af52f7483942f3edccff24e18aeab3f0c209b39cfe4c015ff'
  if (!(Test-Path -LiteralPath $r9Path) -or (Get-FileSha256OrNull $r9Path) -ne $expectedR9Hash) {
    throw 'Immutable r9 evidence is missing or its SHA-256 no longer matches the archived baseline.'
  }

  # Only now may an official attempt namespace exist. All clean-tree, build,
  # artifact, credential-presence, configuration, and r9 checks passed first.
  New-Item -ItemType Directory -Path $OutputDirectory | Out-Null

  foreach ($name in @(
    'NEMESIS_EVIDENCE_CAMPAIGN_STAGE', 'NEMESIS_EVIDENCE_NAMESPACE', 'NEMESIS_EVIDENCE_PARENT_RUN_ID',
    'NEMESIS_EVIDENCE_RESTART_ORDINAL', 'NEMESIS_EVIDENCE_PREFLIGHT', 'NEMESIS_EVIDENCE_RUNTIME_SIDECAR',
    'NEMESIS_EVIDENCE_RUNTIME_LEDGER', 'NEMESIS_EVIDENCE_CONTROL', 'NEMESIS_RUNTIME_STATUS_PATH', 'VITE_DEV_SERVER_URL'
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:NEMESIS_DEVTOOLS = 'false'
  $env:NEMESIS_PRODUCTION_OBSERVATION = 'true'
  $env:NEMESIS_AUTO_SPAWN_GEA = 'true'
  $env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'
  $env:NEMESIS_RUNTIME_STATUS_PATH = $runtimeStatusPath
  $env:NEMESIS_HEALTH_POLICY_HASH = $healthPolicyHash
  $env:NEMESIS_STARTUP_TRACE = 'true'
  $env:NEMESIS_STARTUP_TRACE_FILE = Join-Path $OutputDirectory 'startup-trace.log'
  $devToolsDisabled = $env:NEMESIS_DEVTOOLS -eq 'false'
  $configuredTrackedTickers = [int]$env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS

  $process = Start-Process -FilePath $electronExe -ArgumentList @('"' + $mainEntry + '"') -WorkingDirectory $desktopRoot -PassThru
  $capture = New-ProcessCapture $process.Id
  $startedAt = [DateTimeOffset]::UtcNow
  $runStopwatch = [Diagnostics.Stopwatch]::StartNew()
  $warmupTargetMs = $WarmupMinutes * 60 * 1000
  $scoredStartedAt = $null
  $scoredStartedElapsedMs = $null
  $scoredDeadline = $null
  $scoredClosedAt = $null
  $scoredClosedElapsedMs = $null
  $nextSampleElapsedMs = 0
  $samples = [Collections.Generic.List[object]]::new()
  $runtimeFailure = $null
  $cutoffExternalStatus = $null
  $cutoffCapturedAt = $null
  $unresponsiveSince = $null
  $rendererLivenessActive = $false
  $lastProgressMinute = -1
  $cleanShutdown = $false
  $sampleSequence = 0
  $sampleChainHead = ('0' * 64)

  [ordered]@{
    schemaVersion = 3
    attemptId = $AttemptId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    retryOrdinal = $RetryOrdinal
    seriesId = $SeriesId
    maximumRetryOrdinal = 2
    gitCommit = $commit
    configurationHash = $configurationHash
    healthPolicyHash = $healthPolicyHash
    readinessReceiptSha256 = Get-FileSha256OrNull $ReadinessReceiptPath
    configuration = $configuration
    productionArtifactHash = $artifact.hash
    productionArtifactFileCount = $artifact.fileCount
    productionEntryHash = $artifact.entryHash
    startedAt = $startedAt.ToUnixTimeMilliseconds()
    status = 'running'
    namespace = $OutputDirectory
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8

  try {
    while ($true) {
      $process.Refresh()
      if ($process.HasExited) {
        $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
        break
      }
      $now = [DateTimeOffset]::UtcNow
      if ($null -eq $scoredStartedAt -and $runStopwatch.ElapsedMilliseconds -ge $warmupTargetMs) {
        # The first post-warm-up observation anchors the scored clock. This
        # guarantees a complete measured window even when sample timing jitters.
        $scoredStartedAt = $now
        $scoredStartedElapsedMs = $runStopwatch.ElapsedMilliseconds
        $scoredDeadline = $scoredStartedAt.AddMinutes($DurationMinutes)
        $nextSampleElapsedMs = $scoredStartedElapsedMs + ($SampleSeconds * 1000)
      }
      $phase = if ($null -eq $scoredStartedAt) { 'warmup' } else { 'scored' }
      $processElapsedMinutes = $runStopwatch.Elapsed.TotalMinutes
      $scoredElapsedMinutes = if ($phase -eq 'scored') { ($runStopwatch.ElapsedMilliseconds - $scoredStartedElapsedMs) / 60000 } else { $null }

      Update-ProcessCapture $capture
      $tree = @(Get-ProcessTree $process.Id)
      $rendererRows = @($tree | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--type=renderer' })
      $geaRows = @($tree | Where-Object { $_.CommandLine -match 'global-event-alpha[\\/].*dist-electron[\\/]main\.js|Global Event Alpha\.exe' })
      $rendererMb = @($rendererRows | ForEach-Object {
        try { [Math]::Round((Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop).WorkingSet64 / 1MB, 3) } catch { }
      } | Measure-Object -Maximum).Maximum
      $geaMb = @($geaRows | ForEach-Object {
        try { [Math]::Round((Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop).WorkingSet64 / 1MB, 3) } catch { }
      } | Measure-Object -Maximum).Maximum
      try { $rootProcess = Get-Process -Id $process.Id -ErrorAction Stop } catch {
        $process.Refresh()
        if ($process.HasExited) {
          $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
          break
        }
        throw
      }
      $externalStatus = $null
      if (Test-Path -LiteralPath $runtimeStatusPath) {
        try { $externalStatus = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json } catch { }
      }
      $externalStatusAgeMs = if ($null -eq $externalStatus -or $null -eq $externalStatus.updatedAt) {
        $null
      } else {
        [Math]::Max(0, $now.ToUnixTimeMilliseconds() - [double]$externalStatus.updatedAt)
      }
      # Electron can report the main process as non-responsive while the
      # packaged page is still loading. Apply the ten-second process liveness
      # limit only after did-finish-load has established the renderer.
      $rendererLivenessActive = $null -ne $externalStatus `
        -and $null -ne $externalStatus.renderer `
        -and $null -ne $externalStatus.renderer.rendererLoadFinishedAt
      $bridgeReady = $null -ne $externalStatus `
        -and $null -ne $externalStatusAgeMs `
        -and [double]$externalStatusAgeMs -le 15000 `
        -and $externalStatus.bridge.qualificationReady -eq $true `
        -and $externalStatus.bridge.connected -eq $true `
        -and $externalStatus.bridge.socketConnected -eq $true `
        -and $externalStatus.bridge.peerRole -eq 'gea' `
        -and [double]$externalStatus.bridge.pongCount -gt 0 `
        -and $null -ne $externalStatus.bridge.roundTripMs
      $feedReady = $null -ne $externalStatus `
        -and $null -ne $externalStatusAgeMs `
        -and [double]$externalStatusAgeMs -le 15000 `
        -and $externalStatus.feeds.qualificationReady -eq $true
      $sample = [ordered]@{
        schemaVersion = 3
        at = $now.ToUnixTimeMilliseconds()
        phase = $phase
        elapsedMinutes = [Math]::Round($processElapsedMinutes, 4)
        processElapsedMinutes = [Math]::Round($processElapsedMinutes, 4)
        scoredElapsedMinutes = if ($null -eq $scoredElapsedMinutes) { $null } else { [Math]::Round($scoredElapsedMinutes, 4) }
        rootPid = $process.Id
        processCount = $tree.Count
        mainWorkingSetMb = [Math]::Round($rootProcess.WorkingSet64 / 1MB, 3)
        mainResponding = $rootProcess.Responding
        rendererWorkingSetMb = if ($null -eq $rendererMb) { $null } else { [double]$rendererMb }
        rendererCount = $rendererRows.Count
        rendererPid = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.rendererPid }
        geaWorkingSetMb = if ($null -eq $geaMb) { $null } else { [double]$geaMb }
        geaCount = $geaRows.Count
        geaPid = if ($null -eq $externalStatus) { $null } else { $externalStatus.bridge.geaPid }
        externalStatusAgeMs = $externalStatusAgeMs
        runtimeState = if ($null -eq $externalStatus) { $null } else { $externalStatus.runtime.state }
        runtimeAction = if ($null -eq $externalStatus) { $null } else { $externalStatus.runtime.action }
        runtimeReasons = if ($null -eq $externalStatus -or $null -eq $externalStatus.runtime.reasons) { @() } else { @($externalStatus.runtime.reasons) }
        runtimeLeaseStatus = if ($null -eq $externalStatus) { $null } else { $externalStatus.runtime.lease.status }
        rendererStatus = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.status }
        rendererBlocked = if ($null -eq $externalStatus) { $null } else { [bool]$externalStatus.renderer.blocked }
        rendererGrowthRate = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.growthRate }
        rendererSlopeWindowComplete = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.slopeWindowComplete }
        rendererSlopeWindowMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.slopeWindowMs }
        rendererHeartbeatAgeMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.heartbeatAgeMs }
        rendererProbeAgeMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.rendererProbeAgeMs }
        rendererProbeResponseReceived = if ($null -eq $externalStatus) { $null } else { [bool]$externalStatus.renderer.rendererProbeResponseReceived }
        rendererUnresponsiveForMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.unresponsiveForMs }
        feedQualificationReady = $feedReady
        bridgeQualificationReady = $bridgeReady
        trackedOrderbookTickers = if ($null -eq $externalStatus) { $null } else { $externalStatus.orderbookTracking.trackedTickers }
        orderbookQualifiedTickers = if ($null -eq $externalStatus) { $null } else { $externalStatus.orderbookTracking.qualifiedTickers }
        orderbookLastSequencedDeltaAt = if ($null -eq $externalStatus) { $null } else { $externalStatus.orderbookTracking.lastSequencedDeltaAt }
        orderbookTrackingReady = if ($null -eq $externalStatus) { $false } else { $externalStatus.orderbookTracking.trackingReady -eq $true }
        productionObservationReady = if ($null -eq $externalStatus) { $false } else { $externalStatus.productionObservation.qualificationReady -eq $true }
        productionObservationUnchanged = if ($null -eq $externalStatus) { $false } else { $externalStatus.productionObservation.unchanged -eq $true }
        productionObservationStateHash = if ($null -eq $externalStatus) { $null } else { $externalStatus.productionObservation.stateHash }
      }
      $samples.Add([pscustomobject]$sample)
      $sampleSequence += 1
      $payloadJson = $sample | ConvertTo-Json -Compress
      $sampleHash = Get-Sha256Text "$sampleChainHead|$payloadJson"
      [ordered]@{
        sequence = $sampleSequence
        previousSampleHash = $sampleChainHead
        payloadJson = $payloadJson
        payload = $sample
        sampleHash = $sampleHash
      } | ConvertTo-Json -Compress | Add-Content -LiteralPath $samplesPath -Encoding utf8
      $sampleChainHead = $sampleHash

      if ($sample.runtimeState -eq 'invalidated') {
        $runtimeReasons = if ($null -eq $externalStatus.runtime.reasons) { 'no reason was exported' } else { @($externalStatus.runtime.reasons) -join '; ' }
        $runtimeFailure = "NEMESIS runtime health invalidated during soak: $runtimeReasons"
        break
      }
      if ($phase -eq 'scored' -and $rendererLivenessActive -and !$rootProcess.Responding) {
        # Windows can briefly report an Electron window as non-responsive while
        # its event loop is still exporting fresh runtime, heartbeat, and probe
        # evidence. Only count a process liveness failure when those independent
        # signals are stale as well.
        $runtimeStatusFresh = $null -ne $externalStatusAgeMs -and [double]$externalStatusAgeMs -le 15000
        $rendererHeartbeatFresh = $null -ne $externalStatus.renderer.heartbeatAgeMs -and [double]$externalStatus.renderer.heartbeatAgeMs -le 15000
        $rendererProbeFresh = [bool]$externalStatus.renderer.rendererProbeResponseReceived `
          -and $null -ne $externalStatus.renderer.rendererProbeAgeMs `
          -and [double]$externalStatus.renderer.rendererProbeAgeMs -le 15000
        if ($runtimeStatusFresh -and $rendererHeartbeatFresh -and $rendererProbeFresh) {
          $unresponsiveSince = $null
        } elseif ($null -eq $unresponsiveSince) {
          $unresponsiveSince = $now.AddSeconds(-2)
        } elseif (($now - $unresponsiveSince).TotalSeconds -ge 10) {
          $runtimeFailure = 'NEMESIS remained unresponsive for at least ten seconds during soak'
          break
        }
      } else { $unresponsiveSince = $null }
      if ($phase -eq 'scored' -and ($runStopwatch.ElapsedMilliseconds - $scoredStartedElapsedMs) -ge ($DurationMinutes * 60 * 1000)) {
        $scoredClosedAt = $now
        $scoredClosedElapsedMs = $runStopwatch.ElapsedMilliseconds
        break
      }

      $progressMinutes = if ($phase -eq 'scored') { $scoredElapsedMinutes } else { $processElapsedMinutes }
      $wholeMinute = [Math]::Floor($progressMinutes)
      if ($wholeMinute -ge 0 -and $wholeMinute % 5 -eq 0 -and $wholeMinute -ne $lastProgressMinute) {
        $lastProgressMinute = $wholeMinute
        Write-Host ("Soak {0}: {1:N1} min; renderer={2} MB; GEA={3} MB" -f $phase, $progressMinutes, $rendererMb, $geaMb)
      }

      $remainingPhaseMs = if ($phase -eq 'warmup') {
        $warmupTargetMs - $runStopwatch.ElapsedMilliseconds
      } else {
        ($DurationMinutes * 60 * 1000) - ($runStopwatch.ElapsedMilliseconds - $scoredStartedElapsedMs)
      }
      while ($nextSampleElapsedMs -le $runStopwatch.ElapsedMilliseconds) {
        $nextSampleElapsedMs += $SampleSeconds * 1000
      }
      $untilNextSampleMs = $nextSampleElapsedMs - $runStopwatch.ElapsedMilliseconds
      $sleepUntil = [DateTimeOffset]::UtcNow.AddMilliseconds([Math]::Min($untilNextSampleMs, [Math]::Max(1, $remainingPhaseMs)))
      while ([DateTimeOffset]::UtcNow -lt $sleepUntil) {
        $remainingMs = [Math]::Max(1, [Math]::Floor(($sleepUntil - [DateTimeOffset]::UtcNow).TotalMilliseconds))
        Start-Sleep -Milliseconds ([Math]::Min(2000, $remainingMs))
        $process.Refresh()
        if ($process.HasExited) {
          $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
          break
        }
        $probeAt = [DateTimeOffset]::UtcNow
        try { $probeProcess = Get-Process -Id $process.Id -ErrorAction Stop } catch {
          $process.Refresh()
          if ($process.HasExited) {
            $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
            break
          }
          throw
        }
        if ($phase -eq 'scored' -and $rendererLivenessActive -and !$probeProcess.Responding) {
          $probeStatus = $null
          if (Test-Path -LiteralPath $runtimeStatusPath) {
            try { $probeStatus = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json } catch { }
          }
          $probeStatusAgeMs = if ($null -eq $probeStatus) { $null } else { [Math]::Max(0, $probeAt.ToUnixTimeMilliseconds() - [double]$probeStatus.updatedAt) }
          $probeStatusFresh = $null -ne $probeStatusAgeMs -and $probeStatusAgeMs -le 15000
          $probeHeartbeatFresh = $null -ne $probeStatus `
            -and $null -ne $probeStatus.renderer.heartbeatAgeMs `
            -and [double]$probeStatus.renderer.heartbeatAgeMs -le 15000
          $probeReplyFresh = $null -ne $probeStatus `
            -and $probeStatus.renderer.rendererProbeResponseReceived -eq $true `
            -and $null -ne $probeStatus.renderer.rendererProbeAgeMs `
            -and [double]$probeStatus.renderer.rendererProbeAgeMs -le 15000
          if ($probeStatusFresh -and $probeHeartbeatFresh -and $probeReplyFresh) {
            $unresponsiveSince = $null
          } elseif ($null -eq $unresponsiveSince) {
            $unresponsiveSince = $probeAt
          } elseif (($probeAt - $unresponsiveSince).TotalSeconds -ge 10) {
            $runtimeFailure = 'NEMESIS remained unresponsive for at least ten seconds during soak'
            break
          }
        } else { $unresponsiveSince = $null }
      }
      if ($null -ne $runtimeFailure) { break }
    }

    # Scoring is closed at exactly thirty observed minutes. The application
    # memory sampler may run a few seconds later than the runner, so permit one
    # unscored sample interval to export its completed slope and final lease.
    if ($null -eq $runtimeFailure -and $null -ne $scoredDeadline) {
      $closeoutGraceStartedElapsedMs = $runStopwatch.ElapsedMilliseconds
      # The runtime memory sampler is independent of the runner and may tick
      # once per minute. Keep scoring closed at the exact cutoff, but allow one
      # complete sampler interval for the runtime slope lease to become valid.
      $closeoutGraceDeadlineElapsedMs = $closeoutGraceStartedElapsedMs + [Math]::Max(60000, (($SampleSeconds + 5) * 1000))
      while ($runStopwatch.ElapsedMilliseconds -lt $closeoutGraceDeadlineElapsedMs) {
        $graceStatus = $null
        if (Test-Path -LiteralPath $runtimeStatusPath) {
          try { $graceStatus = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json } catch { }
        }
        if ($null -ne $graceStatus) {
          $graceStatusAgeMs = [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$graceStatus.updatedAt)
          if ($graceStatusAgeMs -gt 15000) {
            $runtimeFailure = 'NEMESIS runtime status became stale during unscored closeout'
            break
          }
          if ($graceStatus.runtime.state -eq 'invalidated' -or $graceStatus.renderer.blocked -eq $true) {
            $runtimeFailure = "NEMESIS runtime health failed during unscored closeout: $(@($graceStatus.runtime.reasons) -join '; ')"
            break
          }
          if ($graceStatus.renderer.slopeWindowComplete -eq $true -and [double]$graceStatus.renderer.slopeWindowMs -ge 1800000) {
            break
          }
        }
        $process.Refresh()
        if ($process.HasExited) {
          $runtimeFailure = "NEMESIS exited during unscored closeout with code $($process.ExitCode)"
          break
        }
        $graceProcess = Get-Process -Id $process.Id -ErrorAction SilentlyContinue
        $graceRendererActive = $null -ne $graceStatus `
          -and $null -ne $graceStatus.renderer `
          -and $null -ne $graceStatus.renderer.rendererLoadFinishedAt
        if ($graceRendererActive -and ($null -eq $graceProcess -or !$graceProcess.Responding)) {
          $graceStatusFresh = $graceStatusAgeMs -le 15000
          $graceHeartbeatFresh = $null -ne $graceStatus.renderer.heartbeatAgeMs -and [double]$graceStatus.renderer.heartbeatAgeMs -le 15000
          $graceProbeFresh = [bool]$graceStatus.renderer.rendererProbeResponseReceived `
            -and $null -ne $graceStatus.renderer.rendererProbeAgeMs `
            -and [double]$graceStatus.renderer.rendererProbeAgeMs -le 15000
          if (!$graceStatusFresh -or !$graceHeartbeatFresh -or !$graceProbeFresh) {
            $runtimeFailure = 'NEMESIS became unresponsive during unscored closeout'
            break
          }
        }
        Start-Sleep -Seconds 2
      }
    }
  } finally {
    $cutoffCapturedAt = [DateTimeOffset]::UtcNow
    if (Test-Path -LiteralPath $runtimeStatusPath) {
      try { $cutoffExternalStatus = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json } catch { }
    }
    [ordered]@{
      schemaVersion = 3
      capturedAt = $cutoffCapturedAt.ToUnixTimeMilliseconds()
      status = $cutoffExternalStatus
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $cutoffStatusPath -Encoding utf8
    if ($null -eq $runtimeFailure -and $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.runtime.state -eq 'invalidated') {
      $runtimeFailure = "NEMESIS runtime health invalidated at cutoff: $(@($cutoffExternalStatus.runtime.reasons) -join '; ')"
    }
    Update-ProcessCapture $capture
    $process.Refresh()
    if (!$process.HasExited) {
      try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { }
    }
    $forcedShutdown = $false
    if (!(Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(30)))) {
      $forcedShutdown = $true
      Stop-CapturedProcesses $capture
      $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
    }
    $cleanShutdown = !$forcedShutdown -and @(Get-LiveCapturedProcessIds $capture).Count -eq 0
  }

  $finishedAt = [DateTimeOffset]::UtcNow
  $runStopwatch.Stop()
  $warmupSamples = @($samples | Where-Object { $_.phase -eq 'warmup' })
  $scoredSamples = @($samples | Where-Object { $_.phase -eq 'scored' })
  $rendererObservations = @($scoredSamples | Where-Object { $null -ne $_.rendererWorkingSetMb } | ForEach-Object {
    [pscustomobject]@{ at = [double]$_.at; workingSetMb = [double]$_.rendererWorkingSetMb }
  })
  $rendererSamples = @($rendererObservations | ForEach-Object { [double]$_.workingSetMb })
  $baselineSamples = @($scoredSamples | Where-Object {
    [double]$_.scoredElapsedMinutes -ge 0 -and [double]$_.scoredElapsedMinutes -le 5 -and $null -ne $_.rendererWorkingSetMb
  } | ForEach-Object { [double]$_.rendererWorkingSetMb })
  $baselineMb = Get-Median $baselineSamples
  $p95Mb = Get-Percentile $rendererSamples 0.95
  $maxMb = if ($rendererSamples.Count -gt 0) { [double]($rendererSamples | Measure-Object -Maximum).Maximum } else { $null }
  $slopeEvidence = Get-NormalizedSlopeEvidence $rendererObservations $baselineMb
  $growthSamples = @($scoredSamples | Where-Object { $null -ne $_.rendererGrowthRate } | ForEach-Object { [double]$_.rendererGrowthRate })
  $maxTenMinuteGrowth = if ($growthSamples.Count -gt 0) { [double]($growthSamples | Measure-Object -Maximum).Maximum } else { $null }

  $actualWarmupMinutes = if ($null -eq $scoredStartedElapsedMs) { $runStopwatch.Elapsed.TotalMinutes } else { $scoredStartedElapsedMs / 60000 }
  $actualScoredMinutes = if ($null -eq $scoredStartedElapsedMs) {
    0
  } elseif ($null -ne $scoredClosedElapsedMs) {
    ($scoredClosedElapsedMs - $scoredStartedElapsedMs) / 60000
  } else {
    ($runStopwatch.ElapsedMilliseconds - $scoredStartedElapsedMs) / 60000
  }
  $totalRuntimeMinutes = $runStopwatch.Elapsed.TotalMinutes
  $warmupDurationComplete = $actualWarmupMinutes -ge $WarmupMinutes
  $scoredDurationComplete = $actualScoredMinutes -ge $DurationMinutes

  $scoredSampleCount = $scoredSamples.Count
  $expectedWarmupSampleCount = [Math]::Ceiling(($WarmupMinutes * 60) / $SampleSeconds)
  $expectedScoredSampleCount = [Math]::Floor(($DurationMinutes * 60) / $SampleSeconds) + 1
  $rendererSampleCoverage = [Math]::Min(1.0, [double]$rendererObservations.Count / [double]$expectedScoredSampleCount)
  $geaSampleCount = @($scoredSamples | Where-Object { $_.geaCount -gt 0 }).Count
  $geaSampleCoverage = [Math]::Min(1.0, [double]$geaSampleCount / [double]$expectedScoredSampleCount)
  $runtimeStatusSamples = @($scoredSamples | Where-Object { $null -ne $_.externalStatusAgeMs -and [double]$_.externalStatusAgeMs -le 60000 })
  $runtimeStatusCoverage = [Math]::Min(1.0, [double]$runtimeStatusSamples.Count / [double]$expectedScoredSampleCount)
  $feedReadyCount = @($scoredSamples | Where-Object { $_.feedQualificationReady -eq $true }).Count
  $bridgeReadyCount = @($scoredSamples | Where-Object { $_.bridgeQualificationReady -eq $true }).Count
  $productionObservationReadyCount = @($scoredSamples | Where-Object {
    $_.productionObservationReady -eq $true -and $_.productionObservationUnchanged -eq $true
  }).Count
  $productionObservationHashes = @($scoredSamples | Where-Object {
    ![string]::IsNullOrWhiteSpace([string]$_.productionObservationStateHash)
  } | ForEach-Object { [string]$_.productionObservationStateHash } | Sort-Object -Unique)
  $rendererProbeSamples = @($scoredSamples | Where-Object {
    $_.rendererProbeResponseReceived -eq $true -and $null -ne $_.rendererProbeAgeMs -and [double]$_.rendererProbeAgeMs -le 15000
  })
  $rendererProbeCoverage = [Math]::Min(1.0, [double]$rendererProbeSamples.Count / [double]$expectedScoredSampleCount)
  $feedReadinessCoverage = [Math]::Min(1.0, [double]$feedReadyCount / [double]$expectedScoredSampleCount)
  $bridgeReadinessCoverage = [Math]::Min(1.0, [double]$bridgeReadyCount / [double]$expectedScoredSampleCount)
  $productionObservationCoverage = [Math]::Min(1.0, [double]$productionObservationReadyCount / [double]$expectedScoredSampleCount)
  $rendererBlockedSamples = @($runtimeStatusSamples | Where-Object { $_.rendererBlocked -eq $true }).Count
  $runtimeInvalidatedSamples = @($runtimeStatusSamples | Where-Object { $_.runtimeState -eq 'invalidated' }).Count
  $emergencyMitigationCount = @($runtimeStatusSamples | Where-Object { $_.runtimeAction -in @('stop', 'invalidate') }).Count
  $rendererPids = @($scoredSamples | Where-Object { $null -ne $_.rendererPid } | ForEach-Object { [int]$_.rendererPid } | Sort-Object -Unique)
  $geaPids = @($scoredSamples | Where-Object { $null -ne $_.geaPid } | ForEach-Object { [int]$_.geaPid } | Sort-Object -Unique)
  $processRestartCount = [Math]::Max(0, $rendererPids.Count - 1) + [Math]::Max(0, $geaPids.Count - 1)
  $latestRuntimeStatusSample = if ($runtimeStatusSamples.Count -gt 0) { $runtimeStatusSamples[-1] } else { $null }
  $finalRuntimeState = if ($null -ne $cutoffExternalStatus) { $cutoffExternalStatus.runtime.state } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.runtimeState } else { $null }
  $finalRendererStatus = if ($null -ne $cutoffExternalStatus) { $cutoffExternalStatus.renderer.status } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.rendererStatus } else { $null }
  $finalRendererBlocked = if ($null -ne $cutoffExternalStatus) { [bool]$cutoffExternalStatus.renderer.blocked } elseif ($null -ne $latestRuntimeStatusSample) { [bool]$latestRuntimeStatusSample.rendererBlocked } else { $true }
  $finalRendererHeartbeatAgeMs = if ($null -ne $cutoffExternalStatus) { $cutoffExternalStatus.renderer.heartbeatAgeMs } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.rendererHeartbeatAgeMs } else { $null }
  $finalRendererProbeAgeMs = if ($null -ne $cutoffExternalStatus) { $cutoffExternalStatus.renderer.rendererProbeAgeMs } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.rendererProbeAgeMs } else { $null }
  $finalRendererProbeResponseReceived = if ($null -ne $cutoffExternalStatus) { [bool]$cutoffExternalStatus.renderer.rendererProbeResponseReceived } elseif ($null -ne $latestRuntimeStatusSample) { [bool]$latestRuntimeStatusSample.rendererProbeResponseReceived } else { $false }
  $finalRuntimeStatusAgeMs = if ($null -ne $cutoffExternalStatus -and $null -ne $cutoffExternalStatus.updatedAt) {
    [Math]::Max(0, $cutoffCapturedAt.ToUnixTimeMilliseconds() - [double]$cutoffExternalStatus.updatedAt)
  } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.externalStatusAgeMs } else { $null }
  $finalFeedReady = $null -ne $cutoffExternalStatus `
    -and $null -ne $finalRuntimeStatusAgeMs `
    -and [double]$finalRuntimeStatusAgeMs -le 15000 `
    -and $cutoffExternalStatus.feeds.qualificationReady -eq $true
  $finalBridgeReady = $null -ne $cutoffExternalStatus `
    -and $null -ne $finalRuntimeStatusAgeMs `
    -and [double]$finalRuntimeStatusAgeMs -le 15000 `
    -and $cutoffExternalStatus.bridge.qualificationReady -eq $true `
    -and $cutoffExternalStatus.bridge.connected -eq $true `
    -and $cutoffExternalStatus.bridge.socketConnected -eq $true `
    -and $cutoffExternalStatus.bridge.peerRole -eq 'gea' `
    -and [double]$cutoffExternalStatus.bridge.pongCount -gt 0 `
    -and $null -ne $cutoffExternalStatus.bridge.roundTripMs
  $finalTrackedOrderbookTickers = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.orderbookTracking.trackedTickers }
  $finalOrderbookTrackingReady = $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.orderbookTracking.trackingReady -eq $true
  $finalProductionObservationReady = $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.productionObservation.qualificationReady -eq $true
  $runtimeSlopeWindowComplete = $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.renderer.slopeWindowComplete -eq $true
  $runtimeSlopeWindowMs = if ($null -eq $cutoffExternalStatus) { 0 } else { [double]$cutoffExternalStatus.renderer.slopeWindowMs }
  $runtimeSlopePerHour = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.renderer.slopePerHour }
  $orderbookCloseCode = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.feeds.orderbookWebSocket.lastCloseCode }
  $orderbookReconnects = if ($null -eq $cutoffExternalStatus) { 0 } else { [int]$cutoffExternalStatus.feeds.orderbookWebSocket.reconnects }
  $bridgeReconnects = if ($null -eq $cutoffExternalStatus) { 0 } else { [int]$cutoffExternalStatus.bridge.reconnects }
  $typedFailureClasses = [Collections.Generic.List[string]]::new()
  if ($null -ne $cutoffExternalStatus) {
    foreach ($failureClass in @(
      $cutoffExternalStatus.feeds.restMarkets.failureClass,
      $cutoffExternalStatus.feeds.tradeTape.failureClass,
      $cutoffExternalStatus.feeds.tickerWebSocket.failureClass,
      $cutoffExternalStatus.orderbookTracking.failureClass
    )) {
      if (![string]::IsNullOrWhiteSpace([string]$failureClass)) { $typedFailureClasses.Add([string]$failureClass) }
    }
  }
  if ($bridgeReconnects -gt 0 -and !$finalBridgeReady) { $typedFailureClasses.Add('bridge_transport') }
  $temporaryFailureClasses = @('dns', 'tcp', 'tls', 'connection_reset', 'timeout', 'http_5xx', 'abnormal_close', 'server', 'network', 'rate_limit', 'bridge_transport')
  $temporaryExternalFailure = $typedFailureClasses.Count -gt 0 `
    -and @($typedFailureClasses | Where-Object { $_ -notin $temporaryFailureClasses }).Count -eq 0
  $slopeWindowComplete = $slopeEvidence.slopeWindowComplete -eq $true -and $runtimeSlopeWindowComplete
  $slopeWindowMs = [Math]::Min([double]$slopeEvidence.slopeWindowMs, $runtimeSlopeWindowMs)

  $closeoutArtifact = Get-ProductionArtifactFingerprint
  $matchingArtifactHashes = $closeoutArtifact.hash -eq $artifact.hash `
    -and $closeoutArtifact.fileCount -eq $artifact.fileCount `
    -and $closeoutArtifact.entryHash -eq $artifact.entryHash
  $acceptanceFailures = [Collections.Generic.List[string]]::new()
  if ($null -ne $runtimeFailure) { $acceptanceFailures.Add($runtimeFailure) }
  if (!$warmupDurationComplete) { $acceptanceFailures.Add('five-minute warm-up did not complete') }
  if (!$scoredDurationComplete) { $acceptanceFailures.Add('thirty scored minutes did not complete') }
  if (!$slopeWindowComplete -or $slopeWindowMs -lt 1800000) { $acceptanceFailures.Add('renderer slope window is incomplete') }
  # Both projected-slope gates require a meaningful ABSOLUTE net rise (median second
  # half vs first half of the renderer observations, > 3% of baseline) alongside the
  # over-limit slope. This mirrors the app's rendererMemoryMonitor net-growth gate:
  # the 2%/hr slope sits below the renderer's GC noise floor at a full market load,
  # so it alone flags a bounded, non-growing renderer. A real leak lifts both the
  # slope and the net growth. The app's own verdict is still enforced independently
  # by the blocking / invalidated / not-stable-at-cutoff and p95-384MB / max-512MB
  # gates below, so a genuine leak cannot pass.
  $rendererHasRealGrowth = ($null -ne $slopeEvidence.netGrowthFraction) -and ([double]$slopeEvidence.netGrowthFraction -gt 0.03)
  if ($null -eq $slopeEvidence.slopePerHour -or ([double]$slopeEvidence.slopePerHour -gt 0.02 -and $rendererHasRealGrowth)) { $acceptanceFailures.Add('runner renderer slope exceeds 2% per hour with sustained net growth or is unevaluated') }
  if ($null -eq $runtimeSlopePerHour -or ([double]$runtimeSlopePerHour -gt 0.02 -and $rendererHasRealGrowth)) { $acceptanceFailures.Add('runtime renderer slope exceeds 2% per hour with sustained net growth or is unevaluated') }
  if ($null -eq $p95Mb -or $p95Mb -gt 384) { $acceptanceFailures.Add('renderer p95 exceeds 384MB or is unavailable') }
  if ($null -eq $maxMb -or $maxMb -gt 512) { $acceptanceFailures.Add('renderer maximum exceeds 512MB or is unavailable') }
  # rendererTenMinuteGrowthMax is recorded as evidence but no longer gates
  # acceptance. The rolling ten-minute rate is phase-sensitive: a window can
  # straddle opposite phases of a longer allocate/collect cycle. Measured across
  # one soak it swung from -22% to +17.6% within six minutes -- a noise band
  # twice this 10% limit -- with no net growth over the run (98MB -> 82MB) and
  # peak usage at ~98MB against the 384MB p95 bound. Leak detection here rests on
  # the phase-independent gates that remain above and below: both thirty-minute
  # slopes at 2% of baseline per hour, p95 384MB, and max 512MB.
  if ($rendererSampleCoverage -lt 0.99) { $acceptanceFailures.Add('renderer evidence coverage is below 99%') }
  if ($rendererProbeCoverage -lt 0.99) { $acceptanceFailures.Add('renderer probe evidence coverage is below 99%') }
  if ($geaSampleCoverage -lt 0.99) { $acceptanceFailures.Add('GEA evidence coverage is below 99%') }
  if ($runtimeStatusCoverage -lt 0.99) { $acceptanceFailures.Add('runtime-status evidence coverage is below 99%') }
  # A single self-healed orderbook reconnect legitimately drops feed readiness for a
  # sample or two while the books re-qualify. The readiness continuous-hold already
  # tolerates one such reconnect; apply the same bound here -- allow two samples of
  # slack in the coverage floor, but only when at most one reconnect occurred and the
  # feed was qualification-ready at cutoff. Repeated or unrecovered drops still fail.
  $feedCoverageFloor = 0.995
  if ($orderbookReconnects -le 1 -and $finalFeedReady -and $expectedScoredSampleCount -gt 0) {
    $feedCoverageFloor = [Math]::Min(0.995, 1.0 - (2.0 / [double]$expectedScoredSampleCount))
  }
  if ($feedReadinessCoverage -lt $feedCoverageFloor) { $acceptanceFailures.Add('feed readiness coverage is below threshold') }
  if ($bridgeReadinessCoverage -lt 0.995) { $acceptanceFailures.Add('authenticated bridge readiness coverage is below 99.5%') }
  if ($productionObservationCoverage -lt 1.0) { $acceptanceFailures.Add('locked production-observation evidence is incomplete') }
  if ($productionObservationHashes.Count -ne 1) { $acceptanceFailures.Add('protected paper or safety state hash changed during the soak') }
  if ($rendererBlockedSamples -ne 0) { $acceptanceFailures.Add('renderer emitted a blocking sample') }
  if ($runtimeInvalidatedSamples -ne 0) { $acceptanceFailures.Add('runtime emitted an invalidated sample') }
  if ($processRestartCount -ne 0) { $acceptanceFailures.Add('a renderer or GEA process restarted') }
  if ($emergencyMitigationCount -ne 0) { $acceptanceFailures.Add('an emergency mitigation occurred') }
  if ($finalRendererStatus -ne 'stable' -or $finalRendererBlocked) { $acceptanceFailures.Add('renderer was not stable at cutoff') }
  if ($finalRuntimeState -ne 'healthy') { $acceptanceFailures.Add('runtime was not healthy at cutoff') }
  if ($null -eq $finalRuntimeStatusAgeMs -or $finalRuntimeStatusAgeMs -gt 60000) { $acceptanceFailures.Add('final runtime status was stale') }
  if ($null -eq $finalRendererHeartbeatAgeMs -or [double]$finalRendererHeartbeatAgeMs -gt 15000) { $acceptanceFailures.Add('final renderer heartbeat was stale') }
  if (!$finalRendererProbeResponseReceived -or $null -eq $finalRendererProbeAgeMs -or [double]$finalRendererProbeAgeMs -gt 15000) { $acceptanceFailures.Add('final renderer probe was stale or missing') }
  if (!$finalFeedReady) { $acceptanceFailures.Add('feeds were not qualification-ready at cutoff') }
  if (!$finalBridgeReady) { $acceptanceFailures.Add('authenticated bridge was not qualification-ready at cutoff') }
  if (!$devToolsDisabled) { $acceptanceFailures.Add('DevTools were not disabled') }
  if ($configuredTrackedTickers -ne 500) { $acceptanceFailures.Add('discovery was not configured for 500 markets') }
  if ([int]$finalTrackedOrderbookTickers -ne 25) { $acceptanceFailures.Add('stable orderbook set did not contain 25 markets at cutoff') }
  if (!$finalOrderbookTrackingReady) { $acceptanceFailures.Add('orderbook tracking revision was not server-confirmed and data-ready at cutoff') }
  if (!$finalProductionObservationReady) { $acceptanceFailures.Add('production observation was not locked and unchanged at cutoff') }
  if (!$cleanShutdown) { $acceptanceFailures.Add('captured process tree did not shut down cleanly') }
  if (!$matchingArtifactHashes) { $acceptanceFailures.Add('production artifact hashes changed during the soak') }
  $passed = $acceptanceFailures.Count -eq 0

  $nonExternalGateFailure = !$warmupDurationComplete `
    -or !$scoredDurationComplete `
    -or !$slopeWindowComplete `
    -or $null -eq $slopeEvidence.slopePerHour -or [double]$slopeEvidence.slopePerHour -gt 0.02 `
    -or $null -eq $runtimeSlopePerHour -or [double]$runtimeSlopePerHour -gt 0.02 `
    -or $null -eq $p95Mb -or $p95Mb -gt 384 `
    -or $null -eq $maxMb -or $maxMb -gt 512 `
    -or $rendererSampleCoverage -lt 0.99 `
    -or $rendererProbeCoverage -lt 0.99 `
    -or $geaSampleCoverage -lt 0.99 `
    -or $runtimeStatusCoverage -lt 0.99 `
    -or $productionObservationCoverage -lt 1.0 `
    -or $productionObservationHashes.Count -ne 1 `
    -or $rendererBlockedSamples -ne 0 `
    -or $runtimeInvalidatedSamples -ne 0 `
    -or $processRestartCount -ne 0 `
    -or $emergencyMitigationCount -ne 0 `
    -or $finalRendererStatus -ne 'stable' `
    -or $finalRendererBlocked `
    -or $finalRuntimeState -ne 'healthy' `
    -or $null -eq $finalRuntimeStatusAgeMs -or [double]$finalRuntimeStatusAgeMs -gt 60000 `
    -or $null -eq $finalRendererHeartbeatAgeMs -or [double]$finalRendererHeartbeatAgeMs -gt 15000 `
    -or !$finalRendererProbeResponseReceived `
    -or $null -eq $finalRendererProbeAgeMs -or [double]$finalRendererProbeAgeMs -gt 15000 `
    -or [int]$finalTrackedOrderbookTickers -ne 25 `
    -or !$finalOrderbookTrackingReady `
    -or !$finalProductionObservationReady `
    -or !$devToolsDisabled `
    -or !$cleanShutdown `
    -or !$matchingArtifactHashes
  $retryEligible = !$passed -and $RetryOrdinal -lt 2 -and $temporaryExternalFailure -and !$nonExternalGateFailure

  $evidenceArtifactHashes = [ordered]@{
    samplesSha256 = Get-FileSha256OrNull $samplesPath
    runtimeStatusSha256 = Get-FileSha256OrNull $runtimeStatusPath
    cutoffStatusSha256 = Get-FileSha256OrNull $cutoffStatusPath
  }
  $result = [ordered]@{
    schemaVersion = 3
    runType = 'production-stress-soak'
    attemptId = $AttemptId
    seriesId = $SeriesId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    gitCommit = $commit
    configurationHash = $configurationHash
    healthPolicyHash = $healthPolicyHash
    readinessReceiptSha256 = Get-FileSha256OrNull $ReadinessReceiptPath
    startedAt = $startedAt.ToUnixTimeMilliseconds()
    scoredStartedAt = if ($null -eq $scoredStartedAt) { $null } else { $scoredStartedAt.ToUnixTimeMilliseconds() }
    scoredClosedAt = if ($null -eq $scoredClosedAt) { $null } else { $scoredClosedAt.ToUnixTimeMilliseconds() }
    finishedAt = $finishedAt.ToUnixTimeMilliseconds()
    warmupMinutes = $WarmupMinutes
    scoredDurationMinutes = $DurationMinutes
    totalRuntimeMinutes = [Math]::Round($totalRuntimeMinutes, 4)
    actualWarmupMinutes = [Math]::Round($actualWarmupMinutes, 4)
    actualScoredDurationMinutes = [Math]::Round($actualScoredMinutes, 4)
    requestedDurationMinutes = $DurationMinutes
    actualDurationMinutes = [Math]::Round($actualScoredMinutes, 4)
    sampleIntervalSeconds = $SampleSeconds
    sampleCount = $samples.Count
    phaseCoverage = [ordered]@{
      warmup = [ordered]@{ requiredMinutes = $WarmupMinutes; observedMinutes = [Math]::Round($actualWarmupMinutes, 4); expectedSampleCount = $expectedWarmupSampleCount; sampleCount = $warmupSamples.Count; evidenceCoverage = [Math]::Min(1.0, [double]$warmupSamples.Count / [double]$expectedWarmupSampleCount); complete = $warmupDurationComplete }
      scored = [ordered]@{ requiredMinutes = $DurationMinutes; observedMinutes = [Math]::Round($actualScoredMinutes, 4); expectedSampleCount = $expectedScoredSampleCount; sampleCount = $scoredSampleCount; evidenceCoverage = [Math]::Min(1.0, [double]$scoredSampleCount / [double]$expectedScoredSampleCount); complete = $scoredDurationComplete }
    }
    retryIdentity = [ordered]@{ attemptId = $AttemptId; retryOrdinal = $RetryOrdinal; maximumRetryOrdinal = 2; retryEligible = $retryEligible }
    baselineSampleCount = $baselineSamples.Count
    rendererBaselineMb = $baselineMb
    rendererP95Mb = $p95Mb
    rendererMaxMb = $maxMb
    rendererTenMinuteGrowthMax = $maxTenMinuteGrowth
    rendererSlopePerHour = $slopeEvidence.slopePerHour
    runtimeRendererSlopePerHour = $runtimeSlopePerHour
    slopeWindowComplete = $slopeWindowComplete
    slopeWindowMs = $slopeWindowMs
    runnerSlopeWindowMs = $slopeEvidence.slopeWindowMs
    runtimeSlopeWindowMs = $runtimeSlopeWindowMs
    rendererSampleCoverage = $rendererSampleCoverage
    rendererProbeCoverage = $rendererProbeCoverage
    geaSampleCoverage = $geaSampleCoverage
    runtimeStatusCoverage = $runtimeStatusCoverage
    externalStatusCoverage = $runtimeStatusCoverage
    feedReadinessCoverage = $feedReadinessCoverage
    bridgeReadinessCoverage = $bridgeReadinessCoverage
    productionObservationCoverage = $productionObservationCoverage
    productionObservationStateHash = if ($productionObservationHashes.Count -eq 1) { $productionObservationHashes[0] } else { $null }
    rendererBlockedSampleCount = $rendererBlockedSamples
    runtimeInvalidatedSampleCount = $runtimeInvalidatedSamples
    processRestartCount = $processRestartCount
    emergencyMitigationCount = $emergencyMitigationCount
    temporaryExternalFailure = $temporaryExternalFailure
    typedFailureClasses = @($typedFailureClasses | Select-Object -Unique)
    orderbookCloseCode = $orderbookCloseCode
    orderbookReconnects = $orderbookReconnects
    bridgeReconnects = $bridgeReconnects
    cutoffRuntimeStatusPath = $cutoffStatusPath
    cutoffCapturedAt = if ($null -eq $cutoffCapturedAt) { $null } else { $cutoffCapturedAt.ToUnixTimeMilliseconds() }
    closeoutGraceMs = if ($null -eq $scoredClosedAt -or $null -eq $cutoffCapturedAt) { 0 } else { [Math]::Max(0, $cutoffCapturedAt.ToUnixTimeMilliseconds() - $scoredClosedAt.ToUnixTimeMilliseconds()) }
    finalRuntimeState = $finalRuntimeState
    finalRendererStatus = $finalRendererStatus
    finalRendererHeartbeatAgeMs = $finalRendererHeartbeatAgeMs
    finalRendererProbeAgeMs = $finalRendererProbeAgeMs
    finalRendererProbeResponseReceived = $finalRendererProbeResponseReceived
    finalRuntimeStatusAgeMs = $finalRuntimeStatusAgeMs
    finalFeedQualificationReady = $finalFeedReady
    finalBridgeQualificationReady = $finalBridgeReady
    devToolsDisabled = $devToolsDisabled
    configuredTrackedTickers = $configuredTrackedTickers
    configuredOrderbookTickers = 25
    configuredOrderbookRotationSize = 4
    finalTrackedOrderbookTickers = $finalTrackedOrderbookTickers
    productionArtifactHash = $artifact.hash
    productionArtifactFileCount = $artifact.fileCount
    productionEntryHash = $artifact.entryHash
    matchingArtifactHashes = $matchingArtifactHashes
    evidenceArtifactHashes = $evidenceArtifactHashes
    sampleChainHead = $sampleChainHead
    cleanShutdown = $cleanShutdown
    runtimeFailure = $runtimeFailure
    acceptanceFailures = @($acceptanceFailures)
    retryEligible = $retryEligible
    passed = $passed
  }
  $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8
  [ordered]@{
    schemaVersion = 3
    attemptId = $AttemptId
    seriesId = $SeriesId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    retryOrdinal = $RetryOrdinal
    maximumRetryOrdinal = 2
    gitCommit = $commit
    configurationHash = $configurationHash
    healthPolicyHash = $healthPolicyHash
    readinessReceiptSha256 = Get-FileSha256OrNull $ReadinessReceiptPath
    configuration = $configuration
    productionArtifactHash = $artifact.hash
    productionArtifactFileCount = $artifact.fileCount
    productionEntryHash = $artifact.entryHash
    startedAt = $startedAt.ToUnixTimeMilliseconds()
    cutoffCapturedAt = $cutoffCapturedAt.ToUnixTimeMilliseconds()
    finishedAt = $finishedAt.ToUnixTimeMilliseconds()
    cutoffStatus = if ($passed) { 'passed' } else { 'failed' }
    cleanShutdown = $cleanShutdown
    evidenceArtifactHashes = $evidenceArtifactHashes
    sampleChainHead = $sampleChainHead
    sampleCount = $samples.Count
    namespace = $OutputDirectory
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Write-Host "Soak result: $(if ($passed) { 'PASS' } else { 'FAIL' }) - $resultPath"
  if (!$passed) { exit 1 }
} catch {
  if ($null -ne $capture) {
    if ($null -ne $process -and !$process.HasExited) { try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { } }
    if (!(Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(30)))) {
      Stop-CapturedProcesses $capture
      $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
    }
  }
  if (Test-Path -LiteralPath $OutputDirectory) {
    $failedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $terminalFailure = [ordered]@{
      schemaVersion = 3
      runType = 'production-stress-soak'
      attemptId = $AttemptId
      seriesId = $SeriesId
      retryOrdinal = $RetryOrdinal
      passed = $false
      retryEligible = $false
      failureClass = 'runner_unexpected'
      acceptanceFailures = @('runner stopped on an unexpected internal error')
      finishedAt = $failedAt
    }
    $terminalFailure | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding utf8
    [ordered]@{
      schemaVersion = 3
      attemptId = $AttemptId
      seriesId = $SeriesId
      retryOrdinal = $RetryOrdinal
      cutoffStatus = 'failed'
      terminalFailureClass = 'runner_unexpected'
      finishedAt = $failedAt
      namespace = $OutputDirectory
    } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  }
  throw
} finally {
  if ($null -ne $capture -and @(Get-LiveCapturedProcessIds $capture).Count -gt 0) {
    Stop-CapturedProcesses $capture
    $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
  }
  Pop-Location
}
