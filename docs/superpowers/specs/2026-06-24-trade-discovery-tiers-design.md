# NEMESIS Trade Discovery & Executable Tier Design

**Date:** 2026-06-24  
**Status:** Approved in brainstorming (Sections 1–4)  
**Goal:** Surface many more Kalshi opportunities that are actually fillable and profit-aligned — not by lowering edge gates globally, but by scanning a larger universe, verifying depth at trade size, and improving implied prices.

---

## Problem

Today NEMESIS processes at most ~30 markets per 15s refresh, uses top-of-book depth only, and applies strict qualification gates (default 2% net edge, $50 min depth, predictability ≥ 50). Tradable card count stays low even when Kalshi has broader liquidity.

## Success criteria (tiered)

Each surfaced card receives **one badge — its highest cleared tier** (Whale > Solid > Scout).

| Tier   | Card cap   | Min fillable | Max slippage |
|--------|------------|--------------|--------------|
| Scout  | ≥ 20       | $100         | 2¢           |
| Solid  | ≤ 20       | $250         | 3¢           |
| Whale  | ≤ 10       | $500         | 5¢           |

Tier filters in Edge Theater show subsets (e.g. Solid = all cards with tier ≥ solid), sorted by tier desc, then net edge, then fillable USD.

## Strategic approach (combined)

Three brainstormed approaches are used together, not as mutually exclusive options:

1. **Depth-first pipeline (backbone)** — Paginate universe → orderbook → `walkBookFill` → tier assignment.
2. **Universe-first cheap filter (performance)** — Rank 500+ tickers on volume/spread/mid-edge before orderbook fetch; depth-verify top ~150 only.
3. **Signal-first quality (lift)** — Pods + feeds + calibrated implied prices on depth-qualified markets only; promotes cards within tier constraints.

### Rollout milestones

| Milestone | Delivers | Acceptance |
|-----------|----------|------------|
| M1 | UniverseCache, DepthVerifier, Scout tier, Cockpit read-only | ≥ 20 Scout cards @ $100 / 2¢ |
| M2 | Solid/Whale tiers, presets, full Cockpit controls | ≤ 20 Solid @ $250 / 3¢ |
| M3 | Per-market feed improvements, hot-ticker re-depth, audit snapshots | ≤ 10 Whale @ $500 / 5¢ |

---

## Architecture

### Layer diagram

```
Edge Theater (renderer)        — browse, filter, act
Discovery Cockpit (renderer)   — configure, monitor, tune
DiscoveryOrchestrator (main)   — schedules, budgets, IPC
├── UniverseCache              — paginated markets, volume rank
├── DepthVerifier              — staggered orderbooks, walkBookFill, tiers
└── SignalPipeline             — pods + edge-scanner on qualified tickers
         └── @nemesis/core     — tier math, ThesisCard extensions
```

### Refresh cycles (decoupled)

| Loop        | Interval | Action |
|-------------|----------|--------|
| Universe    | 60s      | Paginate Kalshi REST (cursor, limit 100), rank by 24h volume, maintain ~500-ticker rolling cache |
| Depth       | 15s      | Process priority queue; assign Scout/Solid/Whale per side |
| Signals     | 15s      | Run pods + edge-scanner on tier-qualified tickers; dedupe |
| Hot tickers | 5s       | Re-depth open Paper positions + watched ticker |

### Pipeline steps (single depth pass)

1. **Universe fetch** — `fetchMarkets` with cursor pagination; sort by volume; cap tracked set (default 500).
2. **Cheap filter** — Mid/spread/volume screen on full tracked set; select top N (default 150) for orderbook fetch.
3. **Microstructure + depth** — Orderbook fetch (12s TTL cache, staggered ~10/s). For each YES/NO side, convert $100 / $250 / $500 to contract count (fee-aware), run `walkBookFill`, check slippage against tier cap.
4. **Tier assignment** — Highest tier where fill ≥ target USD and slippage ≤ cap. Below Scout: do not surface in Edge Theater.
5. **Signal pass** — Category pods + `scanMarketTheses` only on Scout+ tickers. Implied prices feed `qualifyThesis` with tier-scaled `minNetEdge`:
   - Scout: 0.008–0.012
   - Solid: 0.015
   - Whale: 0.02 + higher predictability bar
6. **Finalization** — Existing `finalizeThesis` (quarantine, reviewOnly, demo promotion). `KalshiStream.track` for thesis tickers (batch max 50).

### Boundaries

- **Tier math** lives in `@nemesis/core` (`executableTier.ts`); re-export via `@nemesis/execution/pnlEngine` path only if renderer-safe (types only in UI).
- **Orchestration** in `electron/main.ts` via `DiscoveryOrchestrator`; no new Node imports in renderer.
- **Pods** accept optional `depthContext`; skip sides that failed Scout depth when depth-verify ON.

---

## Data model extensions

### ThesisCard (new fields)

```ts
executableTier?: 'scout' | 'solid' | 'whale';
fillableUsd?: number;
slippagePp?: number;
depthLevels?: number;
```

One badge per card — highest tier cleared. Stored on card after depth pass; updated on hot-ticker re-depth.

### Discovery settings (`nemesis-data/discovery-settings.json`)

```ts
interface DiscoverySettings {
  preset: 'conservative' | 'balanced' | 'aggressive';
  universePageSize: number;      // default 100
  maxTrackedTickers: number;     // default 500
  depthChecksPerCycle: number;   // default 150
  depthVerifyEnabled: boolean;   // default true
  signalPassEnabled: boolean;    // default true
  autoPauseOnApiDegrade: boolean;// default true
  scoutTarget: number;           // default 20
  solidTarget: number;           // default 20
  whaleTarget: number;           // default 10
}
```

Presets bundle underlying values:

| Preset       | Tracked | Depth/cycle | Slippage adjustment | Scout edge |
|--------------|---------|-------------|---------------------|------------|
| Conservative | 200     | 80          | −1¢ each tier       | Stricter   |
| Balanced     | 500     | 150         | As success table    | Default    |
| Aggressive   | 500     | 200         | +1¢ each tier       | 0.008      |

---

## Discovery Cockpit (Settings sub-tab)

### Dashboard (read-only)

- Universe: `487 tracked · page 5/5 · refreshed 42s ago`
- Depth queue: `12 pending · 138 verified · avg 180ms/book`
- Tier yield: `28 scout · 14 solid · 6 whale · 52 below scout`
- API budget: `kalshi-rest 42/60 req/min · orderbooks 89/150`
- Feed freshness per connector

### Controls

- Discovery mode preset + Advanced overrides
- Pause / Resume discovery
- Force universe refresh / force depth pass
- Toggles: depth-verify gate, signal pass, auto-pause on API degrade

### IPC

| Channel | Role |
|---------|------|
| `nemesis:getDiscoveryState` | Dashboard metrics + settings |
| `nemesis:updateDiscoverySettings` | Partial settings update |
| `nemesis:pauseDiscovery` / `nemesis:resumeDiscovery` | Orchestrator control |
| `nemesis:forceUniverseRefresh` / `nemesis:forceDepthPass` | Manual triggers |
| Event `discovery:update` | Push tier counts, queue depth, API usage |

Preload + `App.tsx` Window types must stay in sync (existing IPC parity rule).

---

## Edge Theater UI

### Header

`28 scout · 14 solid · 6 whale · 48 total` + link **Manage discovery →** (Cockpit)

### Filters

- Tier: All | Scout | Solid | Whale
- Sort: tier ↓, net edge ↓, fillable USD ↓
- Existing playbook / category chips unchanged

### ThesisCard

- Tier badge: SCOUT / SOLID / WHALE
- Subline: `~$187 fillable · 1.4¢ slip · 3 book levels`
- “Why profitable” dropdown: tier gate passed, walkBookFill summary, pod signal vs market

### Empty states

| Condition | Message |
|-----------|---------|
| 0 scout | Scanning message + queue depth + link to Cockpit |
| Scout OK, 0 solid | Hint to adjust preset or Solid slippage |
| API degraded | Last verified cards with age timestamp |

---

## Error handling & degraded modes

| Failure | Response |
|---------|----------|
| Kalshi REST down | Serve universe cache ≤ 5 min stale; pause depth queue |
| Orderbook timeout | Skip ticker; retry next depth pass |
| Empty / partial book | No tier; card not surfaced |
| API budget exhausted | Finish in-flight; priority Whale → Solid → Scout |
| FeedHub cold | Signal pass with stale penalty; `qualified` cap possible |
| Source disagreement | Depth-only Scout possible; status capped at `qualified` |
| reviewOnly regime | Cards demoted to `observe` (demo promotion unchanged) |
| User pause | Freeze cards; no new depth/signal |
| Restart | Load discovery-settings + universe cache if < 5 min old |

**Rule:** Never show a tier badge without successful `walkBookFill` for that tier’s USD target when depth-verify is ON.

### Degraded mode ladder

| Mode | Condition | Behavior |
|------|-----------|----------|
| Full | Healthy | Universe + depth + signals |
| Depth-only | Signal pass OFF or feeds stale | Microstructure + edge-scanner only |
| Legacy | Depth-verify OFF | ~30 markets, top-of-book (warn in Cockpit) |
| Frozen | Pause or kill switch | Read-only last verified cards |

Auto-downgrade Full → Depth-only after ≥2 feed warnings for 3 cycles. Never auto-switch to Aggressive preset.

---

## Testing

### Unit — `@nemesis/core`

- `executableTier.ts`: USD → contracts, tier boundaries, slippage caps
- `walkBookFill` + tier assignment on multi-level books

### Unit — `pods`

- Edge-scanner respects `depthContext`; skips sub-Scout sides
- Existing pod tests unchanged

### Integration — main

- Mock Kalshi: pagination → depth cap → tier counts
- Budget exhaustion priority order
- Pause/resume gates depth calls

### E2E — Playwright

- Cockpit visible; preset affects tier header
- Tier chips filter cards; Scout empty state messaging
- Refresh header pattern `\d+ scout · …`

### Manual smoke

- Demo Refresh: ≥ 20 Scout within 2 cycles
- Conservative preset lowers count, raises avg fillable $
- Pause freezes cards with banner

---

## Out of scope (v1)

- Per-tier live trading rules (same guardrails for all tiers)
- User-defined fourth tier
- ML calibration UI (signal work ships as pod/feed code; Cockpit toggles signal pass only)

---

## References

- Existing spec: `2026-06-23-nemesis-design.md`
- Implementation plan: `2026-06-24-nemesis-implementation.md`
- Key code today: `electron/main.ts` (`refreshMarkets`, `buildThesesFromMarkets`), `packages/pods/src/edge-scanner.ts`, `packages/core/src/thesis/qualification.ts`, `packages/core/src/fees/kalshiFee.ts` (`walkBookFill`)
