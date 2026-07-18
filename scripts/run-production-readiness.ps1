param(
  [Parameter(Mandatory = $true)]
  [string]$ReceiptPath,

  [ValidateRange(1, 20)]
  [int]$HoldMinutes = 10,

  [ValidateRange(10, 30)]
  [int]$CeilingMinutes = 20,

  # Production qualification requires exactly 25. Lower values run a reduced-bar
  # validation rehearsal (the receipt records the target and offline verifiers
  # stay pinned at 25, so a reduced hold can never pass real qualification).
  [ValidateRange(1, 25)]
  [int]$OrderbookTarget = 25
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repoRoot 'apps\desktop'
$mainEntry = Join-Path $desktopRoot 'dist-electron\main.js'
$electronExe = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$receiptDirectory = Split-Path -Parent $ReceiptPath
$runtimeStatusPath = Join-Path $receiptDirectory 'readiness-runtime-status.json'
$startupTracePath = Join-Path $receiptDirectory 'readiness-startup-trace.log'
$approvedRestAliases = @(
  'https://external-api.kalshi.com/trade-api/v2',
  'https://api.elections.kalshi.com/trade-api/v2'
)
$approvedWebSocketAliases = @(
  'wss://external-api-ws.kalshi.com/trade-api/ws/v2',
  'wss://api.elections.kalshi.com/trade-api/ws/v2'
)
$healthPolicyPath = Join-Path $repoRoot 'config\evidence-health-policy-v3.json'

function Get-Sha256Text([string]$Value) {
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.UTF8Encoding]::new($false).GetBytes($Value))).ToLowerInvariant()
}

function Get-ArtifactFingerprint {
  $roots = @(
    (Join-Path $repoRoot 'apps\desktop\dist'),
    (Join-Path $repoRoot 'apps\desktop\dist-electron'),
    (Join-Path $repoRoot 'apps\global-event-alpha\dist'),
    (Join-Path $repoRoot 'apps\global-event-alpha\dist-electron')
  )
  $files = @($roots | ForEach-Object { if (Test-Path -LiteralPath $_) { Get-ChildItem -LiteralPath $_ -File -Recurse } } | Sort-Object FullName)
  if ($files.Count -eq 0) { throw 'Frozen production artifacts are missing.' }
  $rows = foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $file.FullName).Replace('\', '/')
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    "$relative|$($file.Length)|$hash"
  }
  return @{ hash = Get-Sha256Text ($rows -join "`n"); fileCount = $files.Count }
}

# The regex labels below mirror KalshiTransportFailureClass values but are
# diagnostic-only reachability tags for the readiness receipt. No retry,
# rotation, or gating decision derives from them; runtime retry decisions use
# the typed classes in kalshiTransportController.ts.
function Test-RestAlias([string]$BaseUrl) {
  try {
    $response = Invoke-WebRequest -Uri "$BaseUrl/markets?limit=1&status=open" -Method Get -Headers @{ Accept = 'application/json'; 'User-Agent' = 'NEMESIS-Readiness/1.0' } -TimeoutSec 10 -UseBasicParsing
    return @{ endpoint = $BaseUrl; reachable = $response.StatusCode -eq 200; failureClass = $null; status = [int]$response.StatusCode }
  } catch {
    $detail = $_.Exception.ToString()
    $classification = if ($detail -match 'ENOTFOUND|NameResolution|DNS') { 'dns' }
      elseif ($detail -match 'reset|forcibly closed|ECONNRESET') { 'connection_reset' }
      elseif ($detail -match 'TLS|SSL|certificate|secure channel') { 'tls' }
      elseif ($detail -match 'timed out|timeout') { 'timeout' }
      else { 'tcp' }
    return @{ endpoint = $BaseUrl; reachable = $false; failureClass = $classification; status = $null }
  }
}

function Test-WebSocketAlias([string]$Url) {
  $socket = [Net.WebSockets.ClientWebSocket]::new()
  $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(10))
  try {
    $socket.ConnectAsync([Uri]$Url, $cancel.Token).GetAwaiter().GetResult()
    return @{ endpoint = $Url; reachable = $true; failureClass = $null; status = 101 }
  } catch {
    $detail = $_.Exception.ToString()
    # An unsigned 401/403 proves DNS, TCP, TLS, and the WebSocket HTTP path.
    if ($detail -match '401|403') { return @{ endpoint = $Url; reachable = $true; failureClass = 'authentication_expected'; status = $Matches[0] } }
    $classification = if ($detail -match 'NameResolution|DNS') { 'dns' }
      elseif ($detail -match 'reset|forcibly closed') { 'connection_reset' }
      elseif ($detail -match 'TLS|SSL|certificate|secure channel') { 'tls' }
      elseif ($detail -match 'timed out|canceled') { 'timeout' }
      else { 'tcp' }
    return @{ endpoint = $Url; reachable = $false; failureClass = $classification; status = $null }
  } finally {
    $cancel.Dispose()
    $socket.Dispose()
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

function Stop-CapturedTree([hashtable]$Capture) {
  Update-ProcessCapture $Capture
  foreach ($id in @($Capture.Order) | Sort-Object -Descending) {
    $row = Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue
    if ($null -ne $row -and (Get-ProcessMarker $row) -eq [string]$Capture.Markers[$id]) {
      Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-CounterTotal([object]$Counters) {
  if ($null -eq $Counters) { return 0 }
  return [double](($Counters.PSObject.Properties | ForEach-Object { [double]$_.Value } | Measure-Object -Sum).Sum ?? 0)
}

function Write-Receipt([hashtable]$Receipt) {
  if (Test-Path -LiteralPath $ReceiptPath) { throw 'Readiness receipt path already exists and is immutable.' }
  New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
  $bodyPath = "$ReceiptPath.body.$PID.tmp"
  try {
    $Receipt | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $bodyPath -Encoding utf8
    & node (Join-Path $PSScriptRoot 'finalize-readiness-receipt.cjs') --body $bodyPath --receipt $ReceiptPath
    if ($LASTEXITCODE -ne 0) { throw 'Readiness receipt finalization failed.' }
  } finally {
    Remove-Item -LiteralPath $bodyPath -Force -ErrorAction SilentlyContinue
  }
}

$process = $null
$capture = $null
$commit = $null
$artifactBefore = $null
$healthPolicyHash = $null
$networkChecks = @()
Push-Location $repoRoot
try {
  if ((Test-Path -LiteralPath $ReceiptPath) -or (Test-Path -LiteralPath $runtimeStatusPath) -or (Test-Path -LiteralPath $startupTracePath)) {
    throw 'Readiness evidence paths already exist; use a fresh explicit receipt path.'
  }
  $dirty = @(git status --porcelain)
  if ($dirty.Count -gt 0) { throw 'Readiness requires a clean frozen worktree.' }
  $commit = (git rev-parse HEAD).Trim()
  $artifactBefore = Get-ArtifactFingerprint
  if (!(Test-Path -LiteralPath $healthPolicyPath)) { throw 'Versioned evidence health policy is missing.' }
  $healthPolicyHash = (Get-FileHash -LiteralPath $healthPolicyPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $credentialPath = Join-Path $env:APPDATA '@nemesis\desktop\nemesis-data\kalshi-credentials.v1.json'
  $credentialPresent = (Test-Path -LiteralPath $credentialPath) -or (
    ![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_PRIVATE_KEY) -and
    (![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_API_KEY_ID) -or ![string]::IsNullOrWhiteSpace($env:NEMESIS_KALSHI_API_KEY))
  )
  if (!$credentialPresent) { throw 'Protected Kalshi credentials are not present.' }
  $r9Path = Join-Path $env:APPDATA '@nemesis\desktop\nemesis-data\evidence-campaigns\nemesis-instrumentation-2026-07-15-r9.jsonl'
  if (!(Test-Path -LiteralPath $r9Path) -or (Get-FileHash -LiteralPath $r9Path -Algorithm SHA256).Hash.ToLowerInvariant() -ne '7c93e9beafe8ec7af52f7483942f3edccff24e18aeab3f0c209b39cfe4c015ff') {
    throw 'Immutable r9 evidence is missing or changed.'
  }

  $networkChecks = @($approvedRestAliases | ForEach-Object { Test-RestAlias $_ }) + @($approvedWebSocketAliases | ForEach-Object { Test-WebSocketAlias $_ })
  if (@($networkChecks | Where-Object { $_.reachable -ne $true }).Count -gt 0) {
    Write-Receipt @{
      schemaVersion = 1; receiptType = 'ReadinessReceipt'; runId = [IO.Path]::GetFileNameWithoutExtension($ReceiptPath)
      verifiedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); passed = $false; timerStarted = $false
      failureClass = 'production_network_unavailable'; networkChecks = $networkChecks; gitCommit = $commit
      productionArtifactHash = $artifactBefore.hash; acceptanceFailures = @('one or more approved production aliases failed before authentication')
      healthPolicyHash = $healthPolicyHash
    }
    exit 2
  }

  New-Item -ItemType Directory -Path $receiptDirectory -Force | Out-Null
  foreach ($name in @('NEMESIS_EVIDENCE_CAMPAIGN_STAGE', 'NEMESIS_EVIDENCE_NAMESPACE', 'NEMESIS_EVIDENCE_PREFLIGHT', 'VITE_DEV_SERVER_URL')) {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $env:NEMESIS_PRODUCTION_OBSERVATION = 'true'
  $env:NEMESIS_DEVTOOLS = 'false'
  $env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'
  $env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = "$OrderbookTarget"
  $env:NEMESIS_AUTO_SPAWN_GEA = 'true'
  $env:NEMESIS_RUNTIME_STATUS_PATH = $runtimeStatusPath
  $env:NEMESIS_HEALTH_POLICY_HASH = $healthPolicyHash
  $env:NEMESIS_STARTUP_TRACE = 'true'
  $env:NEMESIS_STARTUP_TRACE_FILE = $startupTracePath

  $process = Start-Process -FilePath $electronExe -ArgumentList @('"' + $mainEntry + '"') -WorkingDirectory $desktopRoot -PassThru
  $capture = New-ProcessCapture $process.Id
  $startedAt = [DateTimeOffset]::UtcNow
  $deadline = $startedAt.AddMinutes($CeilingMinutes)
  $holdStartedAt = $null
  $holdCompletedAt = $null
  $restSuccesses = [Collections.Generic.HashSet[long]]::new()
  $tradeSuccesses = [Collections.Generic.HashSet[long]]::new()
  $samples = 0
  $failure = $null
  $finalStatus = $null
  $tickerHoldGeneration = $null
  $orderbookHoldGeneration = $null
  $holdTransportFaultBaseline = $null
  while ([DateTimeOffset]::UtcNow -lt $deadline) {
    Start-Sleep -Seconds 5
    Update-ProcessCapture $capture
    $process.Refresh()
    if ($process.HasExited) { $failure = 'NEMESIS exited before readiness completed'; break }
    $status = $null
    if (Test-Path -LiteralPath $runtimeStatusPath) { try { $status = Get-Content -LiteralPath $runtimeStatusPath -Raw | ConvertFrom-Json } catch { } }
    if ($null -eq $status) { continue }
    $now = [DateTimeOffset]::UtcNow
    $ageMs = [Math]::Max(0, $now.ToUnixTimeMilliseconds() - [double]$status.updatedAt)
    if ($null -ne $status.feeds.restMarkets.lastSuccess) { $null = $restSuccesses.Add([long]$status.feeds.restMarkets.lastSuccess) }
    if ($null -ne $status.feeds.tradeTape.lastSuccess) { $null = $tradeSuccesses.Add([long]$status.feeds.tradeTape.lastSuccess) }
    # Counters are cumulative from process start and streams self-heal early
    # startup races, so zero-fault enforcement is anchored at hold start: any
    # increase during the continuous hold fails the run.
    $transportFaultCount = [int]$status.feeds.tickerWebSocket.reconnects `
      + [int]$status.orderbookTracking.reconnects `
      + [int]$status.feeds.tickerWebSocket.sequenceGaps `
      + [int]$status.orderbookTracking.sequenceGaps `
      + [int]$status.orderbookTracking.sequenceRegressions `
      + [int](Get-CounterTotal $status.feeds.tickerWebSocket.failureCounters) `
      + [int](Get-CounterTotal $status.orderbookTracking.failureCounters)
    # Named conditions so a mid-hold gap records exactly which gate dropped.
    $conditions = [ordered]@{
      status_fresh = $ageMs -le 15000
      production_observation = $status.productionObservation.qualificationReady -eq $true
      renderer_loaded = $status.renderer.rendererLoadFinishedAt -ne $null
      renderer_painted = $status.renderer.heartbeatPainted -eq $true
      renderer_heartbeat_fresh = [double]$status.renderer.heartbeatAgeMs -le 15000
      renderer_probe_received = $status.renderer.rendererProbeResponseReceived -eq $true
      renderer_probe_fresh = [double]$status.renderer.rendererProbeAgeMs -le 15000
      feeds_qualified = $status.feeds.qualificationReady -eq $true
      ticker_authenticated = $status.feeds.tickerWebSocket.authenticated -eq $true
      ticker_subscription_acknowledged = $status.feeds.tickerWebSocket.subscriptionAcknowledged -eq $true
      orderbook_tracked = $status.orderbookTracking.trackedTickers -eq $OrderbookTarget
      orderbook_verified = $status.orderbookTracking.verifiedTrackedTickers -eq $OrderbookTarget
      orderbook_server = $status.orderbookTracking.serverTrackedTickers -eq $OrderbookTarget
      orderbook_membership_acknowledged = $status.orderbookTracking.membershipAcknowledged -eq $true
      orderbook_tracking_ready = $status.orderbookTracking.trackingReady -eq $true
      bridge_qualified = $status.bridge.qualificationReady -eq $true
      bridge_pongs = [int]$status.bridge.pongCount -ge 3
      rest_cycles = $restSuccesses.Count -ge 3
      trade_cycles = $tradeSuccesses.Count -ge 3
    }
    $failingConditions = @($conditions.Keys | Where-Object { $conditions[$_] -ne $true })
    $ready = $failingConditions.Count -eq 0
    $permanentFailure = @($status.feeds.tickerWebSocket.failureClass, $status.orderbookTracking.failureClass) | Where-Object { $_ -in @('authentication', 'authorization', 'configuration') } | Select-Object -First 1
    if ($permanentFailure) { $failure = "permanent production transport failure: $permanentFailure"; break }
    if ($null -eq $holdStartedAt -and $ready) {
      $holdStartedAt = $now
      $tickerHoldGeneration = [int]$status.feeds.tickerWebSocket.generation
      $orderbookHoldGeneration = [int]$status.orderbookTracking.generation
      $holdTransportFaultBaseline = $transportFaultCount
    }
    elseif ($null -ne $holdStartedAt -and !$ready) {
      $failure = "readiness gap occurred during the continuous hold: $($failingConditions -join ', ')"
      break
    }
    if ($null -ne $holdStartedAt) {
      if ([int]$status.feeds.tickerWebSocket.generation -ne $tickerHoldGeneration `
        -or [int]$status.orderbookTracking.generation -ne $orderbookHoldGeneration) {
        $failure = 'websocket generation changed during the continuous hold'
        break
      }
      if ($transportFaultCount -gt $holdTransportFaultBaseline) {
        $failure = 'transport reconnect, sequence, or failure counter changed during the continuous hold'
        break
      }
      $samples += 1
      if (($now - $holdStartedAt).TotalMinutes -ge $HoldMinutes) {
        # Credit is granted only by this fresh ready sample, never by shutdown time.
        $holdCompletedAt = $now
        $finalStatus = $status
        break
      }
    }
  }

  if (!$process.HasExited) { try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { } }
  $forcedShutdown = $false
  if (!(Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(30)))) {
    $forcedShutdown = $true
    Stop-CapturedTree $capture
    $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
  }
  $shutdownSurvivors = @(Get-LiveCapturedProcessIds $capture)
  $cleanShutdown = !$forcedShutdown -and $shutdownSurvivors.Count -eq 0
  $artifactAfter = Get-ArtifactFingerprint
  $holdComplete = $null -ne $holdCompletedAt
  $passed = $null -eq $failure -and $holdComplete -and $cleanShutdown -and $artifactAfter.hash -eq $artifactBefore.hash
  Write-Receipt @{
    schemaVersion = 1; receiptType = 'ReadinessReceipt'; runId = [IO.Path]::GetFileNameWithoutExtension($ReceiptPath)
    verifiedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); passed = $passed; timerStarted = $false
    holdMinutes = $HoldMinutes; holdStartedAt = if ($null -eq $holdStartedAt) { $null } else { $holdStartedAt.ToUnixTimeMilliseconds() }
    holdCompletedAt = if ($null -eq $holdCompletedAt) { $null } else { $holdCompletedAt.ToUnixTimeMilliseconds() }
    continuousHoldSamples = $samples; restCycles = $restSuccesses.Count; tradeCycles = $tradeSuccesses.Count
    orderbookTarget = $OrderbookTarget; reducedBarRehearsal = ($OrderbookTarget -ne 25)
    networkChecks = $networkChecks; gitCommit = $commit; productionArtifactHash = $artifactBefore.hash
    healthPolicyHash = $healthPolicyHash
    matchingArtifactHashes = $artifactAfter.hash -eq $artifactBefore.hash; cleanShutdown = $cleanShutdown
    finalStatusHash = if (Test-Path -LiteralPath $runtimeStatusPath) { (Get-FileHash -LiteralPath $runtimeStatusPath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    acceptanceFailures = if ($passed) { @() } else { @($failure ?? 'readiness ceiling elapsed before a continuous hold completed') }
  }
  if (!$passed) { exit 2 }
} catch {
  if ($null -ne $capture) {
    if ($null -ne $process -and !$process.HasExited) { try { $null = (Get-Process -Id $process.Id -ErrorAction Stop).CloseMainWindow() } catch { } }
    if (!(Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(30)))) {
      Stop-CapturedTree $capture
      $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
    }
  }
  if (!(Test-Path -LiteralPath $ReceiptPath)) {
    Write-Receipt @{
      schemaVersion = 1; receiptType = 'ReadinessReceipt'; runId = [IO.Path]::GetFileNameWithoutExtension($ReceiptPath)
      verifiedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); passed = $false; timerStarted = $false
      failureClass = 'runner_unexpected'; networkChecks = $networkChecks; gitCommit = $commit
      productionArtifactHash = if ($null -eq $artifactBefore) { $null } else { $artifactBefore.hash }
      healthPolicyHash = $healthPolicyHash; cleanShutdown = if ($null -eq $capture) { $true } else { @(Get-LiveCapturedProcessIds $capture).Count -eq 0 }
      acceptanceFailures = @('readiness runner stopped safely before qualification completed')
    }
  }
  throw
} finally {
  if ($null -ne $capture -and @(Get-LiveCapturedProcessIds $capture).Count -gt 0) {
    Stop-CapturedTree $capture
    $null = Wait-CapturedExit $capture ([DateTimeOffset]::UtcNow.AddSeconds(10))
  }
  Pop-Location
}
