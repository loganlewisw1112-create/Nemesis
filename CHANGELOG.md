# Changelog

Engineering progress and status notes, most recent first. These were previously
tracked inline in the README.

## 2026-07-22 — Paper trading pipeline: five structural fixes

Separate from the R10 soak work: does the strategy actually find and complete a
profitable paper trade? Paper trading had produced **zero trades since the portfolio
was created on 2026-07-14**, root-caused to a chain of structural gates — not the
profit bars — that rejected candidates before economics were ever evaluated. Five
fixes cleared the chain:

- **Provenance hydration.** Flow-driven candidates were never admitted to WebSocket
  orderbook tracking because the stream's provenance store only knew markets the
  periodic universe sweep had covered. A candidate's ticker is now hydrated from the
  production single-market endpoint before any tracking change. Exchange-origin
  rejection fell from 87.5% to 17.6%.
- **Maker-fee series.** The fee resolver rejected every series reporting
  `quadratic_with_maker_fees`; its taker formula is identical to plain `quadratic`
  (verified against the published schedule), so it is now accepted. Fee-policy
  rejections went to zero.
- **In-flight book pinning.** A candidate collecting confirmation evidence can no
  longer be evicted from the tracked set by the 5-minute rotation, which would delete
  the book its evidence depends on.
- **Provably-continuous quiet books.** A book past the 2s freshness bound is treated
  as current (up to a 10s ceiling) when the transport can prove it missed no update —
  distinguishing a quiet market from a lagging pipeline instead of discarding both.
- **Bar application.** The absolute profit bars now gate admission and the confirming
  observation rather than every intermediate persistence sample, which had compounded
  a 16% bar into ~0.07%.

Candidates now reach genuine economic evaluation and enter the persistence-confirmation
window for the first time. The profit bars themselves are unchanged and are never
lowered to force a trade. Remaining blocker at the time: confirmation samples stalling
at 1 of 4 — see [docs/HANDOFF-NEXT-SESSION.md](docs/HANDOFF-NEXT-SESSION.md). Live
trading stayed hard-locked throughout; no real money at risk.

## 2026-07-20 — R10 readiness: soak stability

Progress toward the R10 gate (readiness hold → full-25 production soak → gap-closure
report) that qualifies NEMESIS for paper and small live trading:

- **Renderer soak-stall bug: fixed and proven.** The append-only campaign ledger was
  `structuredClone`d twice on the per-orderbook-delta hot path, starving the event loop
  until the renderer heartbeat watchdog invalidated the run. Fixed on the hot path; a
  full 30-minute soak now survives with the renderer flat (~133 MB, `recoveryCount 0`,
  zero invalidations).
- **Orderbook coverage decay: fixed.** The 20-second re-verification loop burst all
  tracked markets at once and drew Kalshi 429s, lapsing markets past the 90s provenance
  TTL until the tracked set decayed below 25. Re-verification is now rate-paced
  (`pacedDispatch`) and the book-fetch backoff is bounded below the TTL.
- **Readiness continuous-hold reconnect tolerance: added.** A single self-healed
  transport reconnect (bounded, must re-qualify within a grace window; a second episode
  or a non-recovery still hard-fails) no longer breaks the hold. This is
  orderbook-transport accounting, not a relaxation of the heartbeat watchdog.

A full 30-minute soak completes cleanly with zero stalls, invalidations, or reconnect
faults. The remaining step was a passing soak at the full 25-market bar.
