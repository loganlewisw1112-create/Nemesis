#!/usr/bin/env node
'use strict';

// Reads NEMESIS's real, auto-populated runtime state (session stats, paper
// portfolio, audit log, auto-close decisions) and appends one dated delta
// entry to docs/paper-trading-week-log.md, using a cursor file so each run
// only reports what's new since the previous check-in. journal.json is
// intentionally not read here -- it only populates on a manual UI action
// and won't reflect unattended trading activity.

const fs = require('fs');
const path = require('path');
const os = require('os');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DATA_DIR = path.join(APPDATA, '@nemesis', 'desktop', 'nemesis-data');
const DOCS_DIR = path.join(__dirname, '..', 'docs');
const CURSOR_PATH = path.join(DOCS_DIR, '.weekly-report-cursor.json');
const LOG_PATH = path.join(DOCS_DIR, 'paper-trading-week-log.md');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadCursor() {
  return readJson(CURSOR_PATH, {
    lastAuditTimestamp: 0,
    lastDecisionTimestamp: 0,
    lastTradeCount: 0,
    lastAbortCount: 0,
    lastRealizedPnl: 0,
    lastRunAt: null,
  });
}

function saveCursor(cursor) {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

function groupCounts(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'unspecified';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function main() {
  const sessionStats = readJson(path.join(DATA_DIR, 'session-stats.json'), {
    tradeCount: 0,
    abortCount: 0,
    dailyPnl: 0,
    startingEquity: 0,
  });
  const portfolio = readJson(path.join(DATA_DIR, 'paper-portfolio.json'), {
    cash: 0,
    startingCash: 0,
    positions: [],
    trades: [],
    realizedPnl: 0,
  });
  const auditLog = readJson(path.join(DATA_DIR, 'audit-log.json'), []);
  const autoCloseState = readJson(path.join(DATA_DIR, 'auto-close-state.json'), {
    states: [],
    decisions: [],
  });

  const cursor = loadCursor();
  const isFirstRun = !cursor.lastRunAt;

  const newTradeCount = sessionStats.tradeCount - cursor.lastTradeCount;
  const newAbortCount = sessionStats.abortCount - cursor.lastAbortCount;
  const pnlDelta = portfolio.realizedPnl - cursor.lastRealizedPnl;

  // audit-log.json is a ring buffer capped at 5000 entries (auditLog.ts:18)
  // that shifts from the front once full -- already true here, since total
  // events run well past that cap. An array-index cursor would silently go
  // stale once the buffer wraps, so filter by each entry's own timestamp
  // instead, which is correct regardless of shifting or array length.
  const newAuditEntries = auditLog.filter((e) => (e.t ?? 0) > cursor.lastAuditTimestamp);

  // auto-close-state.json's decisions are capped at 40 and prepended
  // newest-first (main.ts:987), not appended -- so index/count-based
  // slicing would look at the wrong end of the array. Filter by
  // `triggeredAt` for the same reason as the audit log above.
  const decisions = Array.isArray(autoCloseState.decisions) ? autoCloseState.decisions : [];
  const newDecisions = decisions.filter((d) => (d.triggeredAt ?? 0) > cursor.lastDecisionTimestamp);
  const emergencyCloses = newDecisions.filter((d) => /emergency close:/i.test(d.reason || ''));

  const maxAuditTimestamp = auditLog.reduce((max, e) => Math.max(max, e.t ?? 0), cursor.lastAuditTimestamp);
  const maxDecisionTimestamp = decisions.reduce((max, d) => Math.max(max, d.triggeredAt ?? 0), cursor.lastDecisionTimestamp);

  const blockReasonCounts = groupCounts(
    newAuditEntries.filter((e) => e.ok === false),
    (e) => e.detail || e.action,
  );

  const now = new Date();
  const lines = [];
  lines.push(`## ${now.toISOString().slice(0, 10)} check-in (${now.toISOString()})`);
  lines.push('');
  if (isFirstRun) {
    lines.push('_First check-in of this run._');
    lines.push('');
  }
  lines.push(`- New paper trades this period: **${newTradeCount}**`);
  lines.push(`- New blocked/aborted attempts this period: **${newAbortCount}**`);
  lines.push(`- Realized P&L change: **${pnlDelta >= 0 ? '+' : ''}${pnlDelta.toFixed(2)}**`);
  lines.push(`- Open positions: ${portfolio.positions.length}, cash: $${Number(portfolio.cash).toFixed(2)}`);
  lines.push(
    `- Auto-close decisions this period: ${newDecisions.length}` +
      (emergencyCloses.length ? ` (${emergencyCloses.length} emergency close)` : ''),
  );
  if (blockReasonCounts.length > 0) {
    lines.push('- Top block/abort reasons this period:');
    for (const [reason, count] of blockReasonCounts.slice(0, 5)) {
      lines.push(`  - ${reason}: ${count}`);
    }
  } else if (newAuditEntries.length === 0 && newTradeCount === 0) {
    lines.push('- No new activity recorded since the last check-in.');
  }
  lines.push('');

  fs.mkdirSync(DOCS_DIR, { recursive: true });
  fs.appendFileSync(LOG_PATH, lines.join('\n') + '\n');

  saveCursor({
    lastAuditTimestamp: maxAuditTimestamp,
    lastDecisionTimestamp: maxDecisionTimestamp,
    lastTradeCount: sessionStats.tradeCount,
    lastAbortCount: sessionStats.abortCount,
    lastRealizedPnl: portfolio.realizedPnl,
    lastRunAt: now.toISOString(),
  });

  process.stdout.write(lines.join('\n') + '\n');
}

main();
