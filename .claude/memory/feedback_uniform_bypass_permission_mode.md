---
name: feedback-uniform-bypass-permission-mode
description: Operator 2026-10-09 — every roster session, planner included, launches in bypassPermissions; never a mixed-mode roster
metadata:
  type: feedback
---

Dominique launches all his Claude sessions with `--dangerously-skip-permissions`, the planner included, and wants `cli-hierarchy up` to default to that for every role. A roster with mixed permission modes is wrong.

**Why:** cross-session messages between sessions in different permission modes are held for approval in the receiving pane; on 2026-10-09 this blocked planner→dispatch rulings (DEC-0074 was held then denied, never delivered). The hooks, not prompts, are the control surface for all three tiers (AISDLC-752, [[route-questions-via-planner]]).

**How to apply:** the code fix is AISDLC-752 (PR #1259) — it must land first in any fix-round order; until then, relaunch a mismatched planner by hand in `bypassPermissions` (DEC-0075). Never propose keeping the planner on `auto`/`default` "for the operator's prompts". Linked: [[feedback-autonomous-mode-stop-asking]].
