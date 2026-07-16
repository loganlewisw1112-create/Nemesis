param(
  [ValidateRange(1, 240)]
  [int]$DurationMinutes = 30,

  [ValidateRange(1, 30)]
  [int]$WarmupMinutes = 5,

  [ValidateRange(5, 60)]
  [int]$SampleSeconds = 30,

  [ValidateRange(0, 2)]
  [int]$RetryOrdinal = 0,

  [string]$AttemptId,

  [string]$ParentAttemptId,

  [string]$ExpectedArtifactHash,

  [string]$ExpectedEntryHash,

  [int]$ExpectedArtifactFileCount,

  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
if ([string]::IsNullOrWhiteSpace($AttemptId)) { $AttemptId = "soak-attempt-$($RetryOrdinal + 1)" }
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $workspaceRoot 'output\reports\nemesis-gap-closure-r10-2026-07-15\soak'
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
    return [pscustomobject]@{ slopeWindowComplete = $false; slopeWindowMs = $spanMs; slopePerHour = $null }
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
  return [pscustomobject]@{ slopeWindowComplete = $true; slopeWindowMs = $spanMs; slopePerHour = $slope }
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

function Stop-CapturedProcesses([Collections.Generic.HashSet[int]]$ProcessIds) {
  foreach ($processId in @($ProcessIds) | Sort-Object -Descending) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
}

if (Test-Path -LiteralPath $OutputDirectory) {
  $existingAttemptFiles = @(Get-ChildItem -LiteralPath $OutputDirectory -Force)
  if ($existingAttemptFiles.Count -gt 0) {
    throw "Soak attempt namespace is immutable and already contains evidence: $OutputDirectory"
  }
}
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$samplesPath = Join-Path $OutputDirectory 'production-soak-samples.jsonl'
$resultPath = Join-Path $OutputDirectory 'production-soak-result.json'
$manifestPath = Join-Path $OutputDirectory 'production-soak-attempt-manifest.json'
$runtimeStatusPath = Join-Path $OutputDirectory 'production-soak-runtime-status.json'
$cutoffStatusPath = Join-Path $OutputDirectory 'production-soak-runtime-status-at-cutoff.json'
Push-Location $repoRoot
try {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) { throw 'Production soak requires a clean frozen worktree.' }
  $commit = (git rev-parse HEAD).Trim()
  if (!$commit) { throw 'Unable to resolve the frozen git commit.' }

  if ($RetryOrdinal -eq 0) {
    Write-Host "Building frozen production soak at $commit"
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
  } elseif (
    [string]::IsNullOrWhiteSpace($ParentAttemptId) -or
    [string]::IsNullOrWhiteSpace($ExpectedArtifactHash) -or
    [string]::IsNullOrWhiteSpace($ExpectedEntryHash) -or
    $ExpectedArtifactFileCount -le 0
  ) {
    throw 'A retry requires parent attempt identity and the exact original production artifact fingerprint.'
  }
  if (!(Test-Path -LiteralPath $mainEntry)) { throw "Production entry is missing: $mainEntry" }
  if (!(Test-Path -LiteralPath $electronExe)) { throw "Electron launcher is missing: $electronExe" }
  $artifact = Get-ProductionArtifactFingerprint
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
  }
  $configurationHash = Get-Sha256Text ($configuration | ConvertTo-Json -Compress)

  foreach ($name in @(
    'NEMESIS_EVIDENCE_CAMPAIGN_STAGE', 'NEMESIS_EVIDENCE_NAMESPACE', 'NEMESIS_EVIDENCE_PARENT_RUN_ID',
    'NEMESIS_EVIDENCE_RESTART_ORDINAL', 'NEMESIS_EVIDENCE_PREFLIGHT', 'NEMESIS_EVIDENCE_RUNTIME_SIDECAR',
    'NEMESIS_EVIDENCE_RUNTIME_LEDGER', 'NEMESIS_EVIDENCE_CONTROL', 'NEMESIS_RUNTIME_STATUS_PATH', 'VITE_DEV_SERVER_URL'
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:NEMESIS_DEVTOOLS = 'false'
  $env:NEMESIS_AUTO_SPAWN_GEA = 'true'
  $env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'
  $env:NEMESIS_RUNTIME_STATUS_PATH = $runtimeStatusPath
  $env:NEMESIS_STARTUP_TRACE = 'true'
  $env:NEMESIS_STARTUP_TRACE_FILE = Join-Path $OutputDirectory 'startup-trace.log'
  $devToolsDisabled = $env:NEMESIS_DEVTOOLS -eq 'false'
  $configuredTrackedTickers = [int]$env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS

  $process = Start-Process -FilePath $electronExe -ArgumentList @('"' + $mainEntry + '"') -WorkingDirectory $desktopRoot -PassThru
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
  $capturedProcessIds = [Collections.Generic.HashSet[int]]::new()
  $null = $capturedProcessIds.Add($process.Id)
  $runtimeFailure = $null
  $cutoffExternalStatus = $null
  $cutoffCapturedAt = $null
  $unresponsiveSince = $null
  $rendererLivenessActive = $false
  $lastProgressMinute = -1
  $cleanShutdown = $false

  [ordered]@{
    schemaVersion = 2
    attemptId = $AttemptId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    retryOrdinal = $RetryOrdinal
    maximumRetryOrdinal = 2
    gitCommit = $commit
    configurationHash = $configurationHash
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

      $tree = @(Get-ProcessTree $process.Id)
      foreach ($row in $tree) { $null = $capturedProcessIds.Add([int]$row.ProcessId) }
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
        schemaVersion = 2
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
        rendererProbeAgeMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.probeAgeMs }
        rendererProbeResponseReceived = if ($null -eq $externalStatus) { $null } else { [bool]$externalStatus.renderer.probeResponseReceived }
        rendererUnresponsiveForMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.unresponsiveForMs }
        feedQualificationReady = $feedReady
        bridgeQualificationReady = $bridgeReady
        trackedOrderbookTickers = if ($null -eq $externalStatus) { $null } else { $externalStatus.feeds.orderbookWebSocket.trackedTickers }
        orderbookQualifiedTickers = if ($null -eq $externalStatus) { $null } else { $externalStatus.feeds.orderbookWebSocket.qualifiedTickers }
        orderbookLastSequencedDeltaAt = if ($null -eq $externalStatus) { $null } else { $externalStatus.feeds.orderbookWebSocket.lastSequencedDeltaAt }
      }
      $samples.Add([pscustomobject]$sample)
      ($sample | ConvertTo-Json -Compress) | Add-Content -LiteralPath $samplesPath -Encoding utf8

      if ($sample.runtimeState -eq 'invalidated') {
        $runtimeReasons = if ($null -eq $externalStatus.runtime.reasons) { 'no reason was exported' } else { @($externalStatus.runtime.reasons) -join '; ' }
        $runtimeFailure = "NEMESIS runtime health invalidated during soak: $runtimeReasons"
        break
      }
      if ($phase -eq 'scored' -and $rendererLivenessActive -and !$rootProcess.Responding) {
        if ($null -eq $unresponsiveSince) { $unresponsiveSince = $now.AddSeconds(-2) }
        elseif (($now - $unresponsiveSince).TotalSeconds -ge 10) {
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
          if ($null -eq $unresponsiveSince) { $unresponsiveSince = $probeAt.AddSeconds(-2) }
          elseif (($probeAt - $unresponsiveSince).TotalSeconds -ge 10) {
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
      $closeoutGraceDeadlineElapsedMs = $closeoutGraceStartedElapsedMs + (($SampleSeconds + 5) * 1000)
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
          $runtimeFailure = 'NEMESIS became unresponsive during unscored closeout'
          break
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
      schemaVersion = 2
      capturedAt = $cutoffCapturedAt.ToUnixTimeMilliseconds()
      status = $cutoffExternalStatus
    } | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $cutoffStatusPath -Encoding utf8
    if ($null -eq $runtimeFailure -and $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.runtime.state -eq 'invalidated') {
      $runtimeFailure = "NEMESIS runtime health invalidated at cutoff: $(@($cutoffExternalStatus.runtime.reasons) -join '; ')"
    }
    $process.Refresh()
    if (!$process.HasExited) {
      try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { }
      $null = $process.WaitForExit(30000)
    }
    $remainingCaptured = @($capturedProcessIds | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
    $cleanShutdown = $remainingCaptured.Count -eq 0
    if (!$cleanShutdown) { Stop-CapturedProcesses $capturedProcessIds }
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
  $rendererProbeSamples = @($scoredSamples | Where-Object {
    $_.rendererProbeResponseReceived -eq $true -and $null -ne $_.rendererProbeAgeMs -and [double]$_.rendererProbeAgeMs -le 15000
  })
  $rendererProbeCoverage = [Math]::Min(1.0, [double]$rendererProbeSamples.Count / [double]$expectedScoredSampleCount)
  $feedReadinessCoverage = [Math]::Min(1.0, [double]$feedReadyCount / [double]$expectedScoredSampleCount)
  $bridgeReadinessCoverage = [Math]::Min(1.0, [double]$bridgeReadyCount / [double]$expectedScoredSampleCount)
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
  $finalRendererProbeAgeMs = if ($null -ne $cutoffExternalStatus) { $cutoffExternalStatus.renderer.probeAgeMs } elseif ($null -ne $latestRuntimeStatusSample) { $latestRuntimeStatusSample.rendererProbeAgeMs } else { $null }
  $finalRendererProbeResponseReceived = if ($null -ne $cutoffExternalStatus) { [bool]$cutoffExternalStatus.renderer.probeResponseReceived } elseif ($null -ne $latestRuntimeStatusSample) { [bool]$latestRuntimeStatusSample.rendererProbeResponseReceived } else { $false }
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
  $finalTrackedOrderbookTickers = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.feeds.orderbookWebSocket.trackedTickers }
  $runtimeSlopeWindowComplete = $null -ne $cutoffExternalStatus -and $cutoffExternalStatus.renderer.slopeWindowComplete -eq $true
  $runtimeSlopeWindowMs = if ($null -eq $cutoffExternalStatus) { 0 } else { [double]$cutoffExternalStatus.renderer.slopeWindowMs }
  $runtimeSlopePerHour = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.renderer.slopePerHour }
  $orderbookCloseCode = if ($null -eq $cutoffExternalStatus) { $null } else { $cutoffExternalStatus.feeds.orderbookWebSocket.lastCloseCode }
  $orderbookReconnects = if ($null -eq $cutoffExternalStatus) { 0 } else { [int]$cutoffExternalStatus.feeds.orderbookWebSocket.reconnects }
  $bridgeReconnects = if ($null -eq $cutoffExternalStatus) { 0 } else { [int]$cutoffExternalStatus.bridge.reconnects }
  $temporaryExternalFailure = ($orderbookCloseCode -in @(1006, 1001, 1011, 429, 502, 503, 504)) -or
    ($bridgeReconnects -gt 0 -and !$finalBridgeReady)
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
  if ($null -eq $slopeEvidence.slopePerHour -or [double]$slopeEvidence.slopePerHour -gt 0.02) { $acceptanceFailures.Add('runner renderer slope exceeds 2% per hour or is unevaluated') }
  if ($null -eq $runtimeSlopePerHour -or [double]$runtimeSlopePerHour -gt 0.02) { $acceptanceFailures.Add('runtime renderer slope exceeds 2% per hour or is unevaluated') }
  if ($null -eq $p95Mb -or $p95Mb -gt 384) { $acceptanceFailures.Add('renderer p95 exceeds 384MB or is unavailable') }
  if ($null -eq $maxMb -or $maxMb -gt 512) { $acceptanceFailures.Add('renderer maximum exceeds 512MB or is unavailable') }
  if ($null -eq $maxTenMinuteGrowth -or $maxTenMinuteGrowth -gt 0.10) { $acceptanceFailures.Add('renderer ten-minute growth exceeds 10% or is unavailable') }
  if ($rendererSampleCoverage -lt 0.99) { $acceptanceFailures.Add('renderer evidence coverage is below 99%') }
  if ($rendererProbeCoverage -lt 0.99) { $acceptanceFailures.Add('renderer probe evidence coverage is below 99%') }
  if ($geaSampleCoverage -lt 0.99) { $acceptanceFailures.Add('GEA evidence coverage is below 99%') }
  if ($runtimeStatusCoverage -lt 0.99) { $acceptanceFailures.Add('runtime-status evidence coverage is below 99%') }
  if ($feedReadinessCoverage -lt 0.995) { $acceptanceFailures.Add('feed readiness coverage is below 99.5%') }
  if ($bridgeReadinessCoverage -lt 0.995) { $acceptanceFailures.Add('authenticated bridge readiness coverage is below 99.5%') }
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
  if (!$cleanShutdown) { $acceptanceFailures.Add('captured process tree did not shut down cleanly') }
  if (!$matchingArtifactHashes) { $acceptanceFailures.Add('production artifact hashes changed during the soak') }
  $passed = $acceptanceFailures.Count -eq 0

  $failureText = $acceptanceFailures -join '; '
  $nonRetryablePattern = 'integrity|credential|authenticat|memory|renderer|configuration|code|disk|hash|artifact|restart|DevTools'
  $externalPattern = 'Kalshi|feed|bridge|websocket|orderbook|trade tape|rate limit|429|timeout|remote close|traffic'
  $rootFailureText = if ($null -ne $runtimeFailure) { $runtimeFailure } else { $failureText }
  $retryEligible = !$passed -and $RetryOrdinal -lt 2 -and $temporaryExternalFailure -and $failureText -notmatch $nonRetryablePattern

  $evidenceArtifactHashes = [ordered]@{
    samplesSha256 = Get-FileSha256OrNull $samplesPath
    runtimeStatusSha256 = Get-FileSha256OrNull $runtimeStatusPath
    cutoffStatusSha256 = Get-FileSha256OrNull $cutoffStatusPath
  }
  $result = [ordered]@{
    schemaVersion = 2
    runType = 'production-stress-soak'
    attemptId = $AttemptId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    gitCommit = $commit
    configurationHash = $configurationHash
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
    rendererBlockedSampleCount = $rendererBlockedSamples
    runtimeInvalidatedSampleCount = $runtimeInvalidatedSamples
    processRestartCount = $processRestartCount
    emergencyMitigationCount = $emergencyMitigationCount
    temporaryExternalFailure = $temporaryExternalFailure
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
    cleanShutdown = $cleanShutdown
    runtimeFailure = $runtimeFailure
    acceptanceFailures = @($acceptanceFailures)
    retryEligible = $retryEligible
    passed = $passed
  }
  $result | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $resultPath -Encoding utf8
  [ordered]@{
    schemaVersion = 2
    attemptId = $AttemptId
    parentAttemptId = if ([string]::IsNullOrWhiteSpace($ParentAttemptId)) { $null } else { $ParentAttemptId }
    retryOrdinal = $RetryOrdinal
    maximumRetryOrdinal = 2
    gitCommit = $commit
    configurationHash = $configurationHash
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
    namespace = $OutputDirectory
  } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  Write-Host "Soak result: $(if ($passed) { 'PASS' } else { 'FAIL' }) - $resultPath"
  if (!$passed) { exit 1 }
} finally {
  Pop-Location
}
