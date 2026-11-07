---
id: AISDLC-772
title: >-
  demo script and seeded demo repo for the hierarchy walkthrough video
status: To Do
assignee: []
created_date: '2026-10-09'
labels:
  - docs
  - demo
dependencies:
  - AISDLC-759
  - AISDLC-760
  - AISDLC-766
  - AISDLC-743
  - AISDLC-671
references:
  - docs/operations/cli-hierarchy.md
  - pipeline-cli/bin/cli-tui.mjs
  - pipeline-cli/bin/cli-hierarchy.mjs
  - ai-sdlc-plugin/commands/planner.md
  - ai-sdlc-plugin/commands/operator-dispatch.md
  - ai-sdlc-plugin/commands/executor.md
priority: high
dispatchable: true
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (decision rubric, planner session). Held on the board by its dependency on AISDLC-671 until that task lands.'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The operator is recording a screenshare video of the typical workflow: planner, dispatch brief, executor claims, three reviewers, attestation, merge. The video shows the three north-star features: the session hierarchy (`cli-hierarchy`, RFC-0051), the operator TUI (`pipeline-cli/bin/cli-tui.mjs`, RFC-0023) and the Claude Code context-meter mod (AISDLC-743). The recording must never wait on a real review round.

Deliverables: `docs/demo/walkthrough.md` (shot list with the exact commands per pane, timings and what the viewer should see), `scripts/demo/seed-demo-repo.sh` that creates a demo repo with 3 small self-contained tasks whose implementations are 10 to 30 lines and pass review on the first round, a tmux layout (or `cli-hierarchy terminals` output) for the panes, a reset script to return the demo repo to its start state, and a dry-run checklist.

Sequencing: the hierarchy idle and self-clear work (AISDLC-759, AISDLC-760, AISDLC-766), the context-meter mod (AISDLC-743) and the RFC-0051 results note (AISDLC-671) should land first so the recording shows shipped behaviour.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [ ] `scripts/demo/seed-demo-repo.sh` is idempotent (running it twice yields the same repo state).
- [ ] The full walkthrough completes in under 15 minutes wall-clock on the mock or real spawner, and the doc states which.
- [ ] Every command in the shot list exists on main (a test greps them).
- [ ] The reset script restores the start state (test).
- [ ] `docs/demo/walkthrough.md` names the three north-star features shown: hierarchy, operator TUI and context-meter mod.

## Ruling 2026-11-07 (operator, decision rubric)

`dispatchable: true`. AISDLC-671 was re-scoped on 2026-11-07 from an operator-run supervised hierarchy run to a dispatchable results note written from production logs (see the ruling recorded on AISDLC-671; it supersedes the 2026-10-30 non-dispatchable note here). The dependency on AISDLC-671 stays and keeps this task held on the board until that note lands; nothing else about the demo changes.
