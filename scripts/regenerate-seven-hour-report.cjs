const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(repoRoot, '..', '..');
const sourceDir = path.join(workspaceRoot, 'output', 'reports', 'nemesis-actual-next-steps-2026-07-14');
const outputDir = path.join(workspaceRoot, 'output', 'reports', 'nemesis-actual-next-steps-7-hour-2026-07-14');
const sourceHtmlPath = path.join(sourceDir, 'NEMESIS_Actual_Next_Steps_Decision_Report_2026-07-14.html');
const outputHtmlPath = path.join(outputDir, 'NEMESIS_Actual_Next_Steps_7-Hour_Campaign_Plan_2026-07-14.html');
const generatedAt = '2026-07-14T23:15:00-07:00';

function assertWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`unsafe output path: ${candidate}`);
}

function replaceExactly(text, from, to, expectedCount = 1) {
  const count = text.split(from).length - 1;
  if (count !== expectedCount) throw new Error(`expected ${expectedCount} occurrence(s), found ${count}: ${from.slice(0, 100)}`);
  return text.split(from).join(to);
}

assertWithin(path.join(workspaceRoot, 'output', 'reports'), outputDir);
fs.mkdirSync(outputDir, { recursive: true });

const sourceArtifact = JSON.parse(fs.readFileSync(path.join(sourceDir, 'artifact.json'), 'utf8'));
const artifact = structuredClone(sourceArtifact);
artifact.manifest.title = 'NEMESIS: Seven-Hour Next-Step Plan';
artifact.manifest.description = 'An implementation-ready seven-hour campaign plan that preserves the completed 10-hour review as historical evidence.';
artifact.manifest.generatedAt = generatedAt;
artifact.snapshot.generatedAt = generatedAt;

const blocks = Object.fromEntries(artifact.manifest.blocks.map((block) => [block.id, block]));
blocks.title.body = '# NEMESIS: Seven-Hour Next-Step Plan';
blocks.executive_summary.body = `## Executive Summary

- **Do not expand NEMESIS yet.** The 10-hour run proved that scanning, persistence, accounting, and fail-closed controls work. It did not produce one scored trade outcome, so there is no financial evidence to optimize.
- **The next sprint is an evidence-path repair.** Correct exchange price, fill, quantity, and fee handling; enroll viable candidates in diagnostic follow-up before confirmation; and give pending candidates a worker that owns them until pass, reject, or expiry. Do not lower the $1 target, the reward/risk gate, the $10 risk cap, or any live guardrail to manufacture activity.
- **Re-run in two gates.** First pass a two-hour instrumentation check. Then run one new fixed-cutoff seven-hour campaign: enroll through T+6:45, use the final 15 minutes only for scheduled follow-ups, and stop at T+7:00. Require at least 30 valid diagnostic outcomes, complete terminal states, trustworthy exchange timestamps, healthy ledgers, and at least one ready candidate. Do not extend a failed seven-hour run.
- **Treat the strategy brief as a later backlog.** Log honest scores as outcomes arrive, but do not fit calibration, true portfolio Kelly sizing, adaptive weights, or new discovery modules until their specific data requirements are met. The current live-unlock bar remains 100 completed positions, four consecutive profitable weeks, and every existing safety and quality gate.`;
blocks.implementation_heading.body = `## Build in this order

Plan on roughly 2-3 engineering weeks before prospective qualification, then one two-hour instrumentation run, one seven-hour campaign, 3-7+ days of unchanged shadow proof, the existing $10-risk pilot, and at least four weeks to satisfy the formal live-unlock rule. That estimate assumes no exchange-schema surprise and no confirmed renderer leak. Preserve the current 25-commit-ahead baseline and put an off-machine safety copy on an explicitly authorized branch before touching the confirmation path. Freeze configuration per run and never mix evidence across code, schema, strategy, or threshold changes.`;
blocks.implementation_table.body = `### Sequenced plan

0. **Freeze the baseline - 0.5-1 day.** Exit: reproducible \`e1a396a\` baseline, authorized off-machine safety copy, clean build/test/smoke, and archived ledgers.
1. **Make exchange math current - 2-4 days.** Exit: official fee examples pass; unknown rules fail closed; fills reconcile; explicit quantity stays under the safe limit.
2. **Build diagnostic outcomes and persistent confirmation - 3-5 days.** Exit: one restart-safe terminal lifecycle per candidate without rediscovery or duplicates.
3. **Persist provenance, bridge health, and memory evidence - 1-3 days.** Exit: attributable rows, truthful bridge state, bounded queues, and stable renderer memory.
4. **Run the two-hour instrumentation gate.** Exit: every instrumentation requirement below passes.
5. **Run one seven-hour fixed-cutoff campaign.** Exit: at least 30 valid diagnostics, at least one ready candidate, and decision-usable evidence at T+7:00.
6. **Complete unchanged shadow proof - 3-7+ calendar days.** Exit: existing shadow profitability, stress, and concentration thresholds pass.
7. **Pilot and formal qualification - at least four weeks after engineering.** Exit: 100 completed positions, four consecutive profitable weeks, PF at least 1.50, win rate at least 65%, and every current safety gate. Model challengers remain separate until their own data requirements are met.`;
blocks.campaign_gates.body = `## Gates for the next campaign

### Two-hour instrumentation check

1. Enroll at least 20 unique economically viable candidates; otherwise extend only this instrumentation check without changing thresholds. Every enrolled candidate reaches one explicit terminal confirmation state: ready, rejected with a durable reason, or expired. Terminal coverage must be 100%, with zero orphaned pending state.
2. At least 95% receive a scheduled diagnostic follow-up independent of qualification status, and at least 90% produce a valid executable 15-minute observation. Missing prices carry an explicit reason and retry history.
3. At least 95% of confirmation samples use a valid exchange book timestamp no older than one second. Do not accept a local \`Date.now()\` value as proof of source freshness.
4. Qualification and strategy ledgers replay cleanly; there are zero blocking safety failures, zero duplicate lifecycle transitions, and zero paper mutations while the stage is shadow.
5. Renderer memory stabilizes after warm-up. If it remains monotonic, reduce full-state broadcasts and fix the retaining path before continuing.

### Seven-hour fixed-cutoff campaign

1. Freeze commit, configuration, schema, thresholds, and evidence namespace before T+0:00. Any code or configuration change invalidates the run and requires a new namespace.
2. Enroll new candidates from T+0:00 through T+6:45. Use T+6:45 through T+7:00 only to finish follow-ups already scheduled.
3. Take read-only checkpoints at T+2:00 and T+5:00. Stop at T+7:00; unresolved candidates and diagnostics become explicit expired or insufficient-evidence outcomes.
4. Score at least 30 valid diagnostic 15-minute outcomes. This proves measurement capacity; it does not prove profitability.
5. Every candidate has complete provenance, sample history, exchange timestamps, executable fill/fee reconstruction, and exactly one terminal reason.
6. At least 95% of confirmation samples satisfy true exchange-book freshness. Existing safety, ledger, hash-chain, duplicate-lifecycle, and runtime-stability checks remain clean.
7. At least one candidate reaches \`ready\` without any shadow paper mutation.
8. If the run has fewer than 30 diagnostics or zero ready candidates, classify it as failed and diagnose identity, freshness, scheduling, and mathematical feasibility. Do not extend the seven-hour run or loosen thresholds.`;

const phaseFive = artifact.snapshot.datasets.implementation_plan.find((row) => row.phase === 5);
if (!phaseFive) throw new Error('implementation phase 5 missing');
phaseFive.work = 'Run one seven-hour fixed-cutoff campaign';
phaseFive.primary_targets = 'T+0:00 to T+6:45 enrollment, final follow-up window, at least 30 valid diagnostics, and at least one ready candidate';
phaseFive.effort = '7-hour run plus 0.5-day review';
phaseFive.exit_gate = 'Pass at T+7:00 with complete provenance and clean safety/runtime evidence; otherwise fail without extension';

if (JSON.stringify(blocks.confirmation_chart_static) !== JSON.stringify(
  sourceArtifact.manifest.blocks.find((block) => block.id === 'confirmation_chart_static'),
)) throw new Error('historical confirmation chart changed');
if (JSON.stringify(artifact.snapshot.datasets.confirmation_samples) !== JSON.stringify(sourceArtifact.snapshot.datasets.confirmation_samples)) {
  throw new Error('historical confirmation distribution changed');
}
const allowedBlockChanges = new Set(['title', 'executive_summary', 'implementation_heading', 'implementation_table', 'campaign_gates']);
for (const sourceBlock of sourceArtifact.manifest.blocks) {
  if (allowedBlockChanges.has(sourceBlock.id)) continue;
  const revisedBlock = artifact.manifest.blocks.find((block) => block.id === sourceBlock.id);
  if (JSON.stringify(revisedBlock) !== JSON.stringify(sourceBlock)) {
    throw new Error(`unrelated report block changed: ${sourceBlock.id}`);
  }
}
for (const key of ['charts', 'tables', 'sources', 'filters', 'cards']) {
  if (JSON.stringify(artifact.manifest[key]) !== JSON.stringify(sourceArtifact.manifest[key])) {
    throw new Error(`unrelated manifest structure changed: ${key}`);
  }
}
for (const datasetName of ['confirmation_samples', 'strategy_decisions']) {
  if (JSON.stringify(artifact.snapshot.datasets[datasetName]) !== JSON.stringify(sourceArtifact.snapshot.datasets[datasetName])) {
    throw new Error(`unrelated dataset changed: ${datasetName}`);
  }
}
const sourceNonPhaseFive = sourceArtifact.snapshot.datasets.implementation_plan.filter((row) => row.phase !== 5);
const revisedNonPhaseFive = artifact.snapshot.datasets.implementation_plan.filter((row) => row.phase !== 5);
if (JSON.stringify(revisedNonPhaseFive) !== JSON.stringify(sourceNonPhaseFive)) {
  throw new Error('implementation rows outside phase five changed');
}
fs.writeFileSync(path.join(outputDir, 'artifact.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

for (const name of ['confirmation_samples.sql', 'strategy_decisions.sql']) {
  fs.copyFileSync(path.join(sourceDir, name), path.join(outputDir, name));
}

let implementationSql = fs.readFileSync(path.join(sourceDir, 'implementation_plan.sql'), 'utf8');
implementationSql = replaceExactly(implementationSql, "'Run new 10-hour fixed-cutoff shadow'", "'Run one seven-hour fixed-cutoff campaign'");
implementationSql = replaceExactly(implementationSql, "'10-hour run plus 0.5-day review'", "'7-hour run plus 0.5-day review'");
implementationSql = replaceExactly(
  implementationSql,
  "'At least 30 diagnostics and decision-usable evidence'",
  "'At least 30 valid diagnostics, at least one ready candidate, complete provenance, and a clean T+7:00 cutoff'",
);
fs.writeFileSync(path.join(outputDir, 'implementation_plan.sql'), implementationSql, 'utf8');

let sourceNotes = fs.readFileSync(path.join(sourceDir, 'source-notes.md'), 'utf8');
sourceNotes = replaceExactly(sourceNotes, '# Source notes: NEMESIS actual next steps', '# Source notes: NEMESIS seven-hour next-step plan');
sourceNotes = replaceExactly(
  sourceNotes,
  'then run a new fixed-cutoff 10-hour campaign in a fresh evidence namespace.',
  'then run one fixed-cutoff seven-hour campaign in a fresh evidence namespace, with enrollment ending at T+6:45 and a hard stop at T+7:00.',
);
sourceNotes = replaceExactly(sourceNotes, '- Title -> `NEMESIS: What to Do Next`.', '- Title -> `NEMESIS: Seven-Hour Next-Step Plan`.');
sourceNotes += `

## Revision scope

- The completed 10-hour monitoring run, its findings, chart, sources, caveats, and all historical references remain unchanged.
- Only the recommended future campaign, phase-five effort, acceptance gates, cutoff procedure, metadata, and dependent implementation query were revised.
- The future campaign remains fail-closed at 30 valid diagnostics and at least one ready candidate; thresholds are not lowered and a failed run is not extended.
`;
fs.writeFileSync(path.join(outputDir, 'source-notes.md'), sourceNotes, 'utf8');

let html = fs.readFileSync(sourceHtmlPath, 'utf8');
const oldCampaignGateHtml = '<h3>New 10-hour fixed-cutoff shadow</h3>\n<ol><li>Score at least 30 valid diagnostic 15-minute outcomes. This proves measurement capacity; it does not prove profitability.</li><li>Every confirmation candidate has complete provenance, sample history, exchange timestamps, executable fill/fee reconstruction, and a terminal reason.</li><li>Modeled targets stay separate from observed follow-up returns and eventual settlement outcomes. Profit factor, win rate, drawdown, and calibration error use only the label they actually measure.</li><li>Existing safety, hash-chain, and no-live-mutation checks remain clean. Use a new evidence namespace for this exact frozen configuration.</li><li>If the run has fewer than 30 diagnostics or zero ready candidates, stop and diagnose identity, freshness, scheduling, and mathematical feasibility. Do not loosen thresholds to force a pass.</li></ol>';
const newCampaignGateHtml = '<h3 style="break-before:page;page-break-before:always">Seven-hour fixed-cutoff campaign</h3>\n<ol><li>Freeze commit, configuration, schema, thresholds, and evidence namespace before T+0:00. Any code or configuration change invalidates the run and requires a new namespace.</li><li>Enroll new candidates from T+0:00 through T+6:45. Use T+6:45 through T+7:00 only to finish follow-ups already scheduled.</li><li>Take read-only checkpoints at T+2:00 and T+5:00. Stop at T+7:00; unresolved candidates and diagnostics become explicit expired or insufficient-evidence outcomes.</li><li>Score at least 30 valid diagnostic 15-minute outcomes. This proves measurement capacity; it does not prove profitability.</li><li>Every candidate has complete provenance, sample history, exchange timestamps, executable fill/fee reconstruction, and exactly one terminal reason.</li><li>At least 95% of confirmation samples satisfy true exchange-book freshness. Existing safety, ledger, hash-chain, duplicate-lifecycle, and runtime-stability checks remain clean.</li><li>At least one candidate reaches <code>ready</code> without any shadow paper mutation.</li><li>If the run has fewer than 30 diagnostics or zero ready candidates, classify it as failed. Do not extend the seven-hour run or loosen thresholds.</li></ol>';
html = replaceExactly(html, oldCampaignGateHtml, newCampaignGateHtml);
html = replaceExactly(
  html,
  '</head>',
  '<style>@media print{.portable-sources{display:block!important;break-before:page;page-break-before:always}}</style></head>',
);
html = replaceExactly(html, '<title>NEMESIS: What to Do Next</title>', '<title>NEMESIS: Seven-Hour Next-Step Plan</title>');
html = replaceExactly(html, '<h1>NEMESIS: What to Do Next</h1>', '<h1>NEMESIS: Seven-Hour Next-Step Plan</h1>');
html = replaceExactly(
  html,
  'A decision-ready review of the July 14 monitoring campaign and next-generation strategy brief.',
  'An implementation-ready seven-hour campaign plan that preserves the completed 10-hour review as historical evidence.',
);
html = replaceExactly(html, '2026-07-14T21:58:50-07:00', generatedAt);
html = replaceExactly(html, 'Jul 15, 2026, 4:58 AM UTC', 'Jul 15, 2026, 6:15 AM UTC');
html = replaceExactly(
  html,
  'Then run a new fixed-cutoff 10-hour shadow campaign. Require at least 30 valid diagnostic outcomes, complete terminal states, trustworthy exchange timestamps, healthy ledgers, and materially fewer stale-book failures before continuing.',
  'Then run one fixed-cutoff seven-hour campaign: enroll through T+6:45, reserve the final 15 minutes for scheduled follow-ups, and stop at T+7:00. Require at least 30 valid diagnostics, complete terminal states, trustworthy exchange timestamps, healthy ledgers, and at least one ready candidate. Do not extend a failed seven-hour run.',
);
html = replaceExactly(
  html,
  'Plan on roughly 2-3 engineering weeks before prospective qualification, then at least four weeks to satisfy the existing time-based live-unlock rule.',
  'Plan on roughly 2-3 engineering weeks before prospective qualification, then one two-hour instrumentation run, one seven-hour campaign, 3-7+ days of unchanged shadow proof, the existing $10-risk pilot, and at least four weeks to satisfy the formal live-unlock rule.',
);
html = replaceExactly(
  html,
  '<li><strong>Run a new 10-hour fixed-cutoff shadow.</strong> Exit: at least 30 diagnostics and decision-usable evidence.</li>',
  '<li><strong>Run one seven-hour fixed-cutoff campaign.</strong> Exit: at least 30 valid diagnostics, at least one ready candidate, and decision-usable evidence at T+7:00.</li>',
);
if (html.includes('new fixed-cutoff 10-hour') || html.includes('new 10-hour fixed-cutoff') || html.includes('New 10-hour fixed-cutoff')) {
  throw new Error('future 10-hour campaign reference remains in HTML');
}
if (!html.includes('Source: NEMESIS Post 10-Hour Monitoring Review, July 14, 2026.')) {
  throw new Error('historical 10-hour chart source was lost');
}
fs.writeFileSync(outputHtmlPath, html, 'utf8');

console.log(JSON.stringify({ outputDir, outputHtmlPath, generatedAt }, null, 2));
