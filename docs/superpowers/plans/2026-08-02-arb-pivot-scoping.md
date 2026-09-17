# Arb pivot scoping: correlated-market (within Kalshi) vs cross-venue (Kalshi vs Polymarket)

Status: **scoping complete; A1 measured and FALSIFIED 2026-08-04. See "Validation results" below
before reading the rest of this doc — the recommendation it originally made is withdrawn.**
Written to support a go/no-go decision on which direction to build first, after crypto-lead's
third model iteration produced only a 6-sample shadow read (see `docs/HANDOFF-NEXT-SESSION.md`)
and the operator decided to pivot rather than wait for a clean 50-scored read on the current build.

---

# VALIDATION RESULTS (2026-08-04, ~19:00 PDT) — A1 is dead, and the reason generalizes

Measured against **live Kalshi public API data** (`api.elections.kalshi.com`, anonymous, read-only),
one snapshot of all open markets in `KXBTCD`, `KXETHD`, `KXBTC`, `KXETH` (3 expiries each).
Analysis scripts are in the session scratchpad, not the repo.

## Cost structure — CORRECTED (a first pass of this analysis got the mechanism wrong)

**Superseded claim, recorded so it is not repeated:** an earlier pass asserted Kalshi's fee has a
"1-cent floor **per contract**", so "any N-leg structure costs ≥N cents." **That is wrong.** Read
against `packages/core/src/fees/kalshiFee.ts`: `kalshiFeeForOrder` (:122-133) computes
`multiplier * rate * contracts * P * (1-P)` and rounds up to the **centicent ($0.0001)**, and the
whole-cent rounding (`kalshiFeeForFills` :149-151, `non_direct`) applies **once to an order's
total**, not per contract. The cent floor therefore only binds on very small orders.

Correct per-contract taker cost (multiplier 1, `non_direct`), measured:

| contracts | at P=0.01 | at P=0.50 |
|---|---|---|
| 1 | 1.000¢ | 2.000¢ |
| 10 | 0.100¢ | 1.800¢ |
| 100 | 0.070¢ | 1.750¢ |
| 1000 | 0.070¢ | 1.750¢ |

The real driver is **the rate itself**: `0.07·P·(1−P)` per contract, which is **1.75¢/contract at
P=0.50** and asymptotes there at size. Cheap legs get dramatically cheaper with size; mid-priced
legs do not. Round-trip for a taker at mid prices is therefore ~3.5¢ in fees plus 1–3¢ of spread —
**roughly 4.5–6.5¢ per round trip**, falling to ~2–4¢ at extreme prices where `P(1−P)` is small.
That is the bar any strategy must clear, and it is why fees ran 73.8% of modeled `plannedLoss` in
the earlier crypto-lead economics work.

## Test 1 — monotonicity arb on cumulative ladders: 0 found

`KXBTCD`/`KXETHD` are `strike_type: "greater"` (cumulative "above K" — a CDF), so `P(K)` must be
non-increasing in `K`, and `ask(K1) < bid(K2)` for `K1<K2` would be a free structure. Across all
6 events, fee-inclusive: **zero violations.**

## Test 2 — bracket completeness: not remotely close

`KXBTC`/`KXETH` are `strike_type: "between"` — mutually exclusive, exhaustive range brackets (plus
one `less` and one `greater` tail each), so their prices must sum to exactly $1.

| Event | legs | sum(ask) | fees to buy all | total cost | vs payout |
|---|---|---|---|---|---|
| KXBTC-26AUG0517 | 80 | 1.850 | $0.80 | **$2.65** | $1 |
| KXBTC-26AUG0423 | 188 | 4.700 | $1.95 | **$6.65** | $1 |
| KXBTC-26AUG0717 | 50 | 1.560 | $0.50 | **$2.06** | $1 |
| KXETH-26AUG0517 | 40 | 1.480 | $0.43 | **$1.91** | $1 |
| KXETH-26AUG0423 | 300 | 4.040 | $3.01 | **$7.05** | $1 |
| KXETH-26AUG0717 | 50 | 1.560 | $0.53 | **$2.09** | $1 |

`sum(bid)` ran 0.75–0.91 on the sell side. The bid/ask band straddles $1 correctly with a wide
spread — that spread is the market maker's edge, and it is not available to a taker.

## Test 3 — cross-series consistency: the market is consistent to within ONE TICK

The strongest available correlated-market relationship, and the one A1 was really betting on:
`KXBTCD` (CDF) and `KXBTC` (brackets) settle on the **same index at the same instant**, and their
strikes align exactly (`bracket[floor,cap]` ↔ `CDF(floor-0.01) - CDF(cap)`). So the triple
`YES(low) + NO(high) + NO(bracket)` pays **exactly $2 in every state of the world** — a
model-free, guaranteed-payout structure. Arb iff cost + fees < $2.

| Pair | aligned triples | best gross edge/contract |
|---|---|---|
| KXBTCD × KXBTC 26AUG0517 | 78 | **+$0.010** (exactly one tick) |
| KXBTCD × KXBTC 26AUG0423 | 186 | +$0.010 |
| KXBTCD × KXBTC 26AUG0717 | 48 | **+$0.010** (exactly one tick) |
| KXETHD × KXETH 26AUG0517 | 38 | $0.000 |
| KXETHD × KXETH 26AUG0423 | 298 | −$0.010 |
| KXETHD × KXETH 26AUG0717 | 48 | −$0.030 |

**Best case across 696 aligned triples: exactly one tick ($0.010) of gross edge.** That magnitude is
itself the tell — all three legs are quoted on a 1¢ grid, so a sum landing 1¢ off $2.00 is **price
discretization, not a mispricing**.

**The corrected fee model does make two of these net-positive at size** (fees fall to $0.0087/contract
by C≈100, giving **+$0.0013/contract**), and break-even lands at **C=5** (26AUG0517) and **C=10**
(26AUG0717). The first pass missed this by assuming 1-contract sizing. **But it is not executable,
because the binding leg has no depth:**

| Event | binding leg | available depth | break-even needs | net at executable size |
|---|---|---|---|---|
| 26AUG0517 | `KXBTC-…-B65875` NO | **1.00 contract** | 5 | −$0.02/contract |
| 26AUG0717 | `KXBTC-…-B61250` NO | **0.16 contract** | 10 | −$0.02/contract |

Buying NO consumes the YES bid, and the bracket's YES bid is a **token 1.00 / 0.16 contract resting
order** (which is exactly why its NO ask sits at 0.98/0.97). Maximum executable size is an order of
magnitude below break-even. Even if depth existed, +0.13¢/contract requires **atomic 3-leg
execution NEMESIS does not have** (see A2 findings) and is erased by one tick of adverse move on any
leg.

**Lesson worth keeping: check depth before calling a spread an edge.** The gross number, the fee
model, and the executable size are three separate questions, and this analysis initially got a right
answer from a wrong model — which would not have survived a different market.

## Test 4 — the single-leg "edge" is model error, not market error

The first pass found 3–5 strikes per KXBTCD ladder with apparent positive net edge (up to $0.019)
against the ladder's own fitted lognormal. **That signal is an artifact.** A sign-runs test on the
fit residuals ordered by ascending strike:

| Event | n | R² | residual sign pattern | runs | runs if random |
|---|---|---|---|---|---|
| KXBTCD-26AUG0517 | 18 | 0.9906 | `---+++++++-----+++` | **4** | ~9.5 |
| KXBTCD-26AUG0717 | 18 | 0.9814 | `---++++++++++-----` | **3** | ~9.5 |
| KXBTCD-26AUG0423 | 7 | 0.9983 | `+-----+` | **3** | ~4.0 |

A smooth arc with 3–4 sign runs where ~9.5 is expected under randomness is overwhelming evidence of
**systematic curvature** — the real distribution has fat tails/skew and is not lognormal. A high R²
(0.98–0.99) does not rule this out; it hides it. So the "edge" is the market pricing skew that the
lognormal cannot represent. **Trading it means betting a naive symmetric model against the market's
better, skew-aware pricing — the exact failure mode crypto-lead already died of** (§6/§7 of the
project history: a crude probability proxy diverging from the Kalshi price, where the Kalshi price
was simply the better estimate).

## Why the data is trustworthy

The ladder fits independently recovered an implied spot of **$64,364 / $64,398 / $64,259** across
three unrelated BTC expiries (spread 0.2%), and **$1,873.19 / $1,873.94 / $1,873.55** across three
ETH expiries (spread 0.04%). Three independent regressions agreeing to a fraction of a percent on a
quantity never supplied as input is strong evidence the quotes are real and the fitting is correct.

## Trap caught during this work (worth remembering)

The first run of Test 1 reported **76 "hard arbs"** in `KXBTC`/`KXETH`. All false. Those series are
`between` (a density, hump-shaped around spot), not `greater` (a CDF), so monotonicity does not
apply — the "violations" were the natural shape of a probability density, and the giveaway was the
lognormal fit returning **R²≈0 with negative sigma** while the genuine CDF ladders fit at R²≈0.99.
**Always read `strike_type` before applying any ladder constraint.** Same lesson class as the
long-standing "never assess executability from listing data" trap.

## Verdict and revised recommendation

- **A1 (correlated-market arb within Kalshi): falsified. Do not build.** No monotonicity violations,
  brackets nowhere near summing to $1, cross-series consistency to within one tick, and the only
  apparent single-leg edge is lognormal misspecification. Kalshi's 1-cent-per-contract fee floor
  exceeds the entire measured inconsistency, so this stays dead even with a perfect detector.
- **A2 (two-leg paired execution): do not build.** It is real work (see the feasibility findings
  below) but it is execution machinery for a signal that does not exist. Building it now would
  repeat the documented mistake of building downstream of an unanswered question.
- **Path B (cross-venue) is the only survivor — and it now has a hard quantitative bar.** The Kalshi
  leg still pays the 1-cent fee floor plus spread, so a cross-venue mispricing must clear roughly
  **2–4 cents round-trip** to be tradeable at all. That is the number the observation-only spread
  logger must be measured against; it is no longer a vague "does a mispricing exist" question.

## Honest limits of this measurement

- **One snapshot** (~19:00 PDT, Tue 2026-08-04), not a time series — it cannot speak to persistence
  or intraday variation. It does not need to: the gap between max inconsistency (1¢) and fee cost
  (3¢) is large enough that timing cannot plausibly close it, but a determined re-test should sample
  repeatedly before treating this as absolutely final.
- **Crypto series only.** Index families were not tested — the tickers tried (`KXINXD`,
  `KXNASDAQ100D`) returned zero open markets, so the correct series identifiers still need to be
  found. The fee arithmetic applies to them identically, so a different answer would require them to
  be *far* less efficient than crypto.
- **Retail taker fee tier assumed** (`quadratic`, `non_direct`, taker). A maker or fee-tiered
  participant faces different economics; this conclusion is scoped to how NEMESIS actually trades.

---

Grounded in real prior research, not fresh speculation: `.cursor/memory/nemesis-market-strategy-
research.md` (2026-07-23) already identified both directions as the two proven-edge alternatives
to single-venue momentum and left the choice explicitly undecided. This doc is that decision,
made concrete enough to act on.

## The two things "cross-venue/correlated arb" has been shorthand for

They get worse when treated as one idea — the engineering cost differs by roughly an order of
magnitude and they fail differently if wrong.

| | **A: Correlated-market arb (within Kalshi)** | **B: Cross-venue arb (Kalshi vs Polymarket)** |
|---|---|---|
| Signal | Logically-constrained related Kalshi markets pricing inconsistently with each other (e.g. a strike ladder on one underlying/expiry must be monotonic; adjacent strikes are bounded by the same lognormal the volatility-calibration work already fits) | Same event priced differently on Kalshi vs Polymarket; Polymarket is reported to lead price discovery by minutes |
| New external integration | None — same venue, same feed already in place | A second venue's market data (and eventually order) API, from scratch |
| Is it real arbitrage | Directional relative-value bet on convergence, not a hedge (see "single-leg vs two-leg" below) | Same caveat, plus **no shared settlement** — two fully independent capital pools, no atomic execution |
| Reuses current infra | ~90%: orderbook tracking/coverage, exchange-origin check, confirmation persistence engine, fee model, shadow→pilot→buy ladder, all the 07-27→07-31 data-plane hardening | ~30-40%: only the downstream safety/execution/shadow-gate machinery; the entire feed layer is net-new |
| First-signal timeline | Low — days | High — weeks, and that's before any signal exists to test |

## Path A: correlated-market arb within Kalshi

### A1 — single-leg relative-value entry (recommended starting scope)

This is the buildable-now version: detect a constraint violation, take a **single directional
position** on the mispriced leg, exit on convergence or the existing stop/timeout logic — same
shape as crypto-lead's entries today, just fed by a different edge estimate.

**What's reusable as-is:**
- Orderbook tracking/rotation, exchange-origin timestamp+sequence check, data-plane supervisor,
  main-process/renderer memory guards — none of this is signal-specific.
- `EntryConfirmationEngine`'s persistence/sampling logic (`campaignEconomicIdentity` keying,
  quiet-book handling) — the *mechanism* for confirming an edge survives contact with the market
  doesn't care what produced the edge estimate.
- `tradeEconomics.ts` / `kalshiFee.ts` — fee-aware reward/risk math is signal-agnostic.
- The shadow → pilot → paper-buy ladder and its acceptance gates (`shadowMinScored`,
  `shadowMinWinRate`, etc.) — apply unchanged to a new signal's ledger.
- **Most valuable reuse: the ladder-grouping and lognormal-fitting code from `1c2794d`/`22fcd6f`.**
  That work already (a) groups live markets into same-underlying/same-expiry ladders keyed on
  `event_ticker` (the exact grouping A1 needs), and (b) fits a lognormal to the ladder and can
  report a model price for every strike. A no-arbitrage monotonicity/bound check on top of an
  already-fitted ladder is a small addition on top of existing, tested code — not a new subsystem.

**What's net-new:**
1. A constraint-violation detector: given a fitted ladder, compute each strike's model-implied
   price and flag any live quote deviating from it by more than round-trip cost (spread + fees +
   a safety margin) — conceptually similar to the existing `ladderSigmaRatio` band check in
   `crypto-lead.ts`, but produces a *tradeable signal* instead of an *invalidation gate*.
2. A discovery/candidate-surfacing path keyed on "ladder violation detected," separate from the
   current flow-momentum trigger — `buildThesesFromMarkets` (or wherever candidates currently
   enter the pipeline) needs a second entry point, since the trigger condition is structurally
   different (a standing mispricing, not a flow event).
3. Tests proving the no-arb bound is computed correctly (monotonicity direction, cost margin)
   and doesn't fire on noise — same rigor bar as the volatility-calibration test suite.

**Open questions before writing code:**
- Which ladders are wide/liquid enough for this to matter? (KXBTCD crypto-daily is the obvious
  first target since the fitting code already targets it; index families are untested.)
- Does a persistent, slow-decaying mispricing exist at all in Kalshi's own strike ladders, or is
  the market already efficient at internal consistency even where it's inefficient on outright
  direction? This is genuinely unknown — nothing in this project has measured it yet.
- Should this share `entryQualification` bars with crypto-lead, or get its own (operator/
  classifier-blocked either way, per the standing rule)?

**Rough scope:** a few focused sessions to first shadow-scored candidate (signal + discovery
path + tests), then the same 50-scored/1-day gate as any other thesis for a verdict. Cheapest,
fastest way to find out if this project's next thesis has any real edge.

### A2 — true two-leg paired execution (not recommended yet)

The "real arbitrage" version: buy the underpriced leg *and* sell/short the overpriced leg
simultaneously, capturing the spread with a hedged position instead of a directional bet.

**Why this is a bigger, separate lift:**
- The current portfolio model (`paper-portfolio.json`: flat `positions`/`trades` arrays) has no
  concept of a linked pair — P&L, sizing, and stop logic all assume one position at a time.
- Real execution risk appears that A1 doesn't have: if the cheap leg fills and the expensive leg's
  price moves before the second order lands, you're now holding an unhedged directional position
  by accident — worse than A1's honest single-leg bet, because it looks hedged and isn't.
- Kalshi's contract structure may not even support clean "sell" on both legs the way a true spread
  trade needs — needs research into whether the existing order-submission path supports it at all.

**Recommendation:** do not build A2 until A1 has produced enough shadow evidence to know the
underlying constraint-violation signal has real edge. Building two-leg execution risk machinery
around a signal that turns out to be noise is the same mistake the last three weeks were spent
fixing (bugs downstream of the actual open question).

**A2 feasibility, measured 2026-08-04 (read-only codebase audit).** Answered concretely so the
cost is on record even though A1's falsification makes it moot for now:

- **Side selection is already general.** `LiveOrderRequest.side: 'yes'|'no'`
  (`packages/execution/src/liveOrderAdapter.ts:19`) is freely chosen per order, and open vs close
  are distinct paths (`createLiveOrderRequest:56` / `createLiveCloseOrderRequest:71`). Kalshi has no
  true short, and "buy the NO side" is already the correct modeling of one — **no new plumbing
  needed for the directional half of a hedge.**
- **No pairing concept anywhere.** `PaperPosition` (`packages/core/src/paper/types.ts:56-102`) is
  flat; grep for `linkedPosition|positionGroup|parentPositionId|legId|multiLeg` returns zero hits.
  Positions are identified by `(ticker, side)` in `PaperDesk.openPosition`
  (`packages/execution/src/paperDesk.ts:39-41`).
- **`mutualExclusionBlock` (`packages/execution/src/executionRouter.ts:286-306`) actively blocks**
  holding opposite sides of the same ticker. It exists to catch the degenerate same-market hedge
  (a guaranteed loss), and would need an explicit carve-out for an intentional cross-market pair.
- **No atomicity primitive.** Grep for `rollback|atomic|compensat|two-phase|saga` finds no
  mechanism. `PaperExecutionCoordinator` (`apps/desktop/electron/paperExecutionCoordinator.ts:3-24`)
  is a per-`(ticker,side)` mutex only — it cannot reserve two keys. If one leg fills and the other
  fails, **nothing detects or unwinds the resulting naked position.**
- **Biggest design gap: the auto-close engine.** `evaluateAutoClosePosition`
  (`packages/execution/src/autoCloseEngine.ts:221`) keys every exit rule on a single `positionId`
  (`AutoCloseStateSnapshot.autoCloseStateByPosition`). Its ~15 exit branches are per-position, so it
  could close the profitable leg on a giveback trim and leave the hedge naked — **silently
  destroying the hedge relationship.**
- **Sizing would double-count risk.** `decideCapitalAllocation` (`packages/capital/src/allocator.ts:142`)
  sizes one card against `maxPositionUsd`/`maxPortfolioConcentrationPct`/`maxKellyFraction` with no
  notion of offsetting legs; `checkConcentration` (`:230-245`, `maxPerEvent=2`) would treat a hedge
  as two unrelated bets.
- **P&L is the one thing that works free.** `markToMarketPortfolio`
  (`packages/core/src/paper/pnl.ts:32-45`) sums independent per-position marks keyed
  `` `${ticker}:${side}` `` — correct for a pair by construction.
- **Signal layer has no correlation concept at all** — `ThesisCard`
  (`packages/core/src/types.ts:346-383`) is single-ticker/single-side with no pair field.

**Net:** mechanical plumbing (group ids, reservation over two keys, reconcile keyed by
`(ticker,side)`) is modest; the genuine design work is a two-phase commit across legs, pair-aware
risk sizing, and a pair-aware exit engine. Non-trivial, and correctly deferred.

## Path B: cross-venue arb (Kalshi vs Polymarket)

**What's net-new (most of it):**
1. A Polymarket market-data client — their API surface (CLOB REST + WS) is entirely different
   from Kalshi's. Realistically this means repeating a comparable-scope hardening effort to what
   Kalshi's feed took this project roughly three weeks to get right: sequencing, dead-socket
   recovery, provenance, freshness bounds — none of that transfers, it has to be rebuilt against
   a different protocol.
2. A contract-mapping/matching layer: Kalshi and Polymarket do not share strike conventions,
   resolution sources, or expiry granularity for "the same" event. Identifying that two contracts
   on two platforms represent the same underlying probability is a data/research problem before
   it's an engineering one — there's no existing code or research in this repo that's solved it.
3. **No shared settlement.** A Kalshi position and a Polymarket position are two fully independent
   legs: independent capital, independent execution latency, independent counterparty risk. This
   is a real difference from A1/A2, not just more code — it means genuine two-sided execution risk
   with no way to make it atomic, ever.
4. A second capital/custody surface. Polymarket settles in crypto (on-chain, wallet-custodied),
   Kalshi in USD (CFTC-regulated, cash-settled). This is an entirely different operational and
   custody model NEMESIS has never touched — wallet management, on-chain transaction signing, gas,
   a different regulatory posture. This alone is a materially larger scope decision than anything
   built so far, independent of the trading logic.

**Honest minimum viable first step, if this path is chosen:** an **observation-only** mispricing
logger — pull public mid-prices from both venues for a matched set of events, log the spread over
time, and answer "does a capturable, persistent mispricing actually exist and how fast does it
close" **before** writing a single line of execution code or touching custody. This de-risks the
entire path cheaply: if Polymarket's reported lead time doesn't show up in real matched data, the
rest of Path B is moot and should be dropped before the expensive parts (feed hardening, custody)
are built.

**Rough scope:** even the observation-only MVP is a multi-week effort (new feed integration from
scratch). A funded execution pilot is materially further out and carries operational complexity
(custody, on-chain signing) this project has no precedent for.

## Recommended sequencing

1. **A1 first.** Cheapest possible test of whether this project's next thesis has real edge, and
   it reuses essentially the entire infrastructure investment of the last three weeks. Days to a
   first shadow-scored candidate, same 50-scored/1-day gate to a verdict as any other thesis.
2. **If A1 shows no edge either:** the honest read at that point is that Kalshi is internally
   efficient at the layer NEMESIS can observe, which is itself useful information — it would argue
   *for* Path B's observation-only MVP (a genuinely different, external information edge) over
   continuing to search for more single-venue signals.
3. **A2 and Path B's execution phase stay explicitly out of scope** until their respective
   cheaper first steps (A1's shadow read; B's observation-only spread log) produce real evidence
   of edge. Building execution machinery ahead of a proven signal is the exact pattern this
   project spent three weeks unwinding on crypto-lead — bugs found downstream of an unanswered
   question about whether the thesis itself works.

## What this doc deliberately does not do

No code, no settings changes, no new signal thresholds. Per standing rules: profit/risk bars are
operator/classifier-owned regardless of which thesis feeds them, and nothing here proposes
touching `settings.json`. This is scoping only — the next session should start by validating the
A1 open questions above (ladder liquidity, whether internal mispricing exists at all) before
writing the constraint-violation detector.
