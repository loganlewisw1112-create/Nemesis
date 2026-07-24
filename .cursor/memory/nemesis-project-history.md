---
name: nemesis-project-history
description: NEMESIS (KRYPT/nemesis, Electron/Kalshi trading app) full technical history — soak-stall bug (fixed), R10 gate ladder (fixed/proven), and the "0 paper trades ever" investigation (in progress, paused 2026-07-22 — see HANDOFF-2026-07-22.md)
metadata:
  node_type: memory
  type: project
  originSessionId: 60d8a0d4-2202-4553-be24-207d11484146
  modified: 2026-07-22T17:43:08.907Z
---

NEMESIS lives at `KRYPT/nemesis`, branch `agent/nemesis-seven-hour-campaign`. It's an
Electron desktop app that trades Kalshi prediction markets, built around three concentric
goals reached in this order: (1) survive a long unattended soak without crashing, (2) pass
"R10" — a formal readiness/soak/evidence gate that's the prerequisite for any real-money
use — and (3) prove the strategy actually finds and closes profitable paper trades before a
small ($10) live pilot is justified. Goal 1 and 2 are done. Goal 3 is mid-investigation,
paused. See [[nemesis-working-notes]] for lessons on *how* to work on this codebase, and
`output/r10-scheduled/HANDOFF-2026-07-22.md` (local file, not memory) for the exact resume
point.

## 1. The renderer heartbeat stall (root cause of ~40 prior failed repair attempts)

Soak/R10 runs kept "crashing" with a different symptom every time. Root cause, found
2026-07-20: **one bug**. The runtime-health watchdog invalidates a run on a renderer
heartbeat gap > 15s (self-heartbeat + main→renderer probe share the JS thread with React,
`preload.ts:24-43`; thresholds `rendererHeartbeatMonitor.ts:31-36`). The gap is CPU/event-loop
starvation (not memory — working set stayed flat ~55MB), caused by the append-only
seven-hour campaign ledger being `structuredClone`d **twice per orderbook delta**:
`allEvents()` = `structuredClone(this.events)` (`sevenHourCampaign.ts:380-382`), called twice
in `SevenHourCampaignStore.record()` (`sevenHourCampaignStore.ts:56,58`), reached via
`campaignSnapshot()` on the per-delta hot path (`main.ts:5931/5963/6001`) plus an fsync per
append. The growing snapshot was also raw-`broadcast()` to the renderer every 1-5s
(`main.ts:4060-4076`) with no memoization, amplifying the cost. Cost scaled with soak elapsed
time, so failures looked stochastic (stalls at 6/21/26 min in different runs).

**Why ~40 prior commits never found it:** they only reworked feed/transport readiness
accounting or widened watchdog tolerance — never touched the thread-blocking clone. Widening
`heartbeatMaxAgeMs`/grace is explicitly wrong here; the watchdog is correct, the thread block
was the bug. Full plan: `KRYPT/nemesis/docs/soak-stall-root-cause-and-plan.md`.

**Fixed, committed `95b8dda`:** replaced the two `allEvents()` clones with the mutation's own
returned created-events. Confirmed solid across every subsequent run: renderer
`unresponsiveForMs:0`, working set flat/down. **This bug is dead — do not reopen it, and do
not widen the heartbeat watchdog for anything found later; every later blocker was a
different mechanism.**

## 2. The R10 gate ladder (readiness hold → full-25 soak → gap-closure report) — FULLY PROVEN

Gate order: `run-production-readiness.ps1` (10-min continuous hold) → `run-production-soak.ps1`
(5-min warmup + scored duration, full 25-orderbook bar) → `generate-r10-gap-closure-report.cjs`.
Five real blockers were found and fixed in sequence, each verified against measured data before
moving to the next. All are now resolved; see "Current proven state" below.

**a) `kalshi-rest` freshness TTL too tight** — fixed early (`389dfdb`): REST health probe ticks
every 20s but the TTL was 30s, so one delayed poll flipped `qualificationReady` false and
triggered a spurious recovery/invalidation. TTL raised 30s→60s in `FeedHub.getFeedHealthSnapshot`
(`FeedHub.ts:248`), mirroring an earlier trade-tape fix (`a6ce478`).

**b) Orderbook coverage decay (25→13 tracked, non-obvious root cause)** — soak reported
`finalTrackedOrderbookTickers:13` (need 25), `reconnects:0` (**not** a WS drop),
`typedFailureClasses:["rate_limit"]`. Real cause: the every-20s reverify loop burst all 25
markets' REST re-verification at once → Kalshi 429s → `bookFetchCoordinator`'s per-ticker
exponential backoff (`bookFetchCoordinator.ts:56,117-126`, cap 5min) outlasted the 90s
provenance TTL → `selectVerified` (`kalshiOrderbookStream.ts:275`) dropped the ticker →
tracked set decayed and stuck. **Fixed, committed `8970358`:** `pacedDispatch.ts` spreads
each reverify cycle across ~75% of the interval (adaptive gap, ≤3 concurrent) instead of a
5-wide burst; backoff capped below the 90s TTL. Verified: held 25/25 for a full 30+ min soak
at market hours with zero decay.

**c) Readiness-hold reconnect intolerance** — the continuous hold hard-failed on *any* single
sample where a condition dipped, a WS generation changed, or a transport-fault counter
incremented — meaning one self-healed WS reconnect (routine on Kalshi) instant-failed the
whole 10-min hold. **Fixed, committed `8443bc7`:** absorbs exactly one such episode per hold
(45s grace window, must fully re-qualify, re-baselines generation/fault-counters on recovery,
extends the hold by the paused interval so it still proves a full window; a second episode or
non-recovery still fails). Receipt gained `reconnectsAbsorbedDuringHold`. Verified working:
one run held ~4 min/50 samples on a hold that would have died instantly pre-fix, then later a
run passed cleanly with `reconnectsAbsorbedDuringHold:1`.

**d) Renderer memory-slope false positives at the full 25-market bar (two-stage fix)** — only
appeared once orderbook coverage was fixed and a full 33-min soak could actually run to
completion. The 30-min least-squares slope guard (`rendererMemoryMonitor.ts`, 2%/hr limit)
invalidated runs whose renderer was genuinely flat (127-141MB band, no net growth between
first/second half of the window) because: (i) a single phase-aligned high sample stuck the
"unstable-growth" status permanently (the *same* false-positive class already fixed once for
a sibling 10-min gate, commit `b4e6e43`, from before this session), and (ii) even after fixing
that, the 2%/hr limit itself (~1.3MB over 30min) sits *below* the renderer's own GC noise floor
(±6MB sample-to-sample) at full 25-market load — so a genuinely flat renderer can read
4-11%/hr slope purely from where the noisy baseline happens to anchor.
  - **First fix, committed `7097b4d`:** require the slope to exceed 2%/hr across
    `consecutiveSlopeSamples:3` readings (not one) before invalidating — mirrors the existing
    384MB consecutive-warning pattern. Helped (absorbed isolated spikes) but **insufficient
    alone** — a genuinely flat-but-noisy renderer can still sit over the raw threshold for 3
    straight windows.
  - **Second fix, committed `60a5d3a`:** additionally require *real* net growth — median of
    the second half of the slope window minus median of the first half must exceed
    `slopeMinNetGrowthFraction:0.03` (3% of baseline) — before the slope breach counts at all.
    Verified: a flat/noisy 127-140MB trace with 1.1% net growth correctly stays `stable`; a
    genuine linear leak still trips it. **This was the breakthrough** — a full 33-min, full-25
    soak then completed in perfect health (`finalRuntimeState:healthy`,
    `runtimeInvalidatedSampleCount:0`, `rendererBlockedSampleCount:0`, `cleanShutdown:true`).
  - The absolute backstops (150%-of-baseline, 384MB p95, 512MB hard cap) were never touched and
    still catch a real fast leak on a single sample.

**e) Soak-runner acceptance thresholds stricter than the app's own (now-correct) model** —
committed `5e4c73f`: the soak *runner* (`run-production-soak.ps1`) had its own raw
`slopePerHour>0.02` re-checks (no net-growth qualifier) and a `feedReadinessCoverage<0.995`
floor with no reconnect tolerance, so even a run the *app* considered perfectly healthy could
still fail the runner's stricter bookkeeping. Fixed to mirror (b) and (d)'s logic: the
runner's slope checks now also require net growth >3% of baseline, and feed-coverage
tolerates one self-healed reconnect (2-sample slack) when `orderbookReconnects<=1` and the
feed was ready at cutoff. Validated the net-growth math in isolation before shipping (noisy
data → 1.89% → correctly passes; synthetic linear leak → 20% → correctly fails).

**Current proven state:** all five fixes are correct, committed, and each individually
verified against real measured soak data. Commits (in order): `95b8dda`, `389dfdb`, `8970358`,
`8443bc7`, `7097b4d`, `60a5d3a`, `5e4c73f`. A full 33-min, full-25-market soak has completed
cleanly (proof it can be done); the *soak-acceptance-alignment* fix (`5e4c73f`) specifically
was validated in isolation but never got to complete a full end-to-end soak run afterward
before attention moved to external Kalshi problems (below) and then to the paper-trading
question (Section 3) — if resuming R10 work, that's the one remaining thing to actually watch
happen live, though nothing suggests it wouldn't work.

**A one-day detour worth remembering:** on 2026-07-21 Kalshi itself had a genuine intermittent
outage (verified via direct curl: general internet fine, Kalshi oscillating
healthy↔all-feeds-down every few minutes for hours, confirmed independent of NEMESIS). Several
runs failed purely because of that — not a code problem. Two lessons from diagnosing it: (1)
**the intermittency was on Kalshi's WebSocket layer specifically, not REST** — a REST-only
health probe reported 5/5 while the WS ticker+orderbook transports were dropped, so a
REST-based "wait for stability" watcher cannot predict or avoid a WS-layer outage; (2) an
autonomous retry loop (`output/r10-scheduled/run-r10-until-pass.ps1`) was built to wait for a
stable window and auto-launch — reusable pattern if this recurs. Also built and still in
place: `output/r10-scheduled/run-r10-chain.ps1` (readiness→soak→report in one script) and a
now-disabled Windows scheduled task `NemesisPaperMorning` for an unattended market-hours
re-run.

**CI RED BADGE — ROOT-CAUSED AND FIXED 2026-07-22 (two independent causes).** Prior sessions kept
noting "the red badge is just an artifact-quota infra issue, not code" but never fixed it, so it
recurred every run. Both causes are now fixed and CI is **green** (run 29969859352):
- **Artifact storage quota.** The `Upload CI evidence` step bundles the packaged Windows installers,
  so each run stored ~675MB with **no retention limit**; 8 bundles from Jun 29-Jul 4 had filled
  3.37GB, after which every `CreateArtifact` failed and reddened a build whose every real gate
  passed. Fixed in `0d4e90a`: the step is `continue-on-error: true` (evidence storage is diagnostic,
  not a gate) plus `retention-days: 7` so it can no longer accumulate. The 8 stale bundles were
  deleted (3.37GB -> 0). NOTE GitHub recalculates quota usage every 6-12h, so uploads may not
  actually resume until that lands — and `continue-on-error` means a failed upload no longer
  surfaces, so verify uploads explicitly if evidence matters for a given run.
- **A flaky wall-clock latency test, hidden behind the quota failure.**
  `packages/capital/src/allocator.fast.test.ts` asserted `decision.latencyMs < 1`. The allocator
  runs ~0.1ms idle, but under a loaded CI runner or full parallel local suite it reads 1.0-1.1ms —
  CI measured 1.0015, local measured 1.0309, both on unchanged code. Passes in isolation, fails
  under load: a coin flip, not a gate. Raised to 25ms in `e5d7d1f` (kept, not deleted — its real
  intent is catching an algorithmic regression, which is orders of magnitude, not micrograms).
  **This is the THIRD instance in this repo of "correct guard, threshold below its own noise
  floor"** — see also the renderer memory-slope guard (`7097b4d`/`60a5d3a`) and the 2%/hr sibling
  (`b4e6e43`). When a guard fails intermittently on unchanged code, suspect the threshold vs the
  noise floor before suspecting the code.

**Repo/CI notes:** branch was 96 commits ahead of origin and unpushed as of 2026-07-20 night;
pushed through `be36bda` that night (README + status doc). The 5 commits after that
(`7097b4d`..`11ea08b`, spanning both R10 and Section 3 work) are **still local-only,
unpushed** as of this writing. CI run on `be36bda` showed `failure`, but the *only* failed
step was `verify-package > Upload CI evidence` — a GitHub Actions **artifact storage quota**
exhaustion (infra/billing, resets every 6-12h), not a code failure; build/tests/typecheck all
passed. Don't trust a red CI badge at face value here without checking which step actually
failed.

## 3. Paper trading: "0 trades, ever" — investigation in progress, PAUSED 2026-07-22

Separate question from R10: given the app is stable, does the strategy actually find and
close a profitable paper trade? Answer at the start of this investigation: **it has made zero
paper trades since the portfolio was created on 2026-07-14** — not one, at any hour, under
any config tried before today.

**Two wrong turns early on, corrected:**
- Assumed `demoMode` meant simulated market data. **Wrong** — NEMESIS's feeds are *always*
  real Kalshi production data (hardcoded `'production'` throughout `main.ts`); `demoMode`
  actually just gates whether production markets get re-verified, so in demo mode every
  thesis silently stays stuck at `uncertain`/research-only forever. Turning it off (the user
  did this via the in-app UI) was necessary and correct.
- Assumed a `useProductionApi` UI toggle existed and told the user to look for it. **Wrong**
  — it's a dead field (`packages/core/src/types.ts:267`, default `false`), never read by any
  feed-selection code, no UI control anywhere. There was nothing to toggle; I sent the user
  looking for a phantom setting.
- Toggling `demoMode`/`autoClose` trips a strategy-config-hash **pause**
  (`main.ts:1955-1961`, blocks execution at `2695-2698`) that the in-app Reset button does
  *not* clear on its own — needed `npm run paper:archive-reset -- ARCHIVE_AND_RESET_PAPER`
  (or the in-app confirmation-prompt Reset, which does the same thing) with the app stopped,
  which re-baselines the validation store to the current config and clears the pause.

**Bar analysis — proved the economic/persistence thresholds were NOT the blocker.** Pulled
2,887 historical `entry_confirmation_observed` events: 587 cleared the $1 net-reward bar, 693
cleared the 2:1 reward/risk bar, 173 cleared *both* plus stressed-profit>0 — genuine
qualifying opportunity existed regularly. Those 173 all died at **persistence**, not
economics: `entryQualification` required 6 samples over a 30s window with a book no older
than 1s and ≥0.7 edge retention; edge retention was fine (median 1.00) but no candidate ever
reached 6 samples/30s (max observed: 4 samples/25.9s) because the 1s book-freshness
requirement kept breaking the sample sequence on Kalshi's normal jitter (776 "stale book"
aborts). **So the mis-calibrated bar was persistence tuned to a hypothetically-perfect feed —
never the profit bar, which correctly stays untouched throughout this entire investigation**
(`minExpectedNetPnlUsd:1`, `minRewardRiskRatio:2`, `strictProfitMode` — never lowered).
Recalibrated (user edited `settings.json` directly, since I'm classifier-blocked from all
trading-config writes — see [[nemesis-working-notes]]): `entryQualification.minSamples 6→4`,
`minWindowMs 30000→15000`, `maxBookAgeMs 1000→2000`.

**Next wrong turn, also corrected: assumed the remaining blocker was Kalshi feed flakiness /
time-of-day.** After the calibration fix, a 90-min evening session still produced 0 trades —
all 97 candidates rejected at "confirmation requires an exchange-origin book timestamp and
sequence" (`entryConfirmation.ts:148`), a data-integrity check that fires *before* economics
or persistence are ever evaluated. At the time this looked like the same Kalshi evening-WS
wall that blocked R10 (Section 2's detour) — reasonable given the timing, but wrong, or at
least incomplete: a market-hours re-run the next morning hit the *exact same* rejection at the
*exact same* rate, ruling out time-of-day as the explanation.

**Actual root cause, found 2026-07-22 morning:** the orderbook WebSocket only actively tracks
≤25 tickers at a time (`ORDERBOOK_TRACKING_LIMIT`), rotating a handful in every 5 minutes
(`ORDERBOOK_ROTATION_INTERVAL_MS`) — far slower than the flow-driven candidate pipeline
surfaces genuinely new tickers (32-39 distinct tickers seen rejected in a single session).
Any candidate whose ticker isn't currently one of the 25 falls back to a **REST** orderbook
snapshot (`fetchBookForCard`→`bookFetchCoordinator`→`fetchOrderbook`), and Kalshi's REST
snapshot endpoint carries **no match-engine sequence number** — only the WS delta stream does
(`parseOrderbook`, `packages/core/src/kalshi/client.ts:216-218` genuinely tries to parse one
from the REST response but there's nothing there to find). So `sourceTimestamp`/`sequence`
come back undefined and `entryConfirmation.ts:147-148` correctly rejects it — this happens
**every single time**, independent of profit, persistence calibration, or feed health/hour of
day. This is why paper trading has never worked on any day at any hour: the vast majority of
candidates were never able to reach a verifiable book at all.

**Two fixes committed against this, in sequence, each measured before moving to the next:**
- **`8959e9f`** — `fetchOrderbookWithPriorityTracking`: when a candidate's ticker isn't
  WS-tracked, immediately call `kalshiOrderbookStream.track([ticker])` and wait up to 3s for a
  real sequenced snapshot before falling back to REST. **Verified insufficient alone** — a
  30-min live-monitored window showed 100% of candidates still hit the exchange-origin
  rejection, because `desiredOrderbookTickers()` deliberately fills every idle slot with
  "most-active fallback" markets specifically to keep the tracked set busy, so the 25-slot
  cap is essentially *always* full and the "add only if room" branch almost never fires.
- **`11ea08b`** (current HEAD) — extended it: when at capacity, **evict** the tail of
  `orderbookTrackedTickers` (provably the lowest-priority occupant, since
  `desiredOrderbookTickers()` builds that array in priority order: campaign-critical →
  entry-eligible-by-edge → discovery signals → most-active fill) to make room for a candidate
  that has already cleared economics and is attempting a real entry right now. Uses
  `kalshiOrderbookStream.replaceTracked(...)` (which properly removes as well as adds),
  not `track()` (add-only). Bounded to one eviction per untracked candidate;
  `entryQualification.maxPendingCandidates` (8) caps how many can be in flight. Accepted,
  named tradeoff: a different pending candidate whose ticker occupies the evicted slot loses
  its in-progress confirmation samples and restarts them.

**Measured result of the eviction fix (2h observed window, 2026-07-22 08:06-10:07 PT): real
but partial progress.** Rejection rate on the exchange-origin check dropped from 100% to
**87.5%** (56 of 64 post-fix confirmation attempts) — meaning **12.5% of candidates cleared
that gate for the very first time ever** in this project's history, and new *later*-stage
rejections appeared for the first time too (fee-policy-unknown ×4, entry-book-stale ×2,
target-reward-below-minimum ×2) — proof some candidates are now reaching real economic/data
evaluation past the exchange-origin gate. But still **zero trades, $0 realized P&L**, and the
87.5% failure rate was flat across the full 2 hours rather than improving — which argues
against a pure timing issue (a slow-but-legitimate subscription should show *rising* success
over time as more tickers "warm up"; it didn't move at all).

**The likely deeper gap, not yet fixed or fully diagnosed:** `kalshiOrderbookStream`
constructs its **own internal** `ProductionMarketProvenanceStore`
(`kalshiOrderbookStream.ts:215`), entirely separate from the broader `productionMarketRecords`
map in `main.ts` that gates general candidate eligibility. `replaceTracked`/`track` silently
drop any ticker lacking a valid record in *that specific internal store*
(`selectVerified`/`ProductionMarketProvenance.has`, `productionMarketProvenance.ts:118-129`) —
adding a ticker to the tracked *list* doesn't help if the underlying stream's own provenance
check rejects it, no matter how long you wait. There IS a syncing path
(`recordProductionUniverse`, `main.ts:4274-4291`, calls
`kalshiOrderbookStream.recordProductionMarkets(...)` for every record it keeps), so tickers
*should* generally have valid provenance in both places — but evidently most live
flow-driven candidate tickers still don't have one at the moment they attempt entry, and
*why* that sync gap exists was not yet diagnosed when this was paused.

**Status at pause (2026-07-22, ~10:35am PT):** NEMESIS still running live on commit
`11ea08b` — real Kalshi data, paper-only (`demoMode:false, dryRun:true, liveEnabled:false,
autoLiveEnabled:false, killSwitchActive:false` — live trading is hard-locked, no real money at
risk under any outcome here). Portfolio unchanged all day: `cash:5000, realizedPnl:0,
openPos:0, trades:0`. Calibration in effect: `minSamples:4, minWindowMs:15000,
maxBookAgeMs:2000`; profit bar untouched. Three options were posed to the user and none has
been chosen yet: (1) keep investigating the provenance-store gap (likely needs temporary
diagnostics on why most candidate tickers lack internal WS-stream provenance, then a targeted
fix — probably proactively calling `recordProductionMarkets`/verifying the candidate's ticker
synchronously at buy-time using data already available from the thesis/discovery layer,
*before* priority-tracking it); (2) pause here — real measured progress was made, reasonable
stopping point; (3) something else. **User chose to pause and switch accounts before
deciding.** Full detail, exact repo/process state, and the same three options are also written
out in `output/r10-scheduled/HANDOFF-2026-07-22.md` — read that first when resuming, it's the
authoritative "what to do next" doc; this file is the "how did we get here and why" doc.

## 4. Resumed 2026-07-22 midday — both structural blockers CLEARED, funnel is now purely economic

Option 1 (diagnose the provenance gap) was chosen. Instrumenting the decision point settled it
immediately instead of theorizing: an env-gated trace (`NEMESIS_PRIORITY_TRACK_TRACE_PATH`,
mirroring the existing `NEMESIS_RUNTIME_HEALTH_TRACE_PATH` pattern) plus two read-only accessors
on the stream (`hasProductionProvenance`, `isTracked`) recorded, per untracked candidate, whether
`replaceTracked` actually admitted it.

**Result: 3/3 pre-fix samples came back `admitted:false`.** The stream refused every candidate
outright — priority tracking was subscribing to nothing and then waiting the full 3s for it. Not
a timing problem, which is exactly what the flat 87.5% rate over two hours had implied. Root
cause confirmed as suspected: `track`/`replaceTracked` filter through the stream's **own**
`ProductionMarketProvenanceStore`, fed only by the periodic universe sweep, so a flow-driven
candidate discovery hasn't covered (or whose 90s provenance lapsed) is rejected no matter how
long you wait.

**This also exposed `11ea08b` as net-destructive, not merely useless:** it evicts the tail
ticker, `replaceTracked` then drops the incoming ticker for lack of provenance, and
`replaceTracked` deletes the books of removed tickers — so every attempt discarded a live
tracked book and gained nothing.

**Fix 1, committed `00b2786`:** `ensureProductionProvenance` hydrates the candidate's ticker from
the single-market production endpoint and files it through `recordProductionUniverse` (the path
that populates *both* stores), **before** any membership change; if hydration fails the candidate
falls through to REST without evicting anyone. Provenance still earned from a verified production
response (environment + HTTP 200 + transport-returned base URL), same check the GEA path uses.
Measured over 17 samples: **admitted 0/3 → 17/17**, 11 reaching a real sequenced book, median
wait 3055ms (dead) → ~1300ms. Funnel: exchange-origin rejection **87.5% → 17.6%**.

**Fix 2, committed `a5f338b`:** clearing that immediately surfaced the next wall — "account or
series fee policy is unknown" became the top rejection (12 of 34). Single cause: Kalshi returns
`fee_type: "quadratic_with_maker_fees"` (seen on `KXATPMATCH`) and the resolver matched the
literal `'quadratic'`, failing everything else closed. Verified against Kalshi's published
schedule rather than assumed, since it's fee math: takers pay
`multiplier * 0.07 * C * P * (1-P)`, makers a quarter of that where charged at all — both rates
already encoded as `KALSHI_TAKER_RATE`/`KALSHI_MAKER_RATE`. The variant differs *only* in
charging makers; taker math is identical and NEMESIS enters as taker. Kept as an explicit
two-entry allowlist in the fees module (not a prefix match) with a test proving an unrecognized
quadratic-looking type still fails closed. `kalshiAccountPrecision` is `non_direct`, so the other
`isKnownKalshiFeePolicy` gate was already satisfied.

**State after both fixes (8 attempts observed): every structural blocker is gone.** Zero
exchange-origin rejections, zero fee-policy rejections. The only remaining reasons are genuine
economics: "target net reward is below the minimum" (6), "target reward-to-risk ratio is below
the minimum" (1), "entry book is stale" (1). Portfolio still `trades:0` — but for the first time
the pipeline evaluates candidates end-to-end, so zero trades now means *the strategy is declining
unprofitable opportunities*, which is the profit bar working as designed rather than a structural
block. **Do not lower `minExpectedNetPnlUsd:1` / `minRewardRiskRatio:2` in response to this** —
the whole point of the paper test is to find out whether real edge exists at an honest bar.

**Economics validated 2026-07-22 afternoon (31 candidates) — the bars are REACHABLE; persistence
is the new frontier.** Before trusting any of this, the fee model was validated against recorded
data: a first attempt reproduced only 2/31 recorded `entryFeesUsd` because it missed that
`accountPrecision: 'non_direct'` rounds the fee **up to the whole cent**
(`kalshiFee.ts` balanceRoundingFeeUsd), not to the centicent. Corrected, it reproduces **31/31**
and the `targetReward/plannedLoss == rewardRiskRatio` identity holds 31/31. Findings on that
validated basis:
- **7 of 31 candidates (23%) clear BOTH bars** (`reward >= $1` and `R:R >= 2.0`) at shipped
  sizing — 8/31 clear R:R alone, 9/31 clear reward alone. An earlier in-session claim that 2:1
  was "structurally unreachable, needs ~12c edge" was **WRONG** — it came from a 15-sample window
  and an unvalidated fee model. Measure before concluding; this file's own precedent (blocker (b))
  should have prompted that sooner.
- **Position sizing is NOT the lever.** R:R is scale-invariant (reward and risk both scale with
  contracts), so raising the ~$10 `pilotMaxEntryRiskUsd` cap moves median reward $0.75 -> $2.37 at
  $30 but "clears both bars" only 7/31 -> 8/31. Rewriting the absolute-dollar bar as a rate, or
  raising the cap, would NOT have produced trades. Decided against on measurement, not taste.
- **Stop geometry:** `stopPrice = entryPrice - 0.01` is hardcoded (`tradeEconomics.ts:95`), not
  volatility-derived. The stop is 1c against a **median 4c spread** — inside the spread, so as a
  risk model it understates realistic adverse movement. Fees are **73.8%** of modeled
  `plannedLoss` at that stop. Widening the stop makes R:R strictly worse (2c -> 0/31 clear 2.0;
  5c -> 0/31); tightening toward zero raises it (14/31). Worth revisiting as a correctness
  question, but it is NOT what blocks trades.
- **Persistence is now live for the first time in the project's history** — reason "collecting
  persistent executable entry evidence" appeared 4 times, with `samples` reaching 1/2/2/**3** and
  `windowMs` reaching 8103/15026, `edgeRetention` a perfect 1.0. `minSamples:4` is the gate; one
  candidate reached **3 samples at 15.0s** — the closest this project has ever come to an entry.
  Next suspected blocker is `maxBookAgeMs:2000` breaking the sample chain ("entry book is stale"
  x6), which is the same failure shape as the historical 776 stale-book aborts at the old 1s bound.

Open items: (a) needs a longer observation window to see whether a genuinely qualifying candidate
appears and trades; (b) the provenance fix adds one REST call per untracked candidate — nothing
has shown rate-limit faults yet, but R10 blocker (b) above was *caused* by REST 429s, so watch
`typedFailureClasses` for `rate_limit` and add pacing (`pacedDispatch.ts`) if it appears;
(c) 6 of 17 admitted candidates still didn't get a book inside the 3s
`PRIORITY_ORDERBOOK_WAIT_MS` ceiling — raising it would convert some, at the cost of latency.
All work through `a5f338b` is committed AND pushed (origin was 5 commits behind at session start;
user's standing instruction is now to push on green — see [[push-once-green]]).

## 5. Paper pipeline unblocked end-to-end 2026-07-22 evening — samples now stall at 1 of 4 (NEXT SESSION)

Continued past the economics analysis. Two more fixes landed, both measured live:
- `05294c4` **in-flight book pinning**: a candidate mid-confirmation could be evicted from the
  25-slot tracked set by the 5-min rotation, and `replaceTracked` deletes the removed ticker's book
  — destroying partial evidence. Tickers with samples in flight (from both confirmation engines) are
  now inserted after campaign-critical in the desired set AND added to the rotation-exempt `critical`
  list. `EntryConfirmationEngine.inFlightTickers()` is the new accessor.
- `3e4dbdf` **provably-continuous quiet book**: `maxBookAgeMs` (2s) conflated pipeline-lag with a
  quiet market. 17% of observations died on "entry book is stale". Now, when the transport proves it
  missed nothing (`transportQualificationReady` + zero sequence gaps + tracked, un-quarantined
  ticker whose book still returns), an unchanged book counts as current up to a 10s ceiling
  (`MAX_PROVEN_QUIET_BOOK_AGE_MS`, below the 25s dead-connection bound). Mirrored into
  `campaignEnrollment` so the two paths agree. This is the FIFTH place the transport-vs-market
  conflation lived — same class as the readiness/feed/runtime/preflight fixes.
- `eb51654` **bars at admission + confirmation, not every sample**: `observe()` re-ran the full
  economic bars on every persistence sample, compounding a 16% bar into ~0.07% over 4 samples
  (measured: across 155 candidates, exactly one ever accumulated a sample). Now `absoluteBarFailure()`
  is checked at admission (empty sample set) and again at the confirming observation (the actual
  entry); intermediate samples only prove the edge held via edgeRetention/spread-widening.

**Result after `eb51654` (measured): the pipeline is unblocked end-to-end for the first time.**
Candidates are admitted and the persistence accumulator rises (was 1-in-155, now multiple per short
window), but **maxSamples stalls at 1**. Two mechanisms seen in the data: (a) flow re-issues a NEW
`sourceSignalId` for the same active ticker (saw 3 distinct ids on `KXBTCD-…` in ~1 min), and
confirmation state is keyed on `card.id`, so each restarts at sample 0; (b) the 2nd sample requires
a NEW `bookSequence`, so a quiet book that hasn't ticked is deduped even 5s later.

**NEXT SESSION (open at market hours — flow is 10-20x richer than evening): fix the sampler.**
Preferred direction: key confirmation state on `campaignEconomicIdentity(card)` (already exists) not
raw `card.id`, so re-issued signals for the same ticker+side+playbook keep accumulating; and decide
whether a time-spaced observation on a proven-continuous book counts as a sample without a new
sequence (carefully — samples prove persistence over time, not socket liveness). Do NOT relax
edgeRetention or exchange-origin. Only after that, if candidates complete confirmation at healthy
flow but are still filtered, consider fix #3 (reward-bar units — `minExpectedNetPnlUsd` $1 flat vs
~$10 cap = implicit 10% per-trade return), which the OPERATOR must edit in settings.json (Claude is
classifier-blocked) and is an economic decision, not a bug. Full detail:
`KRYPT/nemesis/docs/HANDOFF-NEXT-SESSION.md` (in-repo). Repo-adjacent
`output/r10-scheduled/HANDOFF-2026-07-22.md` is now superseded by the in-repo doc.

**Commits this session, all pushed:** `00b2786` (provenance), `a5f338b` (fee type), `05294c4`
(pinning), `3e4dbdf` (quiet book), `eb51654` (bar application). 555/555 tests green at `eb51654`.
NOTE 2026-07-22: the whole branch history was rewritten to strip `Co-Authored-By: Claude` trailers
at the user's request (distasteful to them) and `main` fast-forwarded to include all this work — so
the SHAs above are the PRE-rewrite ids and will differ from what's on the remote now; match by
commit subject, not hash. See [[nemesis-no-ai-attribution]].
