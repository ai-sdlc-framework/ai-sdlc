---
name: dispatch-standing-operator-items
description: planner 2026-10-21: PRs 1780/1779/1813/1736, 28 brief ingest errors and ~45 stale worktrees are operator items; dispatch takes no action and does not re-route them
metadata:
  type: project
---

Planner ruling 2026-10-21 (cli-dispatch rule refused: no manifest for these ids, so it is recorded here).

- #1780 (RFC-0056) and #1779 (AISDLC-975): red because their runs predate the AISDLC-996 gate fix; a rerun replays the old snapshot. Only an operator hand push fixes it (the AISDLC-798 hook refuses agent lease pushes on non-task branches).
- #1813 (decision-catalog sync): duplicate of what #1814 landed; closing is class (c), operator decides.
- #1736 release PR: operator-only.
- 28 old brief ingest errors (no error text): known noise, nothing to re-brief.
- ~45 merged-PR worktrees the step-0 sweep cannot remove (uncommitted changes): operator item, leave alone.

**Why:** these are class (c) or hook-blocked; routing them again only wastes planner attention.
**How to apply:** `reconcile` still prints route-to-planner for them; do NOT message the planner again, no rerun/push/rebase/close. Mention as repeats at most.
