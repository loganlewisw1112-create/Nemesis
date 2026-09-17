# Claude Code — NEMESIS

Claude Code uses **its own** memory and skills:

- Memory: `~/.claude/projects/.../memory/` (parent-slug history + KRYPT index — see `nemesis-memory-location`)
- Skills: `.claude/skills/` (e.g. `nemesis-ops`)

Cursor maintains a **parallel** pack under `.cursor/` — independent, not a replacement.
Do not overwrite Claude memory/skills from Cursor (or the reverse).
