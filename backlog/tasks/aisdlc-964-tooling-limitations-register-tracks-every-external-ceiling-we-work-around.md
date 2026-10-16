---
id: AISDLC-964
title: 'A tooling-limitations register tracks every external ceiling (GitHub API, gh, git, Actions) we work around, with its headroom metric'
status: To Do
assignee: []
created_date: '2026-10-16'
labels:
  - docs
  - observability
  - cost
dependencies: []
references:
  - docs/operations/cli-hierarchy.md
  - pipeline-cli/src/hierarchy/status.ts
priority: high
dispatchable: true
---

## Description

The gate went down for part of every hour on two consecutive days because the Actions token bucket (1,000 requests per hour per repository) and the operator user token (5,000 per hour) were exhausted. Neither limit is ours; both are ceilings of the tooling the framework depends on, and every fix we ship works around them rather than removing them. Nothing records that. The same is true of other ceilings already met and worked around in passing: the GraphQL points budget and its secondary limits (a `gh pr list` refused while `rate_limit` still shows thousands remaining), the search API at 30 per minute, `gh run rerun` accepting only a run id, git loose-object growth that stops automatic gc in the parent checkout, and eighty worktrees under one repository. Anthropic's engineering post on redesigning source control (https://www.anthropic.com/engineering/redesigning-source-control) describes building custom tooling around git limitations at scale; adopters running many concurrent agents on one codebase, in particular enterprise organisations, will meet the same ceilings earlier than we do and need to see where they are.

**Five-step review (requirements first).**
1. Requirement questioned: is a document the right artifact, or should every ceiling be code? Both: the register is the index, and each entry points at the instrumentation that measures its headroom and the workaround that holds it off.
2. Delete: nothing to delete; the knowledge currently lives in handoff memory lines and task bodies, which are not findable.
3. Simplify: one page, `docs/operations/tooling-limitations.md`, one table row per ceiling: tool and limit, the symptom when hit, the headroom metric and where it is read (the gh-call log, `cli-hierarchy status`, the gate job summary), the workaround, and a scaling note (per-user, per-installation or per-repository; enterprise cloud tiers).
4. Accelerate: `cli-hierarchy status` prints the headroom of every instrumented ceiling so the register's numbers are live, not copied.
5. Automate: a test asserts every row names an existing instrumentation surface or is marked "unmeasured"; the SessionStart banner links the page when any headroom is below its floor.

## Acceptance Criteria

- [ ] `docs/operations/tooling-limitations.md` exists with at least these rows: GitHub user token core and GraphQL budgets, secondary limits, Actions GITHUB_TOKEN per repository (and the enterprise tier), search API, `gh run rerun` argument shape, git loose-object gc stall, worktree count per repository.
- [ ] Each row names its headroom metric and where it is read, or is marked unmeasured.
- [ ] `CLAUDE.md` carries one pointer line to the page (within the size budget).
- [ ] A test keeps the rows and their instrumentation pointers consistent.
