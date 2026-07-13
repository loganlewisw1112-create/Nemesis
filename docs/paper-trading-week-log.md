# NEMESIS + GEA — Paper Trading Week Log

Running log for the one-week automated paper-trading run. Daily entries are
appended by `scripts/weekly-report-snapshot.cjs` (via the
`NEMESIS-WeeklyReportSnapshot` scheduled task, ~9am daily). The end-of-week
"book" is assembled from these entries plus a final full read of
`paper-portfolio.json` and `audit-log.json`.

## Run configuration (established 2026-07-05)

**Starting bankroll:** $5,000 paper (clean baseline; prior transitional data
backed up under `%APPDATA%\@nemesis\desktop\nemesis-data-backup-*`).

**Code fixes applied before the run (all committed, 194/194 tests, clean typecheck):**
1. `a11a446` — Thesis-edge certification. The profit gate previously required an
   instant same-book round-trip (near-impossible on a normal market), so it had
   certified 0 of 13,205 candidates. Now a fee/slippage-aware modeled edge can
   certify, gated on real exit liquidity and book freshness. Labeled
   "thesis edge certified (modeled, not locked-in)" — never a guaranteed profit.
2. `4498e69` — Magnitude-scaled probability calibration. Replaced fixed-bucket
   implied probabilities (e.g. any weather forecast past strike → 65%) with
   logistic/price-impact scaling by actual signal size, plus a favorite-longshot
   correction that only fires at genuine price extremes and fabricates no
   mid-range edge.
3. `b6145c9` — Mutual-exclusion guard. Refuses to open positions that combine
   into a structurally guaranteed loss (both sides of the same event summing
   past $1). Caught live in the first run holding both sides of an MLB game.
4. `7646762` — This daily snapshot/reporting script.

**Risk limits (tightened for the run):** max position $250 (5% of bankroll),
daily loss cap $150 (3%). Previously $15,000 / $8,000, which could never bind
against a $5,000 wallet.

**Safety posture:** demo mode on, live trading off, dry-run off (paper fills),
strict-profit gate on, ProfitOS auto-close on, emergency loss-close on.

**Runtime:** built (non-dev) NEMESIS + GEA, Electron, auto-spawned GEA over the
authenticated loopback bridge on 127.0.0.1:7430.

**Realistic target:** positive expectancy with controlled drawdown over a
statistically meaningful sample — NOT zero losses or guaranteed daily profit.
One week is below the 30–60 day minimum from quant-industry practice, so this
is a first checkpoint, not a certification. Losing trades are expected and will
be reported, not hidden.

---

## 2026-07-06 check-in (2026-07-06T05:20:35.321Z)

_First check-in of this run._

- New paper trades this period: **1**
- New blocked/aborted attempts this period: **4**
- Realized P&L change: **+0.00**
- Open positions: 1, cash: $4996.50
- Auto-close decisions this period: 0
- Top block/abort reasons this period:
  - throughput paper buy blocked: book unavailable (book unavailable: no executable depth): 4
## 2026-07-06 check-in (2026-07-06T21:07:27.805Z)

- New paper trades this period: **-1**
- New blocked/aborted attempts this period: **32**
- Realized P&L change: **+0.00**
- Open positions: 2, cash: $4983.50
- Auto-close decisions this period: 0
- Top block/abort reasons this period:
  - auto-close blocked: book unavailable (book unavailable: no executable depth): 2940
  - throughput paper buy blocked: book unavailable (book unavailable: no executable depth): 852
  - auto-close blocked: book unavailable (fetch failed): 778
  - throughput paper buy blocked: book unavailable (fetch failed): 208
  - bridge packet rejected: stale exit book: 117

## 2026-07-06 check-in (2026-07-06T21:17:33.557Z)

- New paper trades this period: **38**
- New blocked/aborted attempts this period: **423**
- Realized P&L change: **-73.20**
- Open positions: 0, cash: $4926.80
- Auto-close decisions this period: 18 (18 emergency close)
- Top block/abort reasons this period:
  - category concentration limit: 874
  - auto-close blocked: book unavailable (book unavailable: no executable depth): 322
  - throughput paper buy blocked: book unavailable (book unavailable: no executable depth): 179
  - invalid executable price: 177
  - strict profit certification failed: 76

## 2026-07-06 check-in (2026-07-06T21:29:29.779Z)

- New paper trades this period: **9**
- New blocked/aborted attempts this period: **284**
- Realized P&L change: **-8.13**
- Open positions: 1, cash: $4894.17
- Auto-close decisions this period: 4 (4 emergency close)
- Top block/abort reasons this period:
  - category concentration limit: 296
  - throughput paper buy blocked: book unavailable (book unavailable: no executable depth): 178
  - invalid executable price: 52
  - strict profit certification failed: 51
  - invalid executable close price: 5

## 2026-07-08 check-in (2026-07-08T16:00:06.006Z)

- New paper trades this period: **-39**
- New blocked/aborted attempts this period: **1517**
- Realized P&L change: **+73.87**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 2 (2 emergency close)
- Top block/abort reasons this period:
  - throughput paper buy blocked: book unavailable (book unavailable: no executable depth): 1413
  - invalid executable price: 422
  - throughput paper buy blocked: book unavailable (fetch failed): 344
  - category concentration limit: 158
  - strict profit certification failed: 100

## 2026-07-10 check-in (2026-07-10T08:20:33.686Z)

- New paper trades this period: **0**
- New blocked/aborted attempts this period: **0**
- Realized P&L change: **+0.00**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 0
- No new activity recorded since the last check-in.

## 2026-07-10 check-in (2026-07-10T16:00:05.332Z)

- New paper trades this period: **0**
- New blocked/aborted attempts this period: **0**
- Realized P&L change: **+0.00**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 0
- No new activity recorded since the last check-in.

## 2026-07-11 check-in (2026-07-11T16:36:03.260Z)

- New paper trades this period: **0**
- New blocked/aborted attempts this period: **0**
- Realized P&L change: **+0.00**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 0
- No new activity recorded since the last check-in.

## 2026-07-13 check-in (2026-07-13T00:18:05.174Z)

- New paper trades this period: **0**
- New blocked/aborted attempts this period: **0**
- Realized P&L change: **+0.00**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 0
- No new activity recorded since the last check-in.

## 2026-07-13 check-in (2026-07-13T16:00:02.000Z)

- New paper trades this period: **0**
- New blocked/aborted attempts this period: **0**
- Realized P&L change: **+0.00**
- Open positions: 4, cash: $4974.39
- Auto-close decisions this period: 0
- No new activity recorded since the last check-in.

