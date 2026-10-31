---
name: closed-pr-is-wasted-work
description: "Operator 2026-10-13: every PR closed unmerged is wasted work; before asking him to close one, work out how it could have been avoided; closed-unmerged PRs are a KPI"
metadata:
  type: feedback
---

Operator (Dominique, 2026-10-13 ~02:40Z, after being asked to close #1434 and #1437, the AISDLC-823 filing duplicates): "every closed PR means wasted work, so the next time you ask me to close a PR think hard about how you could have avoided it. It means we did all the work to create the change then all that work was wasted." And: "we need to track this in the KPIs."

**Why:** a re-filed PR throws away the review, CI runs and attention the first one consumed, and leaves the operator a cleanup chore. Today's duplicates came from a hook gap (the lease-push hook never implemented DEC-0088 for planner `ai-sdlc/file-*` branches), and the workaround (re-file) was recorded as a rule in [[filing-pr-hygiene]] instead of the gap being fixed.

**How to apply:**
- Never re-file to get around a push refusal; fix or file the refusing path (a missing sanctioned path is a task, per CLAUDE.md) and update the existing PR branch.
- Before any request to close a PR, write down the avoidable cause and the fix for it in the handoff; if there is none, say so.
- Count PRs closed unmerged as a journey metric (waste); AISDLC task to add it is filed from this note.
- Related: [[project_planner_handoff_2026_10_10]], [[feedback_prs_auto_armed_never_ask_to_merge]].
