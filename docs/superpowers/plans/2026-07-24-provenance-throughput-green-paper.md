# Provenance + Throughput → First Green Paper Trade

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **PLAN ONLY until morning.** Do **not** implement while the overnight soak is running. Do **not** kill Electron/GEA/collector before the T‑30 freeze window unless the process is already dead.

**Goal:** By Friday 2026-07-24 morning (US cash hours), complete provenance + throughput fixes proven by the overnight after-cutoff report, then obtain the first certified dry-run paper trade with green realized P&L — without relaxing exchange-origin checks or profit bars.

**Architecture:** Keep the fail-closed confirmation path. Exchange-sequenced WS books are mandatory (`sourceTimestamp` + integer `sequence`). REST snapshots never satisfy that gate. Throughput comes from allowlisted liquid series during US open (`KXINXHUD`, `KXNASDAQ100HUD`) plus crypto (`KXBTCD`), with priority-track hydration ensuring candidates are admitted into the ≤25 WS set *before* confirmation. Sampler identity fix (2026-07-23) stays in place so re-issued cards accumulate samples.

**Tech Stack:** Electron main (`apps/desktop/electron/main.ts`), `KalshiOrderbookStream`, `EntryConfirmationEngine`, AppData paper ledgers, Vitest.

## Global Constraints

- Never relax exchange-origin book timestamp+sequence checks (`entryConfirmation.ts` / `campaignEnrollment.ts`).
- Never lower `minExpectedNetPnlUsd` / `minRewardRiskRatio` to manufacture a trade.
- Live stays hard-locked (`liveEnabled=false`, `dryRun=true`).
- Do not edit `settings.json` via agent tools (classifier boundary) — give the operator exact keys if needed.
- Every analysis filter uses `e.at > cutoffMs` from `.nemesis-relaunch-cutoff.txt` (overnight) **or** the new morning-relaunch cutoff after rebuild.
- Do not declare thesis dead from a contaminated / pre-cutoff / dead-process window.
- Overnight soak + collector stay up until **T‑30** (06:00 PDT / 09:00 ET), then freeze report → implement → relaunch for open.

---

## Context locked for morning (do not re-derive)

### Overnight measurement (in flight)

| Field | Value |
|--------|--------|
| Cutoff | `1784843034218` (`2026-07-23T21:43:54Z` ~14:43 PDT) |
| Allowlist | `NEMESIS_SERIES_ALLOWLIST=KXINXHUD,KXNASDAQ100HUD,KXBTCD` |
| Desktop / GEA (at arm) | `27168` / `32532` |
| Collector | `nemesis/overnight-logs/2026-07-23/` every 5m |
| Safety | `demoMode=false`, `dryRun=true`, `liveEnabled=false` |

### Already shipped (do not redo unless report proves regression)

| Fix | Intent | Evidence historically |
|-----|--------|------------------------|
| `ensureProductionProvenance` before `replaceTracked` | Stop silent refuse + destructive eviction | admitted 0/3 → 17/17; exchange-origin 87.5% → 17.6% |
| Fee type `quadratic_with_maker_fees` | Clear false fee-unknown wall | fee rejects → 0 |
| In-flight book pinning | Rotation must not delete mid-sample books | samples can persist |
| Proven quiet-book age | Stale-book conflation | quiet books can sample |
| Bars at admission + confirm only | Intermediate samples don’t re-kill economics | accumulator rises |
| Sampler economic identity (2026-07-23) | Re-issued `card.id` continues chain | plan `2026-07-23-confirmation-sampler-identity.md` |

### What overnight already shows (pre–T‑30)

- Bridge healthy; equity flat $5000; `tradeCount=0`; `abortCount≈96`.
- **`exchangeDeltaFreshnessMs` null** on sampled telemetry — WS exchange-time may be idle or not updating; treat as a **watch metric**, not automatic proof the priority-track path is gone.
- **Post-cutoff qualification / strategy-validation events = 0** for hours after relaunch — US cash products were closed; this is **throughput silence**, not proven provenance regression on allowlisted tickers.
- Pre-cutoff corpus (~1691 confirms) was ~75% provenance / ~19% min-reward — largely **unfocused / sports / REST fallback**; do **not** treat as post-allowlist truth.

### Market clock

| Event | Local (PDT) | ET |
|-------|-------------|-----|
| T‑30 freeze + after-cutoff report | **Fri 06:00** | 09:00 |
| US cash open (HUD / Nasdaq series) | Fri 06:30 | 09:30 |
| Implement window | 06:00 → ~06:25 | before open if possible |
| First green-paper hunt | from open onward | after fixes + relaunch |

---

## File map (morning implementers)

| File | Role |
|------|------|
| `apps/desktop/electron/main.ts` | `fetchOrderbookWithPriorityTracking`, `ensureProductionProvenance`, `desiredOrderbookTickers`, allowlist choke, funnel |
| `packages/connectors/src/kalshiOrderbookStream.ts` | WS books, `hasProductionProvenance`, `lastExchangeTimestamp`, `selectVerified` |
| `packages/connectors/src/productionMarketProvenance.ts` | 90s TTL production proofs |
| `packages/execution/src/entryConfirmation.ts` | exchange-origin gate (DO NOT WEAKEN) |
| `packages/execution/src/campaignEnrollment.ts` | same provenance gate at enrollment |
| `packages/core/src/kalshi/client.ts` | REST `parseOrderbook` — no sequence (expected) |
| `nemesis/overnight-logs/2026-07-23/*` | soak evidence |
| `docs/HANDOFF-NEXT-SESSION.md` | prior go/no-go checklist |
| `%APPDATA%\@nemesis\desktop\nemesis-data\` | ground truth ledgers |

---

## Phase 0 — T‑30 freeze + after-cutoff report (NO code)

**When:** 2026-07-24 06:00 PDT. Leave Nemesis running; collector may keep sampling.

### Task 0: Write `AFTER-CUTOFF-REPORT.md`

**Files:**
- Create: `nemesis/overnight-logs/2026-07-23/AFTER-CUTOFF-REPORT.md`
- Read: `overnight-snapshots.jsonl`, `overnight-events.md`, AppData ledgers, `.nemesis-relaunch-cutoff.txt`

- [ ] **Step 1: Validity**
  - Desktop/GEA alive? If dead → mark run **Invalid**; note crash time; **do not** declare thesis dead.
  - Settings still dry-run / live off / demo off.

- [ ] **Step 2: Post-cutoff confirmation mine** (`at > 1784843034218`)

```powershell
$cutoff = 1784843034218
$val = "$env:APPDATA\@nemesis\desktop\nemesis-data\paper-strategy-validation-events.jsonl"
node -e "const fs=require('fs');const c=$cutoff;const conf=fs.readFileSync(process.argv[1],'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(e=>e&&e.at>c&&e.type==='entry_confirmation_observed');const by={};let max=0;for(const e of conf){const k=(e.status||'')+'|'+(e.reason||'').slice(0,80);by[k]=(by[k]||0)+1;max=Math.max(max,e.samples||0)}console.log(JSON.stringify({n:conf.length,ready:conf.filter(e=>e.status==='ready').length,maxSamples:max,tickers:[...new Set(conf.map(e=>e.ticker))],top:Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,15)},null,2))" $val
```

- [ ] **Step 3: Snapshot trends**
  - Did `exchangeDeltaFreshnessMs` ever leave null?
  - Any `tradeCount > 0`, `entry_eligible`, abort spikes, bridge drops?

- [ ] **Step 4: Decision inputs for Phase 1** (fill table in report)

| Signal | Implication |
|--------|-------------|
| `n_confirm == 0` all night | Throughput starved overnight (expected for HUD); provenance unmeasured on allowlist — morning open required; enable priority-track trace on relaunch |
| Provenance ≥50% of post-cutoff rejects on allowlisted tickers | Provenance residual is real → Task 1–2 |
| Economics dominate + samples ≥2 | Provenance OK → skip to throughput / persistence |
| `ready ≥ 1` or paper trade | Skip plumbing; go to scale / verify P&L |
| Off-allowlist sports only | Invalid contamination → fix allowlist choke before thesis judgment |

**Gate:** Report written before any source edit.

---

## Phase 1 — Provenance residual (ONLY if report demands it)

**Principle:** Fix delivery of sequenced WS books to confirmation — never loosen the check.

### Task 1: Prove which provenance failure mode is live

**Files:**
- Modify (ops only at relaunch): env `NEMESIS_PRIORITY_TRACK_TRACE_PATH`
- Read: `main.ts` `fetchOrderbookWithPriorityTracking` (~394–481), `kalshiOrderbookStream.ts`

- [ ] **Step 1: On morning rebuild relaunch**, set:

```powershell
$env:NEMESIS_PRIORITY_TRACK_TRACE_PATH = "D:\CODING\PROJECTS - CURRENTLY WORKING ON\KRYPT\nemesis\overnight-logs\2026-07-24\priority-track-trace.jsonl"
$env:NEMESIS_SERIES_ALLOWLIST = "KXINXHUD,KXNASDAQ100HUD,KXBTCD"
$env:NEMESIS_AUTO_SPAWN_GEA = "true"
$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = "25"
```

- [ ] **Step 2: After 10–15 min post-open**, tally trace `outcome`:
  - `provenance-unavailable` → hydration / store sync still broken
  - `refused` → `selectVerified` still dropping
  - `admitted-no-book` → admitted but no sequenced delta inside wait window
  - `sequenced-book` → path healthy; look elsewhere

- [ ] **Step 3: Confirm built code still contains `ensureProductionProvenance`** in `dist-electron/main.js` (string search). If missing → rebuild before any other theory.

### Task 2A: If `provenance-unavailable` / `refused` dominates

**Files:**
- Modify: `apps/desktop/electron/main.ts` (`ensureProductionProvenance`, `recordProductionUniverse`)
- Modify: `packages/connectors/src/kalshiOrderbookStream.ts` (only if store API gap)
- Test: existing connector + main-adjacent unit tests; add focused test if hydration contract regresses

**Likely fix shape (choose after trace, do not shotgun):**
1. Ensure `recordProductionUniverse` always calls `kalshiOrderbookStream.recordProductionMarkets(...)` for the hydrated ticker before `replaceTracked`.
2. If single-market `fetchMarket` fails under allowlist/rate-limit, pace retries (`pacedDispatch` / backoff) — do not skip provenance.
3. Never evict a tracked slot unless `hasProductionProvenance(ticker)` is already true (already intended — verify no regression).

- [ ] **Step 1: Write/extend failing test** for “hydrate then admit” contract (mirror history of `00b2786`).
- [ ] **Step 2: Minimal code to restore admit rate**.
- [ ] **Step 3: `npx vitest run` + desktop `tsc --noEmit` + `npm run build`**.
- [ ] **Step 4: Relaunch with new cutoff file; filter all reads by new cutoff**.

### Task 2B: If `admitted-no-book` dominates

**Files:**
- Modify: `apps/desktop/electron/main.ts` — `PRIORITY_ORDERBOOK_WAIT_MS` (currently 3000) and/or subscribe ack path
- Read: `kalshiOrderbookStream.ts` subscription + first snapshot/delta applying `sequence`/`sourceTimestamp`

**Likely fix shape:**
1. Modest wait increase only if median wait saturates at ceiling (history: 6/17 admitted missed 3s). Prefer **≤5s**, measure; do not set unbounded waits.
2. Ensure first snapshot path stamps integer `sequence` + finite `sourceTimestamp` (not only later deltas).
3. Confirm `lastExchangeTimestamp` updates when deltas land — fixes `exchangeDeltaFreshnessMs` null if books are actually sequencing.

- [ ] **Step 1: Failing test** for snapshot→`hasExchangeProvenance` true.
- [ ] **Step 2: Minimal stream/main fix**.
- [ ] **Step 3: Vitest + build + relaunch + new cutoff**.

### Task 2C: Explicit non-goals

- Do **not** treat REST books as exchange-origin.
- Do **not** fake `sequence` from local clocks.
- Do **not** disable confirmation.

**Gate:** Post-fix, post-cutoff (new) share of `confirmation requires an exchange-origin...` on allowlisted tickers is **clearly secondary** to economics/persistence (target: well under ~20%, ideally near the historical 17.6% or better).

---

## Phase 2 — Throughput (US open instruments)

**Problem:** Even perfect provenance cannot print trades if `raw_candidates` / `entry_eligible` stay 0.

### Task 3: Allowlist + discovery + WS working-set alignment

**Files:**
- Read/Modify: `apps/desktop/electron/main.ts` — discovery allowlist choke (~4910), `desiredOrderbookTickers` (~4519)
- Read: `packages/connectors/src/discoveryOrchestrator.ts`
- Read: GEA `brain:no-trade` path in desktop main (~5272)

- [ ] **Step 1: At US open, verify funnel** within 5–10 minutes:
  - `funnel_increment` stages: `raw_candidates` > 0 on allowlisted prefixes
  - tickers in confirmation log match `KXINXHUD*` / `KXNASDAQ100HUD*` / `KXBTCD*` only
- [ ] **Step 2: If raw_candidates=0** while tape shows liquid allowlisted series:
  - Confirm env allowlist still set on the **relaunch** process
  - Confirm `demoMode=false` (demo stalls theses at uncertain forever)
  - Check GEA bridge: continuous `brain:no-trade` vs recommendations — desktop must still self-discover allowlisted flow, not depend solely on GEA
- [ ] **Step 3: If candidates exist but never enter WS set:**
  - Prefer allowlisted + entry-eligible tickers at the **head** of `desiredOrderbookTickers` (campaign-critical / in-flight already pinned — extend priority so allowlist heads aren’t drowned by dormant fill markets)
  - Keep `ORDERBOOK_TRACKING_LIMIT=25`

- [ ] **Step 4: Tests** for allowlist filter + desired-set ordering invariants.
- [ ] **Step 5: Build, relaunch, new cutoff, re-measure funnel in 10 min**.

### Task 4: Optional universe tweak (operator decision — not default)

Only if Phase 2 still shows zero liquid allowlisted candidates after a healthy open hour:
- Consider adding continuously liquid crypto 15m series (e.g. `KXBTC15M`) **via operator-set allowlist env**, knowing persistence vs fast markets is tense (see `.cursor/memory/nemesis-market-strategy-research.md`).
- Do **not** expand to sports for “activity” — dormant-book wall.

**Gate:** Sustained `raw_candidates > 0` and `entry_eligible ≥ 1` post-open on allowlisted series.

---

## Phase 3 — Persistence / sampler residuals (only after provenance + throughput)

### Task 5: Confirm sampler identity fix is active post-relaunch

**Files:**
- `packages/execution/src/entryConfirmation.ts`
- `docs/superpowers/plans/2026-07-23-confirmation-sampler-identity.md`

- [ ] **Step 1:** Post-cutoff histogram of `samples` — need evidence of 2/3/4, not stuck at 1.
- [ ] **Step 2:** If stuck at 1 with changing `card.id` / same economic identity → verify dist includes identity keying; fix regression.
- [ ] **Step 3:** If stuck because quiet book never gets new `sequence` → confirm quiet-book path still counts time-spaced samples under proven continuity (already shipped `3e4dbdf` lineage); repair if regressed.

**Gate:** At least one chain reaches `minSamples` (4) or `status=ready`, OR clear economic reject after full window (honest no-edge) — not structural stall.

---

## Phase 4 — First green paper trade (only after Phases 1–3 gates)

### Task 6: Certified paper fill + green P&L

**Files / data:**
- `%APPDATA%\@nemesis\desktop\nemesis-data\paper-portfolio.json`
- `session-stats.json`
- `paper-strategy-validation-events.jsonl`

- [ ] **Step 1:** Confirm a `status=ready` (or enrolled campaign path) on allowlisted ticker with sequenced book.
- [ ] **Step 2:** Allow dry-run paper buy → position or fill appears in `paper-portfolio.json`.
- [ ] **Step 3:** Manage/close per autoClose / desk rules until **realized P&L > 0** on at least one closed trade (or session `dailyPnl > 0` with closed green trade evidence).
- [ ] **Step 4:** Write `nemesis/overnight-logs/2026-07-24/GREEN-PAPER-PROOF.md` with cutoff, ticker, fill times, P&L, and rejection mix showing provenance not dominant.

**Success criteria:**
1. Provenance rejects not the primary post-cutoff failure mode.
2. Throughput producing allowlisted candidates at US hours.
3. ≥1 dry-run paper trade completed.
4. Realized P&L green on the proof trade/session slice cited.
5. Bars + exchange-origin intact; live still off.

---

## Morning run order (cheat sheet)

```text
06:00 PDT  Task 0 — AFTER-CUTOFF-REPORT.md (no impl)
06:05      Branch on report → Task 1 trace plan
06:05-06:25 Tasks 2A/2B and/or 3 as demanded — test → build
06:25      Stop ONLY nemesis Electron (ops skill), relaunch with env + NEW cutoff file
06:30      US open — watch funnel + priority-track trace
→          Task 5 if samples stall; Task 6 for green paper proof
```

Safe stop/relaunch (from `.cursor/skills/nemesis-ops/SKILL.md`):

```powershell
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like "*KRYPT*nemesis*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
# confirm 0 nemesis electron, then:
$env:NEMESIS_AUTO_SPAWN_GEA = 'true'
$env:NEMESIS_SERIES_ALLOWLIST = 'KXINXHUD,KXNASDAQ100HUD,KXBTCD'
$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = '25'
# optional: NEMESIS_PRIORITY_TRACK_TRACE_PATH=...
& "node_modules\electron\dist\electron.exe" "apps\desktop\dist-electron\main.js"
# write new .nemesis-relaunch-cutoff.txt with DateTimeOffset ms
```

---

## Self-review

| Spec ask | Task coverage |
|----------|----------------|
| Leave running + monitored until T‑30 | Phase 0 + overnight collector + T‑30 arm |
| Provenance-first fix plan | Phase 1 Tasks 1–2 |
| Throughput plan | Phase 2 Tasks 3–4 |
| After-cutoff report before impl | Task 0 hard gate |
| Fixes before first green paper | Phase 4 gated on 1–3 |
| No bar / exchange-origin weakening | Global constraints + Task 2C |
| Paper trading tomorrow morning | Phase 4 + market clock |

No placeholder tasks: each phase has concrete files, commands, and gates.
