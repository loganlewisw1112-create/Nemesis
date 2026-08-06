# NEMESIS — Project Closeout

**Status: PARKED, 2026-08-05.** Question answered. No further work planned.

**Final position: $5,000 paper capital, 0 trades executed, 0 real money ever at risk, live trading
never enabled.** 199 commits over ~6 weeks (2026-06-25 → 2026-08-05). 806 tests across 112 files,
green at close.

This document exists so that anyone returning — including a future me — starts from the answer
rather than the question. It is deliberately honest about what failed, including my own mistakes.

---

## 1. What NEMESIS was for

An Electron desktop system to trade Kalshi event contracts, built around three goals, in order:

1. **Survive** a long unattended run without crashing or corrupting its own evidence.
2. **Pass R10** — a self-imposed readiness/soak/evidence gate, the prerequisite for risking money.
3. **Prove the strategy actually finds and closes profitable paper trades** before any live pilot.

Goals 1 and 2 were achieved. Goal 3 was tested exhaustively and **failed** — which is the correct
outcome to have discovered on paper rather than with capital.

---

## 2. How the thinking evolved

The project moved through four distinct mental models, each replacing the last when data forced it.

**Phase 1 — "it's a stability problem" (late June → mid July).**
Runs kept dying with a different symptom every time. ~40 commits attacked feed/transport accounting
before the real cause surfaced: the append-only campaign ledger was `structuredClone`d twice per
orderbook delta, starving the event loop until the renderer heartbeat watchdog invalidated the run.
One bug, many faces. Fixed in `95b8dda`. **Lesson: when failures look stochastic, suspect a shared
resource on the hot path, not the subsystem that happens to report the error.**

**Phase 2 — "it's a plumbing problem" (mid → late July).**
With stability fixed, paper trading still produced **zero trades, ever**. A long sequence of real
blockers was found and fixed: Kalshi wire-protocol quirks (`type:"ok"` vs `subscribed`, fire-and-forget
`get_snapshot`), orderbook tracking limits, a provenance store that silently rejected candidates, a
fee-type allowlist that failed closed on a legitimate variant, a confirmation sampler keyed on a
re-issued ID. Each fix was measured before moving to the next. Eventually the pipeline ran
end-to-end — candidates reached `ready`, shadows scored, the execution ladder worked.

**Phase 3 — "it's a model problem" (late July → Aug 1).**
Plumbing fixed, the strategy still lost. The volatility model was found to be pricing off a fixed
floor 57% of the time and its market-calibration cross-check had never once fired (starved by a
depth-filtered input, then by ladders keyed on an optional field that pooled three expiries). All
three were fixed. **The corrected model was then tested cleanly and still failed.**

**Phase 4 — "it's a market problem" (Aug 4–5).**
The final and correct model. Seven independent theses were measured against live data. All seven
failed, and — crucially — they failed for **one shared reason**, not seven unrelated ones. That
convergence is what makes the conclusion trustworthy rather than merely discouraging.

---

## 3. What was built, and works

This is real engineering that survives the negative trading result:

- **Data-plane supervision with proven recovery.** An 8-hour run once died to an absorbing dead
  state (socket closed, no reconnect armed, nothing watching). `superviseDataPlane` now recovers
  from dead sockets, stuck connects, cleared heartbeats and application silence — and was observed
  recovering from the exact terminal condition in production.
- **Fail-closed degraded tagging.** When the data plane can't be trusted, every event recorded is
  tagged `dataPlaneDegraded` and excluded from acceptance tallies — with a 20% contamination ceiling
  above which the gate refuses to open at all, because contamination is not random with respect to
  outcome.
- **Honest economics.** Fee model reproduces Kalshi's schedule to 31/31 recorded trades including
  the whole-cent balance rounding.
- **Hash-chained evidence ledgers** that refuse to append rather than silently lose integrity.
- **A shadow → pilot → paper-buy ladder** with quality gates that cannot be bypassed.
- **Deterministic deadline stops** — measured drift 0.279s and 0.461s, versus 101 minutes for the
  one manual stop ever attempted.
- **A queue-aware maker simulator** (`makerQueue.ts` / `makerSim.ts`, 27 tests) that resolves every
  unobservable pessimistically and models exits honestly rather than marking at an unreachable mid.
- **A falsification rig** that killed four multi-week builds in under an hour each.

---

## 4. The seven theses, and how each died

| # | Thesis | Verdict | Killed by |
|---|---|---|---|
| 1 | Directional crypto momentum (`crypto-lead`) | No edge | 53 scored shadows, **5 quality bars failed simultaneously**, ZERO contamination |
| 2 | Correlated arb within Kalshi | No edge | Market consistent to ~1 tick; best "opportunity" was 1¢ of price-grid discretization, and its binding leg had **1.00 contract** of depth |
| 3 | Cross-venue (Kalshi × Polymarket) | Premise false | No mappable instrument — Polymarket crypto is **touch/barrier at ~147d median**, Kalshi's is **terminal at hours** |
| 4 | Passive market making | Not capturable | Realized spread said +5.59¢; honest simulation lost. Flow is **one-sided** (27% buy share) so a symmetric quoter warehouses inventory against the drift |
| 5 | Favorite-longshot bias | Not present | Liquid series calibrated to <1pp; **1 of 14** band-tests significant, pointing the wrong way |
| 6 | Tail mispricing | No evidence | **85% of the tail is untradeable**; 3 survivors from 62 tests = exactly the chance rate (3.1 expected), all showing trending underlyings |
| 7 | Informational edge (weather vs public models) | Already arbitraged | A practitioner ran this exact test **0–32**; only **28 determined moments across 275 markets** |

### The one explanation covering all seven

> **A retail taker pays 4.5–6.5¢ round-trip into a market priced efficiently to ~1¢.**

Every edge NEMESIS ever measured was 1–3¢. Hunting 2¢ edges while paying 5¢ to transact cannot work
regardless of model quality. The single place that asymmetry inverts — **zero maker fees** on
Kalshi's `quadratic` fee type — is unreachable, because taker flow is one-sided and queue position
cannot be bought.

External evidence agrees and is worth recording: university research found bot accounts earned
**$131M in 2025 while retail lost the same ~$131M — despite retail picking correct outcomes more
often.** A Federal Reserve working paper finds Kalshi's own market prices beat Bloomberg consensus
and professional forecasters on macro. **The scarce resource is latency, not judgment**, and that is
not purchasable with $5,000 and a desktop.

### The one correction worth carrying forward

**Kalshi charges no settlement fee.** A taker entry **held to resolution** costs entry fee + half
spread ≈ **2.25–3.25¢**, not 4.5–6.5¢. The higher figure was correct for what was actually tested
(crypto-lead exited on target/stop within 15 minutes; the maker sim round-tripped by construction),
but it means **the hold-to-expiry regime was never properly explored.** If this is ever revisited,
start there.

### No venue switch is available

Commission-on-**net-winnings** venues (Betfair, Smarkets, Matchbook, Novig, ProphetX) structurally
let a thin edge survive — they tax being right, not trading. But Betfair/Smarkets/Matchbook bar US
persons; Novig and ProphetX are sports-only and **exclude California**; Polymarket US is lateral
(same CLOB microstructure that already defeated passive quoting); PredictIt caps a position at $850.

---

## 5. My own errors, caught in flight

Recorded because the same traps will recur, and because a report that only lists other people's
mistakes is not trustworthy.

| Error | Consequence if uncaught |
|---|---|
| **`taker_book_side` sign** — it names the taker's OWN order side; the consumed side is its *opposite* | 30% of prints mis-signed. Alone this flipped "crypto is toxic for makers" from true to false |
| **Wald confidence interval** collapses to *zero width* at p=0 or p=1 | 12 degenerate series read as "infinitely significant"; Wilson interval cut survivors 12 → 4 |
| **Fee model** — assumed a 1¢-per-contract floor; rounding is per *order*, to the centicent | Right verdict, wrong mechanism — would not have survived a different market |
| **Significance and cost tested independently** | A series whose CI spanned zero was flagged tradeable for merely exceeding cost |
| **Composition effect** when pooling sweep prints across series | Thin-book series masqueraded as a queue-position effect |
| **Bulk `/markets` listing strips quotes** | 4 of 8,000 markets appeared two-sided; must query per-series |
| **Wrong sample universe** — `status=settled` is ~99% auto-generated parlay junk | First calibration test returned 0 usable rows from 1,208 |
| **Timezone / direction bugs** in the weather test | v1 reported "+64¢/contract" that was pure artifact — caught by its own sanity check |

**Standing lesson: gross edge, fee model, and executable depth are three separate questions.** More
than one result here was right for the wrong reason until checked.

---

## 6. What the operator did

Necessary to record, because parts of this could not be automated:

- **Made every directional call** — when to pivot, what to test next, when to stop.
- **Owned all trading-config changes.** Writes to `settings.json` and paper-reset commands are
  classifier-blocked for the agent by design; the operator applied every one of them by hand from
  supplied key/value pairs.
- **Ran and supervised the live app**, including overnight sessions.
- **Insisted on rigour at the right moments** — notably asking for out-of-sample validation and for
  self-review, which is what caught the maker-strategy overfitting.
- **Declined the shortcut.** When told that "be riskier but never lose" was not a configuration that
  exists, chose the honest path. **The profit bars (`minExpectedNetPnlUsd: 1`, `minRewardRiskRatio: 2`)
  and the shadow quality gates were never lowered to manufacture a passing trade.** That decision is
  the reason the $5,000 is intact.

---

## 7. Final state

- Branch `agent/nemesis-seven-hour-campaign`, fully pushed, working tree clean.
- **806 tests / 112 files green**, typecheck clean.
- Portfolio: `cash: 5000, trades: [], realizedPnl: 0`.
- Flags: `demoMode: false, dryRun: true, liveEnabled: false, autoLiveEnabled: false` — and since
  `5797525` these are cross-checked against a certificate at load rather than trusted verbatim.
- Raw research captures are gitignored as regenerable; the analyzers are committed.

**Known dangling threads** (recorded, not defects worth fixing):
- The weather backtest's `min/above` branch is still wrong. No P&L was reported from it.
- The qualification ledger has reached ~156MB and is replayed at every start (~15s). Archiving is
  operator-run and resets the paper ledger.
- Kalshi's official fee PDF could not be fetched to confirm the maker-fee-by-category claim; it rests
  on the repo's fee module plus the series API.

---

## 8. If anyone comes back

Read in this order:
1. This document.
2. `research/2026-08-05/STRATEGY-SEARCH-REPORT.md` — all seven measurements with the numbers.
3. `docs/HANDOFF-NEXT-SESSION.md` — the state at close.
4. `.claude/skills/nemesis-ops/SKILL.md` — the operational runbook, still accurate.

**Do not re-run any of the seven theses without new information.** Re-running a 15% win rate
eventually produces a lucky window; that is how a false positive gets manufactured, not how an edge
is found. The only genuinely unexplored regime is **hold-to-expiry** (§4), and the only edge
category the rig could never test is one requiring **domain knowledge or infrastructure the operator
supplies from outside** — not another parameter sweep.

---

## 9. The actual outcome

NEMESIS was built to answer one question: *is there a tradeable edge here, and can we prove it
before risking money?*

**It answered: no — and it proved it seven times, for $0.**

That is a successful project. The failure mode it was built to prevent is finding this out with
capital, and it prevented exactly that — including the case where the strategy's own headline metric
(realized spread, +5.59¢) said "profitable" while honest simulation said otherwise. Producing seven
falsifiable negatives is harder, and worth more, than producing one unfalsifiable positive.
