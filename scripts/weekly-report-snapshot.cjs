#!/usr/bin/env node
'use strict';

// Generated reports are runtime evidence. They stay under nemesis-data/reports;
// docs/paper-trading-week-log.md is preserved as read-only historical evidence.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash } = require('node:crypto');

const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const DEFAULT_DATA_DIR = process.env.NEMESIS_DATA_DIR
  || path.join(APPDATA, '@nemesis', 'desktop', 'nemesis-data');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function readQualificationEvents(dataDir) {
  const file = path.join(dataDir, 'paper-qualification-events.jsonl');
  const text = fs.readFileSync(file, 'utf8');
  const events = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (events.length === 0 || events[0].type !== 'run_started') {
    throw new Error('qualification evidence is missing run_started');
  }
  const runId = events[0].runId;
  let previousHash = 'GENESIS';
  events.forEach((event, index) => {
    if (event.runId !== runId || event.sequence !== index + 1) {
      throw new Error('qualification evidence has an inconsistent run or event number');
    }
    const { hash, ...unsignedEvent } = event;
    const expectedHash = createHash('sha256').update(stableJson(unsignedEvent)).digest('hex');
    if (event.previousHash !== previousHash || hash !== expectedHash) {
      throw new Error('qualification evidence hash chain is invalid');
    }
    previousHash = hash;
  });
  return events;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function groupCounts(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item) || 'unspecified';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function generateWeeklyReport(dataDir = DEFAULT_DATA_DIR, now = new Date()) {
  const reportsDir = path.join(dataDir, 'reports');
  const cursorPath = path.join(reportsDir, 'weekly-report-cursor.json');
  const reportPath = path.join(reportsDir, 'weekly-report.md');
  const events = readQualificationEvents(dataDir);
  const runId = events[0].runId;
  const cursor = readJson(cursorPath, { runId: null, lastEventNumber: 0, lastRunAt: null });
  const sameRun = cursor.runId === runId;
  const lastEventNumber = sameRun && Number.isInteger(cursor.lastEventNumber)
    ? Math.max(0, cursor.lastEventNumber)
    : 0;
  const newEvents = events.filter((event) => event.sequence > lastEventNumber);
  const portfolio = readJson(path.join(dataDir, 'paper-portfolio.json'), {
    cash: 0,
    startingCash: 0,
    positions: [],
    trades: [],
    realizedPnl: 0,
  });

  const completed = newEvents.filter((event) => event.type === 'position_completed');
  const mutations = newEvents.filter((event) => event.type === 'paper_open' || event.type === 'paper_close');
  const aborts = newEvents.filter((event) => event.type === 'paper_abort');
  const blocking = newEvents.filter((event) => event.type === 'safety_block'
    || (event.type === 'paper_abort' && event.blocking));
  const realizedPnl = completed.reduce((sum, event) => sum + Number(event.position?.netPnlUsd || 0), 0);
  const funnel = {};
  for (const event of newEvents.filter((row) => row.type === 'funnel_increment')) {
    funnel[event.stage] = (funnel[event.stage] || 0) + Math.max(0, Number(event.count) || 0);
  }
  const rejectionCounts = groupCounts(
    newEvents.filter((event) => (event.type === 'paper_abort' && !event.blocking)
      || (event.type === 'funnel_increment' && event.reason)),
    (event) => event.code || event.reason,
  );

  const iso = now.toISOString();
  const eventCoverage = newEvents.length > 0
    ? `${newEvents[0].sequence}-${newEvents.at(-1).sequence}`
    : 'none';
  const lines = [
    `## ${iso.slice(0, 10)} check-in (${iso})`,
    '',
    `- Qualification run: ${runId}`,
    `- Events covered: ${newEvents.length} (${eventCoverage})`,
    `- Paper mutations: ${mutations.length}`,
    `- Completed positions: ${completed.length}`,
    `- Realized P&L from completed positions: ${realizedPnl >= 0 ? '+' : ''}${realizedPnl.toFixed(2)}`,
    `- Blocked/aborted attempts: ${aborts.length}`,
    `- Blocking safety events: ${blocking.length}`,
    `- Open positions: ${Array.isArray(portfolio.positions) ? portfolio.positions.length : 0}, cash: $${Number(portfolio.cash || 0).toFixed(2)}`,
  ];
  const funnelRows = Object.entries(funnel);
  if (funnelRows.length > 0) {
    lines.push(`- Feed stages: ${funnelRows.map(([stage, count]) => `${stage}=${count}`).join(', ')}`);
  }
  if (rejectionCounts.length > 0) {
    lines.push('- Rejection reasons:');
    for (const [reason, count] of rejectionCounts.slice(0, 8)) lines.push(`  - ${reason}: ${count}`);
  }
  if (newEvents.length === 0) lines.push('- No new qualification events since the last report.');
  lines.push('');

  fs.mkdirSync(reportsDir, { recursive: true });
  fs.appendFileSync(reportPath, `${lines.join('\n')}\n`, 'utf8');
  fs.writeFileSync(cursorPath, JSON.stringify({
    runId,
    lastEventNumber: events.at(-1).sequence,
    lastRunAt: iso,
  }, null, 2), 'utf8');
  return { runId, newEventCount: newEvents.length, lines, reportPath, cursorPath };
}

function main() {
  const result = generateWeeklyReport();
  process.stdout.write(`${result.lines.join('\n')}\n`);
}

if (require.main === module) main();

module.exports = { generateWeeklyReport, readQualificationEvents };
