# Agent operating manual — KRYPT / NEMESIS (Cursor)

Cursor-side entrypoint. Claude Code keeps its **own** independent memory/skills under
`~/.claude/` and `nemesis/.claude/` — do not overwrite or rename those.

Product lives in `nemesis/` (Kalshi event-contract Electron desk + GEA). Paper-first; live locked.

## Session start (Cursor)

1. Read `.cursor/memory/MEMORY.md` (Cursor memory index).
2. Read current mission: `nemesis/docs/HANDOFF-NEXT-SESSION.md`.
3. Ops/code/relaunch/paper → `.cursor/skills/nemesis-ops/SKILL.md`.
4. Funnel stalls → `.cursor/skills/diagnose-qualification-funnel/SKILL.md`.
5. Release / P&L audit → `.cursor/skills/audit-nemesis/SKILL.md`.
6. Pick tools proactively per `.cursor/rules/nemesis-tooling-discretion.mdc`.

## Hard constraints (shared intent; Cursor enforces via its rules)

- Do not Edit/Write AppData `settings.json` or run `paper:archive-reset` / `paper:rescore` — user does it; verify by read.
- Never relax exchange-origin book checks or lower profit bars to manufacture green P&L.
- Shadow `ready` ≠ portfolio trade; do not bypass shadow→pilot.
- No AI co-author trailers on commits/PRs/docs.
- Feeds are always real Kalshi production; `demoMode` only gates re-verification.
- Integrity first: report truth, refuse fake-green shortcuts.

## Dual-stack rule

| Surface | Owner | Path |
|---------|--------|------|
| Claude Code memory/skills/rules | Claude only | `~/.claude/projects/.../memory/`, `.claude/skills/` |
| Cursor memory/skills/rules | Cursor only | `.cursor/memory/`, `.cursor/skills/`, `.cursor/rules/` |

Update each stack independently. Never overwrite the other tool’s files to “sync.”
