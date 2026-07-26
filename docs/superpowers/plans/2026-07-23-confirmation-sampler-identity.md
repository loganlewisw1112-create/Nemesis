# Confirmation Sampler Identity Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let confirmation samples accumulate across re-issued flow signal IDs for the same ticker/side/playbook so candidates can reach `ready` (and enable a clean thesis go/no-go).

**Architecture:** Make `campaignEconomicIdentity` truly stable (exclude `card.id`). Key `EntryConfirmationEngine` state on that identity. Treat a new `card.id` for the same economic identity as a continuation, not a reset. Keep exchange-origin, bars, and edgeRetention unchanged.

**Tech Stack:** TypeScript, Vitest, `@nemesis/execution` (`entryConfirmation.ts`, `campaignEnrollment.ts`)

## Global Constraints

- Never relax exchange-origin book timestamp+sequence checks.
- Never lower profit bars (`minExpectedNetPnlUsd`, `minRewardRiskRatio`, `strictProfitMode`).
- Live stays locked; this is paper-path measurement plumbing only.
- Proven-continuous quiet-book sample admission (commit `17ad647`) stays as-is.

---

## File map

| File | Change |
|------|--------|
| `packages/execution/src/campaignEnrollment.ts` | Drop `card.id` from `campaignEconomicIdentity` |
| `packages/execution/src/entryConfirmation.ts` | Key state on economic identity; allow signal-id continuation; mark used by identity |
| `packages/execution/src/entryConfirmation.test.ts` | Tests for re-issued IDs + identity stability |
| `packages/execution/src/sevenHourCampaign.test.ts` | Assert identity ignores `card.id` |
| `docs/HANDOFF-NEXT-SESSION.md` | Point next session at first-ready thesis experiment |

---

### Task 1: Stable economic identity

**Files:**
- Modify: `packages/execution/src/campaignEnrollment.ts`
- Test: `packages/execution/src/sevenHourCampaign.test.ts`

- [x] **Step 1: Failing test** — `candidateEconomicIdentity` equal for same ticker/side/playbook/sourceMove with different `id`
- [x] **Step 2: Implement** — remove `card.id` from `campaignEconomicIdentity` join
- [x] **Step 3: Verify** — targeted vitest green

### Task 2: Confirmation accumulates across re-issued signal IDs

**Files:**
- Modify: `packages/execution/src/entryConfirmation.ts`
- Test: `packages/execution/src/entryConfirmation.test.ts`

- [x] **Step 1: Failing test** — observe with `id: flow-a` then `id: flow-b` (same ticker/side/playbook); samples must go 1→2, not reset
- [x] **Step 2: Failing test** — after `markSourceUsed` on confirming id, a re-issued id for same economic identity is rejected
- [x] **Step 3: Implement** — default state key = `campaignEconomicIdentity(card)`; allow `sourceSignalId` updates; track used economic identities
- [x] **Step 4: Verify** — full `entryConfirmation.test.ts` + `executionTail.integration.test.ts` green

### Task 3: Handoff / experiment framing

- [x] Update `docs/HANDOFF-NEXT-SESSION.md`: sampler fixed; next action is market-hours first-ready go/no-go (no bar tuning)

### Task 4: Verify suite

- [x] `npx vitest run packages/execution`
- [x] `cd apps/desktop && npx tsc --noEmit` if time permits
