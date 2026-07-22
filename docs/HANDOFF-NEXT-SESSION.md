# NEMESIS — Next-Session Handoff (open at market hours, 2026-07-23)

**Read this first.** It is the authoritative "what to do next" doc. Open it right before the US
market opens tomorrow so the fix below can be validated against real, high-flow conditions — the
project's own history shows candidate flow is 10-20x richer during market hours than in the evening
(2 confirmation observations in 15 min last night vs 26-48 in comparable afternoon windows).

## One-paragraph state

The paper-trading pipeline, which had **never placed a single trade since the portfolio was created
on 2026-07-14**, was root-caused and unblocked across five committed fixes on 2026-07-22. Every
structural gate that used to reject 100% of candidates before economics were ever evaluated is now
cleared. Candidates reach genuine economic evaluation, ~13-23% clear both profit bars, and — for the
first time in the project's history — candidates are **admitted into the persistence-confirmation
window**. Still **zero completed trades**: the remaining blocker is that confirmation samples stall
at 1 of the required 4. That blocker is understood and is the single task for tomorrow.

## What was fixed 2026-07-22 (all committed and on `main`)

Each fix was verified against measured live data before moving to the next; full reasoning is in the
commit bodies.

1. **Provenance hydration** — candidates were never admitted to WS orderbook tracking because the
   stream's own provenance store only knew markets the periodic universe sweep had covered. Now a
   candidate's ticker is hydrated from the single-market production endpoint *before* any membership
   change. Admission went from 0/3 to 17/17; exchange-origin rejection 87.5% -> 17.6%.
2. **Fee type `quadratic_with_maker_fees`** — the resolver matched the literal string `quadratic`
   and failed every maker-fee series closed. Verified against Kalshi's published schedule that the
   taker formula is identical; accepted via an explicit two-entry allowlist. Fee-policy rejections
   -> 0.
3. **In-flight book pinning** — a candidate mid-confirmation could be evicted from the tracked set
   by the 5-minute rotation, and `replaceTracked` deletes the removed ticker's book, destroying the
   partial evidence. Tickers with samples in flight are now rotation-exempt.
4. **Provably-continuous quiet book** — `maxBookAgeMs` (2s) conflated "our pipeline is lagging"
   (dangerous) with "the market is quiet" (harmless). With the transport connected, authenticated,
   subscribed, and gap-free, an unchanged book is provably current up to a 10s ceiling. Recovered
   the 17% "entry book is stale" rejections. (Fifth instance of the same transport-vs-market
   conflation this codebase has corrected.)
5. **Bars applied at admission + confirmation, not every sample** — `observe()` re-ran the full
   economic bars on every persistence sample, so a 16% bar compounded to ~0.07% over four samples.
   Now the absolute bars gate admission and the confirming observation (the actual entry); the
   intermediate samples only prove the edge held via `edgeRetention` and `maxSpreadWideningPp`.

## The one remaining blocker — samples stall at 1 of 4

After fix #5, candidates are admitted and start collecting evidence, but no candidate advances past
its first sample. Two mechanisms, both observed in the live data:

- **Re-issued signal IDs restart the count.** Confirmation state is keyed on the flow signal's
  `card.id`. The same active market (e.g. `KXBTCD-…`) produced three *different* source-signal IDs
  in ~1 minute, each starting a fresh confirmation state at sample 0 instead of extending the prior
  one.
- **The 2nd sample requires a *new* `bookSequence`.** A single source that *was* re-observed 5s
  later stayed at `samples=1` — the sampler dedupes on `bookSequence`, so a quiet book that has not
  ticked cannot add a sample even though fix #4 correctly treats it as current for freshness.

### Tomorrow's task, in order

1. **Relaunch and confirm baseline** on the current `main` HEAD, during market hours. Filter every
   read strictly to events after the relaunch timestamp (see `nemesis-ops` skill — mixing pre/post
   data is the most common way to misjudge a fix here). Expect candidates admitted, persistence
   accumulating, samples stalling at 1.
2. **Fix the sampler.** Preferred direction: key confirmation state on the stable economic identity
   (`campaignEconomicIdentity(card)` already exists for exactly this) rather than the raw `card.id`,
   so re-issued signals for the same ticker+side+playbook continue accumulating. Separately decide
   whether a time-spaced observation on a *proven-continuous* book should count as a persistence
   sample even without a new sequence — carefully, because samples exist to prove the edge persisted
   over time, not merely that the socket is alive. Do NOT relax `edgeRetention` or the exchange-origin
   check to force this.
3. **Watch for the first completed confirmation and trade.** Portfolio ground truth is
   `paper-portfolio.json` (`trades[]`).
4. **Only if** candidates then complete confirmation at healthy flow but are still filtered by the
   reward bar, consider fix #3 (reward-bar units): `minExpectedNetPnlUsd` is a flat $1 against a
   ~$10 position cap, which silently demands a 10% per-trade return. This is a settings.json change
   the operator must make by hand (Claude is classifier-blocked from trading-config writes) and is an
   economic decision, not a bug fix — do not do it pre-emptively.

## Hard rules (do not violate to force a trade)

- The exchange-origin book timestamp+sequence check (`entryConfirmation.ts`) is never relaxed.
- The profit bars (`minExpectedNetPnlUsd`, `minRewardRiskRatio`, `strictProfitMode`) are never
  lowered to manufacture a trade. Zero trades because opportunities do not clear an honest bar is a
  valid, informative result — paper trading exists to measure exactly that.
- Live trading stays hard-locked (`liveEnabled:false, dryRun:true`) throughout. No real money is at
  risk under any outcome here.

## Economics reality (measured, 355 candidates)

The strategy finds ~8¢ gross edge consistently. At shipped bars, 16% of observations clear the $1
reward bar, 40% clear 2:1 reward/risk, 13% clear both. Sizing is not a lever: reward/risk is
scale-invariant, so raising the position cap does not change the pass rate. The open economic
question — separate from the sampler bug — is whether ~8¢ edge against bars that effectively want
~12¢ is a profitable business or a slower way to pay fees. The completed-confirmation sample from
tomorrow is what will answer it.

## Operational

- Safe rebuild/relaunch sequence, R10 gate ladder, and where paper data lives: see the
  `nemesis-ops` skill (`.claude/skills/nemesis-ops/SKILL.md`).
- R10 (readiness -> full-25 soak -> gap-closure) is a separate, already-proven thread; it is not
  blocking paper trading and needs no work unless a real-money pilot is being prepared.
