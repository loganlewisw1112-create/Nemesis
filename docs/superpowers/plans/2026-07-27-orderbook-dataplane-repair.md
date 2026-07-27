# Orderbook Data-Plane Repair → Next Qualifying Paper Run

> **Source:** NEMESIS cutoff report for the run `2026-07-26 20:32:12 PDT → 2026-07-27 04:41:25 PDT` (8.15h, KXBTCD-only allowlist, paper/dry-run, live hard-locked).
> **Status:** plan only. No source edits, no relaunch, no settings/archive/reset until Phase 0 lands.
> **Verdict being acted on:** the run was a valid *diagnostic*, not a qualifying paper run. Do not advance to pilot. Do not lower bars. Do not relax the exchange-origin book rule.

**Goal:** restore a provably live orderbook data plane — sequenced exchange books delivered continuously to the candidates actually attempting entry — and make it *impossible* for a dead data plane to masquerade as economic rejection ever again. Only then re-judge shadow.

**Explicitly not the goal:** finding a trade. If the strategy declines every opportunity on a healthy data plane, that is a result, not a failure.

---

## 0. Locked context — measured, do not re-derive

### 0.1 Run facts (from the cutoff report)

| Field | Value |
|---|---|
| Run window | `2026-07-26 20:32:12 PDT` → `2026-07-27 04:41:25 PDT` (8.15h) |
| Stop | requested `03:00:00 PDT`, actual `04:41:25 PDT` — **101.4 min late** |
| Safety | `liveEnabled=false`, `autoLiveEnabled=false`, `dryRun=true`, `demoMode=false`, `killSwitchActive=false` |
| Launch overrides | `allowlist=KXBTCD`, `denylist=KXETHD`, `orderbookTrackingLimit=25`, `shadowMinScored=50`, `shadowMinObservationDays=1` |
| Portfolio | cash `$5,000`, positions `0`, trades `0`, paper orders `0`, realized P&L `$0` |
| Session | abort count `778`, API degraded minutes `152` |
| Ledgers | strategy-validation 4,950 lines / paper-qualification 30,885 lines — **both hash chains replay clean, 0 bad JSON** |
| Entry funnel | 4,472 confirmation observations → ready 4, pending 67, rejected 4,401; **4,136 rejects = "confirmation requires an exchange-origin book timestamp and sequence"** |
| Ready candidates | all 4 inside the first ~95s after launch |
| Priority trace | `admitted-no-book` 4,843 · `provenance-unavailable` 139 · **`sequenced-book` 3** (20:37:21, 20:39:05, 20:42:00 PDT) |
| Shadow | 4 started, 2 scored (+$9.32 net, PF 4.40, 50% win, largest-win share 100%), window 0.028h vs 24h required, 2 scored vs 50 required |

### 0.2 New forensic finding (mined from `bridge-telemetry.jsonl` while writing this plan)

This is the decisive fact the cutoff report was one step short of:

- **Last orderbook *application* frame: `2026-07-27T03:45:52.333Z` = `20:45:52 PDT` — 13 minutes 40 seconds after launch.**
- `orderbookObservationFreshnessMs` crossed the 90s data-plane-silence bound at `03:47:24.748Z` (`20:47:24 PDT`) — last sample under bound was `88,645 ms` at `03:47:20.978Z` — and **never came back down across 18,968 bridge samples covering the remaining 7.91h**. Final value `28,532,578 ms` (7.93h); `exchangeDeltaFreshnessMs` `28,532,844 ms`.
- `KalshiOrderbookStream.connect()` sets `lastApplicationMessageAt = connectedAt` in its `open` handler (`kalshiOrderbookStream.ts:555-558`). A single successful reconnect would therefore have reset freshness to ~0. **It never reset. The orderbook socket did not re-open once in 7.9 hours.**
- The 3 `sequenced-book` trace hits (20:37 / 20:39 / 20:42) all land *before* 20:45:52. Every one of the 4,843 `admitted-no-book` outcomes is after the socket died.

**Therefore: this was not a provenance-store failure and not a Kalshi liquidity failure.** Priority tracking worked — `admitted:true` means `kalshiOrderbookStream.isTracked(ticker)` returned true. `ensureProductionProvenance` worked (only 139 `provenance-unavailable` in 8h). The stream's own ticker set stayed populated. What died was the socket, and nothing in the process ever brought it back. Every downstream number — 4,136 exchange-origin rejects, 778 aborts, the stalled shadows — is a shadow cast by a dead socket.

### 0.3 Corrections to the cutoff report (carry these forward)

1. **"Reconnects / disconnects / failovers: 0 / 0 / 0" are *bridge* counters**, not orderbook-stream counters. They are the `reconnects`/`disconnects`/`failovers` fields of `bridge-telemetry.jsonl`, which describe the desktop↔GEA bridge socket. `KalshiOrderbookStream.reconnects` is **not persisted to any ledger**. The conclusion "the OB stream never reconnected" is correct but follows from the freshness trace in §0.2, not from those counters.
2. **`audit-log.json` is a capped 5,000-entry store keyed on `t`, not `at`.** For this run it covers only `03:35:08Z → 09:06:41Z` (`20:35 → 02:06 PDT`); the last 2.6h of the run has no audit coverage at all. Any analysis filtering on `e.at` silently returns zero rows.
3. "Bridge stayed mechanically alive" is right and is exactly the trap: `bridge:pong` RTT 64ms and `qualificationReady=true` describe the *desktop↔GEA* link, which has nothing to do with Kalshi book delivery.

### 0.4 Root cause: the stream has an absorbing dead state

Three code paths tear the socket down, and each can end without scheduling a reconnect:

| Path | Line | Dead-end condition |
|---|---|---|
| `close` handler | `kalshiOrderbookStream.ts:617` | `if (!this.started \|\| !retry.retry) return;` |
| `restartAfterFailure` | `kalshiOrderbookStream.ts:1098` | `if (!this.started \|\| !decision.retry \|\| decision.delayMs == null) return;` |
| `forceLocalReconnect` | `kalshiOrderbookStream.ts:1023` | `if (!this.started) return;` (this one *does* always schedule when started) |

`retry.retry` is false whenever `KalshiProductionConnectionController.recordFailure` returns `noRetry()` (`kalshiTransportController.ts:254-272`), which happens when:
- the failure class is **sticky** — `authentication`, `authorization`, `configuration` (`:139-143`); or
- the class is **not in either retryable set** — `retryable = rotatingFailures.has(c) || retryingSameEndpointFailures.has(c)` (`:347`), so an unmapped/unknown classification is silently non-retryable; or
- `isCurrent(generation)` is false (stale generation or null `attemptId`) → `noRetry()` at `:255`.

Once any of those fires: `closeCurrentSocket()` (`:1080-1092`) nulls `this.socket` and calls `clearHeartbeatTimer()`. From there:

- the **heartbeat watchdog cannot run** — its interval was just cleared;
- **`recoverIfDataPlaneSilent` cannot run** — it bails on `this.socket?.readyState !== WebSocket.OPEN` (`:264`), and the socket is `null`;
- **`subscribeMissing()` is a no-op** — it returns early unless the socket is `OPEN` (`:640-641`), so every subsequent `replaceTracked` from `refreshOrderbookTracking` silently changes nothing on the wire while `this.tickers` still holds all 25 names;
- `isTracked()` keeps returning **true**, so `fetchOrderbookWithPriorityTracking` records `admitted-no-book` (`main.ts:483`) forever, waits the full `PRIORITY_ORDERBOOK_WAIT_MS` (3s) each time, and falls back to a REST book with no sequence — which `entryConfirmation.ts:147-148` then correctly rejects.

**That is the whole 8-hour failure in one sentence: the orderbook stream entered a non-retryable terminal state at 20:45:52 PDT, and the Jul 25 data-plane-silence fix (`3158ef9`) only covers the "socket OPEN but silent" case, not the "no socket at all" case.**

### 0.5 What is *not* yet known (and must not be guessed)

- **Which** failure class killed it. `registry.recordWarn('kalshi-orderbook-ws', …)` and the `console.warn` from `maybeRecoverStaleOrderbookStream` go to the console only. There is no durable record. Phase 0 exists to fix that before anything else.
- Whether `markTrackingChanged()`'s global blast radius (`:884-891` — every membership change deletes **all** tracked books and re-quarantines **every** ticker) is a second, independent throughput limiter. It is a live suspicion, not a finding: with the socket dead, its effect is unobservable in this run's data.
- Whether the `safety_block` / `shutdown_event` at `11:40:07.291Z` and the 778 aborts have any cause beyond the dead data plane.

---

## 1. Non-negotiable constraints

1. **Never** weaken the exchange-origin check (`entryConfirmation.ts`, `campaignEnrollment.ts`). REST snapshots carry no match-engine sequence and never will (`packages/core/src/kalshi/client.ts` `parseOrderbook`).
2. **Never** synthesize `sequence` or `sourceTimestamp` from a local clock.
3. **Never** lower `minExpectedNetPnlUsd` (1) / `minRewardRiskRatio` (2) / `strictProfitMode`, and never lower the shadow quality bars, to make this run look better.
4. Live stays hard-locked: `liveEnabled=false`, `autoLiveEnabled=false`, `dryRun=true`, `demoMode=false`.
5. Claude/agents do **not** edit `settings.json` (classifier boundary). Any settings change is handed to the operator as exact keys.
6. One desktop per AppData. Never two writers against `%APPDATA%\@nemesis\desktop\nemesis-data` (corrupts both hash chains).
7. Every post-relaunch analysis filters on the **new** cutoff from `.nemesis-relaunch-cutoff.txt`. Never mix pre-cutoff corpus into a verdict.
8. A widened timeout or a raised wait ceiling is **not** a fix for a dead socket. If a change only makes the system wait longer for something that is never coming, it does not ship.

---

## 2. File map

| File | Role in this plan |
|---|---|
| `packages/connectors/src/kalshiOrderbookStream.ts` | socket lifecycle, `recoverIfDataPlaneSilent` (:263), `close` handler (:594-635), `restartAfterFailure` (:1094), `forceLocalReconnect` (:1000-1037), `closeCurrentSocket` (:1080), `subscribeMissing` (:639), `markTrackingChanged` (:884), `getBook` (:339), `telemetry` (:417-462) |
| `packages/connectors/src/kalshiTransportController.ts` | `recordFailure` retry decision (:254), sticky classes (:139), `retryable` mapping (:347) |
| `packages/connectors/src/productionMarketProvenance.ts` | 90s provenance TTL (`DEFAULT_PRODUCTION_MARKET_PROVENANCE_TTL_MS`) |
| `apps/desktop/electron/main.ts` | `refreshBridgeConnectivity` (:678-703), `maybeRecoverStaleOrderbookStream` (:706-716, called at :6601), `ensureProductionProvenance` (:366), `fetchOrderbookWithPriorityTracking` (:400-487), `tracePriorityTracking` (:341), `refreshOrderbookTracking` (~:4780-4872), reverify/universe intervals (:6672-6673) |
| `packages/execution/src/entryConfirmation.ts` | exchange-origin gate — read-only in this plan |
| `scripts/launch-paper-allowlist.ps1` | relaunch protocol, cutoff file, env |
| `%APPDATA%\@nemesis\desktop\nemesis-data\` | `bridge-telemetry.jsonl`, `paper-strategy-validation-events.jsonl`, `paper-qualification-events.jsonl`, `audit-log.json`, `session-stats.json` |

---

## Phase 0 — Durable data-plane observability (lands first, changes no behavior)

**Rationale:** the previous 8 hours produced 466,339 bridge records and could not answer "why did the socket die?" Every fix in Phase 1 is unverifiable without this. Phase 0 is additive logging only — it cannot change what the app does.

### Task 0.1 — Persist orderbook stream telemetry to its own ledger

**Modify:** `apps/desktop/electron/main.ts` (next to `maybeRecoverStaleOrderbookStream`), `packages/connectors/src/kalshiOrderbookStream.ts` (one new read-only accessor).

- [ ] **Step 1** — Add `socketState(): 'none' | 'connecting' | 'open' | 'closing' | 'closed'` to the stream (read-only projection of `this.socket?.readyState`), plus `reconnectScheduled: boolean` (`this.reconnectTimer != null`) on the telemetry object. These two fields alone discriminate every hypothesis in §0.4.
- [ ] **Step 2** — On the same health tick that calls `maybeRecoverStaleOrderbookStream()` (`main.ts:6601`), append one JSON line to `NEMESIS_ORDERBOOK_TRACE_PATH` (env-gated, same pattern as `NEMESIS_PRIORITY_TRACK_TRACE_PATH`, `main.ts:341-348`) with: `at`, `socketState`, `reconnectScheduled`, `started`, `connected`, `authenticated`, `generation`, `reconnects`, `trackedTickers`, `verifiedTrackedTickers`, `serverTrackedTickers`, `qualifiedTickers`, `quarantinedTickers`, `booksWithExchangeTime`, `membershipAcknowledged`, `trackingRevision`, `acknowledgedTrackingRevision`, `subscriptionUpdateQueueDepth`, `subscriptionUpdateInFlight`, `sequenceGaps`, `sequenceRegressions`, `lastApplicationMessageAt`, `lastSequencedDeltaAt`, `lastExchangeTimestamp`, `lastCloseAt`, `lastCloseCode`, `lastCloseReason`, `lastCloseTrigger`, `failureClass`, `errorCode`, `httpStatus`, `nextRetryAt`, `activeEndpoint`, `failedEndpoint`, `switchReason`, `failureCounters`.
  Every one of these already exists on `telemetry()` except the two from Step 1 — this is serialization, not new measurement.
- [ ] **Step 3** — Sample cap: write at most one line per health tick and skip a write when nothing but `at` changed *and* the last write was under 30s ago, so an 8h run costs kilobytes, not gigabytes.
- [ ] **Step 4** — Unit test: given a stubbed stream telemetry, the writer emits one line with all required keys and honors the dedupe window.

### Task 0.2 — Make connector warnings durable

**Modify:** `apps/desktop/electron/main.ts` (connector registry wiring).

- [ ] **Step 1** — Mirror every `recordWarn`/`recordTelemetry` for `kalshi-orderbook-ws`, `kalshi-ws`, `kalshi-rest` into the Task 0.1 ledger (or a sibling `connector-warns.jsonl`) with `at`, `connector`, `message`. The strings that would have solved this run in five minutes — `"order-book websocket data-plane silence; forcing reconnect+resubscribe in Nms"`, `"order-book websocket pong expired"` — currently exist only in a console nobody was reading at 20:45 PDT.
- [ ] **Step 2** — Same for the `console.warn` inside `maybeRecoverStaleOrderbookStream` (`main.ts:710-715`).

### Task 0.3 — Stop the bridge ledger from being misleading

**Modify:** `packages/bridge-contracts/src/bridge.ts`, `apps/desktop/electron/main.ts:678-703`.

- [ ] **Step 1** — Add `orderbookStreamReconnects`, `orderbookTrackedTickers`, `orderbookQualifiedTickers`, `orderbookSocketState` to `BridgeStatus`, populated in `refreshBridgeConnectivity` from `kalshiOrderbookStream.telemetry()`.
- [ ] **Step 2** — Rename nothing; the existing `reconnects`/`disconnects`/`failovers` stay as bridge counters. Add a one-line comment at their declaration (`main.ts:661-675`) stating they are bridge-socket counters, so the next reader does not repeat the §0.3 misreading.

### Task 0.4 — Fix the audit-log truncation

**Modify:** wherever `audit-log.json` is capped/persisted.

- [ ] **Step 1** — The 5,000-entry cap silently discarded the last 2.6h of an 8h run. Either roll to `audit-log.jsonl` (append-only, same shape) or archive-and-rotate on cap with the rotation recorded. Keep the `t` field name; do not break existing readers.
- [ ] **Step 2** — Note in `docs/` that audit entries key on `t`, not `at`.

**Phase 0 gate:** `npx vitest run` green, `tsc --noEmit` green on `apps/desktop`, `npm run build` green. A 10-minute local launch produces a non-empty orderbook trace whose `socketState` reads `open`. No behavior change to tracking, confirmation, or execution.

---

## Phase 1 — Remove the absorbing dead state (the actual fix)

**Principle:** a started stream must never be able to reach a state from which no code path can recover it. Recovery must be driven by an owner that is *outside* the socket, because everything inside the socket dies with it.

### Task 1.1 — Failing tests first

**Modify:** `packages/connectors/src/kalshiOrderbookStream.test.ts`.

- [ ] **Step 1** — Test A (`socket never re-opens after non-retryable close`): start a stream, track tickers, drive a close whose classification is sticky (e.g. `authentication`) or unmapped so `recordFailure` returns `noRetry()`. Assert today's behavior — `socketState === 'none'`, `reconnectScheduled === false`, and `recoverIfDataPlaneSilent()` returns `false` forever. **This test must fail after the fix**, so write it as the desired post-fix assertion: after `SUPERVISOR_INTERVAL`, the stream has attempted a new connection.
- [ ] **Step 2** — Test B (`restartAfterFailure dead end`): drive `unexpected-response` with a non-retryable HTTP status; assert recovery is eventually attempted.
- [ ] **Step 3** — Test C (`OPEN but silent` regression guard): the existing `3158ef9` behavior must still hold — 90s of application silence on an OPEN socket with non-empty membership forces reconnect+resubscribe.
- [ ] **Step 4** — Test D (`no false thrash`): a quiet-but-alive book (snapshots/deltas arriving for *some* tracked tickers) must not trigger recovery.

### Task 1.2 — Supervised reconnect (replace the OPEN-only guard)

**Modify:** `packages/connectors/src/kalshiOrderbookStream.ts`.

- [ ] **Step 1** — Generalize `recoverIfDataPlaneSilent` into `superviseDataPlane(now)` with explicit cases:
  - `!this.started` → no-op (correct: an intentionally stopped stream stays stopped).
  - socket `OPEN` + membership non-empty + application silence > `ORDERBOOK_DATA_PLANE_SILENCE_MS` (90s) → `forceLocalReconnect` (today's behavior, unchanged).
  - socket **not** `OPEN` (`none`/`closing`/`closed`) **and** `reconnectTimer == null` → **schedule a connect attempt** on the supervisor's own backoff. This is the case that ran the whole 8-hour run into the ground and is currently unreachable by any recovery code.
  - socket `CONNECTING` for longer than a connect deadline (propose 20s) → treat as failed attempt, close and re-schedule.
  - membership empty → still supervise the socket (do not require `tickers.size > 0` for *connection* liveness; only the silence check needs membership).
- [ ] **Step 2** — Supervisor backoff: independent of the transport controller's decision, bounded exponential (propose 5s → 2× → cap 60s), reset on a successful `open` + first application frame. A sticky `authentication`/`authorization` failure should back off to the cap and keep retrying **while surfacing a loud, durable warn** — never silently give up. Rationale: credentials can be rotated/repaired at runtime; a permanently dead feed is strictly worse than a slow retry loop, and there is no real-money risk in a paper run.
- [ ] **Step 3** — Never lose the timer: assert (in code, via the supervisor) the invariant `started && socketState !== 'open' ⇒ reconnectScheduled || connectInFlight`. Emit a warn if it is ever observed false — that warn is the tripwire for the next unknown variant of this bug.
- [ ] **Step 4** — Heartbeat self-heal: if the socket is `OPEN` but the heartbeat interval handle is null, restart it. (`closeCurrentSocket` clears it; a stale-generation race could otherwise leave an OPEN socket unpinged.)

### Task 1.3 — Main-process escalation ladder

**Modify:** `apps/desktop/electron/main.ts:706-716` (`maybeRecoverStaleOrderbookStream`).

- [ ] **Step 1** — Call `superviseDataPlane` on the existing health tick, and escalate on consecutive failures: `resubscribe` → `reconnect` → `endpoint failover` → `stop() + start()` full stream restart. Each step bounded, counted, and written to the Phase 0 ledger with the reason.
- [ ] **Step 2** — Hard rule: never escalate silently. Every escalation writes one durable line.
- [ ] **Step 3** — Keep the existing `console.warn` and add the same content to the ledger.

**Phase 1 gate:** Tests A–D green; full `npx vitest run` green (expect 555+ tests); `tsc --noEmit`; `npm run build`. Then a **fault-injection soak**: run 30+ minutes locally and forcibly kill the orderbook socket at least twice (e.g. drive a sticky failure through the stream's test seam); the trace must show `socketState` returning to `open` and `lastSequencedDeltaAt` advancing within one backoff cycle each time.

---

## Phase 2 — Separate "tracked" from "sequenced" (report item 2)

**Problem being fixed:** the system currently has one word — *tracked* — for four different states, and `admitted-no-book` collapses all failures after admission into one bucket. That is why an 8-hour dead socket read as a 4,843-count provenance-shaped symptom.

### Task 2.1 — Per-ticker book lifecycle state

**Modify:** `packages/connectors/src/kalshiOrderbookStream.ts` (new read-only accessor), consumed in `main.ts`.

- [ ] **Step 1** — `bookState(ticker)` returning one of: `untracked` · `tracked-no-provenance` · `subscribed-awaiting-snapshot` · `snapshot-quarantined` (snapshot received, no qualifying delta yet — see `applySnapshot` :839-841, which deliberately quarantines until a sequenced delta proves advance) · `sequenced` — plus `sequencedAgeMs` and `snapshotAgeMs`.
- [ ] **Step 2** — Unit tests for each transition, including the `deltaTrackingRevision !== trackingRevision` case (a delta that arrives against a superseded membership revision does **not** un-quarantine — `applyDelta` :899-906).

### Task 2.2 — Refine the priority-track trace outcomes

**Modify:** `apps/desktop/electron/main.ts:473-484`.

- [ ] **Step 1** — Replace the single `admitted-no-book` outcome with the Task 2.1 state at the moment the wait expires: `admitted-socket-dead`, `admitted-awaiting-snapshot`, `admitted-quarantined`, `admitted-no-delta`. Keep `sequenced-book`, `provenance-unavailable`, `refused` unchanged so historical traces stay comparable.
- [ ] **Step 2** — Add `socketState` and `lastSequencedDeltaAgeMs` to every trace line. Had these existed, this run's diagnosis would have taken minutes.

### Task 2.3 — Measure `markTrackingChanged` blast radius (measure, then decide)

`markTrackingChanged()` (`:884-891`) deletes **every** tracked book and quarantines **every** ticker on **any** membership change. `fetchOrderbookWithPriorityTracking` calls `replaceTracked` per untracked candidate, on top of the 5-minute rotation and the allowlist force-fill path.

- [ ] **Step 1** — From the Phase 0 ledger, compute membership-change rate (`trackingRevision` deltas per minute) and the distribution of time-to-`sequenced` after each change. **Do not change this code before that measurement exists.**
- [ ] **Step 2** — Only if churn is shown to be starving re-qualification: scope invalidation to tickers whose subscription membership actually changed, keeping the fail-closed property (a ticker whose subscription was disturbed must still re-prove sequence continuity before its book is trusted). Add a test that a *retained* ticker keeps its sequenced book across an unrelated add/remove, and that a *disturbed* ticker does not.
- [ ] **Step 3** — Companion measurement: how often provenance lapses (90s TTL) against the 20s paced reverify and 5-minute universe refresh, for tickers that are tracked but not candidates. A lapse silently drops a ticker from `selectVerified` inside `replaceTracked`.

**Phase 2 gate:** a 30-minute run's trace can answer, per candidate, *which* stage it died at, without reading source.

---

## Phase 3 — Fail-closed candidate book health (report item 3)

**Principle:** if the data plane cannot prove itself, the run must declare itself degraded rather than emit thousands of rejections that look economic.

### Task 3.1 — Candidate-scoped health metric

**Modify:** `apps/desktop/electron/main.ts`, `packages/execution/src/entryConfirmation.ts` (accessor use only — the gate itself is untouched).

- [ ] **Step 1** — Define `candidateSequencedBookHealth`: over the tickers with confirmation in flight (`EntryConfirmationEngine.inFlightTickers()` already exists) plus campaign-critical tickers, report `count`, `maxSequencedAgeMs`, `fractionSequencedWithin(N)`. Propose `N = 30s`.
- [ ] **Step 2** — Expose on the bridge status, session stats, and the renderer.

### Task 3.2 — Degraded-run latch

- [ ] **Step 1** — When `fractionSequencedWithin(30s) == 0` across all in-flight candidates for more than a grace window (propose 3 consecutive minutes), latch `dataPlaneDegraded = true`: keep the pipeline running, keep logging, but **tag every confirmation rejection emitted while latched** with `dataPlaneDegraded: true`.
- [ ] **Step 2** — The report/verdict generator must exclude `dataPlaneDegraded` rejections from any economic conclusion and must state the degraded minutes prominently. This is the guardrail that makes "no edge" and "no data" impossible to confuse — the exact confusion this run produced.
- [ ] **Step 3** — Unlatch only on a sustained recovery (propose: 2 consecutive minutes with at least one candidate sequenced inside 30s).
- [ ] **Step 4** — Tests: latch on, latch off, tagging applied, verdict generator excludes tagged rows.

**Phase 3 gate:** replaying this run's conditions (dead socket at T+13m) against the new latch produces a run marked degraded from ~T+16m onward, with 0 rejections counted as economic evidence.

---

## Phase 4 — Controlled relaunch protocol

Only after Phases 0–3 are committed, green, and built.

### Task 4.1 — Preflight

- [ ] Confirm zero `KRYPT*nemesis*` electron processes (`Get-CimInstance Win32_Process`), per the launch script's own refusal check.
- [ ] Confirm `settings.json`: `dryRun=true`, `liveEnabled=false`, `autoLiveEnabled=false`, `demoMode=false`, `killSwitchActive=false`, profit bars unchanged.
- [ ] Confirm `dist-electron/main.js` contains the new supervisor symbol (string-search the built bundle — the Jul 24 plan learned this lesson: never debug a theory against a stale build).
- [ ] Add `NEMESIS_ORDERBOOK_TRACE_PATH` to `scripts/launch-paper-allowlist.ps1` alongside the existing priority-track trace, and point the log dir at `overnight-logs/<run-date>/`.
- [ ] Write a fresh `.nemesis-relaunch-cutoff.txt`; all analysis filters on it.

### Task 4.2 — Staged verification (abort criteria are hard)

| Checkpoint | Must be true | If not |
|---|---|---|
| **T+5 min** | `socketState=open`, `lastSequencedDeltaAgeMs < 30s`, `qualifiedTickers > 0` | stop the run; the fix did not take |
| **T+15 min** | ≥1 `sequenced-book` trace outcome; `orderbookObservationFreshnessMs` staying under 90s | stop; re-diagnose from the new ledger, do not "let it run and see" |
| **T+60 min** | `sequenced-book` share of priority-track outcomes clearly dominant over `admitted-*`; zero unexplained supervisor escalations | stop and diagnose |
| **T+4 h** | data-plane never latched degraded for more than a single recovery cycle; ledger hash chains clean | stop and diagnose |
| **Rolling** | live flags still locked; single writer; abort-count growth explainable | stop immediately on any breach |

- [ ] **Step 1** — Keep the KXBTCD-only allowlist and `orderbookTrackingLimit=25` for the first repair run. One variable at a time: this run tests the data plane, not a new universe.
- [ ] **Step 2** — Use a *deterministic* stop (see Task 6.1) rather than a best-effort heartbeat.

**Phase 4 gate — the run only counts as a data-plane repair proof if:** ≥ 2 continuous hours with `fractionSequencedWithin(30s) > 0.9` for in-flight candidates, and total degraded minutes < 5% of the run.

---

## Phase 5 — Only then, re-judge shadow

- [ ] **Step 1** — With the data plane proven, re-run long enough to satisfy the shadow gate as configured: `shadowMinScored=50` scored observations over `≥ 24h` observation window, plus the unchanged quality bars (`winRate ≥ 0.55`, `profitFactor ≥ 1.25`, `stressedNetPnl > 0`, `stressedPF ≥ 1.1`, hardcoded `largestWinShare ≤ 0.2`).
- [ ] **Step 2** — Judge the strategy **only** on shadows scored entirely inside a non-degraded window. This run's 2 scored shadows (+$9.32, largest-win share 100%, 0.028h window) are not evidence of anything and must not be carried forward.
- [ ] **Step 3** — Remember the standing prior from 2026-07-25: the crude `crypto-lead` probability proxy measured **no edge** over 36 shadows (11% win rate, −$52.48, correlation −0.10). A clean data plane does not repeal that. If the corrected normal-CDF model (`packages/core/src/stats/normalCdf.ts` exists as of `884c90c`) is what is now being tested, say so explicitly in the verdict — otherwise a green data-plane run will be misread as a green *strategy* run.
- [ ] **Step 4** — Do not bypass the shadow gate, do not lower `shadowMinScored` below 50 for a verdict run, and do not advance to pilot on a partial window.

---

## Phase 6 — Operational debt from this run

### Task 6.1 — The 101-minute late stop

- [ ] Requested `03:00:00 PDT`, actual `04:41:25 PDT`. Replace the heartbeat-dependent stop with a scheduled, self-verifying stop: a timer that (a) fires independently of the agent loop, (b) verifies zero matching electron processes afterward, and (c) writes a stop receipt with requested vs actual. A stop that can drift 100 minutes cannot bound an unattended run.

### Task 6.2 — Aborts and degraded minutes

- [ ] Classify the 778 session aborts. The audit ring for this run shows the top classes: `entry_confirmation_rejected / exchange-origin` ×4,136, `capital_allocator_block / insufficient protected profit` ×377, `strict_profit_block` ×147, `capital_allocator_block / excessive slippage` ×55+32, `book_unavailable` ×37+19, `fill_aborted / slippage exceeded` ×25. Under Phase 3, everything downstream of a degraded data plane should be tagged rather than counted.
- [ ] Attribute the 152 "API degraded minutes" to a specific connector; today that number cannot be traced to a cause.

### Task 6.3 — The shutdown safety block

- [ ] `2026-07-27T11:40:07.291Z`, `safety_block`, code `shutdown_event`, detail `session shutdown counters triggered` (`main.ts:4027`). It did not mutate portfolio state. Confirm it is purely a shutdown-path artifact — cross-check against `042ae70` ("Keep paper eligibility alive when session shutdown counters trip") — and if so, downgrade its severity so it stops reading as a runtime risk marker on every clean stop.

---

## Success criteria

1. A started orderbook stream has **no** reachable state from which recovery is impossible — proven by fault-injection tests, not by a clean run.
2. Sequenced exchange books are delivered continuously to in-flight candidates for ≥ 2 hours (`fractionSequencedWithin(30s) > 0.9`).
3. `sequenced-book` is the dominant priority-track outcome; `admitted-*` outcomes are a small, explained minority.
4. A dead or degraded data plane self-declares within 3 minutes and cannot be reported as economic rejection.
5. Every claim above is answerable from durable ledgers alone, with no console access and no source reading.
6. Exchange-origin rule, profit bars, shadow quality bars, and live locks all unchanged. Portfolio integrity intact; hash chains clean.

## Explicit non-goals

- Producing a trade, a green P&L, or a passing shadow gate in this work.
- Widening `PRIORITY_ORDERBOOK_WAIT_MS`, `maxBookAgeMs`, or any tolerance. If a candidate cannot get a sequenced book, the answer is to deliver one, not to wait longer or accept less.
- Expanding the allowlist, changing position sizing, or touching stop geometry. Those are separate, measured decisions and would contaminate this one.
- Re-opening the renderer-heartbeat or memory-slope guards. Those bugs are dead; every later blocker has been a different mechanism.

## Run order (cheat sheet)

```text
1.  Phase 0  — observability only .......... build + 10-min sanity launch
2.  Phase 1  — supervisor + tests .......... fault-injection soak (kill the socket twice)
3.  Phase 2  — state separation ............ 30-min trace legibility check
4.  Phase 3  — degraded latch .............. replay-style verification
5.  Phase 4  — controlled KXBTCD relaunch .. T+5 / T+15 / T+60 / T+4h gates
6.  Phase 5  — shadow re-judgement ......... only on a non-degraded ≥24h window
7.  Phase 6  — ops debt .................... stop timer, abort classification, shutdown block
```

Push each phase once typecheck + tests + build are green; do not park green commits waiting on the next phase.
