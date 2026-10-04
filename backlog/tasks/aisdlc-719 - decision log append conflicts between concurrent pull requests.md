---
id: AISDLC-719
title: >-
  Decision log append conflicts between concurrent pull requests
status: To Do
assignee: []
created_date: '2026-10-04'
labels:
  - governance
  - tooling
dependencies: []
references:
  - .ai-sdlc/_decisions/events.jsonl
  - pipeline-cli/bin/cli-decisions.mjs
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Every pull request that records a decision appends to `.ai-sdlc/_decisions/events.jsonl`.
Two open pull requests that both append conflict as soon as one merges, and a filing branch
cannot be rebased under the lease-push guard, so on 2026-10-04 several filing pull requests
had to be consolidated by hand.

## Conventions
- Hermetic `node --test` tests; temporary directories come from `mkdtemp`, never a shared
  `/tmp` path.

## Acceptance Criteria
- [ ] Decisions recorded in concurrent pull requests merge without conflict (for example one event file per decision under `.ai-sdlc/_decisions/events/` with the existing log as a derived or legacy-read view, or another design with the same property).
- [ ] `cli-decisions` reads both layouts and writes the new one.
- [ ] Migration keeps existing ids and history.
- [ ] Ids are allocated so two open pull requests cannot pick the same DEC id (for example a reserved-id check against open pull requests, or ids derived from the pull request).
- [ ] Tests cover two branches each adding a decision merging cleanly in either order.
- [ ] The pull request body carries a "Velocity impact" section.

## Out of scope
- Changing decision semantics.
<!-- SECTION:DESCRIPTION:END -->
