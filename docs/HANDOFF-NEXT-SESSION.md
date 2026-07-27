# NEMESIS — Next-Session Handoff (pick up 2026-07-24 after overnight)

## Current override — 2026-07-26

This section supersedes the older July 24 instructions below.

- The focused shadow campaign is now **50 scored observations across 1 elapsed
  day**. `scripts/launch-paper-allowlist.ps1` exports
  `NEMESIS_SHADOW_MIN_SCORED=50` and
  `NEMESIS_SHADOW_MIN_OBSERVATION_DAYS=1`.
- Count is never enough by itself. Net P&L, profit factor, win rate, stressed
  P&L/PF, largest-win concentration, ledger integrity, and exchange-origin book
  checks remain mandatory.
- The `Start paper (force)` / `FORCE_ADVANCE_TO_PILOT` UI and drop-file bypasses
  were removed. Only a full `shadowPassed` snapshot plus exact
  `ADVANCE_TO_PILOT` confirmation may enter the capped paper pilot.
- At the 2026-07-26 live inspection, the existing runtime still showed the old
  launch values (`50/25`, one day) because it had not been restarted:
  shadow net **-$19.81**, PF **0.75**, win rate **18%**, stressed net
  **-$40.11**, stressed PF **0.58**. Paper trades/positions remained zero.
- Directional split at that checkpoint: YES **+$30.14 / PF 1.99**; NO
  **-$49.94 / 0 wins from 27**. Treat this as a calibration/regime risk, not a
  reason to weaken the acceptance bars.
- The source tree was built and verified without stopping the running desk.
  A later controlled relaunch is required before the live UI/runtime uses the
  committed 50/1-day gate and no-bypass build.

**Next runtime action:** controlled relaunch with
`scripts/launch-paper-allowlist.ps1`, record a new cutoff, verify the UI reports
50 samples / 1 day and exposes no force button, then judge only post-cutoff
events. Do not reset the paper portfolio or strategy ledger from automation.

**Read this first.** Do **not** start new plumbing overnight. The app was left running for a
crypto-overnight measurement.

**Morning implement plan (PLAN ONLY until T‑30):**
`docs/superpowers/plans/2026-07-24-provenance-throughput-green-paper.md`

**Clock:** Freeze after-cutoff report at **06:00 PDT** (T‑30 before 09:30 ET cash open), then
provenance → throughput → persistence residuals → **first green paper trade**. Do not chase a
fill until those fixes (as demanded by the report) are done.

Tomorrow’s first job is still **post-cutoff analysis** (`AFTER-CUTOFF-REPORT.md`), then execute
that plan — not a thesis pivot — unless the report’s go/no-go table says otherwise.

---

## One-paragraph state

Execution tail (ready → shadow → pilot → paper buy/close) is proven. Sampler stall at 1/4
(re-issued `card.id` resetting confirmation) was fixed 2026-07-23 and built into
`dist-electron`. App was relaunched **2026-07-23 ~14:43 PDT** with a focused series
allowlist and left running through **crypto overnight** (US cash hours were already closed
at relaunch, so daytime silence was expected). **Still no clean post-fix first-ready on
fitting instruments at handoff time** — that is what overnight + morning analysis answer.

---

## Live measurement already in flight (do not relaunch unless dead)

| Field | Value |
|--------|--------|
| Cutoff ms | `1784843034218` |
| Cutoff ISO | `2026-07-23T21:43:54.2215136Z` (~14:43 PDT) |
| Cutoff file | `nemesis/.nemesis-relaunch-cutoff.txt` |
| Allowlist env | `NEMESIS_SERIES_ALLOWLIST=KXINXHUD,KXNASDAQ100HUD,KXBTCD` |
| Main PID (at launch) | `27168` (may have changed; confirm process still up) |
| Flags | `demoMode=false`, `liveEnabled=false`, `dryRun=true` |
| Build | `apps/desktop/dist-electron/main.js` size ~375455 after sampler fix |

**Hard rule:** every analysis filter is `e.at > 1784843034218`. Mixing pre-cutoff lines
will fake “still broken” or “already working.”

If the Electron/NEMESIS process is **dead** tomorrow morning: note that as an invalid/
truncated run, relaunch with the **same** allowlist + new cutoff, and treat overnight as
lost. Do not invent a new fix first.

---

## What landed 2026-07-23 (committed locally? check `git status`)

Sampler identity fix (may still be uncommitted — check before assuming it’s on remote):

1. `campaignEconomicIdentity` = `ticker|side|playbook|sourceMove` (**no** `card.id`).
2. `EntryConfirmationEngine` keys on that identity; re-issued signal IDs continue one chain;
   `markSourceUsed` also burns the economic identity.
3. Quiet-book persistence without a new sequence each sample (prior commit) remains.
4. Plan: `docs/superpowers/plans/2026-07-23-confirmation-sampler-identity.md`.

Unfocused smoke before allowlist only saw **sports** + reward-bar / exchange-origin rejects.
Allowlisted relaunch: equity/session/bridge kept writing; **0** confirmation events in the
first ~5 minutes (expected post–US close).

---

## Tomorrow — post-analysis checklist (in order)

### 0. Confirm the run is still valid
- [ ] NEMESIS desktop still running (or note crash time).
- [ ] `bridge-telemetry.jsonl` / `equity-history.json` / `session-stats.json` have writes
      after cutoff.
- [ ] Settings still: live off, dry-run on, demo off. **Do not edit settings.json**
      (classifier boundary — see `nemesis-ops`).

### 1. Confirmation funnel (post-cutoff only)
Data dir: `%APPDATA%\@nemesis\desktop\nemesis-data\`

Mine `paper-strategy-validation-events.jsonl` for `type === entry_confirmation_observed`
with `at > 1784843034218`:

- Counts by `status` / `reason`
- `max(samples)` and histogram of `samples` (need evidence of 2, 3, 4 — not stuck at 1)
- Tickers: must be allowlisted prefixes only; sports = invalid contamination
- Any `status === 'ready'`?

### 2. Ground truth
- `paper-portfolio.json` → `trades[]` length / any open positions
- Shadow / pilot events in the same validation log if present

### 3. Decision (pre-agreed — do not move bars)

| Outcome | Criteria | Next |
|---------|----------|------|
| **Go** | ≥1 `ready` on allowlisted series that clears shadow (`PF≥1.25`, win≥0.55) and/or produces a paper trade | Thesis viable on that class; scale; defer live-only residuals |
| **No-go** | Healthy post-cutoff flow + samples reaching 4, but zero readys / zero shadow clears over overnight (+ optional next US open) | Stop flow-momentum tuning; design arb pivot |
| **Invalid** | Process died, still max samples=1, off-allowlist sports only, or bars were relaxed | Discard; relaunch clean; **do not** declare thesis dead |

### 4. Only after a valid Go or No-go
- **Go:** optional live-only residuals (electron timer wiring, shadow 15-min book re-fetch).
- **No-go:** thesis pivot plan (cross-venue / correlated arb) — new design doc, not more
  sampler tweaks.
- **Invalid:** fix the measurement conditions, not the thesis.

---

## Hard rules (unchanged)

- Do not relax exchange-origin book timestamp+sequence checks.
- Do not lower profit bars to manufacture a trade.
- Live stays hard-locked.
- Do not continue the “fixing plan” until this analysis is written down.

---

## Operational pointers

- Ops runbook: `.claude/skills/nemesis-ops/SKILL.md`
- Personal funnel skill: `diagnose-qualification-funnel` (filter by cutoff)
- Prior architecture note: plumbing proven; offensive thesis is the open risk; this overnight
  is the first fair test on fitting instruments after the sampler fix.

## Suggested analysis one-liner (PowerShell + node)

```powershell
$cutoff = 1784843034218
$val = "$env:APPDATA\@nemesis\desktop\nemesis-data\paper-strategy-validation-events.jsonl"
node -e "const fs=require('fs');const c=$cutoff;const conf=fs.readFileSync(process.argv[1],'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(e=>e&&e.at>c&&e.type==='entry_confirmation_observed');const by={};let max=0;for(const e of conf){const k=(e.status||'')+'|'+(e.reason||'').slice(0,80);by[k]=(by[k]||0)+1;max=Math.max(max,e.samples||0)}console.log(JSON.stringify({n:conf.length,ready:conf.filter(e=>e.status==='ready').length,maxSamples:max,tickers:[...new Set(conf.map(e=>e.ticker))],top:Object.entries(by).sort((a,b)=>b[1]-a[1]).slice(0,15)},null,2))" $val
```
