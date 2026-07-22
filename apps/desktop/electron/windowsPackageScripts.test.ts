import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(__dirname, '../../..');

describe('Windows package staging scripts', () => {
  it('exposes one local-signed command that stages the standardized release artifact', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['package:local-signed']).toContain('stage-windows-package.ps1');
  });

  it('requires signatures, hashes, and the standard WINDOWS PACKAGE output name', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'stage-windows-package.ps1'), 'utf8');

    expect(script).toContain('WINDOWS PACKAGE');
    expect(script).toContain('NEMESIS-Windows-v$Version-Setup.exe');
    expect(script).toContain('Get-AuthenticodeSignature');
    expect(script).toContain('Get-FileHash');
    expect(script).toContain('signatures.txt');
    expect(script).toContain('NEMESIS-Windows-v*-Setup.exe*');
    expect(script).toContain('apps\\desktop\\release\\win-unpacked\\NEMESIS.exe');
    expect(script).toContain('apps\\desktop\\release\\win-unpacked\\resources\\gea-app\\Global Event Alpha.exe');
    expect(script).toContain('apps\\global-event-alpha\\release\\win-unpacked\\Global Event Alpha.exe');
  });

  it('launches smoke Electron directly so cleanup can kill the process tree', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-desktop-pair.ps1'), 'utf8');

    expect(script).toContain("node_modules\\electron\\dist\\electron.exe");
    expect(script).not.toContain("node_modules\\.bin\\electron.cmd");
  });

  it('quotes the smoke main-entry argument because the repo path contains spaces', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-desktop-pair.ps1'), 'utf8');

    expect(script).toContain('$MainEntryArg = \'"\' + $MainEntry + \'"\'');
    expect(script).toContain('-ArgumentList @($MainEntryArg)');
  });

  it('launches evidence campaigns only from the exact passing soaked production artifact', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'start-evidence-campaign.ps1'), 'utf8');

    expect(script).not.toContain('npm run build');
    expect(script).toContain("$env:NEMESIS_DEVTOOLS = 'false'");
    expect(script).toContain('dist-electron\\main.js');
    expect(script).toContain('Assert-PassingSoak');
    expect(script).toContain('Assert-VerifiedSoakReceipt');
    expect(script).toContain('verify-evidence-receipt.cjs');
    expect(script).toContain('[string]$R10VerificationReceiptPath');
    expect(script).toContain('[string]$SoakManifestPath');
    expect(script).toContain('[string]$SoakSamplesPath');
    expect(script).toContain('check-production-soak.cjs');
    expect(script).toContain('check-evidence-campaign.cjs');
    expect(script).toContain('NEMESIS_PRODUCTION_ARTIFACT_HASH');
    expect(script).toContain('NEMESIS_SOAK_VERIFICATION_RECEIPT_HASH');
    expect(script).toContain('[int]$MaxRecoveryAttempts = 0');
    expect(script).toContain('Official r10 requires MaxRecoveryAttempts=0');
    expect(script).toContain('warmupMinutes -ne 5');
    expect(script).toContain('scoredDurationMinutes -ne 30');
    expect(script).toContain('slopeWindowComplete -ne $true');
    expect(script).toContain('rendererSampleCoverage -lt 0.99');
    expect(script).toContain('feedReadinessCoverage -lt 0.995');
    expect(script).toContain('bridgeReadinessCoverage -lt 0.995');
    expect(script).toContain('productionArtifactHash');
    expect(script).toContain('Current production artifact differs from the exact artifact that passed the soak');
    expect(script).toContain('Assert-CleanR10Unlock');
    expect(script).toContain('restartOrdinal -ne 0');
    expect(script).toContain("-notmatch '(^|[-_.])r10($|[-_.])'");
    expect(script).toContain('NEMESIS_EVIDENCE_PREFLIGHT');
    expect(script).toContain('preflight-ready');
    expect(script).toContain('start-campaign');
    expect(script).toContain('closeout-ready');
    expect(script).toContain('Start-Process -FilePath $electronExe');
    expect(script).toContain('Stop-CapturedProcessTree');
    expect(script).toContain('Update-ProcessCapture');
    expect(script).toContain('Mark-UncleanShutdown');
    expect(script).toContain('verify-evidence-campaign.cjs');
    expect(script).toContain('Assert-NewCampaignNamespace');
    expect(script).not.toContain('Remove-Item -LiteralPath $sidecarPath');
    expect(script).not.toContain('Remove-Item -LiteralPath $controlPath');
    expect(script).toContain("$result.passed -ne $true");
    expect(script).not.toContain('npm run dev');
  });

  it('makes the production soak attest a five-minute warm-up and exact thirty scored minutes', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-production-soak.ps1'), 'utf8');

    expect(script).toContain('[int]$DurationMinutes = 30');
    expect(script).toContain('[int]$WarmupMinutes = 5');
    expect(script).toContain('[string]$ReadinessReceiptPath');
    expect(script).toContain("$readiness.receiptType -ne 'ReadinessReceipt'");
    expect(script).toContain("$env:NEMESIS_DEVTOOLS = 'false'");
    expect(script).toContain("$env:NEMESIS_DISCOVERY_MAX_TRACKED_TICKERS = '500'");
    expect(script).toContain('productionArtifactHash');
    expect(script).toContain('productionEntryHash');
    expect(script).toContain('matchingArtifactHashes');
    expect(script).toContain('Get-NormalizedSlopeEvidence');
    expect(script).toContain('$spanMs -lt $requiredWindowMs');
    expect(script).not.toContain('1620000');
    expect(script).toContain('slopeWindowComplete');
    expect(script).toContain('slopeWindowMs');
    expect(script).toContain("$_.phase -eq 'scored'");
    expect(script).toContain('scoredElapsedMinutes -le 5');
    expect(script).toContain('expectedScoredSampleCount');
    expect(script).toContain('[double]$rendererObservations.Count / [double]$expectedScoredSampleCount');
    expect(script).toContain('rendererSampleCoverage -lt 0.99');
    expect(script).toContain('geaSampleCoverage -lt 0.99');
    expect(script).toContain('NEMESIS_RUNTIME_STATUS_PATH');
    expect(script).toContain('runtimeStatusCoverage -lt 0.99');
    expect(script).toContain('feedReadinessCoverage -lt $feedCoverageFloor');
    expect(script).toContain('bridgeReadinessCoverage -lt 0.995');
    expect(script).toContain("peerRole -eq 'gea'");
    expect(script).toContain('warmupMinutes = $WarmupMinutes');
    expect(script).toContain('scoredDurationMinutes = $DurationMinutes');
    expect(script).toContain('totalRuntimeMinutes');
    expect(script).toContain('phaseCoverage');
    expect(script).toContain('retryIdentity');
    expect(script).toContain('sampleChainHead');
    expect(script).toContain('previousSampleHash');
    expect(script).toContain('typedFailureClasses');
    expect(script).toContain('configurationHash');
    expect(script).toContain('processRestartCount');
    expect(script).toContain('emergencyMitigationCount');
    expect(script).toContain('production-soak-runtime-status-at-cutoff.json');
    expect(script).toContain("cutoffExternalStatus.runtime.state -eq 'invalidated'");
    expect(script).toContain("finalRendererStatus -ne 'stable'");
    expect(script).toContain("finalRuntimeState -ne 'healthy'");
    expect(script).toContain("$sample.runtimeState -eq 'invalidated'");
    expect(script).toContain('remained unresponsive for at least ten seconds');
  });

  it('generates the r10 report only from explicit verified inputs', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'generate-r10-gap-closure-report.cjs'), 'utf8');

    expect(script).toContain('const sevenHourUnlocked = readinessPassed && soakPassed && r10Passed');
    expect(script).toContain("requireAllOrNone(inputs, ['soak-result', 'soak-manifest', 'soak-samples', 'soak-runtime-status', 'soak-cutoff-status', 'soak-receipt'])");
    expect(script).toContain("requireAllOrNone(inputs, ['r10-ledger', 'r10-runtime-ledger', 'r10-result', 'r10-summary', 'r10-receipt'])");
    expect(script).toContain('validateVerificationReceipt');
    expect(script).toContain("'readiness_failed_no_timer_started'");
    expect(script).toContain('artifact.json');
    expect(script).toContain('evidence-inventory.json');
    expect(script).toContain('source-notes.md');
    expect(script).toContain('expectedR9Hash');
    expect(script).toContain("sample.phase === 'scored'");
    expect(script).not.toContain('readdirSync');
    expect(script).not.toContain('soakAttemptsDir');
    expect(script).toContain("flag: 'wx'");
  });

  it('keeps readiness timer-free and tests every approved production alias', () => {
    const script = fs.readFileSync(path.join(repoRoot, 'scripts', 'run-production-readiness.ps1'), 'utf8');

    expect(script).toContain("'https://external-api.kalshi.com/trade-api/v2'");
    expect(script).toContain("'https://api.elections.kalshi.com/trade-api/v2'");
    expect(script).toContain("'wss://external-api-ws.kalshi.com/trade-api/ws/v2'");
    expect(script).toContain("'wss://api.elections.kalshi.com/trade-api/ws/v2'");
    expect(script).toContain('timerStarted = $false');
    expect(script).toContain('readiness gap occurred during the continuous hold');
    expect(script).toContain('$status.orderbookTracking.trackedTickers -eq $OrderbookTarget');
    expect(script).toContain('[int]$OrderbookTarget = 25');
    expect(script).toContain('$status.productionObservation.qualificationReady -eq $true');
  });

  it('keeps empty-paper renderer updates at the five-second summary cadence', () => {
    const main = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron', 'main.ts'), 'utf8');
    expect(main).toContain('PAPER_SUMMARY_BROADCAST_THROTTLE_MS = 5_000');
    expect(main).toContain('paperDesk.snapshot().positions.length > 0');
    expect(main).toContain('const throttleMs = paperDesk.snapshot().positions.length > 0');
    expect(main).toContain('new RuntimeStatusExporter(runtimeStatusPathFromEnvironment(), 5_000)');
  });

  it('keeps renderer liveness independent from page load and cleans up on unload', () => {
    const preload = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron', 'preload.ts'), 'utf8');
    expect(preload).toContain("ipcRenderer.send('renderer:heartbeat'");
    expect(preload).toContain('sequence: ++rendererHeartbeatSequence');
    expect(preload).toContain('setInterval(reportRendererHeartbeat, 5_000)');
    expect(preload).toContain('requestAnimationFrame');
    expect(preload).toContain("ipcRenderer.on('renderer:probe'");
    expect(preload).toContain("ipcRenderer.send('renderer:probe-response'");
    expect(preload).toContain("ipcRenderer.send('renderer:heartbeat-send-failed')");
    expect(preload).toContain("ipcRenderer.removeListener('renderer:probe', onRendererProbe)");
  });

  it('starts renderer probes only after page load and exports probe evidence', () => {
    const main = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron', 'main.ts'), 'utf8');
    expect(main).toContain('rendererHeartbeatMonitor.markLoadFinished(Date.now())');
    expect(main).toContain('startRendererProbe()');
    expect(main).toContain("ipcMain.on('renderer:probe-response'");
    expect(main).toContain('rendererProbeResponseReceived');
    expect(main).toContain('renderer-first-heartbeat');
    expect(main).toContain('renderer-first-painted-heartbeat');
  });

  it('lets the packaged renderer load before starting heavy feed discovery', () => {
    const main = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron', 'main.ts'), 'utf8');
    expect(main).toContain('await rendererLoadReadyPromise');
    expect(main).toContain("startupTrace('renderer-load-gate-open')");
    expect(main).toContain('heartbeat.loadFinishedAt == null');
    expect(main).toContain('packagedLoadRetryCount < 1');
    expect(main).toContain('renderer-load-retry');
  });

  it('requires an exact 25-ticker live orderbook set before preflight readiness', () => {
    const main = fs.readFileSync(path.join(repoRoot, 'apps', 'desktop', 'electron', 'main.ts'), 'utf8');
    const stream = fs.readFileSync(path.join(repoRoot, 'packages', 'connectors', 'src', 'kalshiOrderbookStream.ts'), 'utf8');
    // The production target defaults to 25 and is clamped to 1..25; a reduced
    // override only lowers the runtime bar, never the offline verifiers.
    expect(main).toContain("Number.parseInt(process.env.NEMESIS_ORDERBOOK_TRACKING_LIMIT ?? '', 10)");
    expect(main).toContain('raw >= 1 && raw <= 25 ? raw : 25');
    expect(main).toContain('orderbook_tracking_set_below_25');
    expect(main).toContain('orderbook.trackedTickers === ORDERBOOK_TRACKING_LIMIT');
    expect(main).toContain('trackingReady: orderbook.trackingReady');
    expect(main).toContain('current: orderbookTrackedTickers.filter((ticker) => desiredSet.has(ticker))');
    expect(stream).toContain('const trackingReady = this.tickers.size === this.maxTrackedTickers');
    expect(stream).toContain('&& trackingReady');
  });
});
