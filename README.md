# NEMESIS

[![NEMESIS CI](https://github.com/loganlewisw1112-create/Nemesis/actions/workflows/ci.yml/badge.svg)](https://github.com/loganlewisw1112-create/Nemesis/actions/workflows/ci.yml)

> **PROJECT PARKED — 2026-08-05.** NEMESIS answered the question it was built to answer:
> **no tradeable edge was found, proven across seven independent measurements, with $0 risked.**
> Portfolio closed at $5,000 with 0 trades executed; live trading was never enabled.
> **Read [`docs/PROJECT-CLOSEOUT.md`](docs/PROJECT-CLOSEOUT.md) first** — it explains the reasoning,
> what worked, what didn't, and why not to re-run any of the seven theses.
> Everything below describes the system as built and remains accurate as engineering documentation.

Current as of July 22, 2026 (engineering docs); project closed out 2026-08-05.

NEMESIS is a Kalshi-native desktop trading command center with a companion Global Event Alpha (GEA) intelligence app. It is built for event-market thesis discovery, fillability-aware ticket ranking, paper execution, profit-retention research, fail-closed bridge recommendations, and staged live-trading readiness.

The default posture is intentionally conservative: demo mode on, dry-run on, live trading locked, auto-live disabled, and ProfitOS auto-close limited to paper positions.

## R10 Readiness Status (2026-07-20)

Progress toward the R10 gate (readiness hold → full-25 production soak → gap-closure report) that
qualifies NEMESIS for paper and small live trading:

- **Renderer soak-stall bug: fixed and proven.** The append-only campaign ledger was `structuredClone`d
  twice on the per-orderbook-delta hot path, starving the event loop until the renderer heartbeat
  watchdog invalidated the run. Fixed on the hot path; a full 30-minute full-bar soak now survives with
  the renderer flat (~133 MB, `recoveryCount 0`, zero invalidations).
- **Orderbook coverage decay: fixed.** The 20-second re-verification loop burst all tracked markets at
  once and drew Kalshi 429s, lapsing markets past the 90 s provenance TTL until the tracked set decayed
  below 25. Re-verification is now rate-paced (`pacedDispatch`) and the book-fetch rate-limit backoff is
  bounded below the TTL.
- **Readiness continuous-hold reconnect tolerance: added.** A single self-healed transport reconnect
  (bounded, must re-qualify within a grace window; a second episode or a non-recovery still hard-fails)
  no longer breaks the hold. This is orderbook-transport accounting, not a relaxation of the heartbeat
  watchdog.

A full 30-minute soak completes cleanly with zero stalls, invalidations, or reconnect faults. The
remaining step is a passing soak at the full 25-market bar; validation continues.

## Paper Trading Pipeline Status (2026-07-22)

Separate from R10: does the strategy actually find and complete a profitable paper trade? Paper
trading had produced **zero trades since the portfolio was created on 2026-07-14**. This was
root-caused to a chain of structural gates — not the profit bars — that rejected candidates before
economics were ever evaluated. Five fixes on 2026-07-22 cleared that chain:

- **Provenance hydration.** Flow-driven candidates were never admitted to WebSocket orderbook
  tracking because the stream's own provenance store only knew markets the periodic universe sweep
  had covered. A candidate's ticker is now hydrated from the production single-market endpoint
  before any tracking change. Exchange-origin rejection fell from 87.5% to 17.6%.
- **Maker-fee series.** The fee resolver rejected every series reporting `quadratic_with_maker_fees`;
  its taker formula is identical to plain `quadratic` (verified against the published schedule), so
  it is now accepted. Fee-policy rejections went to zero.
- **In-flight book pinning.** A candidate collecting confirmation evidence can no longer be evicted
  from the tracked set by the 5-minute rotation, which would delete the book its evidence depends on.
- **Provably-continuous quiet books.** A book past the 2s freshness bound is treated as current
  (up to a 10s ceiling) when the transport can prove it missed no update — distinguishing a quiet
  market from a lagging pipeline instead of discarding both.
- **Bar application.** The absolute profit bars now gate admission and the confirming observation
  rather than every intermediate persistence sample, which had compounded a 16% bar into ~0.07%.

Candidates now reach genuine economic evaluation and enter the persistence-confirmation window for
the first time. The profit bars themselves are unchanged and are never lowered to force a trade.
The remaining blocker — confirmation samples stalling at 1 of 4 — is documented with the next steps
in [docs/HANDOFF-NEXT-SESSION.md](docs/HANDOFF-NEXT-SESSION.md). Live trading stays hard-locked
throughout; no real money is at risk.

## Screenshots

### Strict Profit Certification Flow

NEMESIS now keeps suggested tickets watch-only until a fresh executable book can prove a post-fee, post-slippage paper profit certificate.

![NEMESIS Strict Profit Certification Flow](docs/screenshots/nemesis-strict-profit-flow.gif)

### NEMESIS Edge Theater

Ranked thesis discovery with GEA bridge status, Scout/Solid/Whale tiers, tradeability filters, guardrails, risk cockpit context, and visible strict-certification block reasons.

![NEMESIS Edge Theater](docs/screenshots/nemesis-edge-theater.png)

### NEMESIS Paper Command Desk

Paper portfolio, open positions, working orders, realized/unrealized P&L, trade blotter, auto-close decisions, guardrails, and risk panels. Trade count only moves after a certified paper mutation.

![NEMESIS Paper Command Desk](docs/screenshots/nemesis-paper-desk.png)

### Global Event Alpha Command Center

GEA connected to NEMESIS with mirrored state, market/tape intelligence, paper P&L, recommendation flow, retention logic, bridge health, and local persistence.

![Global Event Alpha Command Center](docs/screenshots/global-event-alpha-command-center.png)

## Current Capabilities

- Discovers and ranks Kalshi/event-market opportunities from a broader universe cache.
- Runs a strict profit-only paper execution gate: opens and closes require a valid `ProfitCertificate` with `netPnlUsd >= $0.01` after modeled fees and slippage.
- Rejects missing, zero, stale, synthetic, and non-executable orderbooks before any mutating paper action.
- Keeps unproven ideas visible as watch-only candidates with explicit certification block reasons instead of allowing bad paper buys.
- Scans candidates through a high-throughput queue that fetches books in bounded parallel batches, retries temporary depth/freshness failures, and executes only certified opportunities.
- Assigns executable tiers: Scout, Solid, and Whale, based on fillable depth and slippage context.
- Scores trade theses by net edge, probability gap, settlement clarity, liquidity, freshness, confidence, spread, slippage, source context, and bridge latency.
- Runs a NEMESIS desktop app and a companion Global Event Alpha desktop app.
- Publishes GEA recommendation, no-trade, exit, close-result, hello, ping, and state-mirror packets over an authenticated loopback WebSocket bridge.
- Validates bridge packets fail-closed, including role, freshness, confidence, settlement clarity, schema, and sequence checks.
- Executes paper buys, paper closes, paper cancels, and paper auto-close actions through a strict, certificate-backed dry-run fill model.
- Tracks paper cash, equity, daily P&L, open positions, fills, working orders, marks, regimes, and auto-close history.
- Runs ProfitOS paper auto-close with dynamic exit scoring, GEA exit freshness, velocity trims, predictive threshold crossing, and profit-biased close thresholds.
- Keeps live trading behind an 8-gate guardrail model plus staged manual-live and auto-live unlock certificates.
- Persists GEA market snapshots, orderbook snapshots, public data, ticket cards, profit-retention state, and close feedback in SQLite when the native module is available.
- Builds Windows packages through Electron Builder, with separate postures for unsigned development CI, local signed/staged packages, and release signed packages.

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
| Strict profit mode | On |
| Minimum certified net P&L | `$0.01` |
| Maximum executable book age | `2 seconds` |
| Emergency loss close | Off |
| ProfitOS auto-close | Off |
| ProfitOS live orders | Not supported |

Live unlock is staged:

1. Paper mode is the default operating mode.
2. Manual live requires Kalshi credentials, all 8 guardrail gates, at least 50 paper trades, positive realized paper P&L, equity above start, positive P&L per risk dollar, 65%+ win rate, false-exit rate at or below 10%, average close regret at or below $0.50, average slippage at or below 3pp, drawdown within the daily cap, healthy API status, clean audit state, inactive kill switch, and the confirmation text `ENABLE LIVE MANUAL`.
3. Auto live requires manual live first, at least 20 reconciled manual-live orders, no risk breaches, no unresolved rejects, manual slippage within modeled slippage plus 2pp, at least 30 shadow-auto decisions with expectancy at or above manual baseline, shadow false-exit rate at or below 8%, positive missed-ticket reduction, at least 15 tiny-auto pilot trades, positive pilot expectancy, no pilot risk breaches, and the confirmation text `ENABLE LIVE AUTO`.

The kill switch is available from the UI and by `Ctrl+Shift+K`.

## Strict Profit Gate

NEMESIS prefers no trade over an unproven trade. Every paper open and close now needs a local, fee-aware execution certificate before the Paper Desk can mutate:

- Entry/exit price, contracts, fees, modeled slippage, book age, and `netPnlUsd` are captured in the certificate.
- `netPnlUsd` must be at least `$0.01`.
- Books must be real, fresh, sanitized, and deep enough to execute the requested side.
- Fallback liquidity, synthetic prices, stale quotes, `0`, `1`, `NaN`, and missing depth are rejected.
- Flat or negative paper closes are quarantined unless a future explicit emergency-loss mode is enabled.
- GEA can improve discovery and timing, but it cannot bypass local strict certification.

The throughput engine still tries to maximize trades per day by scanning more candidates, refreshing books, and retrying temporary depth/freshness blocks. Volume never weakens the profit gate: if market data cannot certify a profitable paper mutation, the correct result is no trade.

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
npm ci
```

GEA uses `better-sqlite3` for local persistence. Packaging runs the Electron native rebuild before building GEA. If SQLite loading fails after dependency changes, rebuild the native module manually:

```bash
npm run rebuild:sqlite -w @nemesis/global-event-alpha
```

The GEA SQLite database is stored under the product user-data directory:

```text
%APPDATA%\@nemesis\global-event-alpha\global-event-alpha.sqlite
```

On first launch after an older Electron-default build, GEA non-destructively copies `%APPDATA%\Electron\global-event-alpha.sqlite` to the product path if the product database is missing.

## Run

Launch NEMESIS in development:

```bash
npm run dev
```

`npm run dev` delegates to `@nemesis/desktop`. NEMESIS starts its authenticated local bridge server on `127.0.0.1:7430` by default and can auto-spawn Global Event Alpha with the bridge token in the child process environment.

Run GEA directly:

```bash
npm run dev -w @nemesis/global-event-alpha
```

Useful environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEMESIS_BRIDGE_PORT` | `7430` | Local WebSocket bridge port |
| `NEMESIS_BRIDGE_HOST` | `127.0.0.1` | Bridge bind host; non-loopback values require `NEMESIS_ALLOW_REMOTE_BRIDGE=true` |
| `NEMESIS_BRIDGE_TOKEN` | generated per NEMESIS process | Bridge authentication token; spawned GEA receives it automatically |
| `NEMESIS_ALLOW_REMOTE_BRIDGE` | unset | Must be `true` before NEMESIS accepts a non-loopback bridge host |
| `NEMESIS_AUTO_SPAWN_GEA` | not `false` | Set to `false` to stop NEMESIS from auto-spawning GEA |
| `NEMESIS_E2E_USER_DATA` | unset | NEMESIS e2e user-data override |
| `GEA_E2E_USER_DATA` | unset | GEA e2e user-data override |
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
| `npm run ci:e2e` | Run the direct Electron startup smoke with authenticated bridge `bridge:hello` verification |
| `npm run ci:package` | Build GEA, rebuild SQLite for Electron, and package the Windows apps |
| `npm run package` | Build the Windows installer; signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are configured |
| `npm run package:local-signed` | Build, locally sign, verify, hash, and stage the Windows package with a current-user trusted NEMESIS dev certificate |
| `npm run stage:windows-package` | Sign, verify, hash, and stage existing Windows package outputs |
| `npm run smoke:desktop-pair` | Launch the built NEMESIS/GEA pair and verify visible windows plus authenticated bridge `hello/state/pong` |

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

The local bridge binds to `127.0.0.1` by default and requires a token query parameter before NEMESIS sends `bridge:hello` or `nemesis:state`. The bridge currently supports these message types:

- `bridge:hello`
- `bridge:ping`
- `bridge:pong`
- `nemesis:state`
- `brain:recommendation`
- `brain:no-trade`
- `brain:exit`
- `nemesis:close-result`

NEMESIS rejects unauthenticated clients, expired recommendations, forbidden publishing roles, malformed packets, low-clarity packets, and invalid exit/close payloads before they can become visible tickets or exit actions.

## Build And Verify

Use the full local verification set before treating a branch as release-ready:

```bash
npm run ci:typecheck
npm run ci:build
npm run ci:unit
npm run ci:e2e
npm run ci:package
npm run smoke:desktop-pair
```

For a faster documentation-only check, verify the README-linked screenshots/GIF exist and run at least:

```bash
git status --short
npm test -- --run
```

## Packaging

Build the Windows installer:

```bash
npm run package
```

The package flow builds Global Event Alpha first, rebuilds `better-sqlite3` for Electron, writes the unpacked GEA app to `apps/global-event-alpha/release/win-unpacked`, then bundles that app into the NEMESIS desktop package under `resources/gea-app`.

The desktop package uses Electron Builder with an NSIS target. Raw Electron Builder output is written under `apps/desktop/release`.

Packaging/signing postures:

- Development CI may build unsigned artifacts when signing secrets are absent. CI labels those artifacts as unsigned and still uploads evidence.
- Release/tag CI fails if `CSC_LINK` or `CSC_KEY_PASSWORD` is absent. Release artifacts must verify as Authenticode `Valid`.
- Local signed packages use `npm run package:local-signed` to build, sign, verify, hash, and stage the installer.

For this development machine, `npm run package:local-signed` creates or reuses a current-user `NEMESIS Local Dev Code Signing` certificate, trusts it only for the current Windows user, signs the required executables, verifies them with `Get-AuthenticodeSignature`, and stages:

```text
WINDOWS PACKAGE\NEMESIS-Windows-v0.1.0-Setup.exe
WINDOWS PACKAGE\NEMESIS-Windows-v0.1.0-Setup.exe.sha256.txt
WINDOWS PACKAGE\signatures.txt
```

Required signature targets are the final setup executable, unpacked `NEMESIS.exe`, bundled `resources\gea-app\Global Event Alpha.exe`, and the GEA release `Global Event Alpha.exe`. The local development certificate removes `NotSigned` locally, but it is not a substitute for a CA-issued certificate for public distribution.

## Repository Status

This README describes the current NEMESIS + GEA mainline after CI/package stabilization:

- GEA SQLite persistence is declared through `better-sqlite3`.
- GEA native SQLite rebuild support is present through `rebuild:sqlite`; the package script runs it before Electron Builder.
- NEMESIS and GEA use Electron `42.5.0`.
- Strict profit certification is enabled for paper execution and surfaced on thesis cards as certified, retryable, or blocked.
- The root CI path runs `npm ci`, build, typecheck, Vitest, direct authenticated Electron bridge smoke, Windows packaging, and signature verification or unsigned labeling.
- The direct Electron smoke waits for startup trace milestones, verifies `window-load-file-ok`, and requires authenticated bridge `bridge:hello`.
- Package output includes the NSIS setup executable, unpacked `NEMESIS.exe`, and bundled `resources/gea-app/Global Event Alpha.exe`.

## Risk Notice

NEMESIS is experimental software. It is not financial advice, investment advice, legal advice, tax advice, or a promise of profitable trading. Event-contract trading can lose money quickly. Automated or semi-automated systems can also fail because of stale data, bad assumptions, bugs, API outages, liquidity changes, fee drag, or operator error.

Use demo and paper workflows first. Do not enable live trading without independent review, dedicated Kalshi credentials, local verification, and a clear risk limit you can afford to lose.

See [DISCLAIMER.md](DISCLAIMER.md) for the full risk notice.

## License

Proprietary and all rights reserved. See [LICENSE](LICENSE).
