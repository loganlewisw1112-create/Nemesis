# Maker-side pre-test scoping — measured 2026-08-05

**Verdict: this one is NOT killed.** Unlike A1 (correlated arb) and cross-venue, the maker thesis
survives first contact with the data — the economics look plausible on measurement, not inference.
**But the decisive variable cannot be measured from public data**, which changes what a "cheap
pre-test" can even be. That is the main finding of this document, and it is why this is a scoping
doc rather than a go-ahead.

## The economic case, measured

### Maker fees on `KXBTCD` are ZERO, not merely reduced

`GET /series/KXBTCD` returns `fee_type: "quadratic"`, `fee_multiplier: 1`. Per
`packages/core/src/fees/kalshiFee.ts:19-22`, `quadratic` charges **takers only** —
`quadratic_with_maker_fees` is the variant that bills makers (at a quarter rate). So on the series
NEMESIS trades, a maker pays **no fee at all**.

That reframes the cost problem that killed every prior thesis:

| | taker (what NEMESIS does today) | maker |
|---|---|---|
| Fees, round trip | ~3.5¢ (1.75¢/contract each way at P≈0.5) | **$0.00** |
| Spread | **pays** 1–3¢ | **earns** 1–3¢ |
| Net cost per round trip | **4.5–6.5¢** | **−1¢** (i.e. a credit) |

The measured swing is roughly **5–7¢ per round trip** — against edges of 1–3¢, which is exactly the
gap that made every taker thesis structurally unprofitable.

**Modeling note:** `rateForRole` (`kalshiFee.ts:105-107`) returns `KALSHI_MAKER_RATE` (0.0175) for
makers unconditionally, ignoring `feeType`. For a `quadratic` series the real maker fee is zero, so
the model **overcharges** makers. Conservative, therefore safe, but it means any maker P&L computed
with the current code understates the edge and should be fixed before it is trusted quantitatively.

### Book and flow (live snapshot, 06:44 PDT)

- `KXBTCD`: 318 open markets, **42 two-sided**. Median spread **1¢** (min 1¢, max 3¢).
- Top-of-book depth — contracts resting *ahead* of a newly-placed maker order:
  **min 2 · p25 634 · median 1,776 · p75 4,578 · max 25,329** (n=84).
- Flow is heavy: 12,000 trades across all series in 2.0 minutes. `KXBTCD` did 34,018 contracts;
  the most active strikes ran **1,300–4,240 contracts/minute**.
- Consequence: on near-money strikes the **queue drains in well under a minute** — fills are
  achievable, contrary to what the median depth alone suggests.
- **`KXBTC15M` traded 335,453 contracts in the same 2 minutes — ~10× `KXBTCD`.** If maker-making is
  the play, that is where the volume is (matching the 2026-07-23 research finding).

### Adverse selection — post-fill drift, signed in the maker's favour

For every trade, classify it as the fill a maker would have received (taker hitting the bid ⇒ maker
bought; taker lifting the ask ⇒ maker sold), then measure where the price sat 30s later. Negative
means the maker is underwater. 40,000 trades over 6.3 minutes:

| Ticker | maker-buy drift | maker-sell drift | combined |
|---|---|---|---|
| `KXBTCD-…-T64099.99` (n=745) | −0.79¢ | +0.78¢ | **+0.11¢** |
| `KXBTCD-…-T64199.99` (n=600) | −1.06¢ | −0.04¢ | **−0.54¢** |
| `KXBTCD-…-T63999.99` (n=585) | +0.33¢ | −0.56¢ | **−0.23¢** |
| `KXBTCD-…-T64299.99` (n=330) | +1.58¢ | −0.06¢ | **+0.72¢** |
| `KXBTC15M-…-0945-45` (n=10,603) | +4.90¢ | −6.20¢ | **−0.65¢** |
| `KXBTC15M-…-1000-00` (n=662) | −20.14¢ | +19.29¢ | **+2.71¢** |

**Read on `KXBTCD`: combined drift averages ≈ +0.02¢ — indistinguishable from zero**, with the four
cells scattered −0.54¢ to +0.72¢. That scatter *is* the noise floor at these sample sizes, not a
signal. Against a 1¢ spread captured at zero fee, roughly-zero adverse selection is a plausible
edge — which is more than any prior thesis could show.

**Read on `KXBTC15M`: far more dangerous.** ±5¢ and ±20¢ single-side drifts on a 15-minute contract
mean a maker there is exposed to large directional moves. More volume, more danger — do not assume
the liquid venue is the safe one.

## Why the cheap pre-test does not exist here

The last three directions were killed from public data in under an hour each. **That does not
generalize to this one**, and pretending otherwise would be the mistake:

1. **The drift measure above is an optimistic bound, structurally.** It treats *every* trade as a
   maker fill. A real maker order joins behind a median **1,776-contract** queue and is therefore
   filled *disproportionately when the queue is being swept* — i.e. during exactly the large
   directional moves that hurt. The benign fills at the front of a calm queue are included in my
   average but would not be received by a new entrant. **True adverse selection is worse than
   measured, by an unknown amount.**
2. **Queue position is the entire game and is not in public data.** Knowing where an order sits in
   a 1,776-deep queue requires either L3/order-level data or actually resting orders. Kalshi's
   public API gives top-of-book aggregate size only.
3. **NEMESIS has no resting-order machinery at all.** Per the A2 audit:
   `createLiveOrderRequest` always sets `action: 'buy'` (`liveOrderAdapter.ts:56`), there is no
   limit-order lifecycle (place → queue → partial fill → amend → cancel), and both the paper and
   live paths are immediate-execution. A maker build is **larger than A2 was**, and A2 was already
   judged non-trivial.

So the honest sequence is not "cheap test, then build" — it is **"free-but-slow test, then a real
build decision."**

## Proposed staging

**Phase 0 — passive queue dynamics (free, no code in the app, days not weeks).**
Extend today's 6-minute snapshot into a proper session-length study, run outside the app against
public endpoints:
- Depth, spread, and trade-rate distributions per strike, across market hours and overnight.
- Post-fill drift at 10s/30s/60s/300s horizons with confidence intervals — today's numbers have
  none, and the per-cell scatter shows they need them.
- **The key refinement: condition on queue-sweep events.** Segment fills by the size of the trade
  burst that produced them (a 2,000-contract sweep vs a 20-contract nibble) to approximate the
  adverse selection a *back-of-queue* order would actually receive, rather than the all-fills
  average measured today.
- Compare `KXBTCD` against `KXBTC15M` explicitly — the drift asymmetry above suggests they are
  different businesses.
- **Kill criterion, stated in advance:** if queue-sweep-conditioned drift exceeds the captured
  spread (≈1¢) with confidence, maker-making is dead at retail and the project stops here.

**Phase 1 — only if Phase 0 survives.** A resting-order execution model: limit-order lifecycle,
queue-position estimation, cancel/amend policy, inventory and adverse-selection controls, plus
pair-aware changes to the per-position `autoCloseEngine` and `decideCapitalAllocation` that the A2
audit already flagged. This is a substantial build and should be scoped separately, *after* Phase 0
produces numbers.

**Do not skip Phase 0.** The measured edge is ~1¢ against a noise floor of similar magnitude; that
is precisely the regime where a confident-looking build loses money.

## Honest limits of today's measurement

- **6.3 minutes, single session, one time of day** (~06:44 PDT). Not a basis for any conclusion
  beyond "not obviously dead."
- **No confidence intervals.** With n≈150–400 per cell against ~5¢ price volatility, the standard
  error is roughly ±0.3¢ — the whole −0.54¢…+0.72¢ spread of results sits inside about 2 SE of zero.
- **Drift ≠ realised P&L.** A maker who buys at the bid must still *sell at the ask* to capture the
  spread; 30s mark-to-market does not prove the exit was available.
- **Competition is unmodelled.** The 2026-07-23 research notes ~23 professional market makers on
  Kalshi, with the top 3 holding ~70% of election liquidity. They have latency and queue-priority
  advantages this system does not.
- Fee behaviour is read from `kalshiFee.ts`'s encoding of the published schedule plus the series
  API's `fee_type`; it was **not** verified against a real maker fill, and the code's own
  `rateForRole` disagrees (see modeling note above).
