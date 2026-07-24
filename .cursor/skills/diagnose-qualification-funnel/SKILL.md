---
name: diagnose-qualification-funnel
description: Use whenever a multi-stage qualification, matching, moderation, review, or approval pipeline is producing zero (or far fewer than expected) accepted items, and there's a candidate-level event log or audit trail to mine. Applies to any system where an item must pass sequential gates before being accepted — trading/strategy engines, content moderation queues, matching or allocation systems, application/review pipelines, fraud/risk screening, hiring funnels, ad-auction eligibility, or anything shaped like "candidate enters at the top, gets rejected at one of several checkpoints, or comes out the bottom accepted." Trigger this before assuming the most prominent threshold (a score, a price, a minimum bar) is the blocker — that's usually the wrong first guess.
---

The instinct when something "isn't qualifying" is to look at the last, most visible threshold
(the score cutoff, the price bar, the approval criteria) and assume it's set too strict. That's
often wrong, and tuning it wastes effort or — worse — degrades quality without fixing anything,
because the real blocker is earlier in the pipeline and the visible threshold was never the
bottleneck. This technique finds the actual blocker from real data before touching any
threshold. (Distilled from a real investigation into a trading app's paper-execution pipeline
where this exact instinct was wrong twice in a row before the real cause — a data-freshness
check three stages upstream of the "obvious" profit bar — was found.)

## Step 1 — Pull the real distribution against every gate, not just the last one

Before touching any threshold, get the actual historical values candidates hit at *each* gate,
not just the final one. If there's an event log, sample a meaningful window (hundreds to
thousands of events) and compute, per gate: how many candidates cleared it, and the
distribution of values relative to its threshold (min/median/p90/max, or a simple histogram).

This one step usually settles the "is the bar too strict" question immediately. If hundreds of
candidates already clear a gate comfortably, that gate is not the blocker, full stop — no
amount of further tuning there will change the outcome, and the search needs to move
elsewhere. (In the source investigation: the profit and risk/reward gates looked like the
obvious suspects, and the data showed 17% of all candidates cleared *both simultaneously* —
proving those bars were fine and the real blocker was somewhere else entirely.)

## Step 2 — Rank rejection reasons by raw frequency across the WHOLE pipeline

Pull every rejection event (not just ones at the gate you suspect) and count reasons. Sort
descending. The gate that appears most often is the actual bottleneck — and it is frequently
*not* the gate the pipeline's stated purpose would lead you to assume, because gates fire in
sequence and an earlier, less-discussed check (a data-freshness check, an identity/dedup
check, a rate limit, a capacity constraint) can dominate before the "interesting" business
logic gates are ever reached. If one rejection reason accounts for the overwhelming majority
of all rejections, that is where to dig next — regardless of which gate you originally
suspected.

## Step 3 — Trace *why* that dominant gate fires, not just *that* it fires

Once you've found the dominant rejection reason, read the actual check's implementation and
ask what data it needs and where that data comes from. Two common shapes this takes:

- **A capacity/rate mismatch between two subsystems.** One subsystem can only actively track/
  verify/serve a bounded number of items (a cache, a subscription limit, a rate-limited
  upstream), while a much larger and faster-moving population of candidates needs that
  subsystem's output to pass. Any candidate not currently "in view" of the bounded subsystem
  silently falls back to a lesser data source that can't satisfy the check — and that fallback
  is often unconditional and invisible unless you go looking for it.
- **A verification/provenance gap between two stores that are supposed to be in sync.** One
  part of the system verifies eligibility (A), a downstream part re-checks eligibility
  independently against its *own* internal record (B), and the sync path between A and B
  either lags, only covers a subset, or silently drops entries the downstream part rejects.
  From the outside this looks identical to "the item just isn't eligible," when actually it's
  eligible in A and simply never made it into B.

## Step 4 — When you ship a partial fix, filter verification data strictly to AFTER the fix

This is the single most common way to misjudge whether a fix worked, and it happened in the
source investigation: reading the tail of a shared, ever-growing append-only log after a fix
mixes pre-fix and post-fix events together, and a fix that's actually working can look
inconclusive (or completely broken) for far longer than necessary. Compute the fix's deploy/
relaunch timestamp, and filter every subsequent read of the log to strictly `event.time >
deployTimestamp` before drawing any conclusion. Do this every time, not just when something
looks wrong — it costs nothing and prevents a real, measurable class of wasted time.

## Step 5 — Read the trend shape, not just the current rate, over an observation window

If a fix only partially works, watch the failure rate over time rather than taking one
snapshot. A **declining** failure rate over the window is consistent with a genuine
timing/warm-up issue (things get better as the system catches up) — patience or a longer
wait is a reasonable next step. A **flat** failure rate that doesn't move at all across a
meaningfully long window is evidence of something structural (a hard capacity ceiling, a sync
gap, a rate mismatch) that will not resolve on its own no matter how long you wait — that's
the signal to go back to Step 3 and look for a deeper cause rather than "give it more time."

## Step 6 — Check for shadow-state bugs when a fix that "should" work doesn't

If you write a fix that adds/updates a candidate into some bounded tracked set (Step 3's first
shape), verify the *underlying system* actually accepted it — don't just trust your own
bookkeeping that says "I added it." A common failure mode: your code optimistically marks the
item as handled locally, but the underlying system's own independent verification silently
rejected it, and your local bookkeeping now permanently believes the item is fine — so every
future attempt for that same item short-circuits on your own stale flag and never retries.
Confirm acceptance by checking the actual downstream effect (does the expected data start
flowing?) within a reasonable wait window, and if it doesn't show up, roll your local
bookkeeping back rather than leaving it in a permanently-wrong state.

## Summary checklist for the writeup

When reporting findings, state clearly: (1) the measured distribution proving whether the
obvious threshold was or wasn't the blocker, (2) the ranked rejection-reason breakdown and
which gate actually dominates, (3) the specific mechanism (capacity mismatch vs. provenance
gap vs. something else) once traced, (4) what was fixed and the *strictly post-fix-timestamp*
measured result, and (5) whether the trend is declining (probably resolving) or flat (probably
structural and needs another pass). This is more convincing than any single number and makes
the next person's job (including a future you) much faster.
