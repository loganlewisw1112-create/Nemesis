import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  fileHash,
  sha256,
  verifySampleChain,
  verifySoakEvidence,
} = require('../../../scripts/lib/evidence-verifier.cjs') as {
  fileHash(path: string): string;
  sha256(value: string | Buffer): string;
  verifySampleChain(path: string, head: string, count: number): { failures: string[]; head: string };
  verifySoakEvidence(paths: Record<string, string>): { failures: string[] };
};
const { verifyCampaignEvidence, verifyLedger } = require('../../../scripts/lib/campaign-evidence-verifier.cjs') as {
  verifyCampaignEvidence(paths: Record<string, string>): { failures: string[]; replayed: Record<string, number> };
  verifyLedger(path: string, schema: number, runId: string): { failures: string[] };
};

const HASH = 'a'.repeat(64);
const START = 1_700_000_000_000;

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function writeSampleSeries(filePath: string, payloads: Record<string, unknown>[]): string {
  let head = '0'.repeat(64);
  const rows = payloads.map((payload, index) => {
    const payloadJson = JSON.stringify(payload);
    const sampleHash = sha256(`${head}|${payloadJson}`);
    const row = { sequence: index + 1, previousSampleHash: head, payloadJson, payload, sampleHash };
    head = sampleHash;
    return JSON.stringify(row);
  });
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
  return head;
}

function writeLedger(filePath: string, runId: string, events: Array<Record<string, unknown>>, campaign = false): void {
  let previousHash = 'GENESIS';
  const rows = events.map((event, index) => {
    const body = {
      schemaVersion: 2,
      runId,
      ...(campaign ? { configurationHash: 'configuration' } : {}),
      sequence: index + 1,
      ...event,
      previousHash,
    };
    const hash = sha256(JSON.stringify(body));
    previousHash = hash;
    return JSON.stringify({ ...body, hash });
  });
  fs.writeFileSync(filePath, `${rows.join('\n')}\n`);
}

function soakFixture(): { directory: string; paths: Record<string, string> } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-soak-verifier-'));
  const paths = {
    result: path.join(directory, 'result.json'),
    manifest: path.join(directory, 'manifest.json'),
    samples: path.join(directory, 'samples.jsonl'),
    runtimeStatus: path.join(directory, 'runtime.json'),
    cutoffStatus: path.join(directory, 'cutoff.json'),
  };
  const scoredStart = START + 5 * 60_000;
  const scoredClose = scoredStart + 30 * 60_000;
  const common = {
    schemaVersion: 3,
    rendererWorkingSetMb: 100,
    rendererGrowthRate: 0,
    rendererPid: 11,
    geaPid: 22,
    geaCount: 1,
    externalStatusAgeMs: 0,
    rendererProbeResponseReceived: true,
    rendererProbeAgeMs: 0,
    feedQualificationReady: true,
    bridgeQualificationReady: true,
    trackedOrderbookTickers: 25,
    orderbookTrackingReady: true,
    productionObservationReady: true,
    productionObservationUnchanged: true,
    productionObservationStateHash: HASH,
    rendererBlocked: false,
    runtimeState: 'healthy',
    runtimeAction: 'none',
  };
  const payloads = [
    ...Array.from({ length: 10 }, (_, index) => ({ ...common, at: START + index * 30_000, phase: 'warmup', scoredElapsedMinutes: null })),
    ...Array.from({ length: 61 }, (_, index) => ({ ...common, at: scoredStart + index * 30_000, phase: 'scored', scoredElapsedMinutes: index / 2 })),
  ];
  const sampleChainHead = writeSampleSeries(paths.samples, payloads);
  const runtime = {
    updatedAt: scoredClose,
    runtime: { state: 'healthy' },
    renderer: {
      status: 'stable', blocked: false, heartbeatAgeMs: 0, rendererProbeAgeMs: 0, rendererProbeResponseReceived: true,
      slopePerHour: 0, slopeWindowComplete: true, slopeWindowMs: 30 * 60_000,
    },
    feeds: { qualificationReady: true },
    bridge: { qualificationReady: true },
    orderbookTracking: { trackingReady: true, trackedTickers: 25 },
    productionObservation: { qualificationReady: true, unchanged: true, stateHash: HASH },
  };
  writeJson(paths.runtimeStatus, runtime);
  writeJson(paths.cutoffStatus, { schemaVersion: 3, capturedAt: scoredClose, status: runtime });
  const evidenceArtifactHashes = {
    samplesSha256: fileHash(paths.samples),
    runtimeStatusSha256: fileHash(paths.runtimeStatus),
    cutoffStatusSha256: fileHash(paths.cutoffStatus),
  };
  const identity = {
    attemptId: 'soak-0', seriesId: 'series-0', gitCommit: 'commit', configurationHash: 'configuration', healthPolicyHash: 'health',
    productionArtifactHash: 'artifact', productionEntryHash: 'entry',
  };
  const result = {
    schemaVersion: 3,
    runType: 'production-stress-soak',
    ...identity,
    startedAt: START,
    scoredStartedAt: scoredStart,
    scoredClosedAt: scoredClose,
    finishedAt: scoredClose + 1_000,
    cutoffCapturedAt: scoredClose,
    warmupMinutes: 5,
    scoredDurationMinutes: 30,
    requestedDurationMinutes: 30,
    actualWarmupMinutes: 5,
    actualScoredDurationMinutes: 30,
    totalRuntimeMinutes: 35.0167,
    sampleIntervalSeconds: 30,
    phaseCoverage: {
      warmup: { requiredMinutes: 5, observedMinutes: 5, expectedSampleCount: 10, sampleCount: 10, evidenceCoverage: 1, complete: true },
      scored: { requiredMinutes: 30, observedMinutes: 30, expectedSampleCount: 61, sampleCount: 61, evidenceCoverage: 1, complete: true },
    },
    retryIdentity: { retryEligible: false },
    baselineSampleCount: 11,
    rendererBaselineMb: 100,
    rendererP95Mb: 100,
    rendererMaxMb: 100,
    rendererTenMinuteGrowthMax: 0,
    rendererSlopePerHour: 0,
    runtimeRendererSlopePerHour: 0,
    slopeWindowComplete: true,
    slopeWindowMs: 30 * 60_000,
    runnerSlopeWindowMs: 30 * 60_000,
    runtimeSlopeWindowMs: 30 * 60_000,
    rendererSampleCoverage: 1,
    rendererProbeCoverage: 1,
    geaSampleCoverage: 1,
    runtimeStatusCoverage: 1,
    feedReadinessCoverage: 1,
    bridgeReadinessCoverage: 1,
    productionObservationCoverage: 1,
    productionObservationStateHash: HASH,
    rendererBlockedSampleCount: 0,
    runtimeInvalidatedSampleCount: 0,
    processRestartCount: 0,
    emergencyMitigationCount: 0,
    finalRuntimeState: 'healthy',
    finalRendererStatus: 'stable',
    finalFeedQualificationReady: true,
    finalBridgeQualificationReady: true,
    finalTrackedOrderbookTickers: 25,
    devToolsDisabled: true,
    configuredTrackedTickers: 500,
    configuredOrderbookTickers: 25,
    productionArtifactFileCount: 1,
    matchingArtifactHashes: true,
    evidenceArtifactHashes,
    sampleChainHead,
    cleanShutdown: true,
    runtimeFailure: null,
    acceptanceFailures: [],
    retryEligible: false,
    passed: true,
  };
  const manifest = {
    schemaVersion: 3,
    ...identity,
    sampleCount: payloads.length,
    sampleChainHead,
    evidenceArtifactHashes,
    cleanShutdown: true,
    cutoffStatus: 'passed',
  };
  writeJson(paths.result, result);
  writeJson(paths.manifest, manifest);
  return { directory, paths };
}

interface CampaignFixtureOptions {
  stage?: 'instrumentation' | 'seven-hour';
  invalidFee?: boolean;
  staleSample?: boolean;
  recovery?: boolean;
  extension?: boolean;
}

function campaignFixture(options: CampaignFixtureOptions = {}): { paths: Record<string, string> } {
  const stage = options.stage ?? 'instrumentation';
  const durationMs = stage === 'instrumentation' ? 2 * 60 * 60_000 : 7 * 60 * 60_000;
  const enrollmentMs = stage === 'instrumentation' ? 100 * 60_000 : 405 * 60_000;
  const candidateCount = stage === 'instrumentation' ? 20 : 30;
  const runId = stage === 'instrumentation' ? 'r10-fixed' : 'seven-hour-fixed';
  const cutoff = START + durationMs;
  const finalizedAt = cutoff + 1_000;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-campaign-verifier-'));
  const paths = {
    result: path.join(directory, 'result.json'),
    ledger: path.join(directory, 'campaign.jsonl'),
    runtimeLedger: path.join(directory, 'runtime.jsonl'),
    summary: path.join(directory, 'summary.md'),
  };
  const initialManifest = {
    schemaVersion: 2,
    runId,
    evidenceNamespace: runId,
    configurationHash: 'configuration',
    gitCommit: 'commit',
    stage,
    startedAt: START,
    enrollmentCutoffAt: START + enrollmentMs,
    cutoffAt: cutoff,
    status: 'active',
    restartOrdinal: 0,
    healthPolicyHash: 'health',
    runtimeSidecarPath: paths.runtimeLedger,
  };
  const componentNames = ['rest-markets', 'trade-tape', 'ticker-websocket', 'orderbook-websocket', 'bridge', 'gea'];
  const runtimeEvents: Array<Record<string, unknown>> = [
    { at: START - 10 * 60_000, type: 'runtime_started', payload: { gitCommit: 'commit', configurationHash: 'configuration', healthPolicyHash: 'health' } },
    { at: START, type: 'runtime_transition', payload: { action: 'start-campaign' } },
  ];
  for (let at = START, index = 0; at <= cutoff; at += 5_000, index += 1) {
    runtimeEvents.push({
      at,
      type: 'runtime_sample',
      payload: {
        state: 'healthy',
        lease: { status: 'healthy', metrics: { recoveryCount: options.recovery && index === 10 ? 1 : 0, recentRecoveryCount: 0 } },
        components: componentNames.map((name) => ({ name, connected: true, qualificationReady: true })),
        renderer: {
          status: 'stable', blocked: false, workingSetKb: 100 * 1024, p95WorkingSetKb: 100 * 1024, growthRate: 0,
          slopePerHour: 0, slopeWindowComplete: at - START >= 30 * 60_000, slopeWindowMs: Math.min(at - START, 30 * 60_000),
          rendererPid: 11, heartbeatAgeMs: 0, heartbeatReceived: true, heartbeatPainted: true,
          rendererProbeAgeMs: 0, rendererProbeResponseReceived: true,
        },
        processes: { main: { pid: 10 }, gea: { pid: 12 } },
        orderbookTracking: { trackedTickers: 25, trackingReady: true },
        productionObservation: { qualificationReady: true, unchanged: true, stateHash: HASH },
      },
    });
  }
  runtimeEvents.push({ at: finalizedAt, type: 'runtime_finalized', payload: { cleanShutdownRequested: true } });
  writeLedger(paths.runtimeLedger, runId, runtimeEvents);
  const runtimeHash = fileHash(paths.runtimeLedger);

  const campaignEvents: Array<Record<string, unknown>> = [
    { at: START, type: 'run_started', payload: { manifest: initialManifest } },
  ];
  for (let index = 0; index < candidateCount; index += 1) {
    const at = START + 100 + index;
    const ticker = `TICKER-${index}`;
    const initialFill = {
      ticker, side: 'yes', contracts: 10, expectedPrice: 0.4, fillPrice: 0.4, filled: 10,
      fillLevels: [{ price: 0.4, quantity: 10, cost: 4 }], slippage: 0, fees: 0.1,
      feePolicyKnown: true, netEdge: 0.1, aborted: false,
    };
    // Two stale samples: one alone leaves freshness at exactly 95 percent,
    // which still satisfies the at-least-95-percent gate.
    const staleOffset = options.staleSample && index < 2 ? 2_000 : 0;
    const sample = {
      at, observedAt: at, netEdge: 0.1, spread: 0.02, bookTimestamp: at - staleOffset,
      bookSequence: index + 1, exchangeTimestamp: at - staleOffset, exchangeSequence: index + 1,
      fillPrice: 0.4, filled: 10, fees: 0.1, feePolicyKnown: true,
    };
    const candidate = {
      candidateId: `candidate-${index}`, economicIdentity: `economic-${index}`, originalCardId: `card-${index}`,
      ticker, side: 'yes', configurationHash: 'configuration', enrolledAt: at, updatedAt: at,
      lifecycleState: 'confirming', card: { id: `card-${index}` }, initialFill,
      economics: { targetRewardUsd: 1, plannedLossUsd: 0.5 }, samples: [sample],
    };
    const dueAt = START + 15 * 60_000 + index;
    const diagnostic = {
      diagnosticId: `diagnostic-${index}`, candidateId: candidate.candidateId, dueAt, expiresAt: dueAt + 5 * 60_000,
      attempts: 0, attemptSummaries: [], status: 'scheduled', qualificationEligible: false,
    };
    campaignEvents.push({ at, type: 'candidate_enrolled', payload: { candidate, diagnostic, screening: { status: 'eligible' } } });
  }
  for (let index = 0; index < candidateCount; index += 1) {
    campaignEvents.push({
      at: START + 200 + index,
      type: 'candidate_terminal',
      payload: { candidateId: `candidate-${index}`, state: index === 0 ? 'ready' : 'rejected', reason: 'terminal confirmation result' },
    });
  }
  if (options.extension) campaignEvents.push({ at: START + 300, type: 'instrumentation_extended', payload: { cutoffAt: cutoff + 1_000, enrollmentCutoffAt: cutoff } });
  for (let index = 0; index < candidateCount; index += 1) {
    const at = START + 15 * 60_000 + index;
    const ticker = `TICKER-${index}`;
    campaignEvents.push({
      at,
      type: 'diagnostic_scored',
      payload: {
        diagnosticId: `diagnostic-${index}`,
        result: {
          validExecutableObservation: true,
          exchangeTimestamp: at,
          exchangeSequence: 100 + index,
          executableFollowUpMark: 0.6,
          reconstructedExitFill: {
            ticker, side: 'yes', contracts: 10, expectedPrice: 0.4, fillPrice: 0.6, filled: 10,
            fillLevels: [{ price: 0.6, quantity: 10, cost: 6 }], slippage: 0, fees: 0.1,
            feePolicyKnown: !(options.invalidFee && index === 0), netEdge: 0.19, aborted: false,
          },
          executableNetPnlUsd: 1.8,
          targetAt: at,
          reason: 'valid executable follow-up reconstructed from a matching exchange delta and resolved fees',
        },
      },
    });
  }
  const checkAt = cutoff - 500;
  for (const name of [
    'renderer_memory_stable', 'bridge_bidirectional_traffic', 'runtime_health_coverage',
    'exchange_book_time_available', 'no_runtime_restart_or_emergency_mitigation',
  ]) campaignEvents.push({ at: checkAt, type: 'operational_check', payload: { check: { name, passed: true, detail: 'verified', at: checkAt } } });
  campaignEvents.push({ at: cutoff, type: 'run_closeout_ready', payload: { lastSequence: 0, lastHash: HASH } });
  campaignEvents.push({ at: finalizedAt, type: 'run_finalized', payload: { passed: true, reasons: [], finalRuntimeSidecarHash: runtimeHash } });
  writeLedger(paths.ledger, runId, campaignEvents, true);
  fs.writeFileSync(paths.summary, '# Verified campaign\n');
  writeJson(paths.result, {
    schemaVersion: 2,
    generatedAt: finalizedAt + 1,
    runId,
    passed: true,
    reasons: [],
    manifest: { ...initialManifest, status: 'passed', finalizedAt, finalRuntimeSidecarHash: runtimeHash },
    metrics: {
      candidates: candidateCount,
      validDiagnosticOutcomes: candidateCount,
      readyCandidates: 1,
      terminalCoverage: 1,
      diagnosticSchedulingCoverage: 1,
      validDiagnosticCoverage: 1,
      freshConfirmationRate: options.staleSample ? (candidateCount - 2) / candidateCount : 1,
    },
    finalRuntimeSidecarHash: runtimeHash,
    offlineReplayCount: 1,
  });
  return { paths };
}

describe('offline evidence verifier', () => {
  it('rejects sample tampering and accepts an intact linked series', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-evidence-'));
    const file = path.join(directory, 'samples.jsonl');
    const payloadJson = JSON.stringify({ at: 1, phase: 'scored', rendererWorkingSetMb: 100 });
    const head = sha256(`${'0'.repeat(64)}|${payloadJson}`);
    fs.writeFileSync(file, `${JSON.stringify({ sequence: 1, previousSampleHash: '0'.repeat(64), payloadJson, payload: JSON.parse(payloadJson), sampleHash: head })}\n`);
    expect(verifySampleChain(file, head, 1).failures).toEqual([]);

    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('100', '101'));
    expect(verifySampleChain(file, head, 1).failures.length).toBeGreaterThan(0);
  });

  it('independently accepts a complete thirty-minute soak', () => {
    const fixture = soakFixture();
    expect(verifySoakEvidence(fixture.paths).failures).toEqual([]);
  });

  it('rejects missing numeric evidence instead of treating NaN as a pass', () => {
    const fixture = soakFixture();
    const result = JSON.parse(fs.readFileSync(fixture.paths.result, 'utf8')) as Record<string, unknown>;
    delete result.runtimeRendererSlopePerHour;
    writeJson(fixture.paths.result, result);
    expect(verifySoakEvidence(fixture.paths).failures).toContain('runtimeRendererSlopePerHour is missing or invalid');
  });

  it('rejects compressed timestamps and missing protected hashes even when their chains are recomputed', () => {
    const fixture = soakFixture();
    const rows = fs.readFileSync(fixture.paths.samples, 'utf8').trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const payloads = rows.map((row, index) => ({ ...row.payload, at: START + index, productionObservationStateHash: null }));
    const head = writeSampleSeries(fixture.paths.samples, payloads);
    const result = JSON.parse(fs.readFileSync(fixture.paths.result, 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(fixture.paths.manifest, 'utf8'));
    result.sampleChainHead = head;
    manifest.sampleChainHead = head;
    result.evidenceArtifactHashes.samplesSha256 = fileHash(fixture.paths.samples);
    manifest.evidenceArtifactHashes.samplesSha256 = result.evidenceArtifactHashes.samplesSha256;
    writeJson(fixture.paths.result, result);
    writeJson(fixture.paths.manifest, manifest);
    const failures = verifySoakEvidence(fixture.paths).failures.join('\n');
    expect(failures).toMatch(/cadence|anchored/);
    expect(failures).toContain('protected state hash is missing or malformed');
  });

  it('rejects a tampered campaign hash chain', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-ledger-'));
    const file = path.join(directory, 'campaign.jsonl');
    const body = { schemaVersion: 2, runId: 'r10', configurationHash: 'config', sequence: 1, at: 10, type: 'run_started', payload: {}, previousHash: 'GENESIS' };
    fs.writeFileSync(file, `${JSON.stringify({ ...body, hash: sha256(JSON.stringify(body)) })}\n`);
    expect(verifyLedger(file, 2, 'r10').failures).toEqual([]);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('run_started', 'run_changed'));
    expect(verifyLedger(file, 2, 'r10').failures.length).toBeGreaterThan(0);
  });

  it('accepts a complete fixed r10 only after replaying runtime and campaign evidence', () => {
    const fixture = campaignFixture();
    expect(verifyCampaignEvidence(fixture.paths).failures).toEqual([]);
  });

  it('rejects unresolved diagnostic fees and stale candidate provenance', () => {
    const invalidFee = verifyCampaignEvidence(campaignFixture({ invalidFee: true }).paths).failures.join('\n');
    expect(invalidFee).toContain('unresolved fees');
    const stale = verifyCampaignEvidence(campaignFixture({ staleSample: true }).paths).failures.join('\n');
    expect(stale).toContain('exchange-book freshness is below 95 percent');
  });

  it('rejects any runtime recovery or campaign extension', () => {
    expect(verifyCampaignEvidence(campaignFixture({ recovery: true }).paths).failures.join('\n')).toContain('recovery or invalidation');
    expect(verifyCampaignEvidence(campaignFixture({ extension: true }).paths).failures).toContain('campaign ledger contains a prohibited extension');
  });

  it('enforces the full seven-hour duration, thirty diagnostics, and one ready candidate', () => {
    expect(verifyCampaignEvidence(campaignFixture({ stage: 'seven-hour' }).paths).failures).toEqual([]);
  });
});
