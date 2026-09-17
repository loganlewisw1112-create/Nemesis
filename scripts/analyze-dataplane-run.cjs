#!/usr/bin/env node
/**
 * Data-plane run analyzer — the Phase 4.2 checkpoints as one command.
 *
 * The 2026-07-27 post-mortem needed ad-hoc node one-liners against four
 * different ledgers to establish that the orderbook socket had been dead for
 * 7.9 hours. That evidence should be one command, and the gates it is judged
 * against should be written down rather than re-argued each run.
 *
 * Usage (from the nemesis repo root):
 *   node scripts/analyze-dataplane-run.cjs [--cutoff <ms>] [--log-dir <dir>] [--json]
 *
 * With no arguments it reads `.nemesis-relaunch-cutoff.txt` for the cutoff and
 * the trace paths written by scripts/launch-paper-allowlist.ps1.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const args = process.argv.slice(2);

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

function readCutoffFile() {
  const cutoffPath = path.join(repoRoot, '.nemesis-relaunch-cutoff.txt');
  if (!fs.existsSync(cutoffPath)) return {};
  const parsed = {};
  for (const line of fs.readFileSync(cutoffPath, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/.exec(line.trim());
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}

/**
 * Chunked line reader. bridge-telemetry.jsonl reached 338MB on an 8h run, so
 * readFileSync would allocate the better part of a gigabyte before the first
 * filter runs. Bounded memory matters here: this script is meant to be safe to
 * run against a live, still-growing ledger mid-soak.
 */
function readJsonl(file, sinceMs) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(1 << 20);
  let carry = '';
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes <= 0) break;
      const chunk = carry + buffer.toString('utf8', 0, bytes);
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) collectJsonlRow(rows, line, sinceMs);
    }
    collectJsonlRow(rows, carry, sinceMs);
  } finally {
    fs.closeSync(fd);
  }
  return rows;
}

function collectJsonlRow(rows, line, sinceMs) {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const row = JSON.parse(trimmed);
    const at = row.at ?? row.t ?? null;
    if (sinceMs != null && at != null && at <= sinceMs) return;
    rows.push(row);
  } catch {
    rows.push({ __badJson: true });
  }
}

function appDataLedger(name) {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, '@nemesis', 'desktop', 'nemesis-data', name);
}

function tally(rows, key) {
  const counts = new Map();
  for (const row of rows) {
    const value = String(row[key] ?? 'undefined');
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function pct(part, whole) {
  return whole === 0 ? '0.0%' : `${((part / whole) * 100).toFixed(1)}%`;
}

function ms(value) {
  if (value == null || !Number.isFinite(value)) return 'n/a';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 90_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 5_400_000) return `${(value / 60_000).toFixed(1)}m`;
  return `${(value / 3_600_000).toFixed(2)}h`;
}

function iso(at) {
  return at == null ? 'n/a' : new Date(at).toISOString();
}

const cutoffFile = readCutoffFile();
const cutoffMs = Number(argValue('--cutoff') ?? cutoffFile.cutoffMs ?? 0) || null;
const logDir = argValue('--log-dir')
  ?? (cutoffFile.orderbookTracePath ? path.dirname(cutoffFile.orderbookTracePath) : null);

const orderbookTracePath = cutoffFile.orderbookTracePath
  ?? (logDir ? path.join(logDir, 'orderbook-stream-trace.jsonl') : null);
const priorityTracePath = cutoffFile.tracePath
  ?? (logDir ? path.join(logDir, 'priority-track-trace.jsonl') : null);
const connectorWarnPath = cutoffFile.connectorWarnPath
  ?? (logDir ? path.join(logDir, 'connector-warns.jsonl') : null);

const orderbook = readJsonl(orderbookTracePath, cutoffMs);
const priority = readJsonl(priorityTracePath, cutoffMs);
const warns = readJsonl(connectorWarnPath, cutoffMs);
const bridge = readJsonl(appDataLedger('bridge-telemetry.jsonl'), cutoffMs);
const validation = readJsonl(appDataLedger('paper-strategy-validation-events.jsonl'), cutoffMs);

// Shadow contamination: an entry taken while the data plane was latched
// degraded is a bad entry however cleanly it exits, and a mark taken during a
// degraded window is an untrustworthy mark. Read the WHOLE ledger, not just the
// post-cutoff slice -- the shadow gate accumulates across relaunches.
const wholeValidation = readJsonl(appDataLedger('paper-strategy-validation-events.jsonl'), null);
const shadowStarts = new Map();
for (const event of wholeValidation) {
  if (event.type === 'shadow_candidate_started' && event.candidate) {
    shadowStarts.set(event.candidate.id, event.candidate.dataPlaneDegraded === true);
  }
}
// Retroactive classification. The dataPlaneDegraded flag only exists going
// forward, so shadows scored before it shipped read as clean even when they
// were entered on a dead book. The orderbook trace is the authority on WHEN the
// data plane was degraded, so join against it: inside a degraded interval is
// contaminated, inside trace coverage but outside those intervals is clean, and
// outside coverage entirely is unclassified — never silently counted as clean.
const allTrace = readJsonl(orderbookTracePath, null);
const degradedIntervals = [];
let intervalStart = null;
let previousAt = null;
for (const row of allTrace) {
  if (row.dataPlaneDegraded === true && intervalStart == null) intervalStart = row.at;
  if (row.dataPlaneDegraded !== true && intervalStart != null) {
    degradedIntervals.push([intervalStart, previousAt ?? row.at]);
    intervalStart = null;
  }
  previousAt = row.at;
}
if (intervalStart != null && previousAt != null) degradedIntervals.push([intervalStart, previousAt]);
const traceFrom = allTrace.length > 0 ? allTrace[0].at : null;
const traceTo = allTrace.length > 0 ? allTrace[allTrace.length - 1].at : null;
const withinDegraded = (at) => degradedIntervals.some(([from, to]) => at >= from && at <= to);
const covered = (at) => traceFrom != null && at >= traceFrom && at <= traceTo;

const startAtById = new Map();
for (const event of wholeValidation) {
  if (event.type === 'shadow_candidate_started' && event.candidate) {
    startAtById.set(event.candidate.id, event.candidate.startedAt ?? event.at);
  }
}
const shadowAbandoned = wholeValidation.filter((e) => e.type === 'shadow_candidate_abandoned');
const shadowScored = wholeValidation.filter((e) => e.type === 'shadow_candidate_scored');
const shadowRows = shadowScored.map((event) => {
  const startedAt = startAtById.get(event.candidateId) ?? null;
  const flagged = shadowStarts.get(event.candidateId) === true || event.dataPlaneDegraded === true;
  const retro = (startedAt != null && withinDegraded(startedAt)) || withinDegraded(event.at);
  const knowable = (startedAt == null || covered(startedAt)) && covered(event.at);
  return {
    netPnlUsd: event.netPnlUsd ?? 0,
    contaminated: flagged || retro,
    // Unclassified only when nothing marked it AND the trace cannot speak to it.
    unclassified: !flagged && !retro && !knowable,
    retro: !flagged && retro,
  };
});
const cleanShadows = shadowRows.filter((row) => !row.contaminated && !row.unclassified);
const dirtyShadows = shadowRows.filter((row) => row.contaminated);
const unknownShadows = shadowRows.filter((row) => row.unclassified);
const shadowStat = (rows) => {
  const wins = rows.filter((row) => row.netPnlUsd > 0);
  const net = rows.reduce((sum, row) => sum + row.netPnlUsd, 0);
  return {
    scored: rows.length,
    wins: wins.length,
    winRate: rows.length === 0 ? 0 : wins.length / rows.length,
    netPnlUsd: net,
  };
};

const confirmations = validation.filter((e) => e.type === 'entry_confirmation_observed');
const degradedConfirmations = confirmations.filter((e) => e.dataPlaneDegraded === true);
const cleanConfirmations = confirmations.filter((e) => e.dataPlaneDegraded !== true);

const socketStates = tally(orderbook, 'socketState');
const openSamples = orderbook.filter((row) => row.socketState === 'open').length;
const supervisions = orderbook.filter((row) => row.supervisionAction && row.supervisionAction !== 'none');
const degradedSamples = orderbook.filter((row) => row.dataPlaneDegraded === true);
const withCandidates = orderbook.filter((row) => (row.candidateCount ?? 0) > 0);
const candidateHealthy = withCandidates.filter((row) => (row.candidateFractionSequenced ?? 0) > 0.9);
const lastOrderbook = orderbook[orderbook.length - 1] ?? null;

const priorityOutcomes = tally(priority, 'outcome');
const sequencedBooks = priority.filter((row) => row.outcome === 'sequenced-book').length;

// Bridge freshness is the metric that exposed the 2026-07-27 outage: it never
// reset across 18,968 samples, which only a socket that never re-opened can do.
let bridgeStaleSamples = 0;
let bridgeMaxFreshness = null;
let bridgeFreshnessResets = 0;
let previousFreshness = null;
for (const row of bridge) {
  const freshness = row.orderbookObservationFreshnessMs;
  if (freshness == null) continue;
  if (freshness > 90_000) bridgeStaleSamples += 1;
  if (bridgeMaxFreshness == null || freshness > bridgeMaxFreshness) bridgeMaxFreshness = freshness;
  if (previousFreshness != null && freshness < previousFreshness - 30_000) bridgeFreshnessResets += 1;
  previousFreshness = freshness;
}

const runStartAt = orderbook[0]?.at ?? cutoffMs;
const runEndAt = lastOrderbook?.at ?? null;
const runMs = runStartAt != null && runEndAt != null ? runEndAt - runStartAt : null;
const degradedMs = lastOrderbook?.dataPlaneDegradedMs ?? 0;

const gates = [
  {
    name: 'socket open on the latest sample',
    pass: lastOrderbook?.socketState === 'open',
    detail: `socketState=${lastOrderbook?.socketState ?? 'no samples'}`,
  },
  {
    name: 'sequenced delta fresher than 30s at cutoff',
    pass: lastOrderbook != null && lastOrderbook.sequencedDeltaAgeMs != null && lastOrderbook.sequencedDeltaAgeMs < 30_000,
    detail: `sequencedDeltaAgeMs=${ms(lastOrderbook?.sequencedDeltaAgeMs)}`,
  },
  {
    name: 'at least one sequenced-book priority outcome',
    pass: sequencedBooks > 0,
    detail: `sequenced-book=${sequencedBooks} of ${priority.length} priority attempts`,
  },
  {
    name: 'sequenced-book dominates admitted-* outcomes',
    pass: priority.length > 0 && sequencedBooks > priority.length / 2,
    detail: `${pct(sequencedBooks, priority.length)} of priority attempts`,
  },
  {
    name: 'candidate books sequenced >90% of sampled windows',
    pass: withCandidates.length > 0 && candidateHealthy.length / withCandidates.length > 0.9,
    detail: `${candidateHealthy.length}/${withCandidates.length} windows (${pct(candidateHealthy.length, withCandidates.length)})`,
  },
  {
    name: 'degraded time under 5% of the run',
    pass: runMs != null && runMs > 0 && degradedMs / runMs < 0.05,
    detail: `${ms(degradedMs)} degraded of ${ms(runMs)}`,
  },
  {
    name: 'no supervisor invariant violations',
    pass: !supervisions.some((row) => row.supervisionAction === 'invariant-violation'),
    detail: `${supervisions.filter((r) => r.supervisionAction === 'invariant-violation').length} violations`,
  },
];

const report = {
  cutoffMs,
  cutoffIso: iso(cutoffMs),
  window: { from: iso(runStartAt), to: iso(runEndAt), elapsed: ms(runMs) },
  traces: {
    orderbook: { path: orderbookTracePath, samples: orderbook.length },
    priority: { path: priorityTracePath, samples: priority.length },
    connectorWarns: { path: connectorWarnPath, samples: warns.length },
    bridge: { samples: bridge.length },
    strategyValidation: { samples: validation.length },
  },
  dataPlane: {
    socketStates,
    openSampleShare: pct(openSamples, orderbook.length),
    supervisorActions: tally(supervisions, 'supervisionAction'),
    reconnects: lastOrderbook?.reconnects ?? null,
    supervisorEscalations: lastOrderbook?.supervisorEscalations ?? null,
    degradedSamples: degradedSamples.length,
    degradedMs,
    lastApplicationSilence: ms(lastOrderbook?.applicationSilenceMs),
    lastSequencedDeltaAge: ms(lastOrderbook?.sequencedDeltaAgeMs),
  },
  bridgeFreshness: {
    staleSamples: bridgeStaleSamples,
    staleShare: pct(bridgeStaleSamples, bridge.length),
    maxFreshness: ms(bridgeMaxFreshness),
    resets: bridgeFreshnessResets,
  },
  priorityOutcomes,
  confirmations: {
    total: confirmations.length,
    taggedDegraded: degradedConfirmations.length,
    economicallyValid: cleanConfirmations.length,
    topReasonsClean: tally(cleanConfirmations, 'reason').slice(0, 10),
    topReasonsDegraded: tally(degradedConfirmations, 'reason').slice(0, 5),
    ready: cleanConfirmations.filter((e) => e.status === 'ready').length,
    maxSamples: cleanConfirmations.reduce((max, e) => Math.max(max, e.samples ?? 0), 0),
  },
  warns: tally(warns, 'source'),
  gates,
};

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (label, value) => console.log(`  ${label.padEnd(38)} ${value}`);
  console.log(`\nNEMESIS data-plane run analysis`);
  console.log(`  cutoff ${report.cutoffIso}  window ${report.window.from} -> ${report.window.to} (${report.window.elapsed})\n`);

  console.log('DATA PLANE');
  line('orderbook trace samples', orderbook.length || '0 (NEMESIS_ORDERBOOK_TRACE_PATH unset?)');
  line('socket states', socketStates.map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
  line('samples with socket open', `${openSamples} (${report.dataPlane.openSampleShare})`);
  line('supervisor actions', report.dataPlane.supervisorActions.map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
  line('stream reconnects / escalations', `${report.dataPlane.reconnects ?? 'n/a'} / ${report.dataPlane.supervisorEscalations ?? 'n/a'}`);
  line('last application silence', report.dataPlane.lastApplicationSilence);
  line('last sequenced delta age', report.dataPlane.lastSequencedDeltaAge);
  line('degraded', `${ms(degradedMs)} across ${degradedSamples.length} samples`);

  console.log('\nBRIDGE FRESHNESS (independent check)');
  line('samples over the 90s bound', `${bridgeStaleSamples} (${report.bridgeFreshness.staleShare})`);
  line('max observation freshness', report.bridgeFreshness.maxFreshness);
  line('freshness resets (reconnect proof)', bridgeFreshnessResets);

  console.log('\nPRIORITY TRACKING OUTCOMES');
  for (const [outcome, count] of priorityOutcomes) {
    line(outcome, `${count} (${pct(count, priority.length)})`);
  }
  if (priorityOutcomes.length === 0) line('(none)', 'no priority-track attempts in window');

  console.log('\nENTRY CONFIRMATIONS');
  line('total', confirmations.length);
  line('tagged dataPlaneDegraded (excluded)', degradedConfirmations.length);
  line('economically valid', cleanConfirmations.length);
  line('ready', report.confirmations.ready);
  line('max samples reached', report.confirmations.maxSamples);
  for (const [reason, count] of report.confirmations.topReasonsClean) {
    line(`  ${String(reason).slice(0, 34)}`, count);
  }

  // Volatility calibration reach. The gate can only bind where the strike ladder
  // actually fits, and measurement on 2026-07-31 showed a near-expiry KXBTCD
  // ladder with every quote pinned at the rails and so no fit at all -- which is
  // exactly when this app is most active. A gate that never fires is either
  // always in range or never consulted, and only these counts tell them apart.
  const calibrated = confirmations.filter((c) => c.modelCalibration);
  // Host suspension, named. On 2026-08-01 a machine entering Modern Standby at
  // 01:36 produced one trace sample every few hours, every age counter reading
  // hours on resume, and an initial diagnosis of a seven-hour dead socket that was
  // wrong -- the supervisor had simply not been executing. A gap in the tick is
  // evidence about the host, and the run's own report has to say so.
  // Every trace sample, not just those carrying an action: the tick writes one at
  // least every 30s, so absence of samples IS the signal.
  const tickGaps = orderbook
    .map((row, i) => (i === 0 ? 0 : row.at - orderbook[i - 1].at))
    .filter((ms) => ms > 60_000);
  console.log('\nHOST CONTINUITY');
  if (tickGaps.length === 0) {
    line('gaps in the health tick', 'none over 60s — the process ran continuously');
  } else {
    const total = tickGaps.reduce((sum, ms) => sum + ms, 0);
    line('gaps in the health tick', `${tickGaps.length}, longest ${(Math.max(...tickGaps) / 3600000).toFixed(2)}h`);
    line('total time not executing', `${(total / 3600000).toFixed(2)}h`);
    line('WARNING', 'age counters spanning these gaps describe the host, not the feed');
  }

  console.log('\nMODEL CALIBRATION (volatility vs the strike ladder)');
  if (calibrated.length === 0) {
    line('confirmations carrying calibration', `0 of ${confirmations.length} — not recorded before 2026-07-31`);
  } else {
    const withLadder = calibrated.filter((c) => (c.modelCalibration.ladderQuoteCount || 0) > 0);
    const fitted = calibrated.filter((c) => Number.isFinite(c.modelCalibration.ladderSigmaT));
    const ratios = fitted
      .map((c) => c.modelCalibration.ladderSigmaRatio)
      .filter((r) => Number.isFinite(r))
      .sort((a, b) => a - b);
    const outOfBand = ratios.filter((r) => r < 0.5 || r > 1.5);
    const quoteCounts = calibrated.map((c) => c.modelCalibration.ladderQuoteCount || 0).sort((a, b) => a - b);
    // sigmaT is meaningless without its factors: tiny is correct near expiry and
    // wrong hours out. Annualise so the number can be compared to a real vol.
    const annual = calibrated
      .map((c) => c.modelCalibration)
      .filter((m) => Number.isFinite(m.sigmaPerRootSec))
      .map((m) => m.sigmaPerRootSec * Math.sqrt(365 * 24 * 3600))
      .sort((a, b) => a - b);
    line('confirmations carrying calibration', `${calibrated.length} of ${confirmations.length}`);
    line('  ladder reached the model', `${withLadder.length} (${pct(withLadder.length, calibrated.length)})`);
    const usableCounts = calibrated
      .map((c) => c.modelCalibration.ladderUsableCount)
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => a - b);
    line('  ladder quotes supplied (min/median/max)',
      `${quoteCounts[0]} / ${quoteCounts[Math.floor(quoteCounts.length / 2)]} / ${quoteCounts[quoteCounts.length - 1]}`);
    if (usableCounts.length > 0) {
      // Supply vs usable separates "the ladder never reached the model" from
      // "it reached the model pinned at the rails". Different fixes.
      line('  of those, usable (min/median/max)',
        `${usableCounts[0]} / ${usableCounts[Math.floor(usableCounts.length / 2)]} / ${usableCounts[usableCounts.length - 1]}`);
    }
    line('  ladder produced a fit', `${fitted.length} (${pct(fitted.length, calibrated.length)})`);
    if (annual.length > 0) {
      line('  model vol, annualised (min/median/max)',
        `${(annual[0] * 100).toFixed(1)}% / ${(annual[Math.floor(annual.length / 2)] * 100).toFixed(1)}%`
        + ` / ${(annual[annual.length - 1] * 100).toFixed(1)}%`);
    }
    if (ratios.length > 0) {
      line('  median model/ladder sigma ratio', ratios[Math.floor(ratios.length / 2)].toFixed(3));
      line('  ratio range', `${ratios[0].toFixed(3)} – ${ratios[ratios.length - 1].toFixed(3)}`);
      line('  outside the 0.5–1.5 band', `${outOfBand.length} (${pct(outOfBand.length, ratios.length)})`);
    }
    if (fitted.length === 0) {
      line('  VERDICT', 'gate is DORMANT — no ladder ever fitted, so it can never invalidate');
    } else if (outOfBand.length === 0) {
      line('  VERDICT', 'gate live and never tripped — model agrees with the ladder where it fits');
    }
  }

  console.log('\nSHADOW LEDGER (whole ledger — the gate accumulates across relaunches)');
  const clean = shadowStat(cleanShadows);
  const dirty = shadowStat(dirtyShadows);
  const unknown = shadowStat(unknownShadows);
  const classified = clean.scored + dirty.scored;
  line('scored total', shadowRows.length);
  line('clean (counts toward the gate)', `${clean.scored} · wins ${clean.wins} (${(clean.winRate * 100).toFixed(0)}%) · net $${clean.netPnlUsd.toFixed(2)}`);
  line('contaminated (excluded)', `${dirty.scored} · wins ${dirty.wins} · net $${dirty.netPnlUsd.toFixed(2)}`
    + `${shadowRows.filter((r) => r.retro).length > 0 ? ` (${shadowRows.filter((r) => r.retro).length} classified retroactively from the trace)` : ''}`);
  line('unclassified (no trace cover)', `${unknown.scored} · net $${unknown.netPnlUsd.toFixed(2)}`);
  line('abandoned (market closed, no evidence)', shadowAbandoned.length);
  line('contaminated share', classified === 0 ? 'n/a' : pct(dirty.scored, classified));
  if (classified > 0 && dirty.scored / classified > 0.2) {
    console.log('  NOTE: contamination over 20% — the clean subset is not a valid test of the strategy,');
    console.log('        because degraded books produce bad entries, so exclusions are loss-biased.');
  }

  console.log('\nGATES');
  let failed = 0;
  for (const gate of gates) {
    if (!gate.pass) failed += 1;
    console.log(`  ${gate.pass ? 'PASS' : 'FAIL'}  ${gate.name.padEnd(44)} ${gate.detail}`);
  }
  console.log(`\n  ${failed === 0 ? 'ALL GATES PASS' : `${failed} GATE(S) FAILED`} — a failed data-plane gate means the run is a diagnostic, not evidence about edge.\n`);
  process.exitCode = failed === 0 ? 0 : 1;
}
