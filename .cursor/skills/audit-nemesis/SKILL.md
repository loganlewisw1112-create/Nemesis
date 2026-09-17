---
name: audit-nemesis
description: Use when auditing NEMESIS for bugs, gaps, regressions, or release readiness — black screen, empty Edge Theater, IPC failures, Kalshi connector issues, paper/live drift, guardrail bypasses, or before shipping desktop builds.
---

# Audit NEMESIS

## Overview

Run a **layered audit**: automated gates first, then boundary checks, then behavioral smoke tests. Every finding gets severity, evidence, and a fix recommendation. Do not mark the audit complete until gates pass and findings are listed.

**Core principle:** NEMESIS splits renderer (React) from main process (Electron + Kalshi + paper engine). Most silent failures are boundary violations or IPC drift.

## When to Use

- User asks to audit, health-check, or find gaps in NEMESIS
- Before release, after large refactors, or after Electron/UI/connectors changes
- Symptoms: black screen, stuck loading, no tradable tickets, WS errors, P&L mismatch, live unlock issues

**When NOT to use:** unrelated repos, Kalshi account/API key setup only, or pure feature design (use brainstorming instead).

## Audit Workflow

Copy this checklist and track progress:

```
NEMESIS Audit Progress:
- [ ] Phase 1 — Automated gates
- [ ] Phase 2 — Renderer/main boundaries
- [ ] Phase 3 — IPC contract parity
- [ ] Phase 4 — Data & trading logic
- [ ] Phase 5 — Connectors & runtime
- [ ] Phase 6 — Safety & guardrails
- [ ] Phase 7 — UI smoke (dev app)
- [ ] Phase 8 — Report delivered
```

Work from `nemesis/` unless noted.

---

## Phase 1 — Automated Gates

Run all commands; capture output. **Any failure is at least Medium severity.**

```bash
npm test
npm run typecheck
npm run build
```

Additional checks:

```bash
# Renderer must NOT import execution barrel or Node builtins
rg "from '@nemesis/execution'" packages/ui apps/desktop/src
rg "node:crypto|node:fs|require\\('ws'\\)" packages/ui apps/desktop/src

# Build must not externalize crypto into browser bundle
npm run build 2>&1 | rg -i "node:crypto|createSign|externalized"
```

**Pass criteria:** all tests green, typecheck clean, production build succeeds with no browser-bundle crypto errors.

---

## Phase 2 — Renderer / Main Boundaries

| Layer | Allowed imports | Forbidden in renderer |
|-------|-----------------|----------------------|
| `apps/desktop/src`, `packages/ui` | `@nemesis/core`, `@nemesis/charts`, subpaths like `@nemesis/execution/pnlEngine` | `@nemesis/execution` barrel, `@nemesis/connectors`, `@nemesis/pods`, `node:*`, `fs`, `ws` |
| `electron/main.ts` | all packages | — |

Verify:

1. Grep UI/renderer for forbidden imports (see [checklist.md](checklist.md)).
2. Confirm `packages/execution/src/index.ts` exports Node-only modules (`signer`, `liveOrderAdapter`) and UI never imports that barrel.
3. Confirm `vite.config.ts` aliases point at `packages/*/src` and renderer does not bundle main-only code.

**Known failure:** UI imports `@nemesis/execution` → pulls `signer.ts` → black screen, empty `#root`.

---

## Phase 3 — IPC Contract Parity

Three files must stay in sync:

| File | Role |
|------|------|
| `apps/desktop/electron/preload.ts` | `window.nemesis` API |
| `apps/desktop/electron/main.ts` | `ipcMain.handle('nemesis:…')` |
| `apps/desktop/src/App.tsx` | `Window.nemesis` TypeScript interface |

For each method: name, args, return shape, and event listeners (`onMarketsUpdate`, `onPaperUpdate`, `onSettingsUpdate`, `onTicksUpdate`) must match.

Flag:

- Handler in main with no preload exposure
- Preload method with no main handler
- App.tsx calling methods missing from preload
- `reconcileLive` or other preload-only APIs missing from App types (document if intentional)

---

## Phase 4 — Data & Trading Logic

Review these paths for gaps, stale state, and inconsistent math:

| Concern | Key files |
|---------|-----------|
| Market refresh & thesis build | `electron/main.ts` (`refreshMarkets`, `finalizeThesis`), `packages/pods/src/edge-scanner.ts` |
| Regime / reviewOnly | `main.ts` — must reset each refresh, not stick forever |
| Paper fills | `packages/execution/src/executionRouter.ts`, `dryRun.ts`, `paperDesk.ts` |
| P&L unity | `packages/execution/src/pnlEngine.ts`, `packages/ui/src/PaperDeskPanel.tsx`, `ProfitStationPanel.tsx` |
| Limit/working orders | `paperOrders.ts`, `processWorkingOrders` in main |
| Persistence | `nemesis-data/` JSON: settings, paper, equity-history, session-stats, audit-log |

Checks:

1. `reviewOnly` resets on market refresh; demo mode still shows tradable cards when edge qualifies.
2. Paper buy/close uses orderbook + `dryRunFill`, not naive mid-price fills.
3. Unrealized P&L uses same fee-aware formula in desk and profit station.
4. Daily loss cap blocks new buys when breached.
5. Session stats and equity history persist across restart.

---

## Phase 5 — Connectors & Runtime

| Connector | File | Check |
|-----------|------|-------|
| Kalshi REST | `packages/core` Kalshi client | demo vs live base URL, auth headers when creds present |
| Kalshi WS | `packages/connectors/src/kalshiStream.ts` | uses `ws` in main (not `WebSocket.OPEN`), reconnect backoff, `track()` after thesis build |
| Feed hub | `packages/connectors` FeedHub | background polling registered, health in registry |

Dev runtime:

```bash
npm run dev
```

Watch terminal for:

- `WebSocket is not defined`
- `Network service crashed`
- `did-fail-load`
- Uncaught errors in main during `refreshMarkets` or `kalshiStream.start()`

Confirm Settings shows connector health; `kalshi-ws` should not crash the app when WS unavailable.

---

## Phase 6 — Safety & Guardrails

NEMESIS defaults (from README): demo ON, dry-run ON, 8 gates before live, kill-switch `Ctrl+Shift+K`.

Verify in code:

1. `canEnableLive` / `evaluateGates` enforced in `updateSettings` and `unlockLive`.
2. Kill switch disables live and cancels working orders (`killSwitch` handler).
3. Live path requires quiz + backtest + explicit unlock wizard.
4. No code path places live orders when `settings.liveEnabled` is false.
5. Credentials never logged or committed (grep for `apiKey`, `privateKey`, `.env`).

---

## Phase 7 — UI Smoke (Manual or Browser/Electron)

If dev server is running, verify:

| Tab | Expected |
|-----|----------|
| Edge Theater | tradable count > 0 after Refresh (demo); filter chips work; thesis cards render |
| Thesis card | "Why this trade is profitable" dropdown shows edge + gates |
| Paper | blotter, order ticket, partial close, working orders |
| Profit Station | equity chart, fill quality, attribution panels |
| Settings | guardrail cockpit, connectors list, quiz/backtest/unlock flows |

App must show content within a few seconds — not permanent black screen or endless "Loading NEMESIS...".

---

## Phase 8 — Report

Deliver findings using this template:

```markdown
# NEMESIS Audit Report — [date]

## Summary
[1–3 sentences: ship/no-ship recommendation]

## Automated gates
| Check | Result |
|-------|--------|
| npm test | pass/fail |
| npm run typecheck | pass/fail |
| npm run build | pass/fail |

## Findings

### Critical
- **[title]** — evidence — recommended fix

### High
- ...

### Medium / Low
- ...

## Verified OK
- [what was checked and passed]

## Suggested next steps
1. ...
```

**Severity guide:**

| Level | Examples |
|-------|----------|
| Critical | Black screen, live orders without gates, credential leak, data loss |
| High | IPC drift, P&L wrong, reviewOnly stuck, WS crash loop |
| Medium | Missing tests, stale UI state, connector degraded gracefully but wrong |
| Low | Copy, polish, non-blocking devtools noise |

---

## Common Mistakes (Auditor)

| Mistake | Reality |
|---------|---------|
| "Tests pass, ship it" | Run build + boundary greps; unit tests don't cover Electron renderer bundle |
| "Black screen = CSS" | Usually renderer JS crash from Node import in UI bundle |
| "Only check App.tsx" | Preload/main/type trio must match |
| "Skip manual smoke" | Edge Theater empty state and WS health need runtime verification |
| Audit without running commands | Always run Phase 1 yourself; don't guess from memory |

## Quick Reference

| Symptom | First check |
|---------|-------------|
| Black screen | UI imports of `@nemesis/execution` barrel; `npm run build` crypto error |
| Loading forever | `window.nemesis` / preload path; main IPC hang |
| No tradable tickets | `reviewOnly`, edge-scanner, demo promotion in `edge-scanner.ts` |
| WS errors | `kalshiStream.ts` main-process WebSocket setup |
| P&L drift | `pnlEngine.ts` vs panel calculations |

For the full grep matrix and file map, see [checklist.md](checklist.md).
