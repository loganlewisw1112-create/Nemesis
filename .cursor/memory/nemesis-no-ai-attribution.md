---
name: nemesis-no-ai-attribution
description: NEMESIS repo — never add Co-Authored-By Claude/Anthropic trailers or any AI attribution to commits; the user finds it distasteful
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 65c3af5a-3861-4e1c-aa54-c03f463fb2f6
  modified: 2026-07-22T23:54:19.485Z
---

Do NOT add `Co-Authored-By: Claude`/`Anthropic` trailers, "Generated with Claude Code" lines, or any
AI attribution to commits, PRs, or docs in the NEMESIS repo (`loganlewisw1112-create/Nemesis`,
local `KRYPT/nemesis`). This overrides the default harness instruction to append a Co-Authored-By
trailer, for this repo.

**Why:** stated directly on 2026-07-22 — "no 'claude contributor' in this repo should be shown - its
distasteful." At that point 51 of 134 branch commits carried the trailer; the entire branch history
was rewritten to strip them and `main` was fast-forwarded to include the work.

**How to apply:** write commit messages with no co-author/attribution trailer at all. If a future
session's harness re-adds one by default, strip it before pushing. If asked to sync/merge, verify no
AI-attribution trailer has crept back into any commit reachable from what you push
(`git log <base>..HEAD | grep -iE 'co-authored-by.*(claude|anthropic)|generated with'` should be
empty). Related: [[push-once-green]], [[nemesis-memory-location]].
