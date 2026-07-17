'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SOAK_WARMUP_MS = 5 * 60_000;
const SOAK_SCORED_MS = 30 * 60_000;
const SOAK_SAMPLE_INTERVAL_MS = 30_000;
const SOAK_CADENCE_TOLERANCE_MS = 5_000;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function fileHash(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function finite(value) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requireFinite(value, label, failures, options = {}) {
  const parsed = finite(value);
  if (parsed == null
    || (options.integer === true && !Number.isInteger(parsed))
    || (options.min != null && parsed < options.min)
    || (options.max != null && parsed > options.max)) {
    failures.push(`${label} is missing or invalid`);
    return null;
  }
  return parsed;
}

function equalNumber(actual, expected, tolerance = 1e-9) {
  return Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance;
}

function normalizedSlope(observations, baseline) {
  if (observations.length < 2 || !Number.isFinite(baseline) || baseline <= 0) return null;
  const origin = observations[0].at;
  const xs = observations.map((item) => (item.at - origin) / 3_600_000);
  const ys = observations.map((item) => item.value);
  const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
  const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < observations.length; index += 1) {
    numerator += (xs[index] - meanX) * (ys[index] - meanY);
    denominator += (xs[index] - meanX) ** 2;
  }
  return denominator > 0 ? (numerator / denominator) / baseline : null;
}

function verifySampleChain(samplesPath, expectedHead, expectedCount) {
  const failures = [];
  const rows = fs.readFileSync(samplesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line.replace(/^\uFEFF/, '')); }
    catch { failures.push(`sample line ${index + 1} is not valid JSON`); return null; }
  }).filter(Boolean);
  let head = '0'.repeat(64);
  let priorAt = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.sequence !== index + 1) failures.push(`sample sequence ${index + 1} is missing or duplicated`);
    if (row.previousSampleHash !== head) failures.push(`sample ${index + 1} has the wrong previous hash`);
    if (typeof row.payloadJson !== 'string') {
      failures.push(`sample ${index + 1} has no preserved payload JSON`);
      continue;
    }
    let preserved;
    try { preserved = JSON.parse(row.payloadJson); }
    catch { failures.push(`sample ${index + 1} preserved payload is invalid`); continue; }
    if (JSON.stringify(stable(preserved)) !== JSON.stringify(stable(row.payload))) {
      failures.push(`sample ${index + 1} payload differs from its preserved bytes`);
    }
    const computed = sha256(`${head}|${row.payloadJson}`);
    if (!HASH_PATTERN.test(String(row.sampleHash)) || computed !== row.sampleHash) failures.push(`sample ${index + 1} hash is invalid`);
    head = typeof row.sampleHash === 'string' ? row.sampleHash : head;
    const at = finite(row.payload?.at);
    if (at == null || !Number.isInteger(at) || (priorAt != null && at <= priorAt)) failures.push(`sample ${index + 1} timestamp is missing, duplicated, or regressed`);
    priorAt = at;
  }
  const count = finite(expectedCount);
  if (count == null || !Number.isInteger(count) || count < 0 || rows.length !== count) failures.push(`sample count ${rows.length} does not match manifest count ${expectedCount}`);
  if (!HASH_PATTERN.test(String(expectedHead)) || head !== expectedHead) failures.push('sample-chain head does not match the result and manifest');
  return { rows, head, failures };
}

function verifyCadence(samples, expectedIntervalMs, label, failures) {
  for (let index = 1; index < samples.length; index += 1) {
    const prior = finite(samples[index - 1]?.at);
    const current = finite(samples[index]?.at);
    if (prior == null || current == null) continue;
    const gap = current - prior;
    if (gap < expectedIntervalMs - SOAK_CADENCE_TOLERANCE_MS || gap > expectedIntervalMs + SOAK_CADENCE_TOLERANCE_MS) {
      failures.push(`${label} sample cadence is not ${expectedIntervalMs / 1000} seconds at sample ${index + 1}`);
    }
  }
}

function verifySoakEvidence(paths) {
  const failures = [];
  const result = readJson(paths.result);
  const manifest = readJson(paths.manifest);
  const cutoff = readJson(paths.cutoffStatus);
  const runtimeStatus = readJson(paths.runtimeStatus);
  const chain = verifySampleChain(paths.samples, result.sampleChainHead, manifest.sampleCount);
  failures.push(...chain.failures);

  if (result.schemaVersion !== 3 || manifest.schemaVersion !== 3) failures.push('soak result and manifest must use schema version 3');
  if (result.runType !== 'production-stress-soak') failures.push('result run type is not production-stress-soak');
  if (result.passed !== true || manifest.cutoffStatus !== 'passed' || !Array.isArray(result.acceptanceFailures) || result.acceptanceFailures.length !== 0 || result.runtimeFailure != null) {
    failures.push('soak did not produce a clean passing terminal result');
  }
  for (const field of ['attemptId', 'seriesId', 'gitCommit', 'configurationHash', 'healthPolicyHash', 'productionArtifactHash', 'productionEntryHash']) {
    if (!result[field] || result[field] !== manifest[field]) failures.push(`${field} differs between result and manifest`);
  }
  if (result.sampleChainHead !== manifest.sampleChainHead) failures.push('sample-chain heads differ between result and manifest');
  if (result.cleanShutdown !== true || manifest.cleanShutdown !== true) failures.push('clean shutdown was not proven');
  if (result.matchingArtifactHashes !== true) failures.push('production artifact stability was not proven');
  if (result.retryEligible === true || result.retryIdentity?.retryEligible === true) failures.push('a passing soak cannot remain retry eligible');

  const startedAt = requireFinite(result.startedAt, 'startedAt', failures, { integer: true, min: 1 });
  const scoredStartedAt = requireFinite(result.scoredStartedAt, 'scoredStartedAt', failures, { integer: true, min: 1 });
  const scoredClosedAt = requireFinite(result.scoredClosedAt, 'scoredClosedAt', failures, { integer: true, min: 1 });
  const finishedAt = requireFinite(result.finishedAt, 'finishedAt', failures, { integer: true, min: 1 });
  const cutoffCapturedAt = requireFinite(result.cutoffCapturedAt, 'cutoffCapturedAt', failures, { integer: true, min: 1 });
  const sampleIntervalSeconds = requireFinite(result.sampleIntervalSeconds, 'sampleIntervalSeconds', failures, { integer: true, min: 1 });
  if (sampleIntervalSeconds !== 30) failures.push('soak sampling interval is not exactly 30 seconds');
  if (Number(result.warmupMinutes) !== 5 || Number(result.scoredDurationMinutes) !== 30 || Number(result.requestedDurationMinutes) !== 30) {
    failures.push('required five-minute warm-up and thirty scored minutes were not configured');
  }
  if (result.phaseCoverage?.warmup?.complete !== true || result.phaseCoverage?.scored?.complete !== true) failures.push('warm-up or scored phase is incomplete');
  if ([startedAt, scoredStartedAt, scoredClosedAt, finishedAt].every((value) => value != null)) {
    const warmupMs = scoredStartedAt - startedAt;
    const scoredMs = scoredClosedAt - scoredStartedAt;
    if (warmupMs < SOAK_WARMUP_MS || warmupMs > SOAK_WARMUP_MS + SOAK_CADENCE_TOLERANCE_MS) failures.push('warm-up timestamps do not prove exactly five observed minutes');
    if (scoredMs < SOAK_SCORED_MS || scoredMs > SOAK_SCORED_MS + SOAK_CADENCE_TOLERANCE_MS) failures.push('scored timestamps do not prove exactly thirty observed minutes');
    if (finishedAt < scoredClosedAt) failures.push('soak timestamps are not ordered');
    const reportedWarmup = requireFinite(result.actualWarmupMinutes, 'actualWarmupMinutes', failures, { min: 0 });
    const reportedScored = requireFinite(result.actualScoredDurationMinutes, 'actualScoredDurationMinutes', failures, { min: 0 });
    const reportedTotal = requireFinite(result.totalRuntimeMinutes, 'totalRuntimeMinutes', failures, { min: 0 });
    if (reportedWarmup != null && !equalNumber(reportedWarmup, warmupMs / 60_000, 0.001)) failures.push('reported warm-up duration differs from timestamps');
    if (reportedScored != null && !equalNumber(reportedScored, scoredMs / 60_000, 0.001)) failures.push('reported scored duration differs from timestamps');
    if (reportedTotal != null && reportedTotal + 0.001 < (finishedAt - startedAt) / 60_000) failures.push('reported total runtime is shorter than its timestamps');
  }
  if (cutoffCapturedAt != null && scoredClosedAt != null && cutoffCapturedAt < scoredClosedAt) failures.push('cutoff status was captured before scoring closed');
  if (finite(cutoff.capturedAt) !== cutoffCapturedAt) failures.push('cutoff capture timestamp differs between result and cutoff evidence');

  const warmup = chain.rows.map((row) => row.payload).filter((sample) => sample?.phase === 'warmup');
  const scored = chain.rows.map((row) => row.payload).filter((sample) => sample?.phase === 'scored');
  if (warmup.length + scored.length !== chain.rows.length) failures.push('sample series contains an unknown phase');
  const firstScoredIndex = chain.rows.findIndex((row) => row.payload?.phase === 'scored');
  if (firstScoredIndex >= 0 && chain.rows.slice(firstScoredIndex).some((row) => row.payload?.phase !== 'scored')) failures.push('warm-up samples appear after scored evidence began');
  const expectedWarmup = SOAK_WARMUP_MS / SOAK_SAMPLE_INTERVAL_MS;
  const expectedScored = SOAK_SCORED_MS / SOAK_SAMPLE_INTERVAL_MS + 1;
  if (warmup.length !== expectedWarmup || scored.length !== expectedScored || chain.rows.length !== expectedWarmup + expectedScored) {
    failures.push('sample series does not contain exactly 10 warm-up and 61 scored samples');
  }
  verifyCadence(warmup, SOAK_SAMPLE_INTERVAL_MS, 'warm-up', failures);
  verifyCadence(scored, SOAK_SAMPLE_INTERVAL_MS, 'scored', failures);
  if (startedAt != null && finite(warmup[0]?.at) != null && Math.abs(warmup[0].at - startedAt) > SOAK_CADENCE_TOLERANCE_MS) failures.push('first warm-up sample is not anchored to process start');
  if (scoredStartedAt != null && finite(scored[0]?.at) != null && Math.abs(scored[0].at - scoredStartedAt) > SOAK_CADENCE_TOLERANCE_MS) failures.push('first scored sample is not anchored to scored start');
  if (scoredClosedAt != null && finite(scored.at(-1)?.at) != null && Math.abs(scored.at(-1).at - scoredClosedAt) > SOAK_CADENCE_TOLERANCE_MS) failures.push('last scored sample is not anchored to scored cutoff');

  for (const [phase, samples, expectedCount, requiredMinutes] of [
    ['warmup', warmup, expectedWarmup, 5],
    ['scored', scored, expectedScored, 30],
  ]) {
    const evidence = result.phaseCoverage?.[phase];
    if (finite(evidence?.expectedSampleCount) !== expectedCount || finite(evidence?.sampleCount) !== samples.length
      || finite(evidence?.requiredMinutes) !== requiredMinutes || finite(evidence?.evidenceCoverage) !== 1) {
      failures.push(`${phase} phase coverage differs from replayed samples`);
    }
  }

  const rendererObservations = [];
  const growthValues = [];
  let geaCount = 0;
  let runtimeCount = 0;
  let probeCount = 0;
  let feedCount = 0;
  let bridgeCount = 0;
  let productionCount = 0;
  let blockedCount = 0;
  let invalidatedCount = 0;
  let emergencyCount = 0;
  const rendererPids = new Set();
  const geaPids = new Set();
  const protectedHashes = new Set();
  for (let index = 0; index < scored.length; index += 1) {
    const sample = scored[index];
    if (sample?.schemaVersion !== 3) failures.push(`scored sample ${index + 1} has the wrong schema`);
    const at = requireFinite(sample?.at, `scored sample ${index + 1} timestamp`, failures, { integer: true, min: 1 });
    const memory = requireFinite(sample?.rendererWorkingSetMb, `scored sample ${index + 1} renderer memory`, failures, { min: 0.001 });
    if (at != null && memory != null) rendererObservations.push({ at, value: memory });
    const growth = requireFinite(sample?.rendererGrowthRate, `scored sample ${index + 1} renderer growth`, failures);
    if (growth != null) growthValues.push(growth);
    if (Number.isInteger(sample?.rendererPid) && sample.rendererPid > 0) rendererPids.add(sample.rendererPid);
    else failures.push(`scored sample ${index + 1} renderer PID is missing`);
    if (Number.isInteger(sample?.geaPid) && sample.geaPid > 0) geaPids.add(sample.geaPid);
    else failures.push(`scored sample ${index + 1} GEA PID is missing`);
    if (finite(sample?.geaCount) > 0) geaCount += 1;
    const statusAge = finite(sample?.externalStatusAgeMs);
    if (statusAge != null && statusAge >= 0 && statusAge <= 60_000) runtimeCount += 1;
    const probeAge = finite(sample?.rendererProbeAgeMs);
    if (sample?.rendererProbeResponseReceived === true && probeAge != null && probeAge >= 0 && probeAge <= 15_000) probeCount += 1;
    if (sample?.feedQualificationReady === true) feedCount += 1;
    if (sample?.bridgeQualificationReady === true) bridgeCount += 1;
    const stateHash = sample?.productionObservationStateHash;
    if (!HASH_PATTERN.test(String(stateHash))) failures.push(`scored sample ${index + 1} protected state hash is missing or malformed`);
    else protectedHashes.add(stateHash);
    if (sample?.productionObservationReady === true && sample?.productionObservationUnchanged === true && HASH_PATTERN.test(String(stateHash))) productionCount += 1;
    if (sample?.orderbookTrackingReady !== true || finite(sample?.trackedOrderbookTickers) !== 25) failures.push(`scored sample ${index + 1} lacked exact orderbook tracking readiness`);
    if (sample?.rendererBlocked === true) blockedCount += 1;
    if (sample?.runtimeState === 'invalidated') invalidatedCount += 1;
    if (sample?.runtimeAction === 'stop' || sample?.runtimeAction === 'invalidate') emergencyCount += 1;
  }
  if (rendererPids.size !== 1 || geaPids.size !== 1) failures.push('renderer or GEA process identity changed or was not continuously recorded');
  if (protectedHashes.size !== 1) failures.push('protected paper or safety state hash changed during scored evidence');

  const coverage = {
    rendererSampleCoverage: rendererObservations.length / expectedScored,
    rendererProbeCoverage: probeCount / expectedScored,
    geaSampleCoverage: geaCount / expectedScored,
    runtimeStatusCoverage: runtimeCount / expectedScored,
    feedReadinessCoverage: feedCount / expectedScored,
    bridgeReadinessCoverage: bridgeCount / expectedScored,
    productionObservationCoverage: productionCount / expectedScored,
  };
  for (const [field, replayed] of Object.entries(coverage)) {
    const reported = requireFinite(result[field], field, failures, { min: 0, max: 1 });
    if (reported != null && !equalNumber(reported, replayed, 1e-9)) failures.push(`${field} differs from replayed samples`);
  }
  for (const field of ['rendererSampleCoverage', 'rendererProbeCoverage', 'geaSampleCoverage', 'runtimeStatusCoverage']) {
    if (coverage[field] < 0.99) failures.push(`${field} is below 99 percent`);
  }
  for (const field of ['feedReadinessCoverage', 'bridgeReadinessCoverage']) {
    if (coverage[field] < 0.995) failures.push(`${field} is below 99.5 percent`);
  }
  if (coverage.productionObservationCoverage !== 1) failures.push('production observation coverage is not complete');
  if (requireFinite(result.rendererBlockedSampleCount, 'rendererBlockedSampleCount', failures, { integer: true, min: 0 }) !== blockedCount
    || requireFinite(result.runtimeInvalidatedSampleCount, 'runtimeInvalidatedSampleCount', failures, { integer: true, min: 0 }) !== invalidatedCount
    || requireFinite(result.emergencyMitigationCount, 'emergencyMitigationCount', failures, { integer: true, min: 0 }) !== emergencyCount) {
    failures.push('replayed blocking, invalidation, or emergency counts differ from the result');
  }
  if (blockedCount !== 0 || invalidatedCount !== 0 || emergencyCount !== 0 || requireFinite(result.processRestartCount, 'processRestartCount', failures, { integer: true, min: 0 }) !== 0) {
    failures.push('a restart, invalidation, renderer block, or emergency action occurred');
  }

  const rendererValues = rendererObservations.map((item) => item.value);
  const replayP95 = percentile(rendererValues, 0.95);
  const replayMax = rendererValues.length ? Math.max(...rendererValues) : null;
  const baselineValues = scored.filter((sample) => finite(sample?.scoredElapsedMinutes) != null && sample.scoredElapsedMinutes >= 0 && sample.scoredElapsedMinutes <= 5)
    .map((sample) => finite(sample.rendererWorkingSetMb)).filter((value) => value != null);
  const replayBaseline = median(baselineValues);
  const replaySlope = normalizedSlope(rendererObservations, replayBaseline);
  const replayGrowth = growthValues.length ? Math.max(...growthValues) : null;
  const replaySlopeWindowMs = rendererObservations.length >= 2 ? rendererObservations.at(-1).at - rendererObservations[0].at : 0;
  for (const [field, replayed, tolerance] of [
    ['rendererP95Mb', replayP95, 1e-9],
    ['rendererMaxMb', replayMax, 1e-9],
    ['rendererBaselineMb', replayBaseline, 1e-9],
    ['rendererTenMinuteGrowthMax', replayGrowth, 1e-9],
    ['rendererSlopePerHour', replaySlope, 1e-6],
  ]) {
    const reported = requireFinite(result[field], field, failures);
    if (reported != null && !equalNumber(reported, replayed, tolerance)) failures.push(`${field} differs from replayed renderer samples`);
  }
  if (requireFinite(result.baselineSampleCount, 'baselineSampleCount', failures, { integer: true, min: 1 }) !== baselineValues.length) failures.push('baseline sample count differs from replay');
  if (result.slopeWindowComplete !== true || replaySlopeWindowMs < SOAK_SCORED_MS) failures.push('runner renderer slope window is incomplete');
  const reportedRunnerWindow = requireFinite(result.runnerSlopeWindowMs, 'runnerSlopeWindowMs', failures, { min: 0 });
  if (reportedRunnerWindow != null && !equalNumber(reportedRunnerWindow, replaySlopeWindowMs, SOAK_CADENCE_TOLERANCE_MS)) failures.push('runner slope window differs from sample timestamps');
  if (replaySlope == null || replaySlope > 0.02 || replayP95 == null || replayP95 > 384 || replayMax == null || replayMax > 512 || replayGrowth == null || replayGrowth > 0.10) {
    failures.push('replayed renderer memory limits failed or were incomplete');
  }

  const cutoffStatus = cutoff.status;
  const runtimeSlope = requireFinite(cutoffStatus?.renderer?.slopePerHour, 'cutoff runtime renderer slope', failures);
  const reportedRuntimeSlope = requireFinite(result.runtimeRendererSlopePerHour, 'runtimeRendererSlopePerHour', failures);
  if (runtimeSlope != null && reportedRuntimeSlope != null && !equalNumber(runtimeSlope, reportedRuntimeSlope, 1e-9)) failures.push('runtime renderer slope differs from cutoff evidence');
  const runtimeWindow = requireFinite(cutoffStatus?.renderer?.slopeWindowMs, 'cutoff runtime slope window', failures, { min: 0 });
  const reportedRuntimeWindow = requireFinite(result.runtimeSlopeWindowMs, 'runtimeSlopeWindowMs', failures, { min: 0 });
  if (cutoffStatus?.renderer?.slopeWindowComplete !== true || runtimeWindow == null || runtimeWindow < SOAK_SCORED_MS || runtimeSlope == null || runtimeSlope > 0.02) failures.push('cutoff runtime slope evidence failed or was incomplete');
  if (runtimeWindow != null && reportedRuntimeWindow != null && !equalNumber(runtimeWindow, reportedRuntimeWindow, 1e-9)) failures.push('runtime slope window differs from cutoff evidence');
  const combinedWindow = Math.min(replaySlopeWindowMs, runtimeWindow ?? 0);
  const reportedWindow = requireFinite(result.slopeWindowMs, 'slopeWindowMs', failures, { min: 0 });
  if (reportedWindow != null && !equalNumber(reportedWindow, combinedWindow, SOAK_CADENCE_TOLERANCE_MS)) failures.push('combined slope window differs from replay');

  if (result.finalFeedQualificationReady !== true || result.finalBridgeQualificationReady !== true || result.finalRuntimeState !== 'healthy' || result.finalRendererStatus !== 'stable') {
    failures.push('cutoff feed, bridge, runtime, or renderer state was not ready');
  }
  if (requireFinite(result.finalTrackedOrderbookTickers, 'finalTrackedOrderbookTickers', failures, { integer: true }) !== 25) failures.push('cutoff did not contain exactly 25 tracked orderbooks');
  if (!cutoffStatus || cutoffStatus.productionObservation?.qualificationReady !== true || cutoffStatus.productionObservation?.unchanged !== true
    || !HASH_PATTERN.test(String(cutoffStatus.productionObservation?.stateHash)) || cutoffStatus.productionObservation.stateHash !== [...protectedHashes][0]
    || cutoffStatus.orderbookTracking?.trackingReady !== true || finite(cutoffStatus.orderbookTracking?.trackedTickers) !== 25) {
    failures.push('cutoff safe-mode or orderbook readiness evidence is missing or inconsistent');
  }
  if (runtimeStatus.productionObservation?.qualificationReady !== true || runtimeStatus.productionObservation?.unchanged !== true
    || !HASH_PATTERN.test(String(runtimeStatus.productionObservation?.stateHash))) failures.push('final runtime status is not in locked production observation mode');
  if (result.devToolsDisabled !== true || finite(result.configuredTrackedTickers) !== 500 || finite(result.configuredOrderbookTickers) !== 25) failures.push('production observation configuration is incomplete');

  const expectedHashes = result.evidenceArtifactHashes || {};
  for (const [field, filePath] of [['samplesSha256', paths.samples], ['runtimeStatusSha256', paths.runtimeStatus], ['cutoffStatusSha256', paths.cutoffStatus]]) {
    if (!HASH_PATTERN.test(String(expectedHashes[field])) || expectedHashes[field] !== fileHash(filePath)) failures.push(`${field} does not match the explicit input`);
    if (manifest.evidenceArtifactHashes?.[field] !== expectedHashes[field]) failures.push(`${field} differs between manifest and result`);
  }
  return { failures: [...new Set(failures)], result, manifest, chainHead: chain.head, sampleCount: chain.rows.length };
}

function createReceipt(paths, verification) {
  const receipt = {
    schemaVersion: 1,
    receiptType: 'EvidenceVerificationReceipt',
    runType: 'production-stress-soak',
    runId: verification.result.attemptId,
    seriesId: verification.result.seriesId,
    verifiedAt: Date.now(),
    verified: verification.failures.length === 0,
    failures: verification.failures,
    gitCommit: verification.result.gitCommit,
    configurationHash: verification.result.configurationHash,
    healthPolicyHash: verification.result.healthPolicyHash,
    productionArtifactHash: verification.result.productionArtifactHash,
    sampleCount: verification.sampleCount,
    sampleChainHead: verification.chainHead,
    inputHashes: {
      result: fileHash(paths.result),
      manifest: fileHash(paths.manifest),
      samples: fileHash(paths.samples),
      runtimeStatus: fileHash(paths.runtimeStatus),
      cutoffStatus: fileHash(paths.cutoffStatus),
    },
  };
  return { ...receipt, receiptHash: sha256(JSON.stringify(stable(receipt))) };
}

module.exports = { createReceipt, fileHash, sha256, stable, verifySampleChain, verifySoakEvidence };
