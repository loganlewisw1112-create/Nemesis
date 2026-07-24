---
name: nemesis-shadow-pilot-gate
description: NEMESIS has a shadow→pilot validation ladder that gates ALL portfolio paper trades — a 'ready' confirmation in shadow stage produces evidence, NOT a trade. This is why trades=0 even when the pipeline works.
metadata:
  node_type: memory
  type: project
---

Found 2026-07-23 during a readiness simulation. Beyond the confirmation pipeline there is a SECOND
gate that must be understood or you will chase trades=0 forever:

**The strategy-validation ladder (packages/execution/src/strategyValidation.ts, wired in
apps/desktop/electron/main.ts ~2881, 3188-3253):** stages are shadow → pilot → qualification.
`validationStage = evidenceOnlyCampaign ? 'shadow' : validation.stage`. In **shadow** stage a
confirmation that reaches `status:'ready'` does NOT mutate the portfolio — main.ts:3203-3253 starts a
shadow candidate (evidence) and returns "shadow candidate started without paper mutation". Only when
the stage is **pilot** (or beyond) does the code fall through to `simulatePaperBuy` (main.ts:3255),
which is the only call that increments `paper-portfolio.json` trades[].

**To leave shadow you need shadowPassed** (strategyValidation.ts:399): `shadowMinScored` (100) scored
shadow candidates, over `shadowMinDistinctDays` (3) DISTINCT CALENDAR DAYS, netPnl>0, profitFactor
>=1.25, winRate>=0.55, stressedNetPnl>0, stressedProfitFactor>=1.1, largestWinShare<=0.2, no pause, no
integrity error. Then a MANUAL advance: IPC `nemesis:advanceStrategyStage('pilot','ADVANCE_TO_PILOT')`
(main.ts:5863), which throws if `!shadowPassed` (main.ts:5873). A shadow candidate is started only on
a 'ready' confirmation and SCORED ~shadowFollowUpMs (15min) later.

**Measured state 2026-07-23 (the whole validation log, 1477 confirmation observations):**
entry_confirmation READY **ever = 0**; shadow candidates started = 0; scored = 0; stage changes = 0
(still shadow); no pauses. So NO confirmation has EVER reached 'ready' — every session's work has been
about reaching step 1, and even step 1 only starts the 3-day shadow ladder, it does not place a trade.

**Consequence for "print a green paper trade":** it is NOT a same-day milestone via the designed
ladder. Minimum path = first 'ready' (still unproven) → shadow candidate → 100 scored over >=3 distinct
days at PF>=1.25 → manual ADVANCE_TO_PILOT → THEN pilot 'ready' confirmations place real <=$10-risk
paper trades. Do NOT bypass the ladder to fake a trade (violates the project's whole integrity ethos).
Legitimate ACCELERATION for testing the execution PLUMBING only (not edge): the operator lowers
`entryQualification.shadowMinScored` and `shadowMinDistinctDays` in settings.json (Claude is
classifier-blocked from that write) to reach pilot in hours, confirm a paper trade actually places and
closes end-to-end, then restore the real thresholds. Also still-unverified because 0 candidates ever
reached it: whether the shadow follow-up SCORING loop and the pilot simulatePaperBuy path actually fire
in practice. Related: [[nemesis-project-history]], [[nemesis-market-strategy-research]].
