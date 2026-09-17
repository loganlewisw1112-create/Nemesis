---
name: nemesis-ops
description: Operational runbook for working on NEMESIS (this repo, KRYPT/nemesis — an Electron/Kalshi trading app). Use this whenever changing code and relaunching the live app, running the R10 readiness/soak gate, editing entryQualification/settings.json/paper-trading behavior, or investigating why paper trading isn't producing trades. Covers the safe rebuild-and-relaunch sequence, the R10 gate ladder's exact commands and gotchas, where paper-trading data lives, and hard-won facts about this codebase (demoMode's real meaning, the exchange-origin book check, the classifier boundary around trading config) that should never need re-deriving from scratch.
---

This repo has a long, expensive history of re-discovering the same things. Read this first;
it saves hours. Full narrative and exact commit-by-commit reasoning lives in
`.cursor/memory/` (`nemesis-project-history.md`, `nemesis-working-notes.md`) — this file is
the short, actionable version for actually doing the next piece of work. Session entrypoint:
repo root `AGENTS.md`.

## Facts worth never re-deriving

- **NEMESIS always uses real Kalshi production market data**, regardless of `demoMode`. Feed
  endpoints are hardcoded to `production` throughout `main.ts`. `demoMode` does not mean
  "simulated data" — it only gates whether production markets get re-verified. In demo mode,
  every thesis stalls at `uncertain`/research-only forever, which looks like a data problem
  but is actually just this one setting.
- **There is no `useProductionApi` UI control.** It's a dead field in
  `packages/core/src/types.ts`, default `false`, never read by any feed-selection code, never
  wired to a button. Don't tell a user to look for it.
- **The exchange-origin book check (`entryConfirmation.ts`, "confirmation requires an
  exchange-origin book timestamp and sequence") must never be relaxed.** It's the only thing
  standing between a trade and an unverifiable book. If paper trading is stuck here, the fix
  is upstream (get the candidate a real WS-tracked book — see "Orderbook WS tracking capacity"
  below), never loosening this specific check.
- **The orderbook WebSocket only tracks ≤25 tickers at a time**
  (`ORDERBOOK_TRACKING_LIMIT`, `main.ts`), rotating a handful every 5 minutes
  (`ORDERBOOK_ROTATION_INTERVAL_MS`). The flow-driven candidate pipeline surfaces far more
  distinct tickers per session than that. Any candidate ticker not currently in the tracked 25
  falls back to a REST orderbook snapshot, and Kalshi's REST snapshot has no match-engine
  sequence number (only the WS delta stream does — see `parseOrderbook`,
  `packages/core/src/kalshi/client.ts`) — so it *always* fails the exchange-origin check. This
  was the real reason paper trading produced zero trades for the project's entire history; see
  [[nemesis-project-history]] for the fix attempts and where they got to.
- **`kalshiOrderbookStream` keeps its own internal provenance store**, separate from
  `main.ts`'s `productionMarketRecords`. Adding a ticker to the tracked list doesn't guarantee
  the stream actually accepts it — check whether `getBook(ticker)` ever returns non-null, not
  just whether you called `track()`/`replaceTracked()`. This is where the investigation was
  paused; see the handoff doc referenced in memory if picking this back up.

## Safe change-and-verify workflow for this live-running Electron app

NEMESIS is frequently running live (paper-trading mode) while you're editing it. Never touch
trading config yourself (see below) — but for source-code changes, this is the loop:

1. **Stop only NEMESIS's own processes**, never electron indiscriminately (the machine may be
   running other Electron apps):
   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
     Where-Object { $_.CommandLine -like "*KRYPT*nemesis*" } |
     ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop }
   ```
   Confirm 0 remain before editing/rebuilding.
2. **Typecheck**: `cd apps/desktop && npx tsc --noEmit` (must be clean, no output = pass).
3. **Full suite from repo root**: `npx vitest run` — expect 550+ tests, 98+ files, all green.
   If exactly one fails and it's asserting a literal string that a recent commit changed
   (e.g. a PS1-script content check), it's very likely a stale test from a prior edit in the
   same session, not a new regression — check `git log -p` on the relevant test before
   assuming otherwise.
4. **Build**: `npm run build --workspaces --if-present` from repo root. Watch for `dist-electron/main.js`
   size changing (confirms the new code actually landed in the build).
5. **Relaunch**:
   ```powershell
   $env:NEMESIS_AUTO_SPAWN_GEA = 'true'
   & "node_modules\electron\dist\electron.exe" "apps\desktop\dist-electron\main.js"
   ```
   Confirm ~9 electron processes come up (main + renderer + GEA + subprocesses) and the
   qualification funnel (see below) shows a fresh event within a few seconds.
6. **Verify with a monitor filtered strictly to timestamps AFTER this exact relaunch.** This
   is the single most common way to misjudge a fix here: reading the last N lines of an
   append-only event log mixes pre-fix and post-fix data, and a working fix can look
   inconclusive or broken for much longer than it actually took to prove out. Always compute
   a cutoff timestamp at relaunch and filter every subsequent read by `e.at > cutoffMs`.

## Where paper-trading data lives

`%APPDATA%\@nemesis\desktop\nemesis-data\` (i.e.
`C:\Users\<user>\AppData\Roaming\@nemesis\desktop\nemesis-data\`):
- `settings.json` — the trading config (see "Trading-config boundary" below before touching).
- `paper-portfolio.json` — `{cash, realizedPnl, positions[], trades[]}`. This is the ground
  truth for "has it ever actually traded."
- `session-stats.json` — `{dayStart, dailyPnl, tradeCount, abortCount}`.
- `paper-qualification-events.jsonl` — the funnel: `funnel_increment` events per stage
  (`raw_candidates`, `entry_eligible`, `books_fetched`, etc.) plus `paper_abort` events with
  `abortReason`/`abortCode`.
- `paper-strategy-validation-events.jsonl` — the higher-fidelity per-candidate confirmation
  trail: `entry_confirmation_observed` events carry `status`, `reason`, `ticker`,
  `targetRewardUsd`, `rewardRiskRatio`, `stressedNetPnlUsd`, and a full `economics` object.
  This is the file to mine when diagnosing "why isn't it trading" — see
  `.cursor/skills/diagnose-qualification-funnel/SKILL.md` for the general technique; the one-line
  node incantations used throughout this project's history all read this file, e.g.:
  ```bash
  tail -2000 paper-strategy-validation-events.jsonl | node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const c={};d.trim().split(/\r?\n/).forEach(l=>{try{const e=JSON.parse(l);
        if(e.type==="entry_confirmation_observed"){const r=e.reason||e.status;c[r]=(c[r]||0)+1;}
      }catch(x){}});
      console.log(JSON.stringify(Object.fromEntries(Object.entries(c).sort((a,b)=>b[1]-a[1])),null,1));
    })'
  ```

## Trading-config boundary — do not fight this, route around it

Every attempt to Edit/Write `settings.json` directly, or run `npm run paper:archive-reset` /
`npm run paper:rescore` via Bash, gets blocked by the auto-mode classifier — including
attempts to self-grant permission for it via a config-editing skill. This holds even with
explicit chat authorization ("go ahead") because chat approval doesn't override the
guardrail, and trying a different tool to route around a denial defeats its purpose. Don't
retry the same blocked write with a different tool.

The workflow that works every time: give the user the **exact** key/value pairs to change (or
the exact command to run themselves), then verify the result by reading the file back — reads
are never blocked. If a config change trips the strategy-validation pause (see below), tell
the user to run the reset command themselves, or use the in-app Reset button in the Paper
Command Desk (type `ARCHIVE_AND_RESET_PAPER` when prompted) — both work identically.

**Toggling `demoMode` or `autoClose` trips a strategy-config-hash pause** (blocks all paper
execution) that the in-app portfolio Reset does *not* automatically clear — the reset button
does clear it too, just confirm the latest event in `paper-strategy-validation-events.jsonl`
is `validation_run_started`, not `validation_paused`, before assuming the app is unpaused.

## The R10 gate ladder (readiness → full-25 soak → gap-closure report)

Gate order and scripts (all in `scripts/`):
1. `run-production-readiness.ps1` — 10-minute continuous hold. Takes `-OrderbookTarget N`
   (use 8 for a reduced-bar rehearsal, 25 for the real bar) and `-ReceiptPath`.
2. `run-production-soak.ps1` — 5-min warmup + scored duration at the full 25-market bar.
   Takes `-ReadinessReceiptPath`, `-AttemptId`, `-DurationMinutes`.
3. `generate-r10-gap-closure-report.cjs` — assembles the final evidence report from a passing
   soak's artifacts.

Combined chain script: `output/r10-scheduled/run-r10-chain.ps1` (repo-adjacent, not inside the
repo — R10 runners require a clean git worktree, so never write run outputs into the repo
itself). Runs readiness then the soak sequentially and prints a `RESULT=` line.

**Two gotchas that will silently corrupt a run if you don't know them:**
- The readiness runner sets `$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT` in its own PowerShell
  process. The soak runner never resets it and defaults to 25 — so if you run both stages in
  *one* PowerShell session (as a naive chain script would), the soak silently inherits the
  reduced readiness target and fails the "==25 markets" acceptance check despite its own
  manifest claiming 25. **Always explicitly reset `$env:NEMESIS_ORDERBOOK_TRACKING_LIMIT = "25"`
  before launching the soak stage**, even though the soak's default is technically 25 — the
  inherited env var overrides that default.
- A soak run with the default `-DurationMinutes 30` (30-min scored) yields only a ~29.55-min
  renderer slope window (the first post-warmup sample lands ~30s in), which reads as
  "slope window incomplete/unevaluated" and fails acceptance on an otherwise-perfectly-healthy
  run. **Always pass `-DurationMinutes 33`** so the 30-minute slope window actually completes.

**Kalshi feed reality check before spending an hour on a run:** the WebSocket layer is
sometimes intermittently unstable in a way REST health checks can't detect (a REST probe can
show 5/5 healthy while the ticker/orderbook WS transports are dropped). If several
consecutive runs die early on feed-quality reasons (timeouts, "exchange-origin book" gaps,
sudden all-feeds staleness), that's very likely external and no code change will fix it —
either wait and retry, or (better) resume during US market hours, when this has reliably been
calmer.
