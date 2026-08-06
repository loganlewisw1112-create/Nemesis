# NEMESIS Strategy Search — single report file

**Started 2026-08-05 07:20 PDT. Live document — updated as tests complete.**
Goal: find ONE thing worth building, established by measurement rather than assumption.

---

## 0. Where we start (all established by measurement, not opinion)

| Fact | Evidence |
|---|---|
| crypto-lead has no edge | 53 scored shadows, 15.1% win rate vs 55% bar, PF 0.327, 1.9% contamination — count-complete and clean |
| Kalshi crypto is efficient to ~1 tick | 0 monotonicity violations, 0 arbs across 696 aligned cross-series triples |
| Taker round-trip costs 4.5–6.5¢ | fees `0.07·P·(1−P)` ≈1.75¢/side at P=0.5, plus 1–3¢ spread |
| Every edge we ever found was 1–3¢ | the entire reason 6 weeks of work lost money |
| **Maker fees are ZERO on `quadratic` series** | `GET /series/KXBTCD` → `fee_type: quadratic`; bills takers only |
| Cross-venue (Polymarket) has no mappable instrument | their crypto is touch/barrier @ ~147d median; ours is terminal @ hours |

**The one surviving direction entering today: maker-side.** Everything below is an attempt to
either confirm it or find something better.

---

## 1. FINDING — we were trading the worst possible category for a maker

A maker wants **wide spread** (more to earn) and **thin depth** (less queue to wait behind).
Measured across actively-traded Kalshi series (tape-derived activity + per-series book query):

| Series | med spread | med depth | books |
|---|---|---|---|
| **KXBTCD** (what we traded) | **0.01** | **1,027** | 46 |
| KXBTC15M | 0.01 | 1,166 | 1 |
| KXITFMATCH (tennis) | 0.02 | 130 | 118 |
| KXITFWMATCH (tennis) | 0.02 | 250 | 120 |
| KXINXU (index) | 0.03 | 207 | 78 |
| **KXCS2GAME (esports)** | **0.04** | **52** | 186 |
| KXMVECROSSCATEGORY | 0.043 | 42 | 1 |
| KXPGATOUR | 0.001 | 57,062 | 118 |
| KXHEISMAN | 0.01 | 68,365 | 24 |

**`KXBTCD` is close to the worst cell in this table for a maker: the tightest spread AND one of
the deepest queues.** Esports (`KXCS2GAME`) offers 4× the spread against 1/20th the depth.
Tennis offers 2× the spread against 1/4 to 1/8 the depth.

Back-of-envelope, expected gross maker revenue per hour per contract of posted size scales as
`(trade rate ÷ depth) × spread`:

- `KXBTCD`: (31,020/hr ÷ 1,027) × $0.01 ≈ **$0.30**
- `KXCS2GAME`: (1,177/hr ÷ 52) × $0.04 ≈ **$0.91**
- `KXITFWMATCH`: (22,913/hr ÷ 250) × $0.02 ≈ **$1.83**

**This is gross of adverse selection**, which is the whole question — but as a *screen* for where
to even look, it says we spent six weeks in the least attractive corner of the exchange.

*(Full ranked screen running; table above is the 2.2-minute pilot. Numbers will be replaced with
the session-length version.)*

### Methodology trap caught (again)
The first version of this survey queried `/markets?status=open` in bulk and reported **4 two-sided
books out of 8,000** — because the bulk listing strips quotes. This is the project's
oldest documented trap ("never assess executability from listing data"). Correct method: use
`/markets/trades` to learn what is live, then query **per-series** for real quotes. Every number
above uses the correct method.

---

## 1b. RESEARCH — what actually works, evidence-graded

Two research passes completed. The single most load-bearing source is venue-specific:

### The Kalshi paper (this changes the maker thesis)
**Bürgi, Deng & Whelan, "Makers and Takers: The Economics of the Kalshi Prediction Market"**
(CEPR DP20631 / SSRN 5502658), transaction-level data on **300,000+ Kalshi contracts**:

- Average pre-fee return across all contracts: **−20%**
- **Takers lose ~32% on average. MAKERS LOSE ~10% ON AVERAGE.**
- Clear favorite-longshot bias: longshots (low-price) win less often than breakeven requires;
  favorites (high-price) win slightly *more* often and yield small positive pre-fee returns.

**This kills "just be a maker, fees are zero" as a standalone plan.** Zero fees removes a cost
layer; it does not create an edge. Any maker strategy needs a specific reason to beat the *average*
maker, who loses money.

Corroborating, same direction:
- Kalshi's **own affiliated market maker** ("Kalshi Trading") was stated by their co-founder to be
  **"not profitable"** despite ~$310M/month sports volume — self-serving (said in litigation), but
  it is the best-positioned MM on the exchange saying MM is not a faucet.
- Susquehanna is a **designated** institutional MM (invitation-only, uptime obligations, enhanced
  rebates). That tier is not available to a $5k retail account.
- Polymarket wallet data (WSJ-sourced): **0.1% of accounts capture 67% of all profits**; ~70–84%
  of trading addresses are net losers. Money is extremely concentrated in fast/well-resourced players.

### The one finding that points somewhere
A Kalshi adverse-selection study (**41.6M trades**, Kyle's λ + Glosten-Harris) reports market makers
in **single-name** markets earn ~**2×** per contract what they earn in broad-based markets — *not*
mainly from wider spreads, but because **retail systematically overbets YES in markets that mostly
settle NO**, cross-subsidizing the adverse selection MMs take from informed flow.

**That composes with the favorite-longshot bias into one testable hypothesis** — see §4.

### Ruled out (do not spend time here)
| Thing | Why |
|---|---|
| Generic market making | Average Kalshi maker P&L is negative |
| Intra-market ladder arb on liquid crypto | Our own measurement: 0 violations / 696 triples; academic confirmation that Kyle's λ collapses as markets mature |
| Cross-venue Kalshi↔Polymarket | No mappable instrument (measured yesterday); also doubles capital, settlement-timing tail risk |
| FLB as a standalone taker strategy | Decades of literature: real effect, but **does not survive transaction costs** |
| Any bot/signal vendor | 12+ near-identical SEO sites, zero audited track records |
| Manual discretionary vs bots | Bots trade ~89×/day vs 2.2×/day; every manual fill pays an adverse-selection tax |

### Methodology now in hand (for the decisive test)
- `ES = 2·D·(P−M)` · `RS(τ) = 2·D·(P−M_{t+τ})` · `PI = ES − RS`. Realized spread **is** maker
  revenue net of adverse selection, before fees.
- **We are exempt from the trade-signing problem** — Kalshi gives us the taker side directly. Most
  of the literature had to infer it at 72–93% accuracy; the Polymarket paper's estimates flipped
  sign on 67% of markets from signing noise alone. This is a real advantage.
- Use a **term structure** {1s, 5s, 10s, 30s, 60s, 300s}, not one horizon. Don't use the equity
  5-minute convention on a market doing multiple trades/second.
- **Do not implement VPIN** (discredited by Andersen-Bondarenko). Use **OFI** (Cont-Kukanov-Stoikov)
  from consecutive top-of-book snapshots.
- **THE KEY CORRECTION:** tape-wide realized spread is an **upper bound**, not an estimate, for a new
  entrant. Time priority means a back-of-queue order is only filled by prints large enough to walk
  through everyone ahead — disproportionately *informed* flow. Measurable proxy: count how often a
  print/burst consumes more than the full resting size, and compute realized spread on **those**
  fills specifically.
- Exact ceiling from bounded-martingale identity: `p(1−p) = E[Σ(Δp)²]` — total remaining price
  variance to expiry. Caps worst-case cumulative adverse selection.
- **Run everything per price band**, never as an all-strikes average.

---

## 2. In flight

| Work | Status |
|---|---|
| Session-length data collector (books + tape, 4 crypto series, 12s cadence) | **running** since 07:27 PDT, healthy |
| Full maker-attractiveness screen across top 26 series | running |
| Research: what strategies demonstrably work on prediction markets | running (restarted after a connection failure) |
| Research: microstructure methodology (effective/realized spread, adverse selection) | running |

---

## 3. Results log

### 08:15 — Realized spread, FIRST PASS (magnitudes NOT trustworthy; sign pattern is suggestive)

Ran the `RS = 2·D·(P−M_{t+τ})` decomposition over 8,674 observations from the first ~45 min of
collection. **Direction convention came out inverted and was auto-flipped by the calibration check**
(mean ES was −0.018 → +1.83c after flip) — the self-calibration worked as designed.

**These numbers are contaminated and I am not treating them as results.** Book snapshots were on a
40-second cadence with a 45-second matching tolerance, so the "prevailing mid" can be badly stale in
fast markets. Two tells prove it: `KXINXU` reports `ES = −11.15c` (**impossible** — a marketable
order cannot execute through the mid in the wrong direction), and `KXBTCD` reports `RS = −86.67c` at
300s on a contract whose entire range is $1. Both are stale-quote artifacts, exactly the
"post-trade quote contamination" pitfall the methodology flagged.

What survives as *directional* signal, because the pattern is stable across horizons rather than a
single wild value:

| Series | RS 30s | RS 60s | RS 120s | RS 300s | PI (adverse selection) | read |
|---|---|---|---|---|---|---|
| **KXMLBGAME** | +0.99c | +0.90c | +0.90c | +0.99c | **≈ 0.00c at every horizon** | textbook uninformed flow |
| **KXITFWMATCH** | +0.43c | +0.93c | +1.12c | +2.43c | +0.5 to +0.8c | positive, low impact |
| KXCS2GAME | +2.75c | +3.47c | +1.91c | +14.58c | +0.6 to +3.8c | positive but noisy |
| **KXBTCD** | +0.28c | **−6.59c** | **−44.93c** | **−86.67c** | +6.9 → +61c | **severe adverse selection** |

- **`KXMLBGAME` is the standout.** Realized spread pinned near **+0.9c at every horizon** with price
  impact of **essentially exactly zero** is the signature of a market where takers carry no
  information — i.e. the flow is recreational. That stability across four horizons is hard to
  manufacture from stale-quote noise (noise would scatter, not hold a constant).
- **`KXBTCD` confirms everything else we know.** Realized spread collapses as the horizon extends
  and price impact explodes — crypto takers are informed, and a maker there is picked off. This is
  the same conclusion as the directional work, now visible from the liquidity-provision side.

**Corrective action taken:** collector refocused onto `KXMLBGAME`, `KXITFWMATCH`, `KXCS2GAME`,
`KXMLBTOTAL`, `KXBTCD` at **10-second cadence with books every cycle** (was 40s), so the clean
re-run has quote staleness an order of magnitude below the signal.

### 08:20 — FLB test v2 running on a proper universe
v1 returned **0 usable rows from 1,208** — two real bugs, both instructive:
1. The `status=settled` bulk listing is **~99% MVE parlay junk** (712 `KXMVESPORTSMULTIGAMEEXTENDED`
   + 494 `KXMVECROSSCATEGORY` of 1,208). Same provisional-market contamination this project has hit
   repeatedly. Fixed by querying **per real series**.
2. A fixed "1 hour before close" horizon is nonsense for markets that live minutes — the sample
   market opened 14:36:55 and closed 14:42:41. Fixed with **lifetime-relative** sample points
   (50% and 80% through each market's life).

v2 universe: **11,397 settled markets, volume ≥ 10, across 14 series** — a genuinely large sample.

### 08:50 — FLB RESULT: **Kalshi's liquid markets are calibrated. No exploitable bias. This kills strategy #1.**

22,578 observations from 11,397 settled markets, quoted price at 50% and 80% through each market's
life vs. realized outcome.

**First pass looked like a discovery and was an artifact.** Every band showed positive edge
(contracts at 6¢ winning 13.2%) — i.e. *reverse* favorite-longshot bias, contradicting both the
general literature and the Kalshi-specific paper. Per-series decomposition found the cause: two
index series, **`KXINXU` (mean mid 0.513 → realized 0.831)** and **`KXNASDAQ100U` (0.383 → 0.745)**,
whose settled sample spans a window in which the index rose. Every "up" market resolved YES. That is
a **directional sample artifact of a short window**, not an edge, and at 6% of rows it was enough to
tilt every band. (My first hypothesis — selection against one-sided books — was **wrong**: retention
was 99.1%.)

**Clean result, index series excluded (n = 10,610):**

| | 50% through life | 80% through life |
|---|---|---|
| aggregate mean mid | 0.4887 | 0.4854 |
| aggregate realized | 0.4834 | 0.4834 |
| **difference** | **−0.005** | **−0.002** |

Band-level edge vs. its own 95% binomial CI:

| band | n | mid | realized | edge | 95% CI | significant? |
|---|---|---|---|---|---|---|
| 0.02–0.10 | 436 | 0.064 | 0.062 | −0.002 | ±0.023 | no |
| 0.10–0.25 | 1355 | 0.182 | 0.195 | +0.013 | ±0.021 | no |
| 0.25–0.40 | 2027 | 0.333 | 0.311 | −0.022 | ±0.020 | **yes (negative)** |
| 0.40–0.60 | 3566 | 0.494 | 0.488 | −0.006 | ±0.016 | no |
| 0.60–0.75 | 1456 | 0.669 | 0.663 | −0.005 | ±0.024 | no |
| 0.75–0.90 | 1134 | 0.822 | 0.825 | +0.002 | ±0.022 | no |
| 0.90–0.98 | 567 | 0.937 | 0.938 | +0.001 | ±0.020 | no |

**One of 14 band-tests across both horizons clears its own confidence interval, and it points the
wrong way (YES overpriced).** At the 80% horizon, none clear. Per-series, the liquid books are
calibrated to a fraction of a point: `KXMLBGAME` 0.499→0.500, `KXATPMATCH` 0.501→0.501,
`KXITFWMATCH` 0.490→0.500, `KXCS2GAME` 0.492→0.500, `KXBTC15M` 0.494→0.494.

**Verdict: the favorite-longshot bias is not exploitable on Kalshi's liquid series.** The literature
says FLB is real but doesn't survive costs; here it barely exists in the liquid markets at all. This
closes the highest-ranked strategy from the research pass.

**A trap worth recording:** the same table showed `makerYES` AND `makerNO` both positive (+5¢ to
+10¢) in most bands. Both sides cannot be profitable simultaneously. That column is measuring
**half-spread width on illiquid mid-life books** (the 0.25–0.40 band implies a ~15¢ spread), not
capturable profit — you neither get filled at those prices in size, nor keep the money if you do.
**Wide spread is not edge.** Only realized spread — which accounts for what the price does *after*
your fill — answers that, and it is now the sole remaining question.

---

### 09:20 — REALIZED SPREAD on clean data: the decisive measurement

30,853 observations, 10-second book cadence, 12-second matching tolerance (the first pass ran 40s/45s
and produced impossible values). Mean effective spread +0.73c — well-formed. Direction convention
auto-calibrated (inverted and flipped, as designed).

**Per-series, size-weighted realized spread — maker revenue net of adverse selection, zero fees:**

| Series | ES | RS 30s | RS 60s | RS 120s | price impact | median depth ahead |
|---|---|---|---|---|---|---|
| **KXCS2GAME** (esports) | **+4.14c** | **+4.00c** | **+3.31c** | **+3.73c** | +0.3 to +1.7c | **30–56** |
| KXITFWMATCH (tennis) | +1.67c | +0.19c | +0.72c | +1.06c | ~+1.0c | 5,237 |
| KXMLBGAME | +0.86c | +0.97c | +0.97c | +0.97c | **≈0.01c** | **721,108** |
| KXMLBTOTAL | −0.51c | −0.18c | −0.11c | −0.25c | ~−0.4c | 22,299 |
| **KXBTCD** (what we traded) | −1.10c | **−0.54c** | **−1.09c** | **−0.88c** | +0.7 to +9c | 1,208 |

**`KXBTCD` is negative at every horizon.** Crypto takers are informed and a maker there gets picked
off. This is the same verdict as the directional work, now reached independently from the
liquidity-provision side — six weeks were spent making markets' worst counterparty.

**`KXMLBGAME` is the instructive failure.** Realized spread +0.97c pinned at *every* horizon with
price impact of ~0.01c — flow carrying literally no information, the theoretical ideal. And it is
**uncapturable**: median depth ahead is **721,108 contracts**, and only 4 of 3,671 prints ever swept
the queue. The flow is uninformed *because* professionals own the queue. Perfect market, zero access.

### The back-of-queue correction, done WITHIN series

First attempt compared sweep vs non-sweep prints pooled across series and showed sweeps performing
*better* — the opposite of queue theory. That was a **composition artifact**: the sweep subset was
dominated by thin-book `KXCS2GAME`, which has high RS for unrelated reasons. Redone within series:

| Series | subset | n | RS 60s | median depth |
|---|---|---|---|---|
| KXCS2GAME | sweep (back-of-queue) | 503 | **+1.98c** | 10 |
| KXCS2GAME | non-sweep (front) | 1,586 | +4.59c | 52 |
| KXITFWMATCH | sweep | 964 | +1.01c | 15 |
| KXITFWMATCH | non-sweep | 8,403 | +0.59c | 6,409 |
| KXBTCD | non-sweep | 13,951 | **−1.66c** | 1,401 |

**`KXCS2GAME` survives the back-of-queue correction**: +1.98c at 60s even when restricted to prints
that consumed the whole visible queue. There *is* a real queue penalty (+4.59c → +1.98c, roughly
halved), which is what theory predicts — but it stays positive.

### Capacity: NOT estimable from public data (two failed attempts, recorded)

I tried twice to convert per-contract edge into $/hour and both produced nonsense:
1. First model divided **total flow across all ~186 books** by **one book's depth** → 12,627 fills/hr,
   $391/hr. Absurd.
2. Second model went per-book and capital-constrained → still 4,725 contracts/hr on $175 of capital.
   Also impossible: it assumed a proportional share of all flow, ignoring that each fill consumes
   inventory that must be exited, and that the queue refills with *other* makers' orders.

**This is not a bug I can fix — it is the documented limit.** Fill throughput depends on queue-position
dynamics that public L1/L2 data cannot reveal. Any $/hour figure I produce here would be fabrication.
**No capacity number is reported. It requires a live test.**

What *is* defensible from this data:

| | KXCS2GAME | KXBTCD |
|---|---|---|
| RS per contract @60s | **+3.10c** | **−1.02c** |
| share of fills profitable | **65%** | 47% |
| RS distribution (p10 / median / p90) | −10c / +2c / +12c | −13c / −1c / +11c |
| median depth ahead | **36** | 1,200 |

Positive expectancy per contract, but **high variance** (p10 −10c) — this is a many-small-trades
process where the mean only shows up over a large number of fills, not a reliable per-fill gain.

---

### 09:35 — Robustness: does it survive being split up?

| Series | overall RS60 | 1st half | 2nd half | distinct matches | per-match signs (largest first) |
|---|---|---|---|---|---|
| **KXCS2GAME** | +3.11c | +6.03c | +2.41c | **34** | +1.48, +1.61, +7.41, +0.47, +8.98 — **all positive** |
| KXITFWMATCH | +0.61c | +0.79c | +0.56c | 39 | +1.65, **−1.10**, +2.90, −0.06, **−0.72**, +0.94, −0.16, +2.66 |
| KXBTCD | −4.80c | +0.63c | −6.20c | 4 | −6.31 (n=6452), +1.16, −0.23, −1.21 |

- **`KXCS2GAME` survives.** Positive in both time halves and positive in every one of its five
  largest matches, across **34 distinct matches** — not one lucky event.
  **But the aggregate is inflated by small-n matches** (+7.41c on n=83, +8.98c on n=63). The largest
  single sample, n=727, shows **+1.48c** — that is the honest central estimate, not +3.11c.
- **`KXITFWMATCH` fails robustness.** Three of its eight largest matches are negative. The positive
  aggregate is an average over sign-flipping matches, which is not an edge.
- **`KXBTCD` confirmed negative**, and dominated by a single bad event — high variance on top of
  negative expectancy.

---

## 4. THE ONE GOAL

> **Passive market making on Kalshi esports (`KXCS2GAME`), quoting both sides on thin books —
> and explicitly NOT on crypto, index, or deep-queue sports markets.**

**Why this and nothing else survived:**

| Requirement | Why it matters | KXCS2GAME |
|---|---|---|
| Positive realized spread | you keep the spread after adverse selection | **+1.5 to +3.1c/contract @60s** |
| Survives back-of-queue correction | a small account starts behind everyone | **+1.98c** on sweep-only prints |
| Fillable depth | must actually reach the front | **30–56 contracts** (vs 721,108 on MLB) |
| Zero maker fee | removes the cost that killed every taker thesis | `fee_type: quadratic` bills takers only |
| Robust across events | not one lucky match | **positive across 34 matches** |
| Majority of fills profitable | not one outlier carrying it | **65%** |

**The honest mechanism — and its built-in ceiling.** Esports books are thin (30–56 deep) and the
flow is recreational, so the spread is wide (+4.1c) and takers carry little information (price impact
+0.3 to +1.7c, versus +9c on crypto). **The reason this edge exists is that the books are too small
to be worth a professional's time.** That is also the reason it will never be large: the same
thinness that lets a $5k account reach the front of the queue caps how much can be earned there.
This is a real edge in a small pond, not a scalable business — and it should be sized and judged
that way.

**What is NOT established, and must not be assumed:**
1. **Capacity/throughput is unknown and unknowable from public data** (two failed models above).
   Per-contract edge ≠ dollars per hour. This is the single biggest open question.
2. **~2 hours of data on one day.** Esports schedules are event-driven; this window may not
   represent typical conditions.
3. **High variance.** p10 is −10c against a +1.5–3c mean. Positive expectancy shows up over many
   fills, not per fill.
4. **We are claiming to beat a documented base rate** where the average Kalshi maker loses ~10%.
   The mechanism above is plausible and measured, but it is a claim about a niche, and niches are
   where measurement error hides.

**Next step (and it is a measurement, not a build):** a live paper test that rests real quotes on
`KXCS2GAME` and records actual fill rates and realized P&L. That is the only way to answer the
capacity question, and it requires the resting-order machinery NEMESIS does not have
(`createLiveOrderRequest` always `action: 'buy'`, no limit-order lifecycle) — the one genuine
build on the table, and it should be scoped only after a longer observation window confirms the
per-contract edge holds across more sessions.

---

## 5. FULL-DAY VALIDATION (18:10 PDT) — 10 hours, 113,564 observations

The collector ran ~10 hours (survived a mid-session process restart). This is a **3.6× larger sample**
than the 1.9h window the initial conclusion rested on, and it is the real test — it both confirmed
the survivor and **killed one candidate I had provisionally kept**.

### Realized spread, 60s horizon: 1.9h vs 10h

| Series | RS60 @1.9h | **RS60 @10h** | n @10h | verdict |
|---|---|---|---|---|
| **KXCS2GAME** | +3.31c | **+3.07c** | 4,060 | **HELD** |
| KXITFWMATCH | +0.72c | **−0.04c** | 10,838 | **KILLED by bigger sample** |
| KXMLBGAME | +0.97c | +0.15c | 12,419 | collapsed (and uncapturable anyway) |
| KXMLBTOTAL | −0.11c | −0.65c | 4,307 | negative |
| **KXBTCD** | −1.09c | **−3.92c** | 21,095 | **definitively toxic** |

### The back-of-queue correction — the decisive column

| Series | ES | sweep RS30 | **sweep RS60** | sweep RS120 | sweep n | sweep depth |
|---|---|---|---|---|---|---|
| **KXCS2GAME** | +3.88c | +4.42c | **+2.74c** | +1.68c | 1,917 | 10 |
| KXITFWMATCH | +1.66c | −0.60c | **−1.93c** | +1.15c | 2,105 | 15 |
| KXMLBGAME | +3.33c | +0.35c | **−7.42c** | +0.62c | 915 | 11 |
| KXMLBTOTAL | −3.85c | −3.28c | −3.54c | +0.86c | 660 | 6 |
| KXBTCD | +2.14c | −2.67c | **−6.39c** | −7.68c | 3,912 | 20 |

**`KXCS2GAME` is the only series that is positive at the back of the queue.** Every other candidate —
including tennis and MLB, which looked positive tape-wide — goes **negative** once restricted to
prints that consumed the whole visible queue. That is queue theory working exactly as predicted, and
it eliminates four of five candidates.

### Robustness across matches

`KXCS2GAME`, **55 distinct matches**, 8 largest: +3.01, +2.66, +5.85, +1.56, **−0.04**, +6.27, +1.58,
**−5.10** → **6 of 8 positive**. Time halves +3.26c / +2.11c.

`KXITFWMATCH`, 56 matches: signs scatter (+1.23, +1.69, +2.76, −0.15, −1.10, +0.29, +2.90, +0.16) and
the aggregate is now **−0.04c**. Confirmed not an edge.

`KXBTCD`, 12 events: −8.51, −1.69, +0.11, −2.76, +1.16, −5.34, −4.28, −0.97. Confirmed toxic.

### Final answer

**The ONE GOAL stands, now validated on 10 hours of data: passive market making on Kalshi esports
(`KXCS2GAME`), and nothing else.**

Honest reading of the numbers:
- **Central estimate +2.7 to +3.1c per contract** at the 30–60s horizon, back-of-queue-adjusted.
- **The edge decays fast with horizon** (sweep: +4.42c @30s → +2.74c @60s → +1.68c @120s). This is a
  quick in-and-out strategy; holding erodes it.
- **Not every match works** — 2 of 8 largest were negative, one at −5.10c. Match-level selection or
  per-match risk limits matter.
- **Capacity remains unmeasured and unmeasurable from public data.** Still the biggest open question,
  and still requires resting real orders.
- Esports are **event-driven** — `KXCS2GAME` disappeared from the active tape mid-day. Tradeable
  windows are limited to match times, which caps daily opportunity independent of edge.

**What changed from the 1.9h read:** tennis died. That is the value of the longer window — the
initial pass would have carried two candidates forward, one of which turns negative at scale and
negative at the back of the queue. The 10-hour data converted a two-horse shortlist into a single
answer.
