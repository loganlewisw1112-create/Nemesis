---
name: nemesis-market-strategy-research
description: NEMESIS strategic research (2026-07-23) — which Kalshi markets are actually liquid, what automated strategies actually profit, and why NEMESIS's flow-momentum + 15s-persistence model is mis-fit to the instruments
metadata:
  node_type: memory
  type: project
---

Researched 2026-07-23 after four plumbing fixes made the paper pipeline correct end-to-end but it
still placed 0 trades, blocked at a deeper layer: the flow strategy surfaces market instances with
no live *sequenced* orderbook, and the exchange-origin check (correctly, never to be relaxed)
rejects them. Root question asked: what markets/strategies would actually make this work.

**Live Kalshi tape (pulled 2026-07-23 ~11:25 PT via /markets/trades): the exchange is very active
— 1000 trades in 5 minutes.** Most-traded families right now: KXBTC15M (236 trades/5min), crypto
15-min (KXETH15M/KXDOGE15M/KXSOL15M/KXXRP15M), KXBTCD (BTC daily), and sports during their event
windows (KXUECLGAME, KXMLBGAME, KXITFWMATCH, KXUELGAME). So NEMESIS is NOT starved of activity —
the families it picks ARE active. The mismatch is at the *instance* level: within an active family
(e.g. KXMLBGAME did 63 trades/5min) a *specific* game ticker can be dormant pre-game while other
games trade. Crypto 15-min are the most uniformly liquid (few concurrent tickers, all trading).
CAVEAT: the bulk /markets listing endpoint still returns provisional MVE parlay junk first with
zero quotes/volume — use the /markets/trades tape for "what is live", never the listing (this
re-confirms the long-standing measurement trap).

**Instrument reality:**
- **Crypto 15-min (BTC/ETH/etc.)**: most continuously liquid, but they move FAST — NEMESIS's 15s
  persistence window is longer than the edge survives (measured: an edge went 9.75c->4c in 10s,
  correctly rejected as decayed). Fast markets and the persistence model are in direct tension.
- **Sports**: ~80% of Kalshi volume but event-clustered — liquid only during/near the game, dormant
  otherwise. NEMESIS picking pre-game instances at midday = the dormant-book wall.
- **Financial index (S&P KXINXHUD hourly / KXINXDUD daily, Nasdaq KXNASDAQDUD)**: continuous during
  market hours, slower-moving than crypto — plausibly a better fit for a persistence model, and
  UNTESTED by NEMESIS so far.
- **Gold/silver/platinum**: Kalshi has FILED with CFTC for 24x5 metals perpetuals but they are NOT
  yet approved/live (as of 2026-07-23). Not available to trade now.

**What actually profits on Kalshi (industry research):** the proven automated edges are ARBITRAGE,
not single-venue momentum: (1) cross-exchange arb (same event priced differently Kalshi vs
Polymarket — Polymarket leads price discovery, Kalshi lags minutes); (2) correlated-market arb
within Kalshi (logically-constrained related outcomes diverging); (3) systematic crypto hourly/15m.
Market-making exists but competes with 23 pro MMs (top 3 = 70% of election liquidity) and needs
low-latency. Consistent theme across every source: "automation is a tool, not an edge"; Kalshi
markets are "surprisingly efficient"; be deeply skeptical of guaranteed-return bot claims.

**Honest strategic diagnosis:** NEMESIS is architecturally strong on the DEFENSIVE side (strict
local profit certification, fail-closed guardrails, exchange-origin integrity) but its OFFENSIVE
thesis — flow-momentum detection + 15s persistence confirmation on a single venue — is not aligned
with where Kalshi money actually is. The persistence model is simultaneously too slow for the
liquid fast markets (crypto) and inapplicable to the dormant slow ones (pre-game sports). The two
directions worth weighing (user decision, not yet made): (a) retarget the SAME engine at
continuously-liquid slower instruments — financial index hourly/daily — where a persistence window
fits; (b) add a genuinely different, more proven edge (cross-venue or correlated-market arb), which
is a larger architectural change and, for cross-venue, needs a Polymarket data feed. Neither is a
quick fix; both are real product decisions. Sources saved in the session; see startuphub/quantvps/
clawarbs/coingape links in transcript.
