# NEMESIS

Current as of June 26, 2026.

NEMESIS is a Kalshi-native desktop trading command center with a companion Global Event Alpha (GEA) intelligence app. It is built for event-market thesis discovery, fillability-aware ticket ranking, paper execution, profit-retention research, fail-closed bridge recommendations, and staged live-trading readiness.

The default posture is intentionally conservative: demo mode on, dry-run on, live trading locked, auto-live disabled, and ProfitOS auto-close limited to paper positions.

## Screenshots

### NEMESIS Edge Theater

Ranked thesis discovery with GEA bridge status, Scout/Solid/Whale tiers, tradeability filters, guardrails, and risk cockpit context.

![NEMESIS Edge Theater](docs/screenshots/nemesis-edge-theater.png)

### NEMESIS Paper Command Desk

Paper portfolio, open positions, working orders, realized/unrealized P&L, trade blotter, auto-close decisions, guardrails, and risk panels.

![NEMESIS Paper Command Desk](docs/screenshots/nemesis-paper-desk.png)

### Global Event Alpha Command Center

GEA connected to NEMESIS with mirrored state, market/tape intelligence, paper P&L, recommendation flow, retention logic, bridge health, and local persistence.

![Global Event Alpha Command Center](docs/screenshots/global-event-alpha-command-center.png)

## Current Capabilities

- Discovers and ranks Kalshi/event-market opportunities from a broader universe cache.
- Assigns executable tiers: Scout, Solid, and Whale, based on fillable depth and slippage context.
- Scores trade theses by net edge, probability gap, settlement clarity, liquidity, freshness, confidence, spread, slippage, source context, and bridge latency.
- Runs a NEMESIS desktop app and a companion Global Event Alpha desktop app.
- Publishes GEA recommendation, no-trade, exit, close-result, hello, ping, and state-mirror packets over a local WebSocket bridge.
- Validates bridge packets fail-closed, including role, freshness, confidence, settlement clarity, schema, and sequence checks.
- Executes paper buys, paper closes, paper cancels, and paper auto-close actions through a dry-run fill model.
- Tracks paper cash, equity, daily P&L, open positions, fills, working orders, marks, regimes, and auto-close history.
- Runs ProfitOS paper auto-close with dynamic exit scoring, GEA exit freshness, velocity trims, predictive threshold crossing, and profit-biased close thresholds.
- Keeps live trading behind an 8-gate guardrail model plus staged manual-live and auto-live unlock certificates.
- Persists GEA market snapshots, orderbook snapshots, public data, ticket cards, profit-retention state, and close feedback in SQLite when the native module is available.
- Builds a Windows installer through Electron Builder.

## Safety Model

NEMESIS is not live-first software. The current defaults in code are:

| Setting | Default |
| --- | --- |
| Demo mode | On |
| Dry-run | On |
| Live enabled | Off |
| Live stage | `paper` |
| Auto-live enabled | Off |
| Crypto live enabled | Off |
| Max position | `$10` |
| Daily loss cap | `$5` |
| Max slippage | `3pp` |
| Paper wallet | `$1,000` |
| ProfitOS auto-close | Off |
| ProfitOS live orders | Not supported |

Live unlock is staged:

1. Paper mode is the default operating mode.
2. Manual live requires Kalshi credentials, all 8 guardrail gates, at least 50 paper trades, positive realized paper P&L, equity above start, positive P&L per risk dollar, 65%+ win rate, false-exit rate at or below 10%, average close regret at or below $0.50, average slippage at or below 3pp, drawdown within the daily cap, healthy API status, clean audit state, inactive kill switch, and the confirmation text `ENABLE LIVE MANUAL`.
3. Auto live requires manual live first, at least 20 reconciled manual-live orders, no risk breaches, no unresolved rejects, manual slippage within modeled slippage plus 2pp, at least 30 shadow-auto decisions with expectancy at or above manual baseline, shadow false-exit rate at or below 8%, positive missed-ticket reduction, at least 15 tiny-auto pilot trades, positive pilot expectancy, no pilot risk breaches, and the confirmation text `ENABLE LIVE AUTO`.

The kill switch is available from the UI and by `Ctrl+Shift+K`.

## ProfitOS Paper Auto-Close

ProfitOS is paper-only in the current implementation. It does not place live sell orders.

Current default auto-close settings:

| Control | Default |
| --- | --- |
| Enabled | Off |
| Minimum position age | 30 seconds |
| Minimum ticks | 3 |
| First trim | 50% of contracts |
| First trim trigger | 6% peak P&L and 15% giveback |
| Final close trigger | 12% peak P&L and 25% giveback |
| Emergency edge exit | Edge at or below 0 |
| GEA exit confidence | 0.85 |
| Stale signal close | 90 seconds |
| Bad-liquidity slippage close | 7pp |
| Max bridge latency for GEA exits | 2 seconds |
| Standard decision cooldown | 5 seconds |
| High-confidence cooldown | 500 ms |
| Predictive crossing | On |
| Profit-biased thresholds | On |
| Quick-profit trim | Implemented, off by default |
| Adaptive drift | Implemented, off by default |

The engine records peak paper P&L, peak edge, mark velocity, edge velocity, giveback, exit score, GEA retention action, bridge freshness, slippage, and decision reasons. Decisions are pushed into the Paper Command Desk, trade blotter, notifications, and GEA close feedback.

## Install

Prerequisites:

- Windows 10/11 for the packaged desktop target.
- Node.js 18+.
- npm.
- Git.

Clone and install:

```bash
git clone https://github.com/loganlewisw1112-create/Nemesis.git
cd Nemesis
npm install
```

GEA uses `better-sqlite3` for local persistence. The GEA workspace includes a `postinstall` rebuild for Electron. If SQLite loading fails after installing dependencies, rebuild the native module manually:

```bash
npm run rebuild:sqlite -w @nemesis/global-event-alpha
```

The GEA SQLite database is stored under the Electron user-data directory, typically:

```text
%APPDATA%\@nemesis\global-event-alpha\global-event-alpha.sqlite
```

## Run

Launch NEMESIS in development:

```bash
npm run dev
```

`npm run dev` delegates to `@nemesis/desktop`. NEMESIS starts its local bridge server on port `7430` by default and can auto-spawn Global Event Alpha.

Run GEA directly:

```bash
npm run dev -w @nemesis/global-event-alpha
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEMESIS_BRIDGE_PORT` | `7430` | Local WebSocket bridge port |
| `NEMESIS_AUTO_SPAWN_GEA` | not `false` | Set to `false` to stop NEMESIS from auto-spawning GEA |
| `GEA_TAPE_REFRESH_MS` | `30000` | GEA Kalshi tape REST refresh interval |
| `GEA_TAPE_STALE_MS` | `15000` | GEA tape stale threshold |
| `GEA_TAPE_MARKET_LIMIT` | `25` | GEA market refresh limit |
| `GEA_TAPE_STREAM` | enabled | Set to `false` to disable tape streaming |
| `GEA_TAPE_REST` | enabled | Set to `false` to disable tape REST refresh |
| `GEA_PUBLIC_DATA` | enabled | Set to `false` to disable public-data mesh startup |

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Launch the NEMESIS desktop app |
| `npm run dev -w @nemesis/global-event-alpha` | Launch the GEA companion app directly |
| `npm test -- --run` | Run the Vitest suite |
| `npm run typecheck --workspaces --if-present` | Typecheck all workspaces that expose a typecheck script |
| `npm run build` | Build every workspace that exposes a build script |
| `npm run build -w @nemesis/desktop` | Build the NEMESIS desktop app |
| `npm run build -w @nemesis/global-event-alpha` | Build the Global Event Alpha app |
| `npm run test:e2e -w @nemesis/desktop` | Run Electron smoke and bridge tests |
| `npm run package` | Build the Windows installer; signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are configured |

## Architecture

```text
apps/desktop/              NEMESIS Electron shell, bridge server, IPC, renderer
apps/global-event-alpha/   Companion GEA Electron app, tape engine, SQLite store
packages/bridge-contracts/ Bridge message contracts and fail-closed validation
packages/core/             Kalshi types/client, fees, thesis model, guardrails, live unlock
packages/execution/        Paper desk, live adapter, auto-close engine, benchmarking, audit log
packages/connectors/       Feed hub, Kalshi stream/tape, discovery orchestrator, public data mesh
packages/pods/             Signal pods, edge scanner, playbook logic
packages/ui/               Shared cockpit, guardrail, paper desk, and live-unlock components
packages/charts/           Profit Station chart utilities
packages/capital/          Allocator, risk controls, quarantine logic
packages/journal/          Session journal
packages/brain-core/       GEA intelligence, retention, tournament, no-trade logic
packages/simulation-core/  Replay, ticket autopsy, and model evaluation utilities
```

## Bridge Contract

The local bridge currently supports these message types:

- `bridge:hello`
- `bridge:ping`
- `bridge:pong`
- `nemesis:state`
- `brain:recommendation`
- `brain:no-trade`
- `brain:exit`
- `nemesis:close-result`

NEMESIS rejects expired recommendations, forbidden publishing roles, malformed packets, low-clarity packets, and invalid exit/close payloads before they can become visible tickets or exit actions.

## Build And Verify

Use the full local verification set before treating a branch as release-ready:

```bash
npm test -- --run
npm run typecheck --workspaces --if-present
npm run build
npm run test:e2e -w @nemesis/desktop
```

For a faster documentation-only check, verify the README-linked screenshots exist and run at least:

```bash
git status --short
npm test -- --run
```

## Packaging

Build the Windows installer:

```bash
npm run package
```

The desktop package uses Electron Builder with an NSIS target. Configure `CSC_LINK` and `CSC_KEY_PASSWORD` locally or as GitHub Actions secrets to sign the Windows executable and installer; output is written under the desktop app release directory.

## Repository Status

This README describes the current NEMESIS + GEA mainline after the institutional platform upgrade:

- GEA SQLite persistence is declared through `better-sqlite3`.
- GEA native SQLite rebuild support is present through `rebuild:sqlite` and `postinstall`.
- NEMESIS and GEA use Electron `42.5.0`.
- The bridge E2E suite covers valid recommendation ingestion and fail-closed rejection of expired or forbidden packets.
- Desktop smoke coverage checks app boot, thesis-tier summary rendering, paper desk rendering, refresh behavior, and kill-switch activation.

## Risk Notice

NEMESIS is experimental software. It is not financial advice, investment advice, legal advice, tax advice, or a promise of profitable trading. Event-contract trading can lose money quickly. Automated or semi-automated systems can also fail because of stale data, bad assumptions, bugs, API outages, liquidity changes, fee drag, or operator error.

Use demo and paper workflows first. Do not enable live trading without independent review, dedicated Kalshi credentials, local verification, and a clear risk limit you can afford to lose.

See [DISCLAIMER.md](DISCLAIMER.md) for the full risk notice.

## License

MIT. See [LICENSE](LICENSE).
