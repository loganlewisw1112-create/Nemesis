# Agent operating manual — KRYPT / NEMESIS

This file is the **shared brain entrypoint** for Cursor, Claude Code, and any account that
opens this repo. Prefer repo paths over `~/.claude` or account-local memory — those do not
travel across machines or Cursor accounts.

Product lives in `nemesis/` (Kalshi event-contract Electron desk + GEA). Paper-first; live locked.

## Session start (every agent, every account)

1. Read `.cursor/memory/MEMORY.md` (index).
2. Read current mission: `nemesis/docs/HANDOFF-NEXT-SESSION.md`.
3. For ops/code/relaunch/paper diagnosis → skill `.cursor/skills/nemesis-ops/SKILL.md`.
4. If trades ≈ 0 or funnel stalls → `.cursor/skills/diagnose-qualification-funnel/SKILL.md`.
5. Before release / P&L audit → `.cursor/skills/audit-nemesis/SKILL.md`.
6. Pick tools proactively from `.cursor/rules/nemesis-tooling-discretion.mdc` — do not wait to be asked.

## Hard constraints (never negotiate)

- **Never** Edit/Write `%APPDATA%\@nemesis\desktop\nemesis-data\settings.json` or run
  `paper:archive-reset` / `paper:rescore` yourself — give the user exact keys/commands; verify by read.
- **Never** relax exchange-origin book timestamp+sequence checks.
- **Never** lower profit / certification bars to manufacture green P&L.
- **Never** bypass shadow→pilot ladder to fake a portfolio trade (`ready` in shadow ≠ trade).
- **Never** add `Co-Authored-By: Claude|Anthropic` or any AI attribution to commits/PRs/docs.
- Feeds are always **real Kalshi production**; `demoMode` only gates re-verification (not fake data).
- Integrity first: report truth, refuse shortcuts that fake results.

## Working loop (live paper app)

1. Stop only NEMESIS electron processes (CommandLine like `*KRYPT*nemesis*`) — not all Electron.
2. Typecheck → full vitest → build (see nemesis-ops).
3. Relaunch with `NEMESIS_AUTO_SPAWN_GEA=true`; record cutoff ms.
4. Filter **all** AppData JSONL analysis to `at > cutoffMs` before judging a fix.
5. One theory → measure → decide. After 2–3 failed rounds, checkpoint with the user.

## Git (this project only)

- Branch work: `agent/nemesis-seven-hour-campaign` (not straight to `main`).
- When typecheck + tests + build are green: **commit and push** without asking (project standing rule).
- Still refuse secrets; inspect `git status` before push.
- CI artifact-quota failures ≠ code red — check which step failed.

## Cross-account continuity

Commit and push `.cursor/` (rules, skills, memory) and this `AGENTS.md` / `CLAUDE.md`.
Any Cursor or Claude Code account that clones the repo inherits the same flows.
