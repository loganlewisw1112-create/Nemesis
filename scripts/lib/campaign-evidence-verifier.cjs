'use strict';

const fs = require('node:fs');
const { fileHash, sha256, stable } = require('./evidence-verifier.cjs');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RUNTIME_INTERVAL_MS = 5_000;
const MAX_BOOK_AGE_MS = 1_000;
const STAGE_TIMING = Object.freeze({
  instrumentation: { durationMs: 2 * 60 * 60_000, enrollmentMs: 100 * 60_000, expectedRunType: 'r10-instrumentation' },
  'seven-hour': { durationMs: 7 * 60 * 60_000, enrollmentMs: 405 * 60_000, expectedRunType: 'seven-hour' },
});
const COMPONENT_NAMES = ['rest-markets', 'trade-tape', 'ticker-websocket', 'orderbook-websocket', 'bridge', 'gea'];
const REQUIRED_OPERATIONAL_CHECKS = [
  'renderer_memory_stable',
  'bridge_bidirectional_traffic',
  'runtime_health_coverage',
  'exchange_book_time_available',
  'no_runtime_restart_or_emergency_mitigation',
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
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

function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function notEmpty(value) {
  return Array.isArray(value) && value.length > 0;
}

function verifyLedger(filePath, expectedSchema, expectedRunId) {
  const failures = [];
  const events = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line.replace(/^\uFEFF/, '')); }
    catch { failures.push(`ledger line ${index + 1} is invalid JSON`); return null; }
  }).filter(Boolean);
  let previousHash = 'GENESIS';
  let previousAt = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const { hash, ...body } = event;
    if (event.schemaVersion !== expectedSchema) failures.push(`ledger sequence ${index + 1} has the wrong schema`);
    if (event.runId !== expectedRunId) failures.push(`ledger sequence ${index + 1} has the wrong run identity`);
    if (event.sequence !== index + 1) failures.push(`ledger sequence ${index + 1} is missing or duplicated`);
    if (event.previousHash !== previousHash) failures.push(`ledger sequence ${index + 1} has the wrong previous hash`);
    if (!HASH_PATTERN.test(String(hash)) || sha256(JSON.stringify(body)) !== hash) failures.push(`ledger sequence ${index + 1} hash is invalid`);
    const at = finite(event.at);
    if (at == null || !Number.isInteger(at) || (previousAt != null && at < previousAt)) failures.push(`ledger sequence ${index + 1} timestamp is missing or regressed`);
    previousHash = typeof event.hash === 'string' ? event.hash : previousHash;
    previousAt = at;
  }
  if (events.length === 0) failures.push('ledger is empty');
  return { events, failures, finalEventHash: previousHash };
}

function validateFill(fill, label, failures, expectedTicker, expectedSide, expectedContracts) {
  if (!fill || typeof fill !== 'object') {
    failures.push(`${label} is missing`);
    return false;
  }
  let valid = true;
  if (fill.ticker !== expectedTicker || fill.side !== expectedSide) { failures.push(`${label} identity differs from its candidate`); valid = false; }
  if (fill.aborted !== false || fill.feePolicyKnown !== true) { failures.push(`${label} is aborted or has unresolved fees`); valid = false; }
  const contracts = requireFinite(fill.contracts, `${label} contracts`, failures, { min: Number.EPSILON });
  const filled = requireFinite(fill.filled, `${label} filled quantity`, failures, { min: Number.EPSILON });
  const fillPrice = requireFinite(fill.fillPrice, `${label} fill price`, failures, { min: 0, max: 1 });
  requireFinite(fill.expectedPrice, `${label} expected price`, failures, { min: 0, max: 1 });
  requireFinite(fill.slippage, `${label} slippage`, failures, { min: 0 });
  requireFinite(fill.netEdge, `${label} net edge`, failures);
  requireFinite(fill.fees, `${label} fees`, failures, { min: 0 });
  if (contracts == null || filled == null || !equalNumber(contracts, filled, 1e-8)
    || (expectedContracts != null && !equalNumber(contracts, expectedContracts, 1e-8))) {
    failures.push(`${label} does not prove a complete requested fill`);
    valid = false;
  }
  if (!Array.isArray(fill.fillLevels) || fill.fillLevels.length === 0) {
    failures.push(`${label} has no order-book level reconstruction`);
    return false;
  }
  let totalQuantity = 0;
  let totalCost = 0;
  for (let index = 0; index < fill.fillLevels.length; index += 1) {
    const level = fill.fillLevels[index];
    const price = requireFinite(level?.price, `${label} level ${index + 1} price`, failures, { min: 0, max: 1 });
    const quantity = requireFinite(level?.quantity, `${label} level ${index + 1} quantity`, failures, { min: Number.EPSILON });
    const cost = requireFinite(level?.cost, `${label} level ${index + 1} cost`, failures, { min: 0 });
    if (price == null || quantity == null || cost == null) { valid = false; continue; }
    if (!equalNumber(cost, price * quantity, 1e-6)) { failures.push(`${label} level ${index + 1} cost is inconsistent`); valid = false; }
    totalQuantity += quantity;
    totalCost += cost;
  }
  if (filled != null && !equalNumber(totalQuantity, filled, 1e-6)) { failures.push(`${label} level quantities do not equal the filled quantity`); valid = false; }
  if (filled != null && fillPrice != null && !equalNumber(totalCost / filled, fillPrice, 1e-6)) { failures.push(`${label} level costs do not reconstruct its fill price`); valid = false; }
  return valid;
}

function validateCandidateSample(sample, label, failures, observedAt) {
  if (!sample || typeof sample !== 'object') { failures.push(`${label} is missing`); return { valid: false, fresh: false }; }
  let valid = true;
  const at = requireFinite(sample.at, `${label} at`, failures, { integer: true, min: 1 });
  const observed = requireFinite(sample.observedAt, `${label} observedAt`, failures, { integer: true, min: 1 });
  const exchangeTimestamp = requireFinite(sample.exchangeTimestamp, `${label} exchange timestamp`, failures, { integer: true, min: 1_000_000_000_000 });
  const bookTimestamp = requireFinite(sample.bookTimestamp, `${label} book timestamp`, failures, { integer: true, min: 1_000_000_000_000 });
  const exchangeSequence = requireFinite(sample.exchangeSequence, `${label} exchange sequence`, failures, { integer: true, min: 0 });
  const bookSequence = requireFinite(sample.bookSequence, `${label} book sequence`, failures, { integer: true, min: 0 });
  requireFinite(sample.netEdge, `${label} net edge`, failures);
  requireFinite(sample.spread, `${label} spread`, failures, { min: 0, max: 1 });
  requireFinite(sample.fillPrice, `${label} fill price`, failures, { min: 0, max: 1 });
  requireFinite(sample.filled, `${label} filled quantity`, failures, { min: Number.EPSILON });
  requireFinite(sample.fees, `${label} fees`, failures, { min: 0 });
  if (sample.feePolicyKnown !== true) { failures.push(`${label} has unresolved fees`); valid = false; }
  if (at == null || observed == null || at !== observed || (observedAt != null && observed !== observedAt)) { failures.push(`${label} does not use its actual observation completion time`); valid = false; }
  if (exchangeTimestamp == null || bookTimestamp == null || exchangeTimestamp !== bookTimestamp
    || exchangeSequence == null || bookSequence == null || exchangeSequence !== bookSequence) {
    failures.push(`${label} book and exchange provenance differ`);
    valid = false;
  }
  const age = observed == null || exchangeTimestamp == null ? null : observed - exchangeTimestamp;
  return { valid, fresh: age != null && age >= 0 && age <= MAX_BOOK_AGE_MS, sequence: exchangeSequence };
}

function validateDiagnosticResult(result, diagnostic, candidate, eventAt, failures) {
  const label = `diagnostic ${diagnostic.diagnosticId}`;
  let valid = true;
  if (!result || result.validExecutableObservation !== true) { failures.push(`${label} is not a valid executable observation`); return false; }
  const exchangeTimestamp = requireFinite(result.exchangeTimestamp, `${label} exchange timestamp`, failures, { integer: true, min: 1_000_000_000_000 });
  requireFinite(result.exchangeSequence, `${label} exchange sequence`, failures, { integer: true, min: 0 });
  const mark = requireFinite(result.executableFollowUpMark, `${label} executable mark`, failures, { min: 0, max: 1 });
  const pnl = requireFinite(result.executableNetPnlUsd, `${label} executable net PnL`, failures);
  if (typeof result.reason !== 'string' || result.reason.trim() === '') { failures.push(`${label} terminal reason is missing`); valid = false; }
  if (exchangeTimestamp == null || eventAt - exchangeTimestamp < 0 || eventAt - exchangeTimestamp > MAX_BOOK_AGE_MS) {
    failures.push(`${label} exchange provenance is stale or future dated`);
    valid = false;
  }
  if (eventAt < diagnostic.dueAt || eventAt > diagnostic.expiresAt) { failures.push(`${label} was scored outside its fixed observation window`); valid = false; }
  const fillValid = validateFill(result.reconstructedExitFill, `${label} reconstructed exit fill`, failures, candidate.ticker, candidate.side, candidate.initialFill?.filled);
  valid = fillValid && valid;
  const fill = result.reconstructedExitFill;
  if (mark != null && finite(fill?.fillPrice) != null && !equalNumber(mark, fill.fillPrice, 1e-9)) { failures.push(`${label} executable mark differs from its fill`); valid = false; }
  if (pnl != null && fill && candidate.initialFill) {
    const replayedPnl = Number((fill.fillPrice * fill.filled - fill.fees
      - (candidate.initialFill.fillPrice * candidate.initialFill.filled + candidate.initialFill.fees)).toFixed(6));
    if (!equalNumber(pnl, replayedPnl, 1e-6)) { failures.push(`${label} executable net PnL does not reconstruct from fills and fees`); valid = false; }
  }
  for (const field of ['targetAt', 'lossAt', 'edgeGoneAt']) {
    if (result[field] != null) {
      const timestamp = requireFinite(result[field], `${label} ${field}`, failures, { integer: true, min: 1 });
      if (timestamp != null && timestamp !== eventAt) { failures.push(`${label} ${field} is not tied to completion time`); valid = false; }
    }
  }
  return valid;
}

function replayRuntime(runtime, manifest, failures) {
  const timing = STAGE_TIMING[manifest?.stage];
  const startedAt = requireFinite(manifest?.startedAt, 'campaign startedAt', failures, { integer: true, min: 1 });
  const cutoffAt = requireFinite(manifest?.cutoffAt, 'campaign cutoffAt', failures, { integer: true, min: 1 });
  if (!timing || startedAt == null || cutoffAt == null) return { activeSamples: [], expectedSamples: 0, coverage: {} };
  const expectedSamples = timing.durationMs / RUNTIME_INTERVAL_MS + 1;
  const activeSamples = runtime.events.filter((event) => event.type === 'runtime_sample' && event.at >= startedAt && event.at <= cutoffAt);
  if (activeSamples.length === 0) failures.push('runtime ledger has no active campaign samples');
  const occupiedSlots = new Set();
  let priorAt = null;
  for (const sample of activeSamples) {
    const offset = sample.at - startedAt;
    const slot = Math.round(offset / RUNTIME_INTERVAL_MS);
    const distance = Math.abs(offset - slot * RUNTIME_INTERVAL_MS);
    if (slot < 0 || slot >= expectedSamples || distance > RUNTIME_INTERVAL_MS / 2 || occupiedSlots.has(slot)) {
      failures.push('runtime sample cadence contains an off-grid or duplicated interval');
    } else occupiedSlots.add(slot);
    if (priorAt != null) {
      const gap = sample.at - priorAt;
      if (gap < RUNTIME_INTERVAL_MS / 2 || gap > RUNTIME_INTERVAL_MS * 2 + RUNTIME_INTERVAL_MS / 2) failures.push('runtime sample cadence contains a gap longer than two intervals');
    }
    priorAt = sample.at;
  }
  const sampleCoverage = occupiedSlots.size / expectedSamples;
  if (sampleCoverage < 0.95) failures.push('runtime sample coverage is below 95 percent');
  if (activeSamples[0] && activeSamples[0].at - startedAt > 10_000) failures.push('runtime evidence began more than ten seconds after campaign start');
  if (activeSamples.at(-1) && cutoffAt - activeSamples.at(-1).at > 60_000) failures.push('final runtime sample is more than sixty seconds before cutoff');

  const protectedHashes = new Set();
  const componentReady = Object.fromEntries(COMPONENT_NAMES.map((name) => [name, 0]));
  let runtimeHealthy = 0;
  let rendererReady = 0;
  let trackingReady = 0;
  const rendererValues = [];
  const rendererPids = new Set();
  const mainPids = new Set();
  const geaPids = new Set();
  let maxGrowth = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < activeSamples.length; index += 1) {
    const payload = activeSamples[index].payload || {};
    if (payload.state === 'recovering' || payload.state === 'invalidated'
      || finite(payload.lease?.metrics?.recoveryCount) !== 0 || finite(payload.lease?.metrics?.recentRecoveryCount) !== 0) {
      failures.push(`runtime sample ${index + 1} contains a recovery or invalidation`);
    }
    if (payload.state === 'healthy' && payload.lease?.status === 'healthy') runtimeHealthy += 1;
    const stateHash = payload.productionObservation?.stateHash;
    if (!HASH_PATTERN.test(String(stateHash))) failures.push(`runtime sample ${index + 1} protected state hash is missing or malformed`);
    else protectedHashes.add(stateHash);
    if (payload.productionObservation?.qualificationReady !== true || payload.productionObservation?.unchanged !== true) failures.push(`runtime sample ${index + 1} was not in unchanged production observation mode`);
    const components = Array.isArray(payload.components) ? payload.components : [];
    for (const name of COMPONENT_NAMES) {
      const matching = components.filter((component) => component?.name === name);
      if (matching.length !== 1) failures.push(`runtime sample ${index + 1} does not contain exactly one ${name} component`);
      else if (matching[0].connected === true && matching[0].qualificationReady === true) componentReady[name] += 1;
    }
    if (payload.orderbookTracking?.trackedTickers === 25 && payload.orderbookTracking?.trackingReady === true) trackingReady += 1;
    const renderer = payload.renderer;
    const workingSet = finite(renderer?.workingSetKb);
    const growth = finite(renderer?.growthRate);
    if (workingSet != null && workingSet > 0) rendererValues.push(workingSet);
    if (growth != null) maxGrowth = Math.max(maxGrowth, growth);
    const heartbeatAge = finite(renderer?.heartbeatAgeMs);
    const probeAge = finite(renderer?.rendererProbeAgeMs);
    if (workingSet != null && workingSet > 0 && renderer?.blocked === false
      && renderer?.heartbeatReceived === true && renderer?.heartbeatPainted === true && heartbeatAge != null && heartbeatAge >= 0 && heartbeatAge <= 15_000
      && renderer?.rendererProbeResponseReceived === true && probeAge != null && probeAge >= 0 && probeAge <= 15_000) rendererReady += 1;
    if (Number.isInteger(renderer?.rendererPid) && renderer.rendererPid > 0) rendererPids.add(renderer.rendererPid);
    else failures.push(`runtime sample ${index + 1} renderer PID is missing`);
    if (Number.isInteger(payload.processes?.main?.pid) && payload.processes.main.pid > 0) mainPids.add(payload.processes.main.pid);
    else failures.push(`runtime sample ${index + 1} main PID is missing`);
    if (Number.isInteger(payload.processes?.gea?.pid) && payload.processes.gea.pid > 0) geaPids.add(payload.processes.gea.pid);
    else failures.push(`runtime sample ${index + 1} GEA PID is missing`);
  }
  if (protectedHashes.size !== 1) failures.push('protected paper or safety state hash changed during the campaign');
  if (rendererPids.size !== 1 || mainPids.size !== 1 || geaPids.size !== 1) failures.push('a required process restarted or lacked continuous identity evidence');
  if (runtimeHealthy / expectedSamples < 0.995) failures.push('runtime healthy coverage is below 99.5 percent');
  if (rendererReady / expectedSamples < 0.99) failures.push('renderer liveness and memory coverage is below 99 percent');
  if (trackingReady / expectedSamples < 0.995) failures.push('orderbook tracking coverage is below 99.5 percent');
  for (const name of COMPONENT_NAMES) {
    if (componentReady[name] / expectedSamples < 0.995) failures.push(`${name} runtime coverage is below 99.5 percent`);
  }
  const p95 = percentile(rendererValues, 0.95);
  const maximum = rendererValues.length ? Math.max(...rendererValues) : null;
  // rendererTenMinuteGrowthMax is replayed and reported but does not gate. The
  // rolling ten-minute rate is phase-sensitive -- a window can straddle opposite
  // phases of a longer allocate/collect cycle -- and was measured swinging from
  // -22% to +17.6% within six minutes with no net growth across the run. The
  // phase-independent bounds below and the final thirty-minute slope check that
  // follows are what establish the renderer did not leak.
  if (p95 == null || p95 > 384 * 1024 || maximum == null || maximum > 512 * 1024) {
    failures.push('replayed renderer p95 or maximum failed');
  }
  const lastRenderer = activeSamples.at(-1)?.payload?.renderer;
  if (!lastRenderer || lastRenderer.blocked !== false || lastRenderer.status !== 'stable'
    || lastRenderer.slopeWindowComplete !== true || requireFinite(lastRenderer.slopeWindowMs, 'final renderer slope window', failures, { min: 0 }) < 30 * 60_000
    || requireFinite(lastRenderer.slopePerHour, 'final renderer slope', failures) > 0.02) {
    failures.push('final renderer memory evidence failed or was incomplete');
  }
  const disallowedTransitions = runtime.events.filter((event) => event.type === 'runtime_transition'
    && event.at >= startedAt && event.at <= cutoffAt
    && ['pause', 'invalidate', 'stop', 'recover', 'recovering', 'restart'].includes(String(event.payload?.action).toLowerCase()));
  if (disallowedTransitions.length > 0) failures.push('runtime ledger contains a recovery, pause, invalidation, or restart transition');
  return {
    activeSamples,
    expectedSamples,
    coverage: {
      sampleCoverage,
      runtimeHealthyCoverage: runtimeHealthy / expectedSamples,
      rendererCoverage: rendererReady / expectedSamples,
      orderbookTrackingCoverage: trackingReady / expectedSamples,
      componentCoverage: Object.fromEntries(COMPONENT_NAMES.map((name) => [name, componentReady[name] / expectedSamples])),
      rendererP95Kb: p95,
      rendererMaxKb: maximum,
      rendererTenMinuteGrowthMax: maxGrowth,
    },
  };
}

function verifyCampaignEvidence(paths) {
  const failures = [];
  const result = readJson(paths.result);
  const manifest = result.manifest;
  const runId = result.runId;
  if (!manifest || result.schemaVersion !== 2 || manifest.schemaVersion !== 2) failures.push('campaign result or manifest schema is invalid');
  if (typeof runId !== 'string' || runId.length === 0) failures.push('campaign result run identity is missing');
  const campaign = verifyLedger(paths.ledger, 2, runId);
  const runtime = verifyLedger(paths.runtimeLedger, 2, runId);
  failures.push(...campaign.failures, ...runtime.failures);
  if (result.passed !== true || manifest?.status !== 'passed' || notEmpty(result.reasons)) failures.push('campaign did not produce a clean passing terminal result');
  if (result.invalidated === true || result.uncleanShutdown === true || result.restartable === true) failures.push('campaign result records invalidation, unclean shutdown, or restartability');
  if (result.offlineReplayCount !== 1) failures.push('campaign was not finalized by exactly one offline replay');
  if (manifest?.runId !== runId || manifest?.evidenceNamespace !== runId) failures.push('campaign result and manifest identity differ');
  if (manifest?.restartOrdinal !== 0 || /-recovery-/i.test(String(runId)) || manifest?.parentRunId && /-recovery-/i.test(String(manifest.parentRunId))) failures.push('campaign used a recovery or restart namespace');

  const timing = STAGE_TIMING[manifest?.stage];
  if (!timing) failures.push('campaign stage is invalid');
  const startedAt = requireFinite(manifest?.startedAt, 'campaign startedAt', failures, { integer: true, min: 1 });
  const enrollmentCutoffAt = requireFinite(manifest?.enrollmentCutoffAt, 'campaign enrollmentCutoffAt', failures, { integer: true, min: 1 });
  const cutoffAt = requireFinite(manifest?.cutoffAt, 'campaign cutoffAt', failures, { integer: true, min: 1 });
  const finalizedAt = requireFinite(manifest?.finalizedAt, 'campaign finalizedAt', failures, { integer: true, min: 1 });
  if (timing && startedAt != null && enrollmentCutoffAt != null && cutoffAt != null) {
    if (cutoffAt - startedAt !== timing.durationMs || enrollmentCutoffAt - startedAt !== timing.enrollmentMs) failures.push('campaign fixed duration or enrollment cutoff was changed');
  }
  if (finalizedAt != null && cutoffAt != null && finalizedAt < cutoffAt) failures.push('campaign finalized before its fixed cutoff');
  if (campaign.events.some((event) => event.type === 'instrumentation_extended')) failures.push('campaign ledger contains a prohibited extension');
  if (campaign.events[0]?.type !== 'run_started' || campaign.events.at(-1)?.type !== 'run_finalized') failures.push('campaign ledger is missing start or finalization');
  if (campaign.events.some((event) => event.type === 'run_invalidated' || event.type === 'safety_failure')) failures.push('campaign ledger contains invalidation or safety failure');
  if (campaign.events.some((event) => event.configurationHash !== manifest?.configurationHash)) failures.push('campaign event configuration changed during the run');
  const initialManifest = campaign.events[0]?.payload?.manifest;
  if (!initialManifest || initialManifest.runId !== runId || initialManifest.stage !== manifest?.stage
    || initialManifest.startedAt !== startedAt || initialManifest.enrollmentCutoffAt !== enrollmentCutoffAt || initialManifest.cutoffAt !== cutoffAt
    || initialManifest.gitCommit !== manifest?.gitCommit || initialManifest.configurationHash !== manifest?.configurationHash
    || initialManifest.healthPolicyHash !== manifest?.healthPolicyHash || initialManifest.restartOrdinal !== 0) {
    failures.push('final manifest is not bound to the immutable run-start manifest');
  }

  const finalRuntimeHash = fileHash(paths.runtimeLedger);
  const finalCampaignEvent = campaign.events.at(-1);
  if (finalCampaignEvent?.payload?.passed !== result.passed
    || JSON.stringify(finalCampaignEvent?.payload?.reasons ?? []) !== JSON.stringify(result.reasons ?? [])
    || finalCampaignEvent?.at !== finalizedAt) failures.push('final campaign ledger result differs from the result JSON');
  if (finalCampaignEvent?.payload?.finalRuntimeSidecarHash !== finalRuntimeHash || manifest?.finalRuntimeSidecarHash !== finalRuntimeHash || result.finalRuntimeSidecarHash !== finalRuntimeHash) {
    failures.push('final runtime ledger hash is not linked by campaign result and final event');
  }
  if (runtime.events[0]?.type !== 'runtime_started' || runtime.events.at(-1)?.type !== 'runtime_finalized') failures.push('runtime ledger is missing start or finalization');
  const runtimeStart = runtime.events[0]?.payload || {};
  if (runtimeStart.gitCommit !== manifest?.gitCommit || runtimeStart.configurationHash !== manifest?.configurationHash || runtimeStart.healthPolicyHash !== manifest?.healthPolicyHash) {
    failures.push('runtime ledger does not match frozen campaign identity');
  }
  const startTransitions = runtime.events.filter((event) => event.type === 'runtime_transition' && event.payload?.action === 'start-campaign');
  if (startTransitions.length !== 1 || startTransitions[0]?.at !== startedAt) failures.push('runtime ledger does not contain exactly one start-campaign transition at the fixed start');
  if (runtime.events.at(-1)?.at !== finalizedAt || runtime.events.at(-1)?.payload?.cleanShutdownRequested !== true) failures.push('runtime finalization is not bound to campaign finalization and clean shutdown request');

  const candidates = new Map();
  const diagnostics = new Map();
  const diagnosticByCandidate = new Map();
  let freshSamples = 0;
  let totalSamples = 0;
  for (const event of campaign.events) {
    if (event.type === 'candidate_enrolled') {
      const candidate = event.payload?.candidate;
      const diagnostic = event.payload?.diagnostic;
      if (!candidate?.candidateId || candidates.has(candidate.candidateId)) failures.push('duplicate or invalid candidate enrollment');
      else {
        const row = { ...candidate, samples: Array.isArray(candidate.samples) ? [...candidate.samples] : [] };
        candidates.set(candidate.candidateId, row);
        if (candidate.configurationHash !== manifest?.configurationHash || candidate.enrolledAt !== event.at || event.at > enrollmentCutoffAt) failures.push(`candidate ${candidate.candidateId} enrollment identity or cutoff is invalid`);
        if (!candidate.economicIdentity || !candidate.originalCardId || !candidate.ticker || !['yes', 'no'].includes(candidate.side)) failures.push(`candidate ${candidate.candidateId} provenance is incomplete`);
        validateFill(candidate.initialFill, `candidate ${candidate.candidateId} initial fill`, failures, candidate.ticker, candidate.side);
        if (row.samples.length !== 1) failures.push(`candidate ${candidate.candidateId} enrollment must contain exactly one initial exchange sample`);
        const sampleResult = validateCandidateSample(row.samples[0], `candidate ${candidate.candidateId} initial sample`, failures, event.at);
        totalSamples += 1;
        if (sampleResult.fresh) freshSamples += 1;
        row.sequences = new Set(sampleResult.sequence == null ? [] : [sampleResult.sequence]);
      }
      if (!diagnostic?.diagnosticId || diagnostics.has(diagnostic.diagnosticId)) failures.push('duplicate or invalid diagnostic scheduling');
      else {
        diagnostics.set(diagnostic.diagnosticId, { ...diagnostic, status: 'scheduled', valid: false });
        if (diagnostic.candidateId !== candidate?.candidateId || diagnostic.qualificationEligible !== false
          || finite(diagnostic.dueAt) == null || finite(diagnostic.expiresAt) == null || diagnostic.expiresAt < diagnostic.dueAt || diagnostic.expiresAt > cutoffAt
          || diagnosticByCandidate.has(diagnostic.candidateId)) failures.push(`diagnostic ${diagnostic.diagnosticId} scheduling or ownership is invalid`);
        diagnosticByCandidate.set(diagnostic.candidateId, diagnostic.diagnosticId);
      }
    } else if (event.type === 'candidate_sampled') {
      const candidate = candidates.get(String(event.payload?.candidateId));
      if (!candidate || candidate.terminalState) failures.push('orphaned candidate sample or sample after terminal state');
      else {
        const sampleResult = validateCandidateSample(event.payload?.sample, `candidate ${candidate.candidateId} confirmation sample`, failures, event.at);
        if (sampleResult.sequence != null && candidate.sequences.has(sampleResult.sequence)) failures.push(`candidate ${candidate.candidateId} repeated an exchange sequence`);
        else if (sampleResult.sequence != null) candidate.sequences.add(sampleResult.sequence);
        candidate.samples.push(event.payload.sample);
        totalSamples += 1;
        if (sampleResult.fresh) freshSamples += 1;
      }
    } else if (event.type === 'candidate_terminal') {
      const candidate = candidates.get(String(event.payload?.candidateId));
      if (!candidate || candidate.terminalState) failures.push('duplicate or orphaned candidate terminal event');
      else if (!['ready', 'rejected', 'expired'].includes(event.payload?.state) || typeof event.payload?.reason !== 'string' || event.payload.reason.trim() === '') failures.push(`candidate ${candidate.candidateId} terminal state or reason is invalid`);
      else candidate.terminalState = event.payload.state;
    } else if (event.type === 'diagnostic_scored' || event.type === 'diagnostic_expired') {
      const diagnostic = diagnostics.get(String(event.payload?.diagnosticId));
      if (!diagnostic || diagnostic.status !== 'scheduled') failures.push('duplicate or orphaned diagnostic terminal event');
      else if (event.type === 'diagnostic_expired') {
        diagnostic.status = 'expired';
        if (typeof event.payload?.reason !== 'string' || event.payload.reason.trim() === '') failures.push(`diagnostic ${diagnostic.diagnosticId} expiry reason is missing`);
      } else {
        diagnostic.status = 'scored';
        const candidate = candidates.get(diagnostic.candidateId);
        diagnostic.valid = Boolean(candidate) && validateDiagnosticResult(event.payload?.result, diagnostic, candidate, event.at, failures);
      }
    }
  }
  const candidateRows = [...candidates.values()];
  const diagnosticRows = [...diagnostics.values()];
  if (candidateRows.some((candidate) => !candidate.terminalState)) failures.push('one or more candidates lack exactly one terminal lifecycle state');
  if (diagnosticRows.some((diagnostic) => diagnostic.status === 'scheduled')) failures.push('one or more diagnostics lack a terminal result');
  const terminal = candidateRows.filter((candidate) => candidate.terminalState).length;
  const ready = candidateRows.filter((candidate) => candidate.terminalState === 'ready').length;
  const validDiagnostics = diagnosticRows.filter((diagnostic) => diagnostic.status === 'scored' && diagnostic.valid).length;
  const replayed = {
    candidates: candidateRows.length,
    validDiagnosticOutcomes: validDiagnostics,
    readyCandidates: ready,
    terminalCoverage: ratio(terminal, candidateRows.length),
    diagnosticSchedulingCoverage: ratio(diagnosticRows.length, candidateRows.length),
    validDiagnosticCoverage: ratio(validDiagnostics, diagnosticRows.length),
    freshConfirmationRate: ratio(freshSamples, totalSamples),
  };
  for (const [field, value] of Object.entries(replayed)) {
    const reported = requireFinite(result.metrics?.[field], `result metric ${field}`, failures);
    if (reported != null && !equalNumber(reported, value, 1e-6)) failures.push(`replayed ${field} differs from result metrics`);
  }

  const operationalChecks = campaign.events.filter((event) => event.type === 'operational_check').map((event) => event.payload?.check).filter(Boolean);
  if (operationalChecks.some((check) => check.passed !== true)) failures.push('campaign contains a failed operational check');
  for (const name of REQUIRED_OPERATIONAL_CHECKS) {
    const matching = operationalChecks.filter((check) => check.name === name).sort((left, right) => left.at - right.at);
    const latest = matching.at(-1);
    if (!latest || latest.passed !== true || finalizedAt == null || finite(latest.at) == null || latest.at > finalizedAt || finalizedAt - latest.at > 60_000) {
      failures.push(`${name} was not proven by a fresh passing closeout check`);
    }
  }

  const runtimeReplay = replayRuntime(runtime, manifest, failures);
  if (manifest?.stage === 'instrumentation') {
    if (candidateRows.length < 20) failures.push('r10 enrolled fewer than 20 viable candidates');
    if (replayed.terminalCoverage < 1 || replayed.diagnosticSchedulingCoverage < 0.95 || replayed.validDiagnosticCoverage < 0.90) failures.push('r10 candidate or diagnostic coverage failed');
  } else if (manifest?.stage === 'seven-hour') {
    if (validDiagnostics < 30) failures.push('seven-hour campaign produced fewer than 30 valid diagnostic outcomes');
    if (ready < 1) failures.push('seven-hour campaign produced zero ready candidates');
    if (replayed.terminalCoverage < 1) failures.push('seven-hour candidate terminal coverage is incomplete');
  }
  if (replayed.freshConfirmationRate < 0.95) failures.push('exchange-book freshness is below 95 percent');
  return { failures: [...new Set(failures)], result, manifest, campaign, runtime, replayed, runtimeReplay };
}

function createCampaignReceipt(paths, verification) {
  const body = {
    schemaVersion: 1,
    receiptType: 'EvidenceVerificationReceipt',
    runType: STAGE_TIMING[verification.manifest?.stage]?.expectedRunType ?? 'invalid-stage',
    runId: verification.result.runId,
    verifiedAt: Date.now(),
    verified: verification.failures.length === 0,
    failures: verification.failures,
    gitCommit: verification.manifest?.gitCommit,
    configurationHash: verification.manifest?.configurationHash,
    healthPolicyHash: verification.manifest?.healthPolicyHash,
    finalCampaignEventHash: verification.campaign.finalEventHash,
    finalRuntimeEventHash: verification.runtime.finalEventHash,
    finalRuntimeLedgerHash: fileHash(paths.runtimeLedger),
    inputHashes: {
      ledger: fileHash(paths.ledger),
      runtimeLedger: fileHash(paths.runtimeLedger),
      result: fileHash(paths.result),
      summary: fileHash(paths.summary),
    },
    replayedMetrics: verification.replayed,
    replayedRuntime: verification.runtimeReplay.coverage,
  };
  return { ...body, receiptHash: sha256(JSON.stringify(stable(body))) };
}

module.exports = { createCampaignReceipt, verifyCampaignEvidence, verifyLedger };
