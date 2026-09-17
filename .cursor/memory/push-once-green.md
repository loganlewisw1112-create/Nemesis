---
name: push-once-green
description: "Standing instruction — push commits as soon as verification is green; don't hold them back waiting for a decision"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 65c3af5a-3861-4e1c-aa54-c03f463fb2f6
  modified: 2026-07-22T19:14:23.704Z
---

Push to the remote as soon as the work is green. Do not park commits locally and ask "push is
your call" — that's the default, not a decision the user wants to make each time.

**Why:** stated directly on 2026-07-22 ("always push once its green") after NEMESIS had
accumulated 5 unpushed local commits (`7097b4d`..`11ea08b`) across multiple sessions, with each
handoff re-listing "push is a user decision, not yet made" as an open item. Holding green work
back created a recurring false to-do and left verified fixes unbacked.

**How to apply:** "green" for NEMESIS means typecheck clean + full suite passing (550+ tests,
98+ files) + build succeeding — the sequence in the repo skill `nemesis-ops`. Once that passes,
commit and push without asking. Still apply the normal pre-push checks: `git status` to review
what's staged, and inspect anything that could carry secrets. Branch work goes to its own branch
(NEMESIS lives on `agent/nemesis-seven-hour-campaign`), never straight to `main`.

Caveat worth keeping: a red CI badge on this repo is not automatically a code failure — a known
GitHub Actions **artifact storage-quota** exhaustion has failed the `verify-package > Upload CI
evidence` step while build/tests/typecheck all passed. Check which step failed before reacting.
Related: [[nemesis-memory-location]].
