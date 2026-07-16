const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..', '..');
const outputDir = path.join(workspaceRoot, 'output', 'reports', 'nemesis-gap-closure-r10-2026-07-15');
const soakDir = path.join(outputDir, 'soak');
const soakAttemptsDir = path.join(outputDir, 'soak-attempts');
const soakResultPath = path.join(soakDir, 'production-soak-result.json');
const soakSamplesPath = path.join(soakDir, 'production-soak-samples.jsonl');
const campaignDir = path.join(process.env.APPDATA ?? '', '@nemesis', 'desktop', 'nemesis-data', 'evidence-campaigns');
const r9Path = path.join(campaignDir, 'nemesis-instrumentation-2026-07-15-r9.jsonl');
const r3RunId = 'nemesis-instrumentation-2026-07-15-r3';
const r3Path = path.join(campaignDir, `${r3RunId}.jsonl`);
const r10RunId = 'nemesis-instrumentation-2026-07-15-r10';
const r10ResultPath = path.join(campaignDir, `${r10RunId}.result.json`);
const expectedR9Hash = '7c93e9beafe8ec7af52f7483942f3edccff24e18aeab3f0c209b39cfe4c015ff';
const generatedAt = new Date().toISOString();

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function percent(value) {
  return value != null && value !== '' && Number.isFinite(Number(value))
    ? `${(Number(value) * 100).toFixed(2)}%`
    : 'not available';
}

function number(value, digits = 3) {
  return value != null && value !== '' && Number.isFinite(Number(value))
    ? Number(value).toFixed(digits)
    : 'not available';
}

function passLabel(value) {
  return value === true ? 'PASS' : 'FAIL';
}

function source(id, label, sourcePath) {
  return { id, label, path: sourcePath };
}

fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(r9Path)) throw new Error(`preserved r9 ledger is missing: ${r9Path}`);
const actualR9Hash = sha256File(r9Path);
if (actualR9Hash !== expectedR9Hash) {
  throw new Error(`preserved r9 ledger hash mismatch: expected ${expectedR9Hash}, found ${actualR9Hash}`);
}

const soak = readJson(soakResultPath);
const soakSamples = fs.existsSync(soakSamplesPath)
  ? fs.readFileSync(soakSamplesPath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  : [];
const r10 = readJson(r10ResultPath);
const r3Events = readJsonl(r3Path);
let r3HashChainValid = r3Events.length > 0;
let r3PreviousHash = 'GENESIS';
for (const event of r3Events) {
  const unsigned = { ...event };
  delete unsigned.hash;
  const expectedHash = crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
  if (event.previousHash !== r3PreviousHash || event.hash !== expectedHash) r3HashChainValid = false;
  r3PreviousHash = event.hash;
}
const r3Invalidation = r3Events.find((event) => event.type === 'run_invalidated');
const verification = readJson(path.join(outputDir, 'verification-summary.json'));
const soakPassed = soak?.passed === true;
const r10Passed = r10?.passed === true;
const sevenHourUnlocked = soakPassed && r10Passed;
const reportState = !soakPassed
  ? 'soak_failed_r10_not_run'
  : !r10
    ? 'soak_passed_r10_not_run'
    : r10Passed
      ? 'soak_and_r10_passed'
      : 'soak_passed_r10_failed';

const scoredSoakSamples = soakSamples.filter((sample) => sample.phase === 'scored');
const soakAttempts = fs.existsSync(soakAttemptsDir)
  ? fs.readdirSync(soakAttemptsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const resultPath = path.join(soakAttemptsDir, entry.name, 'production-soak-result.json');
      const result = readJson(resultPath);
      return result ? { namespace: entry.name, ...result } : null;
    })
    .filter(Boolean)
  : [];
const attemptSummary = soakAttempts.length > 0
  ? `Archived attempts: ${soakAttempts.map((attempt) => `${attempt.attemptId ?? attempt.namespace}=${passLabel(attempt.passed)}`).join(', ')}.`
  : 'No additional archived soak attempt result was present.';
const expectedScoredSamples = soak ? Math.floor((Number(soak.scoredDurationMinutes) * 60) / Number(soak.sampleIntervalSeconds)) + 1 : 0;
const derivedCoverage = expectedScoredSamples > 0 ? {
  renderer: Math.min(1, scoredSoakSamples.filter((sample) => sample.rendererWorkingSetMb != null).length / expectedScoredSamples),
  gea: Math.min(1, scoredSoakSamples.filter((sample) => Number(sample.geaCount) > 0).length / expectedScoredSamples),
  runtime: Math.min(1, scoredSoakSamples.filter((sample) => sample.externalStatusAgeMs != null && Number(sample.externalStatusAgeMs) <= 60_000).length / expectedScoredSamples),
  feeds: Math.min(1, scoredSoakSamples.filter((sample) => sample.feedQualificationReady === true).length / expectedScoredSamples),
  bridge: Math.min(1, scoredSoakSamples.filter((sample) => sample.bridgeQualificationReady === true).length / expectedScoredSamples),
} : null;
const coverageRows = soak && derivedCoverage ? [
  { metric: 'Renderer', coverage: derivedCoverage.renderer, threshold: 0.99, result: derivedCoverage.renderer >= 0.99 ? 'pass' : 'fail' },
  { metric: 'GEA', coverage: derivedCoverage.gea, threshold: 0.99, result: derivedCoverage.gea >= 0.99 ? 'pass' : 'fail' },
  { metric: 'Runtime status', coverage: derivedCoverage.runtime, threshold: 0.99, result: derivedCoverage.runtime >= 0.99 ? 'pass' : 'fail' },
  { metric: 'Feeds', coverage: derivedCoverage.feeds, threshold: 0.995, result: derivedCoverage.feeds >= 0.995 ? 'pass' : 'fail' },
  { metric: 'Authenticated bridge', coverage: derivedCoverage.bridge, threshold: 0.995, result: derivedCoverage.bridge >= 0.995 ? 'pass' : 'fail' },
] : [];

const r10Metrics = r10?.metrics ?? null;
const r10FunnelRows = r10Metrics ? [
  { stage: 'Enrolled candidates', count: Number(r10Metrics.candidates ?? 0) },
  { stage: 'Diagnostics scheduled', count: Math.round(Number(r10Metrics.candidates ?? 0) * Number(r10Metrics.diagnosticSchedulingCoverage ?? 0)) },
  { stage: 'Valid diagnostics', count: Number(r10Metrics.validDiagnosticOutcomes ?? 0) },
  { stage: 'Ready candidates', count: Number(r10Metrics.readyCandidates ?? 0) },
] : [];
const decisionStatusRows = [
  { gate: 'R9 preserved', complete: 1 },
  { gate: 'Official soak passed', complete: soakPassed ? 1 : 0 },
  { gate: 'R10 passed', complete: r10Passed ? 1 : 0 },
  { gate: 'Seven-hour unlocked', complete: sevenHourUnlocked ? 1 : 0 },
];

const decisionBody = sevenHourUnlocked
  ? `## Decision\n\n**R10 passed every gate.** The unchanged frozen build is eligible to proceed to the separate seven-hour evidence campaign. This is not a live-trading approval; the 30-diagnostic, ready-candidate, safety, profit, shadow, pilot, and formal qualification gates remain unchanged.`
  : `## Decision\n\n**Do not start the seven-hour campaign.** ${!soakPassed
    ? 'The required production soak did not pass, so r10 remains locked.'
    : !r10
      ? 'The production soak passed, but r10 has not produced a finalized result.'
      : `R10 failed: ${Array.isArray(r10.reasons) && r10.reasons.length > 0 ? r10.reasons.join('; ') : 'one or more required gates did not pass'}.`} Preserve the evidence and repair the named failure without extending, splicing, or lowering thresholds.`;

const soakBody = soak ? `## 30-minute production soak\n\nResult: **${passLabel(soak.passed)}**. The process ran for ${number(soak.actualWarmupMinutes, 2)} warm-up minutes plus ${number(soak.actualScoredDurationMinutes, 2)} scored minutes. The 30-minute slope window was ${soak.slopeWindowComplete ? 'complete' : 'incomplete'} (${number(Number(soak.slopeWindowMs) / 60000, 2)} minutes).\n\n${attemptSummary}\n\n- Renderer p95: **${number(soak.rendererP95Mb, 2)} MB**; limit 384 MB.\n- Renderer maximum: **${number(soak.rendererMaxMb, 2)} MB**; limit 512 MB.\n- Maximum rolling ten-minute growth: **${percent(soak.rendererTenMinuteGrowthMax)}**; limit 10%.\n- Runner slope: **${soak.slopeWindowComplete ? `${percent(soak.rendererSlopePerHour)} per hour` : 'not evaluated'}**; limit 2%.\n- Runtime slope: **${soak.slopeWindowComplete ? `${percent(soak.runtimeRendererSlopePerHour)} per hour` : 'not evaluated'}**; limit 2%.\n- Restarts / emergency mitigations / invalidations: **${soak.processRestartCount ?? 'n/a'} / ${soak.emergencyMitigationCount ?? 'n/a'} / ${soak.runtimeInvalidatedSampleCount ?? 'n/a'}**.\n- Frozen artifact remained identical: **${soak.matchingArtifactHashes === true ? 'yes' : 'no'}**. Clean shutdown: **${soak.cleanShutdown === true ? 'yes' : 'no'}**.\n\n${Array.isArray(soak.acceptanceFailures) && soak.acceptanceFailures.length > 0 ? `Failure reasons: ${soak.acceptanceFailures.join('; ')}.` : 'No soak acceptance failures were recorded.'}`
  : '## 30-minute production soak\n\nNo finalized official soak result was found. R10 remains locked.';

const r10Body = r10 ? `## R10 two-hour instrumentation result\n\nResult: **${passLabel(r10.passed)}**.\n\n- Economically viable candidates: **${r10Metrics?.candidates ?? 'n/a'}**; required at least 20.\n- Terminal lifecycle coverage: **${percent(r10Metrics?.terminalCoverage)}**; required 100%.\n- Diagnostic scheduling coverage: **${percent(r10Metrics?.diagnosticSchedulingCoverage)}**; required at least 95%.\n- Valid diagnostic coverage: **${percent(r10Metrics?.validDiagnosticCoverage)}**; required at least 90%.\n- Valid diagnostic outcomes: **${r10Metrics?.validDiagnosticOutcomes ?? 'n/a'}**.\n- True exchange-book freshness: **${percent(r10Metrics?.freshConfirmationRate)}**; required at least 95%.\n- Ready candidates: **${r10Metrics?.readyCandidates ?? 'n/a'}**.\n- Healthy runtime samples: **${r10Metrics?.runtimeHealthySamples ?? 'n/a'} / ${r10Metrics?.runtimeObservedSamples ?? 'n/a'}**.\n\n${Array.isArray(r10.reasons) && r10.reasons.length > 0 ? `Failure reasons: ${r10.reasons.join('; ')}.` : 'No r10 gate failures were recorded.'}`
  : `## R10 two-hour instrumentation result\n\nR10 was not run because no eligible finalized soak result was available, or it has not yet finalized.\n\n- Two-hour prerequisite ${r3RunId}: **${r3Invalidation ? 'FAIL / INVALIDATED' : 'not finalized'}**.\n- Prerequisite hash chain: **${r3HashChainValid ? 'valid' : 'not proven'}** across ${r3Events.length} events.\n- Prerequisite terminal reason: **${r3Invalidation?.payload?.reason ?? 'not recorded'}**.`;

const verificationBody = verification
  ? `## Pre-run verification\n\n- Test files: **${verification.testFilesPassed ?? 'n/a'} passed**. Tests: **${verification.testsPassed ?? 'n/a'} passed**.\n- Type-checks: **${verification.typechecksPassed === true ? 'passed' : 'not proven'}**. Production builds: **${verification.productionBuildPassed === true ? 'passed' : 'not proven'}**.\n- Diff checks: **${verification.diffChecksPassed === true ? 'passed' : 'not proven'}**.\n- Preserved r9 hash: **verified**.\n- Frozen commit: \`${soak?.gitCommit ?? verification.gitCommit ?? 'not available'}\`.`
  : `## Pre-run verification\n\nThe preserved r9 ledger hash was verified as \`${actualR9Hash}\`. The separate verification summary was not present.`;

const charts = [{
  id: 'decision_status_chart',
  title: 'Evidence-gate status',
  subtitle: 'A downstream gate remains closed until every prior gate passes',
  type: 'bar',
  dataset: 'decision_status',
  sourceId: 'r9_ledger',
  source: { query: { sql: `SELECT * FROM (VALUES ('R9 preserved', ${decisionStatusRows[0].complete}), ('Official soak passed', ${decisionStatusRows[1].complete}), ('R10 passed', ${decisionStatusRows[2].complete}), ('Seven-hour unlocked', ${decisionStatusRows[3].complete})) AS evidence_status(gate, complete)` } },
  valueFormat: 'percent',
  encodings: {
    x: { field: 'gate', type: 'ordinal', label: 'Gate' },
    y: { field: 'complete', type: 'quantitative', label: 'Complete' },
  },
  layout: 'full',
}];
const blocks = [
  { id: 'title', type: 'markdown', body: '# NEMESIS R9 Gap Closure and R10 Two-Hour Monitoring Review' },
  { id: 'decision', type: 'markdown', body: decisionBody },
  { id: 'status', type: 'markdown', body: `## Status at a glance\n\n- Report state: **${reportState.replaceAll('_', ' ')}**.\n- Interrupted 28.56-minute attempt: **preserved as incomplete, never resumed or spliced**.\n- Official soak: **${soak ? passLabel(soak.passed) : 'NOT FINALIZED'}**.\n- R10: **${r10 ? passLabel(r10.passed) : 'NOT RUN / NOT FINALIZED'}**.\n- Seven-hour campaign: **${sevenHourUnlocked ? 'UNLOCKED FOR A SEPARATE EVIDENCE RUN' : 'LOCKED'}**.` },
  { id: 'decision_status', type: 'chart', chartId: 'decision_status_chart', layout: 'full' },
  { id: 'verification', type: 'markdown', body: verificationBody },
  { id: 'soak', type: 'markdown', sourceId: soak ? 'soak_result' : undefined, body: soakBody },
];

if (coverageRows.length > 0) {
  charts.push({
    id: 'soak_coverage_chart',
    title: 'Scored soak evidence coverage',
    subtitle: 'Runtime evidence requires 99%; feeds and authenticated bridge require 99.5%',
    type: 'bar',
    dataset: 'soak_coverage',
    sourceId: 'soak_result',
    source: { query: { sql: `SELECT * FROM (VALUES ${coverageRows.map((row) => `('${row.metric.replaceAll("'", "''")}', ${row.coverage}, ${row.threshold}, '${row.result}')`).join(', ')}) AS soak_coverage(metric, coverage, threshold, result)` } },
    valueFormat: 'percent',
    encodings: {
      x: { field: 'metric', type: 'ordinal', label: 'Evidence stream' },
      y: { field: 'coverage', type: 'quantitative', label: 'Coverage' },
      tooltip: [
        { field: 'threshold', type: 'quantitative', label: 'Required', format: 'percent' },
        { field: 'result', type: 'nominal', label: 'Gate' },
      ],
    },
    layout: 'full',
  });
  blocks.push({ id: 'soak_coverage', type: 'chart', chartId: 'soak_coverage_chart', layout: 'full' });
}

blocks.push({ id: 'r10', type: 'markdown', sourceId: r10 ? 'r10_result' : undefined, body: r10Body });
if (r10FunnelRows.length > 0) {
  charts.push({
    id: 'r10_funnel_chart',
    title: 'R10 evidence funnel',
    subtitle: 'Counts from the finalized schema-v2 result',
    type: 'bar',
    dataset: 'r10_funnel',
    sourceId: 'r10_result',
    source: { query: { sql: `SELECT * FROM (VALUES ${r10FunnelRows.map((row) => `('${row.stage.replaceAll("'", "''")}', ${row.count})`).join(', ')}) AS r10_funnel(stage, count)` } },
    valueFormat: 'number',
    encodings: {
      x: { field: 'stage', type: 'ordinal', label: 'Stage' },
      y: { field: 'count', type: 'quantitative', label: 'Count' },
    },
    layout: 'full',
  });
  blocks.push({ id: 'r10_funnel', type: 'chart', chartId: 'r10_funnel_chart', layout: 'full' });
}

blocks.push(
  { id: 'r9_fixes', type: 'markdown', sourceId: 'r9_ledger', body: `## What was fixed after r9\n\nThe schema-v2 implementation screens static and economic eligibility before enrollment, persists one restart-safe candidate lifecycle and one diagnostic, routes fresh orderbook deltas to due work, records typed failure outcomes, separates production/demo endpoint health, removes the retired host, supervises bridge round trips every five seconds, and keeps memory/feed/runtime health as expiring evidence rather than an early permanent pass. Profit, reward/risk, $10 risk, freshness, diagnostic, shadow, pilot, and live-unlock gates were not lowered.` },
  { id: 'next', type: 'markdown', body: sevenHourUnlocked
    ? `## Next action\n\nStart one new seven-hour evidence namespace from the same frozen artifact. Enroll only through T+6:45, close at T+7:00, require at least 30 valid diagnostics and one ready candidate, and preserve every existing safety and profit gate. A failed run is final; do not extend or splice it.`
    : `## Next action\n\nKeep the seven-hour campaign locked. Preserve this attempt, fix only the recorded failure class, rerun all verification required by policy, and create a fresh isolated namespace. Do not reuse samples, extend the clock, or reduce thresholds.` },
  { id: 'limits', type: 'markdown', body: `## Limits\n\nA passing soak proves runtime evidence quality, not profitability. A passing r10 proves the campaign can create trustworthy diagnostic evidence, not that NEMESIS is ready for live capital. Live qualification still requires the unchanged shadow proof, $10-risk pilot, 100 completed positions, four consecutive profitable weeks, profit factor at least 1.50, win rate at least 65%, and every current safety gate.` },
);

const sources = [
  source('r9_ledger', 'Preserved r9 schema-v1 campaign ledger and verified SHA-256', 'nemesis-instrumentation-2026-07-15-r9.jsonl'),
  ...(soak ? [source('soak_result', 'Official schema-v2 production soak result', 'soak/production-soak-result.json')] : []),
  ...(r10 ? [source('r10_result', 'Official schema-v2 r10 result', `${r10RunId}.result.json`)] : []),
  ...(r3Events.length > 0 ? [source('r3_prerequisite', 'Two-hour prerequisite r3 ledger and terminal result', `${r3RunId}.jsonl`)] : []),
  ...(soakAttempts.length > 0 ? [source('soak_attempts', 'Archived schema-v2 soak attempts', 'soak-attempts/')] : []),
  ...(verification ? [source('verification', 'Build, test, type-check, diff, and hash verification summary', 'verification-summary.json')] : []),
  source('notes', 'Evidence inventory and report-generation notes', 'source-notes.md'),
];

const artifact = {
  surface: 'report',
  manifest: {
    version: 1,
    surface: 'report',
    title: 'NEMESIS R9 Gap Closure and R10 Two-Hour Monitoring Review',
    description: 'Evidence-backed decision report for the 30-minute scored production soak and fixed two-hour r10 instrumentation run.',
    generatedAt,
    filters: [],
    cards: [],
    charts,
    tables: [],
    sources,
    blocks,
  },
  snapshot: {
    version: 1,
    generatedAt,
    status: 'ready',
    datasets: { decision_status: decisionStatusRows, soak_coverage: coverageRows, r10_funnel: r10FunnelRows },
    accessIssues: [],
  },
  sources,
};

const inventory = {
  generatedAt,
  reportState,
  r9: { path: r9Path, sha256: actualR9Hash, verified: true },
  soak: { path: soakResultPath, present: Boolean(soak), passed: soak?.passed ?? null, sha256: fs.existsSync(soakResultPath) ? sha256File(soakResultPath) : null },
  soakAttempts: soakAttempts.map((attempt) => ({ namespace: attempt.namespace, attemptId: attempt.attemptId ?? null, passed: attempt.passed ?? null })),
  r3: { runId: r3RunId, path: r3Path, present: r3Events.length > 0, eventCount: r3Events.length, hashChainValid: r3HashChainValid, terminalType: r3Events.at(-1)?.type ?? null, terminalReason: r3Invalidation?.payload?.reason ?? null },
  r10: { runId: r10RunId, path: r10ResultPath, present: Boolean(r10), passed: r10?.passed ?? null, sha256: fs.existsSync(r10ResultPath) ? sha256File(r10ResultPath) : null },
  sevenHourUnlocked,
};

const notes = `# NEMESIS r9 gap closure and r10 report notes\n\nGenerated: ${generatedAt}\n\n- The r9 ledger was read only and verified at SHA-256 ${actualR9Hash}.\n- The interrupted 28.56-minute attempt remains incomplete evidence and is excluded from qualification.\n- Soak state: ${soak ? passLabel(soak.passed) : 'not finalized'}.\n- Archived soak attempts: ${soakAttempts.length}.\n- R10 state: ${r10 ? passLabel(r10.passed) : 'not run or not finalized'}.\n- Two-hour prerequisite r3: ${r3Invalidation ? 'invalidated' : r3Events.length > 0 ? 'not invalidated' : 'not found'}; hash chain ${r3HashChainValid ? 'valid' : 'not proven'}.\n- Seven-hour unlock: ${sevenHourUnlocked ? 'yes' : 'no'}.\n- The report generator recommends the seven-hour campaign only when both the official soak and r10 have passed.\n- Existing reports and historical evidence are not overwritten.\n`;

fs.writeFileSync(path.join(outputDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'evidence-inventory.json'), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(outputDir, 'source-notes.md'), notes, 'utf8');
console.log(JSON.stringify({ outputDir, reportState, soakPassed, r10Passed, sevenHourUnlocked }, null, 2));
