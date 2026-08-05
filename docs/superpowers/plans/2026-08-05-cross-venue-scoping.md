# Cross-venue (Kalshi × Polymarket) scoping — measured 2026-08-05

**Verdict: do not build the observation logger for crypto. There is nothing to observe.** The
cross-venue thesis assumed "the same event priced differently on two venues." Measured against both
venues' live public APIs, that premise **does not hold for the instruments NEMESIS trades** — not
because prices agree, but because **the matching contracts do not exist.**

This is scoping only. No code was written, and none should be.

## What was measured

Both public APIs, anonymous and read-only: `gamma-api.polymarket.com` (2,100 open market records,
1,817 genuinely live after filtering to future end-date + non-zero liquidity) and
`api.elections.kalshi.com` (2,000 open markets sampled).

## Finding 1 — Polymarket is a long-horizon venue; NEMESIS is a same-day system

Live Polymarket markets, time-to-resolution:

| | hours |
|---|---|
| min | 10.4 |
| p25 | 2,146 (~89 days) |
| **median** | **3,538 (~147 days / ~5 months)** |
| max | 19,786 (~2.3 years) |

Only **81 of 1,817** live markets (4.5%) resolve within 7 days; 189 within 30 days. NEMESIS's
`KXBTCD` contracts resolve in **hours**. The venues barely overlap on the time axis at all.

## Finding 2 — the crypto contracts are different *instruments*, not differently-priced

This is the decisive one, and it is a payoff-structure mismatch, not a pricing gap.

| | Kalshi (`KXBTCD`, what NEMESIS trades) | Polymarket crypto |
|---|---|---|
| Question | "Bitcoin **above $65,750 at 5PM EDT on Aug 5**" | "Will Bitcoin **reach $150k by December 31, 2026**" |
| Payoff type | **terminal** European digital — pays on the value *at expiry* | **touch / barrier** — pays if the price *ever* touches the level |
| Horizon | hours | ~5 months |
| Resolution | CF Benchmarks BRTI, 60-second average | Polymarket's own source |
| Count in scan | `strike_type: "greater"`, aligned strike ladders | **90 touch-style, 0 terminal-style** |

`P(touch X by date)` and `P(above X at time T)` are **different probabilities** — the touch is
strictly larger, and the gap is enormous over a 5-month horizon. Comparing them and calling the
difference a mispricing would be the same category error as the `strike_type` trap in the A1 work
(applying a CDF test to bracket markets). **There is no arbitrage relationship to log.**

## Finding 3 — Polymarket's short-dated crypto product is gone

The scan surfaced 30 crypto markets in a "<24h" bucket that look like exactly what would be needed —
`Bitcoin Up or Down — December 19, 11:35AM-11:40AM ET`, 5-minute terminal contracts. They are
**stale records**: end dates ~229 days in the past (December 2025), `outcomePrices: undefined`,
`spread: 1`, `liquidity: 0`, still flagged `closed=false`. The product appears discontinued and the
records never cleaned up.

**Live Polymarket crypto-price markets resolving within 7 days: zero.**

## Finding 4 — where cross-venue *could* work, and why it still doesn't fit NEMESIS

All 81 short-dated live Polymarket markets are **political primaries** (2026 Tennessee governor
primaries at ~10h, Minnesota Senate/MN-02 nominations at ~130h), liquidity ~$9k–27k each, spreads
**0.001–0.045** — frequently *tighter* than Kalshi's 1–3¢. Live Polymarket by topic: politics 645,
crypto 122, econ 52, entertainment 22, sports 4.

Kalshi lists political and economic markets too, so a genuine same-event overlap does exist **in
politics and econ**. But that is a different product from the one this repo is built around:

- NEMESIS's entire pipeline is tuned to **sub-second orderbook deltas, a 15-second persistence
  window, and same-day expiries**. A primary resolving in 10 hours or a nomination in 130 hours
  is not a flow-momentum instrument.
- A months-long convergence trade has a completely different **capital profile** — capital locked
  for weeks or months, versus minutes. Position sizing, the auto-close engine, and the shadow
  mark-to-market (15-minute due) all assume short holds.
- The "Polymarket leads price discovery by minutes" premise from the 2026-07-23 research is about
  **fast-moving news**, and is untested here. It is also least relevant on a slow-resolving primary.

So the surviving overlap is real but points at building a **different system**, not at pointing the
existing one across a second venue.

## Recommendation

**Do not build the cross-venue observation logger.** Its premise fails at the instrument level for
crypto, and the categories where overlap genuinely exists (politics/econ, multi-day-to-multi-month)
are a poor fit for an engine built for same-day flow.

If cross-venue is ever revisited, the honest first step is **not** a logger but a
**contract-mapping feasibility study on politics/econ**: pick 10–20 events both venues list, verify
the rulebooks actually resolve identically (resolution source, tie/edge-case handling, settlement
timing), and only then measure whether a spread exists. Mapping is the risk; pricing is downstream
of it. That study is a research task, not an engineering one.

## What this closes out

With this, all three post-crypto-lead directions have been measured rather than assumed:

| Direction | Status | Cost to find out |
|---|---|---|
| **A1** correlated-market arb within Kalshi | Falsified — market consistent to ~1 tick, binding leg had 1.00 contract of depth | ~1 hour |
| **A2** two-leg paired execution | Feasible but moot without a signal | parallel audit |
| **Cross-venue** Kalshi × Polymarket | Premise fails — no mappable instrument at NEMESIS's horizon | ~30 minutes |

**Pattern worth keeping: three multi-week builds were each killed by well under an hour of
measurement.** That is now the most reliable lesson this project has produced, and it generalizes
past NEMESIS. Measure the premise before scoping the build.

**Remaining live option: maker instead of taker** — demonstrably where the money is on Kalshi (MMs
quote sum(bid) 0.75–0.91 against sum(ask) 1.48–4.70, and the maker rate is a *quarter* of taker).
It is the largest build on the list and should not be started on inference. Its equivalent cheap
pre-test would be: measure realized queue depth and fill probability at top-of-book on `KXBTCD`
over a session, and model adverse selection, **before** writing any resting-order execution.

## Honest limits

- Polymarket coverage came from `gamma-api` `closed=false` pagination (2,100 records, exhausted).
  Other endpoints/structures (events API, CLOB directly) were not enumerated; a short-dated crypto
  product could in principle exist outside that view, though the discontinued "Up or Down" records
  argue against it.
- Topic classification is a crude regex over question/title text. It is directionally fine for
  Polymarket (whose questions are plain English) but **unreliable for Kalshi**, whose 2,000-market
  sample bucketed almost entirely to "other" — so the Kalshi topic counts in Finding 4 should not be
  cited as a catalog breakdown.
- Single snapshot, 2026-08-05 ~06:20 PDT. Product catalogs change; Polymarket could relaunch a
  short-dated crypto product, which would reopen Finding 3 (but not Finding 2's payoff mismatch for
  the long-dated ones).
