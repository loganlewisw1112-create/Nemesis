# NEMESIS — Soak/R10 Stall: Root Cause & Finalize Plan

Author: planning phase (Opus 4.8), 2026-07-20. For execution by Opus 4.8.

## 0. TL;DR

The recurring soak/R10 failure is **one bug wearing many masks**, not a stream of new
bugs. Every failure resolves to: the renderer/main event loop is starved of CPU long
enough that the runtime-health watchdog sees a **renderer heartbeat gap > 15s**, marks
the run `invalidated` (sticky), and `app.quit()`s → soak records "exited early / runtime
invalidated". The starvation is caused by an **append-only campaign ledger that is
`structuredClone`d twice on every orderbook delta** and whose ever-growing snapshot is
also raw-broadcast to the renderer every 1–5s. Cost scales with elapsed soak time, so the
stall appears minutes in, stochastically, with steady-state memory flat (it's CPU/event-
loop saturation, not a leak).

Prior ~40 repair commits never touched this. They (a) reworked feed/transport readiness
accounting and (b) repeatedly **widened the watchdog's tolerance** (`avoid false stale
probe during delayed response`, `extend renderer startup grace`, `ignore heartbeat age
before renderer load`). Widening tolerance is why small stalls now "recover"
(`recoveryCount: 3` in the last run) — but a big stall still blows past 15s. That is the
loop we are breaking.

## 1. Evidence (how we know)

- 3 soak runs today (15:04 / 15:59 / 17:13) all failed identically. Window closed at
  ~6.5 / ~21.6 / ~26 min — **stochastic, later-in-run**.
- Cutoff snapshot `.../r10-soak-20260720-171356-a0/production-soak-runtime-status-at-cutoff.json`:
  everything green except renderer — bridge connected, feeds `ok`, main process 181 MB.
  Renderer: `heartbeatAgeMs: 15717`, `rendererProbeAgeMs: 14553`, `blocked: true`,
  reason `"renderer heartbeat gap exceeded 15 seconds"`; **both** liveness signals froze
  at the same instant → JS event loop starvation (not IPC/transport).
  `runtime_health` lease `failed`, `recoveryCount: 3` (≥3 earlier stalls that cleared
  under 15s). Renderer working set 55 MB, `growthRate: -0.25` → **not memory**.
- Watchdog wiring (confirmed): main sends probe every 5s (`main.ts:556-576`); probe +
  self-heartbeat handlers both live in `preload.ts:24-43` **on the same JS thread as
  React** — a long sync task starves both. Thresholds `rendererHeartbeatMonitor.ts:31-36`
  (`heartbeatMaxAgeMs/probeMaxAgeMs = 15_000`). Sticky reasons →
  `runtimeHealthController.ts` `invalidate()` (sticky) → `invalidateEvidenceAttempt()`
  (`main.ts:1661-1697`) → `geaProcess.kill()` + `setTimeout(() => app.quit(), 250)` →
  `window-closed` trace → soak script sees `runtimeState === 'invalidated'` and aborts
  (`run-production-soak.ps1:486-489`). There is **no app-authored exit code -1**; the -1
  is the PS runner force-terminating the process tree.

## 2. Root cause (confirmed by source)

`packages/execution/src/sevenHourCampaign.ts`
- `clone = structuredClone` (271-273). `allEvents(): return clone(this.events)` (380-382)
  — deep-clones the **entire append-only `events` array** (276, never pruned).
- `append()` (389-413) pushes events for screened-out candidates, diagnostics, samples,
  etc. → ledger grows unbounded for the campaign's life.

`apps/desktop/electron/sevenHourCampaignStore.ts`
- `record()` (54-74): `const before = this.tracker.allEvents().length;` … `const created =
  this.tracker.allEvents().slice(before);` → **two full-ledger `structuredClone`s per
  call**, purely to compute which events were appended. Then `fs.writeSync` +
  **`fs.fsyncSync`** (synchronous forced flush) when events were created (60-67).

`apps/desktop/electron/main.ts`
- `campaignSnapshot()` (1137-1141) = `campaignStore.record(...)` + `campaignStore.snapshot()`.
  `snapshot()` additionally clones the growing `candidates`/`diagnostics`/`screenedOut`
  maps.
- Called from ~18 sites incl. the **per-orderbook-delta hot path** (5931, 5963, 6001;
  fires for 25 books at tens of deltas/sec) and raw renderer broadcasts (4072, 5170, 5349).
- `broadcast('paper:update', { evidenceCampaign: campaignSnapshot(), orderbookStream: ...
  })` (4060-4076) is a **raw `webContents.send`** (bypasses the diffing
  `VersionedStateStream`/`stateStreamCoalescer`), pushing the whole growing snapshot to the
  renderer every 1–5s.

Renderer amplifier (`apps/desktop/src/App.tsx`, defense-in-depth, not the trigger):
- Every IPC message rebuilds the full `markets`/`theses` Maps → new array identity every
  message (278-292); **no `React.memo`/`useMemo` anywhere** → every mounted component
  re-renders on every message; Markets tab renders up to **500 unvirtualized `<tr>`**
  (684-708); no renderer-side coalescing/throttle. So a large `evidenceCampaign` payload
  lands as a full-tree synchronous re-render.

Secondary duration-scaling growth on the main thread (make soak fragile, worsen GC):
- `discoveryOrchestrator.ts:44-45` `depthByTicker` / `orderbookCache` — only `.set()`,
  **never evicted** on the 5-min universe refresh; iterated + `JSON.stringify` + sha256'd
  every 15s (`main.ts:2184-2190`).
- `auditLog` → `saveAuditLog()` (`main.ts:2306-2309`) re-`JSON.stringify`s the whole
  (≤5000) log + `writeFileSync` on **every** audit event.
- Bridge telemetry `fs.appendFileSync` per inbound packet to an **unbounded** JSONL
  (`main.ts:588-601`).

## 3. The fix — layered (root cause first, then resilience, then guard)

### Layer 1 — kill the per-delta full-ledger clones (PRIMARY, do first)
1. `sevenHourCampaignStore.ts record()`: the mutation already **returns the created
   events** (`record<T extends CampaignEvent[]>(mutation): T`; `append()` returns
   `[clone(event)]`). Replace the two `allEvents()` calls with the returned value:
   `const created = result;` and delete the `before`/`slice` lines. First **audit every
   `record()` caller's mutation** to confirm it returns exactly the newly-created events
   (esp. `ensureConfiguration` — must return `[]` when nothing changed). This removes 2
   full-ledger deep clones per record() with zero behavior change.
2. Add `SevenHourCampaignTracker.eventCount(): number` (return `this.events.length`) for
   any caller that only needs a count; forbid using `allEvents()` on hot paths.
3. Memoize `campaignStore.snapshot()`: cache the built snapshot, invalidate the cache on
   any mutation. Per-delta paths (`main.ts:5931/5963/6001`) then reuse the cached snapshot
   instead of rebuilding+cloning the growing candidate/diagnostic/screened maps.
4. Move `fs.fsyncSync` off the hot path — batch appends and fsync on a timer / debounce,
   or drop fsync to an async flush (durability of the *evidence* ledger is preserved by
   the append; per-event fsync is what blocks).

### Layer 2 — stop shipping the growing snapshot to the renderer
5. `main.ts:4072/5170/5349`: replace `evidenceCampaign: campaignSnapshot()` with a
   **bounded summary** (manifest/status, counts, last-N records) or route it through the
   diffing coalescer. The renderer must never receive the full unbounded
   candidates/diagnostics/screenedOut arrays every 1–5s.

### Layer 3 — renderer resilience (so no payload can ever block > 15s again)
6. `App.tsx`: coalesce inbound IPC into a single rAF/microtask batch (apply at most one
   render per frame regardless of message burst).
7. Wrap heavy panels in `React.memo`; `useMemo` the O(500) `filter/sort/Set` derivations
   (358-379, `Notifications.tsx:66-75`); keep stable array identity for unchanged rows.
8. Virtualize the Markets tab table (684-708) or cap it like the Theater tab
   (`DEFAULT_VISIBLE_THESIS_LIMIT`).

### Layer 4 — secondary main-thread growth
9. `discoveryOrchestrator.ts`: evict `depthByTicker`/`orderbookCache` entries not in the
   current universe on `refreshUniverse` (206). Avoid stringify+hash of the whole state
   every 15s (diff, or hash incrementally).
10. `auditLog`: append the new entry to disk instead of re-serializing the whole log.
11. Bridge telemetry JSONL: rotate/cap the file.

### Layer 5 — regression guard (this is how we "stop them indefinitely")
12. Unit test: feed the tracker 10k events, assert `record()` does **O(1)** work
    (no `allEvents()` call) — e.g. spy that `allEvents` is not invoked, and/or assert
    per-record time stays flat as the ledger grows. Fails CI if the clone-on-hot-path
    pattern returns.
13. Keep the runtime-health trace (already documented) and add a soak-invariant assertion:
    a passing soak must end with `recoveryCount == 0` and zero `invalidate` actions — so a
    partial regression (stalls that "recover") is caught, not hidden by tolerance.

## 4. Verification gates (must pass in order — no skipping)

- **G1 Rehearsal soak** (reduced-bar / existing rehearsal config): must complete the full
  30 scored minutes, `recoveryCount == 0`, no `invalidated`. Proves Layer 1–3.
- **G2 Full production soak** (`run-production-soak.ps1`, official duration): all
  `acceptanceFailures` empty, `passed: true`.
- **G3 R10 gap-closure run**: runs to completion with zero crashes.
- Between G1 and G2, watch the **secondary open gap** seen at cutoff: orderbook
  `status: warn`, `qualifiedTickers: 0`, `"awaiting repaired sequenced delta"`,
  `quarantinedTickers: 4`. Coverage metrics (`feedReadinessCoverage`) can only be judged
  once a run survives to steady state; if G2 fails on feed qualification rather than the
  stall, address orderbook qualification as a **separate** ticket (do not re-widen the
  watchdog).

## 5. Suggested execution sequencing (Opus, dispatch agents per wave)

1. **Wave A (serial, careful):** Layer 1 (items 1–4) + the Layer 5 regression test (12).
   Run existing unit/integration tests + typecheck + build. This is the load-bearing fix.
2. **Wave B (parallel agents ok):** Layer 2 (5) and Layer 3 (6–8) — main-side summary and
   renderer resilience can be built in parallel; integrate + test.
3. **Gate G1.** Only proceed if clean.
4. **Wave C:** Layer 4 (9–11) hardening + Layer 5 soak-invariant (13).
5. **Gate G2 → G3.**

## 6. Explicitly out of scope / do-not-do
- Do **not** raise `heartbeatMaxAgeMs/probeMaxAgeMs` or add more startup grace. The
  watchdog is correct; the thread block is the bug.
- Do not disable the campaign ledger or its evidence integrity — fix the *clone-on-read*
  and *snapshot-on-hot-path* patterns, not the evidence guarantees.
