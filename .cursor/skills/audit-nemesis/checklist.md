# NEMESIS Audit Checklist (Reference)

Detailed grep targets and file map. Load only during Phase 2–5.

## Repo map

```
nemesis/
  apps/desktop/
    electron/main.ts      # IPC, market refresh, paper engine, persistence
    electron/preload.ts   # window.nemesis bridge
    src/App.tsx           # Shell UI + Window types
    vite.config.ts        # Aliases, electron plugin
  packages/
    core/       fees, guardrails, Kalshi client, thesis types
    ui/         React panels (renderer-safe only)
    charts/     graph helpers (renderer-safe)
    execution/  paper, live, signer (main-only barrel exports)
    connectors/ Kalshi WS, feed hub, registry
    pods/       edge scanner, category pods
    journal/    session journal
    capital/    quarantine, allocator
```

## Grep commands (run from `nemesis/`)

### Renderer boundary violations

```bash
rg "from '@nemesis/(execution|connectors|pods|journal|capital)'" packages/ui apps/desktop/src
rg "from '@nemesis/execution'" packages/ui apps/desktop/src
rg "node:(crypto|fs|path|http)" packages/ui apps/desktop/src
rg "require\\(" packages/ui apps/desktop/src
```

Expected: **zero** matches in UI for execution barrel, connectors, pods. Allowed exception: `@nemesis/execution/<submodule>` if submodule has no Node deps (e.g. `pnlEngine`).

### Node-only modules must stay in main

```bash
rg "createSign|signKalshi|authHeaders" packages/ui apps/desktop/src
rg "KalshiStream|FeedHub" packages/ui apps/desktop/src
```

Expected: zero in renderer.

### IPC channel inventory

```bash
rg "ipcMain\\.handle\\('nemesis:" apps/desktop/electron/main.ts
rg "ipcRenderer\\.invoke\\('nemesis:" apps/desktop/electron/preload.ts
rg "window\\.nemesis\\." apps/desktop/src
```

Diff the channel lists manually.

### Sticky / stale state patterns

```bash
rg "reviewOnly" apps/desktop packages/pods packages/core
rg "let reviewOnly|reviewOnly =" apps/desktop/electron/main.ts
```

Confirm reset on each `refreshMarkets` / regime compute.

### Secrets

```bash
rg -i "api[_-]?key|private[_-]?key|secret|password" nemesis --glob '!**/node_modules/**' --glob '!**/*.test.ts'
```

Flag hardcoded secrets; `.env` must not be committed.

## IPC channels (baseline — re-verify when auditing)

Main handlers (`nemesis:*`):

- getState, getMarkets, updateSettings
- journalAdd, journalExport
- dryRun, passQuiz, passBacktest
- quarantinePlaybook, killSwitch, unlockLive
- exportSession, reconcileLive, refresh
- paperBuy, paperClose, paperPreview, paperPlaceLimit, paperCancelOrder
- getPaperPortfolio, resetPaper
- getTickHistory, watchTicker

Preload events:

- settings:update, markets:update, paper:update, ticks:update

## Persistence files (`app.getPath('userData')/nemesis-data/`)

| File | Purpose |
|------|---------|
| settings.json | Guardrails, demo/live flags |
| journal.json | Trade journal |
| paper-portfolio.json | Positions, cash, trades |
| equity-history.json | Profit station chart |
| session-stats.json | Daily P&L, eval stats |
| paper-orders.json | Working limit orders |
| audit-log.json | Session audit trail |

Verify load on startup and save after mutations in `main.ts`.

## Test coverage gaps

Packages **with** tests: core (fees), execution, connectors, pods, journal.

Packages **without** dedicated tests: ui, charts, capital, desktop (E2E).

When auditing, note missing coverage for changed areas — suggest tests for:

- `pnlEngine` fee math
- `edge-scanner` qualification logic
- IPC handler error paths
- `kalshiStream` reconnect (mock ws)

## Electron dev smoke script

```bash
cd nemesis && npm run dev
```

Wait for `Local: http://localhost:5173/` and `dist-electron/main.js built`.

Watch 60s for crashes. Electron window should show UI, not solid `#0a0b0f` with no text.
