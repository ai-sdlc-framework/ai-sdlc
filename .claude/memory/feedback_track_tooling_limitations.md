---
name: track-tooling-limitations
description: operator 2026-10-16 — every external tooling ceiling (gh/GitHub API quotas, git, Actions) we work around is recorded in a register with its headroom metric; instrument as they grow
metadata:
  type: feedback
---

When a failure is caused by a limit of the tooling we depend on (GitHub user token 5,000/hr, Actions GITHUB_TOKEN 1,000/hr/repo, GraphQL secondary limits, search 30/min, `gh run rerun` taking only a run id, git loose-object gc stalls, worktree count), say so explicitly: it is a tooling limitation we are working around, not our bug. Record it in `docs/operations/tooling-limitations.md` (AISDLC-964) with the limit, the symptom, the headroom metric and where it is read, the workaround, and a scaling note.

**Why:** the framework is mostly dependent on `gh`; the rate-limit outage hit on two consecutive days (2026-10-15/16) before anyone could say which caller spent the quota. Anthropic's engineering post on redesigning source control (https://www.anthropic.com/engineering/redesigning-source-control) shows the same pattern: custom tooling grows around git's limits at scale. Enterprise adopters with many concurrent agents on one codebase hit these ceilings earlier than we do.

**How to apply:** when ruling on a red that is a quota or tooling ceiling, name the ceiling and the register row; when filing a workaround task, add or update the row and point at its instrumentation ([[every-gh-call-is-logged]] AISDLC-963 feeds the gh rows). Prefer measuring headroom (`cli-hierarchy status`, gate job summary) over remembering limits. Related: [[feedback_stability_before_unsupervised_spend]], [[feedback_priority_velocity_and_token_cost]].
