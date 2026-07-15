param(
  [ValidateRange(1, 240)]
  [int]$DurationMinutes = 45,

  [ValidateRange(5, 60)]
  [int]$SampleSeconds = 30,

  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Split-Path -Parent (Split-Path -Parent $repoRoot)
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
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

function Get-NormalizedSlopePerHour([object[]]$Observations, [double]$BaselineMb) {
  if ($Observations.Count -lt 2 -or $BaselineMb -le 0) { return $null }
  $latestAt = [double]$Observations[-1].at
  $window = @($Observations | Where-Object { [double]$_.at -ge $latestAt - 1800000 })
  if ($window.Count -lt 2 -or ([double]$window[-1].at - [double]$window[0].at) -lt 1620000) { return $null }
  $origin = [double]$window[0].at
  $xs = @($window | ForEach-Object { ([double]$_.at - $origin) / 3600000 })
  $ys = @($window | ForEach-Object { [double]$_.workingSetMb })
  $meanX = ($xs | Measure-Object -Average).Average
  $meanY = ($ys | Measure-Object -Average).Average
  $numerator = 0.0
  $denominator = 0.0
  for ($index = 0; $index -lt $window.Count; $index += 1) {
    $numerator += ($xs[$index] - $meanX) * ($ys[$index] - $meanY)
    $denominator += [Math]::Pow($xs[$index] - $meanX, 2)
  }
  if ($denominator -le 0) { return $null }
  return ($numerator / $denominator) / $BaselineMb
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
  $aggregate = [Convert]::ToHexString(
    [Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes(($rows -join "`n")))
  ).ToLowerInvariant()
  return @{
    hash = $aggregate
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

function Stop-CapturedProcessTree([int]$RootProcessId) {
  $tree = @(Get-ProcessTree $RootProcessId)
  $depth = @{}
  $depth[$RootProcessId] = 0
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $tree) {
      if ($depth.ContainsKey([int]$process.ParentProcessId) -and !$depth.ContainsKey([int]$process.ProcessId)) {
        $depth[[int]$process.ProcessId] = $depth[[int]$process.ParentProcessId] + 1
        $changed = $true
      }
    }
  }
  foreach ($process in $tree | Sort-Object { $depth[[int]$_.ProcessId] } -Descending) {
    Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
  }
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$samplesPath = Join-Path $OutputDirectory 'production-soak-samples.jsonl'
$resultPath = Join-Path $OutputDirectory 'production-soak-result.json'
$runtimeStatusPath = Join-Path $OutputDirectory 'production-soak-runtime-status.json'
Remove-Item -LiteralPath $samplesPath, $resultPath, $runtimeStatusPath -Force -ErrorAction SilentlyContinue

Push-Location $repoRoot
try {
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) { throw 'Production soak requires a clean frozen worktree.' }
  $commit = (git rev-parse HEAD).Trim()
  if (!$commit) { throw 'Unable to resolve the frozen git commit.' }

  Write-Host "Building frozen production soak at $commit"
  npm run build
  if ($LASTEXITCODE -ne 0) { throw "Build failed with exit code $LASTEXITCODE." }
  if (!(Test-Path -LiteralPath $mainEntry)) { throw "Production entry is missing: $mainEntry" }
  if (!(Test-Path -LiteralPath $electronExe)) { throw "Electron launcher is missing: $electronExe" }
  $artifact = Get-ProductionArtifactFingerprint

  foreach ($name in @(
    'NEMESIS_EVIDENCE_CAMPAIGN_STAGE', 'NEMESIS_EVIDENCE_NAMESPACE', 'NEMESIS_EVIDENCE_PARENT_RUN_ID',
    'NEMESIS_EVIDENCE_RESTART_ORDINAL', 'NEMESIS_EVIDENCE_PREFLIGHT', 'NEMESIS_EVIDENCE_RUNTIME_SIDECAR',
    'NEMESIS_EVIDENCE_RUNTIME_LEDGER', 'NEMESIS_EVIDENCE_CONTROL', 'NEMESIS_RUNTIME_STATUS_PATH', 'VITE_DEV_SERVER_URL'
  )) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:NEMESIS_DEVTOOLS = 'false'
  $env:NEMESIS_AUTO_SPAWN_GEA = 'true'
  $env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'
  $env:NEMESIS_RUNTIME_STATUS_PATH = $runtimeStatusPath
  $devToolsDisabled = $env:NEMESIS_DEVTOOLS -eq 'false'
  $configuredTrackedTickers = [int]$env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS

  $process = Start-Process -FilePath $electronExe -ArgumentList @('"' + $mainEntry + '"') -WorkingDirectory $desktopRoot -PassThru
  $startedAt = [DateTimeOffset]::UtcNow
  $deadline = $startedAt.AddMinutes($DurationMinutes)
  $samples = [Collections.Generic.List[object]]::new()
  $runtimeFailure = $null
  $unresponsiveSince = $null
  $lastProgressMinute = -1
  try {
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) {
        $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
        break
      }
      $now = [DateTimeOffset]::UtcNow
      $elapsedMinutes = ($now - $startedAt).TotalMinutes
      $tree = @(Get-ProcessTree $process.Id)
      $rendererRows = @($tree | Where-Object { $_.ParentProcessId -eq $process.Id -and $_.CommandLine -match '--type=renderer' })
      $geaRows = @($tree | Where-Object { $_.CommandLine -match 'global-event-alpha[\\/].*dist-electron[\\/]main\.js|Global Event Alpha\.exe' })
      $rendererMb = @($rendererRows | ForEach-Object {
        try { [Math]::Round((Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop).WorkingSet64 / 1MB, 3) } catch { }
      } | Measure-Object -Maximum).Maximum
      $geaMb = @($geaRows | ForEach-Object {
        try { [Math]::Round((Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop).WorkingSet64 / 1MB, 3) } catch { }
      } | Measure-Object -Maximum).Maximum
      try {
        $rootProcess = Get-Process -Id $process.Id -ErrorAction Stop
      } catch {
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
      $sample = [ordered]@{
        schemaVersion = 2
        at = $now.ToUnixTimeMilliseconds()
        elapsedMinutes = [Math]::Round($elapsedMinutes, 4)
        rootPid = $process.Id
        processCount = $tree.Count
        mainWorkingSetMb = [Math]::Round($rootProcess.WorkingSet64 / 1MB, 3)
        mainResponding = $rootProcess.Responding
        rendererWorkingSetMb = if ($null -eq $rendererMb) { $null } else { [double]$rendererMb }
        rendererCount = $rendererRows.Count
        geaWorkingSetMb = if ($null -eq $geaMb) { $null } else { [double]$geaMb }
        geaCount = $geaRows.Count
        externalStatusAgeMs = $externalStatusAgeMs
        runtimeState = if ($null -eq $externalStatus) { $null } else { $externalStatus.runtime.state }
        runtimeLeaseStatus = if ($null -eq $externalStatus) { $null } else { $externalStatus.runtime.lease.status }
        rendererStatus = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.status }
        rendererBlocked = if ($null -eq $externalStatus) { $null } else { [bool]$externalStatus.renderer.blocked }
        rendererHeartbeatAgeMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.heartbeatAgeMs }
        rendererUnresponsiveForMs = if ($null -eq $externalStatus) { $null } else { $externalStatus.renderer.unresponsiveForMs }
      }
      $samples.Add([pscustomobject]$sample)
      ($sample | ConvertTo-Json -Compress) | Add-Content -LiteralPath $samplesPath -Encoding utf8
      if (!$rootProcess.Responding) {
        if ($null -eq $unresponsiveSince) { $unresponsiveSince = $now.AddSeconds(-2) }
        elseif (($now - $unresponsiveSince).TotalSeconds -ge 10) {
          $runtimeFailure = 'NEMESIS remained unresponsive for at least ten seconds during soak'
          break
        }
      } else { $unresponsiveSince = $null }
      $wholeMinute = [Math]::Floor($elapsedMinutes)
      if ($wholeMinute -ge 0 -and $wholeMinute % 5 -eq 0 -and $wholeMinute -ne $lastProgressMinute) {
        $lastProgressMinute = $wholeMinute
        Write-Host ("Soak {0:N1}/{1} min; renderer={2} MB; GEA={3} MB" -f $elapsedMinutes, $DurationMinutes, $rendererMb, $geaMb)
      }
      $remainingSleepSeconds = $SampleSeconds
      while ($remainingSleepSeconds -gt 0 -and [DateTimeOffset]::UtcNow -lt $deadline) {
        $probeDelaySeconds = [Math]::Min(2, $remainingSleepSeconds)
        Start-Sleep -Seconds $probeDelaySeconds
        $remainingSleepSeconds -= $probeDelaySeconds
        $process.Refresh()
        if ($process.HasExited) {
          $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
          break
        }
        $probeAt = [DateTimeOffset]::UtcNow
        try {
          $probeProcess = Get-Process -Id $process.Id -ErrorAction Stop
        } catch {
          $process.Refresh()
          if ($process.HasExited) {
            $runtimeFailure = "NEMESIS exited early with code $($process.ExitCode)"
            break
          }
          throw
        }
        if (!$probeProcess.Responding) {
          if ($null -eq $unresponsiveSince) { $unresponsiveSince = $probeAt.AddSeconds(-$probeDelaySeconds) }
          elseif (($probeAt - $unresponsiveSince).TotalSeconds -ge 10) {
            $runtimeFailure = 'NEMESIS remained unresponsive for at least ten seconds during soak'
            break
          }
        } else { $unresponsiveSince = $null }
      }
      if ($null -ne $runtimeFailure) { break }
      if ($null -ne $unresponsiveSince) {
        $cutoffProbeAt = [DateTimeOffset]::UtcNow
        if (($cutoffProbeAt - $unresponsiveSince).TotalSeconds -ge 10) {
          $runtimeFailure = 'NEMESIS remained unresponsive for at least ten seconds during soak'
          break
        }
      }
    }
  } finally {
    $process.Refresh()
    $cleanShutdown = $process.HasExited
    if (!$process.HasExited) {
      try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { }
      $cleanShutdown = $process.WaitForExit(30000)
    }
    if (!$cleanShutdown) { Stop-CapturedProcessTree $process.Id }
  }

  $rendererObservations = @($samples | Where-Object { $null -ne $_.rendererWorkingSetMb } | ForEach-Object {
    [pscustomobject]@{ at = [double]$_.at; workingSetMb = [double]$_.rendererWorkingSetMb }
  })
  $rendererSamples = @($rendererObservations | ForEach-Object { [double]$_.workingSetMb })
  $baselineSamples = @($samples | Where-Object {
    $_.elapsedMinutes -ge 5 -and $_.elapsedMinutes -le 10 -and $null -ne $_.rendererWorkingSetMb
  } | ForEach-Object { [double]$_.rendererWorkingSetMb })
  $baselineMb = Get-Median $baselineSamples
  $p95Mb = Get-Percentile $rendererSamples 0.95
  $maxMb = if ($rendererSamples.Count -gt 0) { [double]($rendererSamples | Measure-Object -Maximum).Maximum } else { $null }
  $slopePerHour = $null
  if ($rendererObservations.Count -ge 2 -and $baselineMb -gt 0) {
    $slopePerHour = Get-NormalizedSlopePerHour $rendererObservations $baselineMb
  }
  $actualDurationMinutes = (([DateTimeOffset]::UtcNow - $startedAt).TotalMinutes)
  $rendererSampleCoverage = if ($samples.Count -gt 0) { $rendererObservations.Count / $samples.Count } else { 0 }
  $geaSampleCount = @($samples | Where-Object { $_.geaCount -gt 0 }).Count
  $geaSampleCoverage = if ($samples.Count -gt 0) { $geaSampleCount / $samples.Count } else { 0 }
  $externalStatusSamples = @($samples | Where-Object {
    $null -ne $_.externalStatusAgeMs -and [double]$_.externalStatusAgeMs -le 60000
  })
  $externalStatusCoverage = if ($samples.Count -gt 0) { $externalStatusSamples.Count / $samples.Count } else { 0 }
  $rendererBlockedSamples = @($externalStatusSamples | Where-Object { $_.rendererBlocked -eq $true }).Count
  $runtimeInvalidatedSamples = @($externalStatusSamples | Where-Object { $_.runtimeState -eq 'invalidated' }).Count
  $latestExternalStatus = if ($externalStatusSamples.Count -gt 0) { $externalStatusSamples[-1] } else { $null }
  $durationComplete = $actualDurationMinutes -ge ($DurationMinutes - ($SampleSeconds / 60))
  $passed = $null -eq $runtimeFailure -and $rendererSamples.Count -gt 0 -and $baselineSamples.Count -gt 0 `
    -and $p95Mb -le 384 -and $maxMb -le 512 -and $null -ne $slopePerHour -and $slopePerHour -le 0.02 -and $cleanShutdown `
    -and $durationComplete -and $rendererSampleCoverage -ge 0.95 -and $geaSampleCoverage -ge 0.95 `
    -and $externalStatusCoverage -ge 0.95 -and $rendererBlockedSamples -eq 0 -and $runtimeInvalidatedSamples -eq 0 `
    -and $null -ne $latestExternalStatus -and $latestExternalStatus.rendererStatus -eq 'stable' `
    -and $latestExternalStatus.runtimeState -eq 'healthy' -and $latestExternalStatus.externalStatusAgeMs -le 60000 `
    -and $devToolsDisabled -and $configuredTrackedTickers -eq 500
  $result = [ordered]@{
    schemaVersion = 2
    runType = 'production-stress-soak'
    gitCommit = $commit
    startedAt = $startedAt.ToUnixTimeMilliseconds()
    finishedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    requestedDurationMinutes = $DurationMinutes
    actualDurationMinutes = [Math]::Round($actualDurationMinutes, 4)
    sampleIntervalSeconds = $SampleSeconds
    sampleCount = $samples.Count
    baselineSampleCount = $baselineSamples.Count
    rendererBaselineMb = $baselineMb
    rendererP95Mb = $p95Mb
    rendererMaxMb = $maxMb
    rendererSlopePerHour = $slopePerHour
    rendererSampleCoverage = $rendererSampleCoverage
    geaSampleCoverage = $geaSampleCoverage
    externalStatusCoverage = $externalStatusCoverage
    rendererBlockedSampleCount = $rendererBlockedSamples
    runtimeInvalidatedSampleCount = $runtimeInvalidatedSamples
    finalRuntimeState = if ($null -eq $latestExternalStatus) { $null } else { $latestExternalStatus.runtimeState }
    finalRendererStatus = if ($null -eq $latestExternalStatus) { $null } else { $latestExternalStatus.rendererStatus }
    finalRendererHeartbeatAgeMs = if ($null -eq $latestExternalStatus) { $null } else { $latestExternalStatus.rendererHeartbeatAgeMs }
    finalRuntimeStatusAgeMs = if ($null -eq $latestExternalStatus) { $null } else { $latestExternalStatus.externalStatusAgeMs }
    devToolsDisabled = $devToolsDisabled
    configuredTrackedTickers = $configuredTrackedTickers
    productionArtifactHash = $artifact.hash
    productionArtifactFileCount = $artifact.fileCount
    productionEntryHash = $artifact.entryHash
    cleanShutdown = $cleanShutdown
    runtimeFailure = $runtimeFailure
    passed = $passed
  }
  $result | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $resultPath -Encoding utf8
  Write-Host "Soak result: $(if ($passed) { 'PASS' } else { 'FAIL' }) — $resultPath"
  if (!$passed) { exit 1 }
} finally {
  Pop-Location
}
