#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const expectedR9Hash = '7c93e9beafe8ec7af52f7483942f3edccff24e18aeab3f0c209b39cfe4c015ff';
const generatedAt = new Date().toISOString();

function parseArgs(argv) {
  if (argv.length % 2 !== 0) throw new Error('Every report option requires an explicit value.');
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    const value = argv[index + 1];
    if (!name || !value || !argv[index].startsWith('--')) throw new Error('Report options must use --name value.');
    if (values[name]) throw new Error(`Duplicate report option --${name}.`);
    values[name] = path.resolve(value);
  }
  return values;
}

function requirePath(inputs, name) {
  if (!inputs[name]) throw new Error(`Missing explicit --${name} input.`);
  if (!fs.existsSync(inputs[name])) throw new Error(`Explicit --${name} input does not exist: ${inputs[name]}`);
  return inputs[name];
}

function requireAllOrNone(inputs, names) {
  const supplied = names.filter((name) => Boolean(inputs[name]));
  if (supplied.length !== 0 && supplied.length !== names.length) {
    throw new Error(`Supply all or none of: ${names.map((name) => `--${name}`).join(', ')}.`);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line.replace(/^\uFEFF/, '')));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function validateVerificationReceipt(receipt, result, expectedRunType, explicitFiles) {
  const failures = [];
  if (receipt?.receiptType !== 'EvidenceVerificationReceipt') failures.push('receipt type is invalid');
  if (receipt?.runType !== expectedRunType) failures.push('receipt run type is invalid');
  const body = { ...receipt };
  delete body.receiptHash;
  if (!receipt?.receiptHash || sha256(JSON.stringify(stable(body))) !== receipt.receiptHash) failures.push('receipt hash is invalid');
  for (const [field, filePath] of Object.entries(explicitFiles)) {
    if (receipt?.inputHashes?.[field] !== sha256File(filePath)) failures.push(`receipt does not authenticate explicit ${field}`);
  }
  const expectedRunId = expectedRunType === 'production-stress-soak' ? result?.attemptId : result?.runId;
  if (!expectedRunId || receipt?.runId !== expectedRunId) failures.push('receipt and result identities differ');
  return { valid: failures.length === 0, failures };
}

function percent(value) {
  return value != null && value !== '' && Number.isFinite(Number(value)) ? `${(Number(value) * 100).toFixed(2)}%` : 'not available';
}

function number(value, digits = 2) {
  return value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'not available';
}

function passLabel(value) {
  return value === true ? 'PASS' : 'FAIL';
}

function writeNew(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
}

const inputs = parseArgs(process.argv.slice(2));
if (!inputs['output-dir']) throw new Error('Missing explicit --output-dir value.');
for (const name of ['r9-ledger', 'readiness-receipt']) requirePath(inputs, name);
requireAllOrNone(inputs, ['soak-result', 'soak-manifest', 'soak-samples', 'soak-runtime-status', 'soak-cutoff-status', 'soak-receipt']);
requireAllOrNone(inputs, ['r10-ledger', 'r10-runtime-ledger', 'r10-result', 'r10-summary', 'r10-receipt']);
for (const name of ['r3-ledger', 'verification-summary', 'soak-result', 'soak-manifest', 'soak-samples', 'soak-runtime-status', 'soak-cutoff-status', 'soak-receipt', 'r10-ledger', 'r10-runtime-ledger', 'r10-result', 'r10-summary', 'r10-receipt']) {
  if (inputs[name]) requirePath(inputs, name);
}

const outputDir = inputs['output-dir'];
if (fs.existsSync(outputDir)) throw new Error(`Report output directory already exists; use a fresh revision directory: ${outputDir}`);
fs.mkdirSync(outputDir, { recursive: false });

const actualR9Hash = sha256File(inputs['r9-ledger']);
if (actualR9Hash !== expectedR9Hash) throw new Error(`Preserved r9 ledger hash mismatch: expected ${expectedR9Hash}, found ${actualR9Hash}.`);

const readiness = readJson(inputs['readiness-receipt']);
const readinessReceiptBody = { ...readiness };
delete readinessReceiptBody.receiptHash;
const readinessHashValid = Boolean(readiness.receiptHash) && sha256(JSON.stringify(stable(readinessReceiptBody))) === readiness.receiptHash;
if (readiness.receiptType !== 'ReadinessReceipt' || readiness.timerStarted !== false || !readinessHashValid) {
  throw new Error('The explicit readiness receipt is invalid or claims a qualification timer started.');
}
const readinessPassed = readiness.passed === true
  && Number(readiness.holdMinutes) >= 10
  && Number.isFinite(Number(readiness.holdCompletedAt))
  && readiness.cleanShutdown === true
  && readiness.matchingArtifactHashes === true
  && Array.isArray(readiness.acceptanceFailures)
  && readiness.acceptanceFailures.length === 0
  && Array.isArray(readiness.networkChecks)
  && readiness.networkChecks.length === 4
  && readiness.networkChecks.every((check) => check.reachable === true);

const soak = inputs['soak-result'] ? readJson(inputs['soak-result']) : null;
const soakReceipt = inputs['soak-receipt'] ? readJson(inputs['soak-receipt']) : null;
const soakReceiptCheck = soak ? validateVerificationReceipt(soakReceipt, soak, 'production-stress-soak', {
  result: inputs['soak-result'], manifest: inputs['soak-manifest'], samples: inputs['soak-samples'],
  runtimeStatus: inputs['soak-runtime-status'], cutoffStatus: inputs['soak-cutoff-status'],
}) : null;
const soakSamples = inputs['soak-samples'] ? readJsonl(inputs['soak-samples']).map((row) => row.payload ?? row) : [];
const soakIdentityBound = soak != null
  && soak.gitCommit === readiness.gitCommit
  && soak.productionArtifactHash === readiness.productionArtifactHash
  && soak.healthPolicyHash === readiness.healthPolicyHash
  && soak.readinessReceiptSha256 === sha256File(inputs['readiness-receipt']);
const soakVerified = soakReceiptCheck?.valid === true && soakReceipt?.verified === true && soakIdentityBound;
const soakPassed = soak?.passed === true && soakVerified;

const r10 = inputs['r10-result'] ? readJson(inputs['r10-result']) : null;
const r10Receipt = inputs['r10-receipt'] ? readJson(inputs['r10-receipt']) : null;
const r10ReceiptCheck = r10 ? validateVerificationReceipt(r10Receipt, r10, 'r10-instrumentation', {
  ledger: inputs['r10-ledger'], runtimeLedger: inputs['r10-runtime-ledger'], result: inputs['r10-result'], summary: inputs['r10-summary'],
}) : null;
const r10IdentityBound = r10 != null && soak != null
  && r10.manifest?.gitCommit === soak.gitCommit
  && r10.manifest?.healthPolicyHash === soak.healthPolicyHash
  && r10.manifest?.productionArtifactHash === soak.productionArtifactHash
  && r10.manifest?.soakVerificationReceiptHash === sha256File(inputs['soak-receipt']);
const r10Verified = r10ReceiptCheck?.valid === true && r10Receipt?.verified === true && r10IdentityBound;
const r10Passed = r10?.passed === true && r10Verified;

const r3Events = inputs['r3-ledger'] ? readJsonl(inputs['r3-ledger']) : [];
let r3HashChainValid = r3Events.length > 0;
let previousHash = 'GENESIS';
for (const event of r3Events) {
  const { hash, ...body } = event;
  if (event.previousHash !== previousHash || sha256(JSON.stringify(body)) !== hash) r3HashChainValid = false;
  previousHash = hash;
}
const r3Invalidation = r3Events.find((event) => event.type === 'run_invalidated');
const verification = inputs['verification-summary'] ? readJson(inputs['verification-summary']) : null;
const sevenHourUnlocked = readinessPassed && soakPassed && r10Passed;

const reportState = !readinessPassed
  ? 'readiness_failed_no_timer_started'
  : !soak
    ? 'readiness_passed_soak_not_run'
    : !soakPassed
      ? 'soak_failed_or_unverified_r10_locked'
      : !r10
        ? 'soak_passed_r10_not_run'
        : r10Passed
          ? 'soak_and_r10_verified_pass'
          : 'soak_passed_r10_failed_or_unverified';

const scoredSoakSamples = soakSamples.filter((sample) => sample.phase === 'scored');
const expectedScoredSamples = soak ? Math.floor((Number(soak.scoredDurationMinutes) * 60) / Number(soak.sampleIntervalSeconds)) + 1 : 0;
const coverageRows = expectedScoredSamples > 0 ? [
  { metric: 'Renderer', coverage: scoredSoakSamples.filter((sample) => sample.rendererWorkingSetMb != null).length / expectedScoredSamples, threshold: 0.99 },
  { metric: 'GEA', coverage: scoredSoakSamples.filter((sample) => Number(sample.geaCount) > 0).length / expectedScoredSamples, threshold: 0.99 },
  { metric: 'Runtime status', coverage: scoredSoakSamples.filter((sample) => sample.externalStatusAgeMs != null && Number(sample.externalStatusAgeMs) <= 60_000).length / expectedScoredSamples, threshold: 0.99 },
  { metric: 'Feeds', coverage: scoredSoakSamples.filter((sample) => sample.feedQualificationReady === true).length / expectedScoredSamples, threshold: 0.995 },
  { metric: 'Authenticated bridge', coverage: scoredSoakSamples.filter((sample) => sample.bridgeQualificationReady === true).length / expectedScoredSamples, threshold: 0.995 },
].map((row) => ({ ...row, coverage: Math.min(1, row.coverage), result: row.coverage >= row.threshold ? 'pass' : 'fail' })) : [];

const r10Metrics = r10?.metrics ?? null;
const r10FunnelRows = r10Metrics ? [
  { stage: 'Enrolled candidates', count: Number(r10Metrics.candidates ?? 0) },
  { stage: 'Diagnostics scheduled', count: Math.round(Number(r10Metrics.candidates ?? 0) * Number(r10Metrics.diagnosticSchedulingCoverage ?? 0)) },
  { stage: 'Valid diagnostics', count: Number(r10Metrics.validDiagnosticOutcomes ?? 0) },
  { stage: 'Ready candidates', count: Number(r10Metrics.readyCandidates ?? 0) },
] : [];

const decisionStatusRows = [
  { gate: 'R9 preserved', complete: 1 },
  { gate: 'Readiness passed', complete: readinessPassed ? 1 : 0 },
  { gate: 'Soak verified', complete: soakPassed ? 1 : 0 },
  { gate: 'R10 verified', complete: r10Passed ? 1 : 0 },
  { gate: 'Seven-hour unlocked', complete: sevenHourUnlocked ? 1 : 0 },
];

const readinessFailures = Array.isArray(readiness.acceptanceFailures) ? readiness.acceptanceFailures : [];
const decisionBody = sevenHourUnlocked
  ? '## Decision\n\n**R10 passed every gate and both verifier receipts are valid.** The unchanged frozen build is eligible for a separate seven-hour evidence campaign. This is not live-trading approval; all later profit and safety gates remain closed.'
  : `## Decision\n\n**Do not start the seven-hour campaign.** ${!readinessPassed
    ? `Production readiness failed before any soak timer started${readinessFailures.length ? `: ${readinessFailures.join('; ')}` : ''}.`
    : !soakPassed
      ? 'The required soak is missing, failed, or was rejected by the offline verifier.'
      : !r10
        ? 'The soak passed, but r10 has not run.'
        : 'R10 failed or its verifier receipt was rejected.'} Preserve all evidence; do not extend, splice, or lower thresholds.`;

const readinessBody = `## Production readiness gate\n\nResult: **${passLabel(readinessPassed)}**. Qualification timer started: **no**.\n\n- Frozen commit: \`${readiness.gitCommit ?? 'not available'}\`.\n- Frozen artifact: \`${readiness.productionArtifactHash ?? 'not available'}\`.\n- Continuous readiness hold: **${readinessPassed ? `${readiness.holdMinutes ?? 10} minutes` : 'not completed'}**.\n- Clean shutdown: **${readiness.cleanShutdown === true ? 'yes' : readiness.cleanShutdown === false ? 'no' : 'not applicable; app was not launched'}**.\n- Failure class: **${readiness.failureClass ?? 'none'}**.\n\n${readinessFailures.length ? `Failures: ${readinessFailures.join('; ')}.` : 'No readiness failures were recorded.'}`;

const soakBody = soak ? `## 30-minute production soak\n\nRecorded result: **${passLabel(soak.passed)}**. Offline verification: **${soakVerified ? 'PASS' : 'FAIL'}**.\n\n- Warm-up / scored time: **${number(soak.actualWarmupMinutes)} / ${number(soak.actualScoredDurationMinutes)} minutes**.\n- Complete 30-minute slope window: **${soak.slopeWindowComplete === true ? 'yes' : 'no'}**.\n- Renderer p95 / maximum: **${number(soak.rendererP95Mb)} / ${number(soak.rendererMaxMb)} MB**.\n- Ten-minute growth / hourly slope: **${percent(soak.rendererTenMinuteGrowthMax)} / ${percent(soak.rendererSlopePerHour)}**.\n- Clean shutdown / unchanged artifact: **${soak.cleanShutdown === true ? 'yes' : 'no'} / ${soak.matchingArtifactHashes === true ? 'yes' : 'no'}**.\n\n${soakReceiptCheck?.failures.length ? `Receipt integrity failures: ${soakReceiptCheck.failures.join('; ')}.` : Array.isArray(soakReceipt?.failures) && soakReceipt.failures.length ? `Verifier failures: ${soakReceipt.failures.join('; ')}.` : 'No soak verifier failures were recorded.'}`
  : '## 30-minute production soak\n\nNo explicit soak result and verifier receipt were supplied. The soak was not used for qualification.';

const r10Body = r10 ? `## R10 two-hour instrumentation result\n\nRecorded result: **${passLabel(r10.passed)}**. Offline verification: **${r10Verified ? 'PASS' : 'FAIL'}**.\n\n- Viable candidates: **${r10Metrics?.candidates ?? 'not available'}**; required at least 20.\n- Terminal coverage: **${percent(r10Metrics?.terminalCoverage)}**; required 100%.\n- Diagnostic scheduling / valid coverage: **${percent(r10Metrics?.diagnosticSchedulingCoverage)} / ${percent(r10Metrics?.validDiagnosticCoverage)}**.\n- True exchange-book freshness: **${percent(r10Metrics?.freshConfirmationRate)}**.\n- Ready candidates: **${r10Metrics?.readyCandidates ?? 'not available'}**.\n\n${r10ReceiptCheck?.failures.length ? `Receipt integrity failures: ${r10ReceiptCheck.failures.join('; ')}.` : Array.isArray(r10Receipt?.failures) && r10Receipt.failures.length ? `Verifier failures: ${r10Receipt.failures.join('; ')}.` : 'No r10 verifier failures were recorded.'}`
  : `## R10 two-hour instrumentation result\n\nR10 was not run or no explicit verified inputs were supplied. It remains locked.\n\n${r3Events.length ? `Historical prerequisite evidence: ${r3HashChainValid ? 'valid hash chain' : 'invalid hash chain'} across ${r3Events.length} events; terminal reason: ${r3Invalidation?.payload?.reason ?? 'not recorded'}.` : 'No historical r3 input was used.'}`;

const verificationBody = verification
  ? `## Build and test verification\n\n- Test files / tests: **${verification.testFilesPassed ?? 'not available'} / ${verification.testsPassed ?? 'not available'}**.\n- Type-checks: **${verification.typechecksPassed === true ? 'passed' : 'not proven'}**.\n- Production build: **${verification.productionBuildPassed === true ? 'passed' : 'not proven'}**.\n- Diff and r9 checks: **${verification.diffChecksPassed === true ? 'passed' : 'not proven'} / verified**.`
  : `## Build and test verification\n\nThe immutable r9 ledger hash was independently verified as \`${actualR9Hash}\`. No explicit build-verification summary was supplied.`;

const charts = [{
  id: 'decision_status_chart', title: 'Evidence-gate status', subtitle: 'Every prior gate must pass before seven-hour monitoring', type: 'bar', dataset: 'decision_status', sourceId: 'readiness_receipt',
  source: { query: { sql: `SELECT * FROM (VALUES ${decisionStatusRows.map((row) => `('${row.gate.replaceAll("'", "''")}', ${row.complete})`).join(', ')}) AS evidence_status(gate, complete)` } },
  valueFormat: 'percent', encodings: { x: { field: 'gate', type: 'ordinal', label: 'Gate' }, y: { field: 'complete', type: 'quantitative', label: 'Complete' } }, layout: 'full',
}];
const blocks = [
  { id: 'title', type: 'markdown', body: '# NEMESIS Feed Hardening, Soak, and R10 Review' },
  { id: 'decision', type: 'markdown', body: decisionBody },
  { id: 'status', type: 'markdown', body: `## Status at a glance\n\n- State: **${reportState.replaceAll('_', ' ')}**.\n- Readiness: **${passLabel(readinessPassed)}**.\n- Soak: **${soak ? passLabel(soakPassed) : 'NOT RUN'}**.\n- R10: **${r10 ? passLabel(r10Passed) : 'NOT RUN'}**.\n- Seven-hour campaign: **${sevenHourUnlocked ? 'UNLOCKED FOR SEPARATE EVIDENCE RUN' : 'LOCKED'}**.` },
  { id: 'decision_status', type: 'chart', chartId: 'decision_status_chart', layout: 'full' },
  { id: 'verification', type: 'markdown', body: verificationBody },
  { id: 'readiness', type: 'markdown', sourceId: 'readiness_receipt', body: readinessBody },
  { id: 'soak', type: 'markdown', sourceId: soak ? 'soak_result' : undefined, body: soakBody },
];

if (coverageRows.length) {
  charts.push({
    id: 'soak_coverage_chart', title: 'Scored soak evidence coverage', subtitle: 'Runtime requires 99%; feeds and bridge require 99.5%', type: 'bar', dataset: 'soak_coverage', sourceId: 'soak_result',
    source: { query: { sql: `SELECT * FROM (VALUES ${coverageRows.map((row) => `('${row.metric.replaceAll("'", "''")}', ${row.coverage}, ${row.threshold}, '${row.result}')`).join(', ')}) AS soak_coverage(metric, coverage, threshold, result)` } },
    valueFormat: 'percent', encodings: { x: { field: 'metric', type: 'ordinal', label: 'Stream' }, y: { field: 'coverage', type: 'quantitative', label: 'Coverage' } }, layout: 'full',
  });
  blocks.push({ id: 'soak_coverage', type: 'chart', chartId: 'soak_coverage_chart', layout: 'full' });
}
blocks.push({ id: 'r10', type: 'markdown', sourceId: r10 ? 'r10_result' : undefined, body: r10Body });
if (r10FunnelRows.length) {
  charts.push({
    id: 'r10_funnel_chart', title: 'R10 evidence funnel', subtitle: 'Counts from the explicit finalized result', type: 'bar', dataset: 'r10_funnel', sourceId: 'r10_result',
    source: { query: { sql: `SELECT * FROM (VALUES ${r10FunnelRows.map((row) => `('${row.stage.replaceAll("'", "''")}', ${row.count})`).join(', ')}) AS r10_funnel(stage, count)` } },
    valueFormat: 'number', encodings: { x: { field: 'stage', type: 'ordinal', label: 'Stage' }, y: { field: 'count', type: 'quantitative', label: 'Count' } }, layout: 'full',
  });
  blocks.push({ id: 'r10_funnel', type: 'chart', chartId: 'r10_funnel_chart', layout: 'full' });
}
blocks.push(
  { id: 'controls', type: 'markdown', body: '## Controls now enforced\n\nTyped transport failures, production-only provenance, exact 25-market tracking, current-generation acknowledgements and exchange data, explicit yes-price orderbooks, bounded subscriptions, locked observation mode, immutable namespaces, hash-linked evidence, explicit input paths, and offline verification are now required. No profit, risk, freshness, memory, diagnostic, or safety threshold was lowered.' },
  { id: 'next', type: 'markdown', body: sevenHourUnlocked
    ? '## Next action\n\nLaunch one separate seven-hour evidence namespace from the same verified artifact. Keep the 30-diagnostic and ready-candidate gates unchanged.'
    : !readinessPassed
      ? '## Next action\n\nRestore authorized production connectivity, then repeat the timer-free readiness gate from the exact frozen artifact. Do not start a soak on a failed network path.'
      : !soakPassed
        ? '## Next action\n\nRun a new five-minute warm-up plus 30 scored-minute soak only after readiness remains clean. Independently verify it before r10.'
        : '## Next action\n\nRun one fixed two-hour r10 with no recovery namespace. A failure is final.' },
  { id: 'limits', type: 'markdown', body: '## Limits\n\nA readiness or soak pass proves evidence quality and runtime stability, not profitability. Live capital remains locked behind all existing shadow, pilot, profit, drawdown, concentration, and safety gates.' },
);

const sources = [
  { id: 'r9_ledger', label: 'Immutable r9 campaign ledger', path: inputs['r9-ledger'] },
  { id: 'readiness_receipt', label: 'Explicit production readiness receipt', path: inputs['readiness-receipt'] },
  ...(soak ? [{ id: 'soak_result', label: 'Explicit soak result and verification receipt', path: inputs['soak-result'] }] : []),
  ...(r10 ? [{ id: 'r10_result', label: 'Explicit r10 result and verification receipt', path: inputs['r10-result'] }] : []),
  ...(inputs['verification-summary'] ? [{ id: 'verification', label: 'Explicit build and test verification summary', path: inputs['verification-summary'] }] : []),
  { id: 'notes', label: 'Evidence inventory and generation notes', path: path.join(outputDir, 'source-notes.md') },
];

const artifact = {
  surface: 'report',
  manifest: {
    version: 1, surface: 'report', title: 'NEMESIS Feed Hardening, Soak, and R10 Review',
    description: 'Verified readiness, production-soak, and fixed r10 decision report generated only from explicit evidence inputs.', generatedAt,
    filters: [], cards: [], charts, tables: [], sources, blocks,
  },
  snapshot: { version: 1, generatedAt, status: 'ready', datasets: { decision_status: decisionStatusRows, soak_coverage: coverageRows, r10_funnel: r10FunnelRows }, accessIssues: [] },
  sources,
};

const inventory = {
  generatedAt, reportState, sevenHourUnlocked,
  r9: { path: inputs['r9-ledger'], sha256: actualR9Hash, verified: true },
  readiness: { path: inputs['readiness-receipt'], passed: readinessPassed, timerStarted: readiness.timerStarted, sha256: sha256File(inputs['readiness-receipt']) },
  soak: soak ? { path: inputs['soak-result'], recordedPassed: soak.passed === true, receiptIntegrity: soakReceiptCheck.valid, verifierPassed: soakReceipt.verified === true, qualifiedPass: soakPassed, sha256: sha256File(inputs['soak-result']) } : null,
  r10: r10 ? { path: inputs['r10-result'], recordedPassed: r10.passed === true, receiptIntegrity: r10ReceiptCheck.valid, verifierPassed: r10Receipt.verified === true, qualifiedPass: r10Passed, sha256: sha256File(inputs['r10-result']) } : null,
  r3: inputs['r3-ledger'] ? { path: inputs['r3-ledger'], eventCount: r3Events.length, hashChainValid: r3HashChainValid } : null,
};

const notes = `# NEMESIS report-generation notes\n\nGenerated: ${generatedAt}\n\n- Every input path was supplied explicitly; no evidence directory was scanned.\n- The immutable r9 SHA-256 is ${actualR9Hash}.\n- Readiness: ${passLabel(readinessPassed)}; timer started: no.\n- Soak qualified pass: ${soakPassed ? 'yes' : 'no or not run'}.\n- R10 qualified pass: ${r10Passed ? 'yes' : 'no or not run'}.\n- Seven-hour unlock: ${sevenHourUnlocked ? 'yes' : 'no'}.\n- Existing evidence and reports were not overwritten.\n`;

writeNew(path.join(outputDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`);
writeNew(path.join(outputDir, 'evidence-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`);
writeNew(path.join(outputDir, 'source-notes.md'), notes);
process.stdout.write(`${JSON.stringify({ outputDir, reportState, readinessPassed, soakPassed, r10Passed, sevenHourUnlocked }, null, 2)}\n`);
