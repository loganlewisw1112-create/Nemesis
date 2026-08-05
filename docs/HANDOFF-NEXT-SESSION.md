# NEMESIS — Next-Session Handoff (written 2026-08-05, during the run ending 07:00 PDT)

**Headline: the central question is answered. crypto-lead has no edge, and the test that says so
is clean.** After ~6 weeks of infrastructure work whose entire purpose was to make a fair test
possible, the fair test ran and the strategy failed it. No real money was ever at risk.

This supersedes the 2026-08-02 handoff.

## The verdict

Run launched **2026-08-04 20:01:21 PDT** (cutoff `1785898881530`), HEAD `0cb82b6`, allowlist
`KXBTCD`, shadow gate 50 scored / 1 observation day. Numbers below are as of **06:08 PDT
2026-08-05**; the run continues until a 07:00 deadline stop, so final counts will be modestly
higher (see "Final numbers" at the bottom, to be filled in from the stop receipt).

| Metric | Measured | Gate requires |
|---|---|---|
| Shadows scored | **44** | ≥ 50 |
| Win rate | **11.4%** (5/44) | ≥ 55% |
| Profit factor | **0.314** | ≥ 1.25 |
| Net P&L | **−$72.01** | > 0 |
| **Shadows tagged `dataPlaneDegraded`** | **0** | ≤ 20% share |
| Observation days | ~0.4 (hibernation-interrupted) | ≥ 1 |
| Paper trades | **0** | — |
| Portfolio | $5,000 unchanged | — |

**44 samples is enough.** A 95% Wilson interval on 5/44 tops out near **24%** — the 55% bar is far
outside it. Six more samples cannot reverse this, and the two unmet *count* bars (50 scored, 1 day)
only ever gated a **pass**; the quality bars are decisively failed regardless.

**The zero-contamination number is what makes this different from every prior read.** Previous
"no edge" conclusions were all recoverable by "maybe the feed was broken" — §7 of the project
history is an entire 8-hour run that looked like a strategy result and was actually a dead socket.
This run has **zero degraded-tagged shadows** and 2.4 minutes of total degraded time. The escape
hatch is closed.

## Why — one explanation now covers every failure this project has had

Measured against live Kalshi data on 2026-08-04 (full detail:
`docs/superpowers/plans/2026-08-02-arb-pivot-scoping.md`):

- Kalshi crypto is priced **efficiently to ~1 tick**. Three independent model-free tests
  (ladder monotonicity, bracket completeness, cross-series CDF/bracket consistency across 696
  aligned triples) found nothing above 1¢ price-grid discretization.
- A taker round-trip costs **4.5–6.5¢** at mid prices (≈3.5¢ fees + 1–3¢ spread).
- Every edge NEMESIS has ever measured is **1–3¢**.

So the shadows bleed the round trip: −$72.01 over 44 scored is **−$1.64 average**, which is what
paying 5¢ to capture 2¢ looks like. **This is not a signal problem, it is a cost-structure
problem** — and it explains crypto-lead momentum (§6), the corrected volatility model (§7b), and
ladder arb identically. It is also the same wall as the older finding that fees were 73.8% of
modeled `plannedLoss`.

**Do not respond to this by lowering `minExpectedNetPnlUsd` / `minRewardRiskRatio` or the shadow
quality bars.** With these odds, a "green" trade manufactured by loosening a bar only books losses.
The bars did their job.

## What was validated this session (and one self-correction)

- **A1 — correlated-market arb within Kalshi: falsified before any code was written.** See the
  scoping doc. Zero monotonicity violations *even at zero fees*; bracket sums 1.48–4.70 vs a $1
  payout *at zero fees*; best cross-series edge exactly one tick, and **not executable** because the
  binding leg had **1.00 / 0.16 contracts** of depth against a 5–10 contract break-even.
- **A2 — two-leg paired execution: real work, but moot without a signal.** Audited: `yes|no` side
  selection is already first-class (Kalshi has no short — "buy NO" is the correct model), but there
  is no pairing concept, no atomicity primitive (a half-filled pair leaves a naked position nothing
  unwinds), the per-position `autoCloseEngine` would close the profitable leg and strand the hedge,
  and `decideCapitalAllocation` would double-count a hedge's risk.
- **Self-correction worth keeping:** the first pass of the arb analysis claimed Kalshi's fee has a
  "1-cent floor per contract." **Wrong** — rounding is to the centicent per order, applied once to
  the total (`packages/core/src/fees/kalshiFee.ts:122-133`, `:149-151`). The real driver is the rate
  `0.07·P·(1−P)` ≈ 1.75¢/contract at P=0.50. The verdict survived, but it was right for the wrong
  reason — which would not have held in a different market. **Gross edge, fee model, and executable
  depth are three separate questions.**

## Run/ops facts worth not re-deriving

- **The overnight gap was battery hibernation, not a bug and not a sleep-fix failure.** A 7.17h tick
  gap ended 05:48 PDT; the process survived with its original PID (hibernate restores RAM).
  `powerSaveBlocker` maps to `ES_SYSTEM_REQUIRED`, which prevents **idle** sleep and **cannot**
  prevent battery-critical hibernation — no in-app API can. **Mitigation is operational: keep the
  machine plugged in for unattended runs.** This is the second overnight run lost this way.
- **Flow is far richer than previously assumed.** ~3 effective hours produced **2,852** confirmations
  / **50 `ready`** / 58 distinct tickers, versus 555 / 6 / ~11 across the entire ~20h Aug 1 run. A
  useful shadow sample takes hours, not days — earlier "we need a full day" pacing was too
  pessimistic. Note the 1-observation-day gate bar is still a real requirement for a formal pass.
- **The qualification ledger is 156MB and is replayed in full at every start** (startup still only
  took ~15s, so it is not yet a practical problem, but it is growing). Archiving is operator-run and
  resets the paper ledger: `npm run paper:archive-reset -- ARCHIVE_AND_RESET_PAPER` with the app
  stopped. Claude is classifier-blocked from this.
- **Deadline stops are reliable** — `scripts/stop-nemesis-at.ps1 -At '<local datetime>'` run
  detached. Measured drift: **0.461s** (2026-08-02) vs the 101-minute drift of the one manual stop
  this project ever did. Only ever arm one at a time; two would overwrite each other's receipt.
- Top rejection reasons this run (all genuine economics, no structural blockers):
  R:R below minimum 1,097 · collecting evidence 575 · entry book stale 490 · net reward below
  minimum 270 · source signal stale 167 · needs flow-driven source 118 · exchange-origin 72.
  Exchange-origin at 72/2,852 (2.5%) confirms the structural fixes from §4/§5 still hold.

## Repo state

- Branch `agent/nemesis-seven-hour-campaign`, HEAD **`0cb82b6`**, tree clean,
  **0 ahead / 0 behind origin**.
- **Full suite verified green this session: 777 tests / 109 files, 0 failures.** (The prior handoff
  flagged this as unverified; it is now confirmed.)
- No source changes were made this session — all work was measurement and documentation.

## Where to go next

The infrastructure is genuinely finished and valuable: data-plane supervision with proven recovery,
fail-closed degraded tagging, honest fee/economics modeling, a shadow→pilot→buy ladder with
contamination-aware gating, deterministic deadline stops, and hash-chained evidence ledgers. **That
work is not wasted by this verdict — it is what made the verdict trustworthy.**

Given the cost-structure finding, only two directions are coherent. Either get an edge **larger than
the ~5¢ round trip**, or **stop paying the spread and start earning it**:

| Option | Case for | Case against |
|---|---|---|
| **Cross-venue (Kalshi vs Polymarket), observation-only first** | Polymarket reportedly leads price discovery by minutes; during a real move that lag could plausibly be worth 5–10¢, the first candidate that clears the bar. Testable with **public data from both venues before writing any feed, execution, or custody code.** | A full build is weeks: new feed hardening from scratch, an unsolved contract-mapping problem, no shared settlement, and a second (on-chain) custody model this project has never touched. |
| **Maker instead of taker** | This is demonstrably where the money is — market makers quote `sum(bid) 0.75–0.91` against `sum(ask) 1.48–4.70` and collect that spread, and Kalshi's maker rate is **a quarter** of taker. Structurally the correct side of this market. | Requires resting-order execution NEMESIS has none of, plus adverse selection and queue-position modeling; competes with ~23 professional MMs. Large build on a hunch. |
| **Park it** | Infrastructure is done and the central question is answered. A clean stopping point. | Leaves the platform unused. |

**Recommended:** the cross-venue **observation-only spread logger** — it is the only option that can
be falsified cheaply, and it now has a concrete quantitative bar to clear (**>4.5–6.5¢ round-trip**)
rather than a vague "does a mispricing exist." Do not build execution or touch custody until the
logger shows the mispricing is real, large enough, and persistent.

## Hard rules (unchanged)

- Do not lower `minExpectedNetPnlUsd:1` / `minRewardRiskRatio:2` or the shadow quality bars
  (`shadowMinWinRate:0.55`, `shadowMinProfitFactor:1.25`, `shadowMinStressedProfitFactor:1.1`).
- Do not relax the exchange-origin book timestamp+sequence check.
- Live stays hard-locked (`liveEnabled:false`, `autoLiveEnabled:false`, `dryRun:true`; since
  `5797525` these are cross-checked against a certificate at load rather than trusted verbatim).
- Claude is classifier-blocked from `settings.json` and paper-reset commands — hand the operator
  exact keys/commands instead. See the `nemesis-ops` skill.
- Don't widen a health/heartbeat watchdog in response to a stall without first establishing whether
  it was the feed or the host (suspend, hibernation, dead battery).

## Data locations

| What | Where |
|---|---|
| Cutoff/config for this run | `.nemesis-relaunch-cutoff.txt` (cutoffMs `1785898881530`) |
| Portfolio / trades | `%APPDATA%\@nemesis\desktop\nemesis-data\paper-portfolio.json` |
| Confirmations + shadow ledger | `...\nemesis-data\paper-strategy-validation-events.jsonl` — filter `e.at > 1785898881530` |
| Bridge telemetry | `...\nemesis-data\bridge-telemetry.jsonl` (rotated, 4×32MB) |
| Connector warns / traces | `nemesis/overnight-logs/2026-08-04/` |
| Stop receipt | `nemesis/overnight-logs/2026-08-05/stop-receipt.json` |
| Arb validation + A2 audit | `docs/superpowers/plans/2026-08-02-arb-pivot-scoping.md` |

## Final numbers

To be filled in from `overnight-logs/2026-08-05/stop-receipt.json` and a final ledger read after the
07:00 PDT stop. The 06:08 figures above are not expected to move materially — and cannot change the
verdict, since the quality bars are missed by margins several times larger than the remaining
sample could close.
