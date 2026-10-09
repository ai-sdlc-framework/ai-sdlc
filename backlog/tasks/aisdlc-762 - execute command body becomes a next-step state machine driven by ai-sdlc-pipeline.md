---
id: AISDLC-762
title: >-
  Execute command body becomes a next-step state machine driven by ai-sdlc-pipeline.md
status: To Do
assignee: []
created_date: '2026-10-08'
labels:
  - pipeline
  - token-cost
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/src/steps/
  - pipeline-cli/src/cli/index.ts
  - pipeline-cli/README.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

execute.md is 2,041 lines (142 KB, about 35k tokens loaded per executor session); about 1,300 lines re-narrate steps that pipeline-cli/src/steps already implements. A task costs about 160 LLM round-trips of orchestration (about $29 API weight) against about $25 of developer and reviewer work. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. Add `ai-sdlc-pipeline next-step --task <id> --state <file>` that runs every deterministic step itself and returns a small JSON instruction only when an LLM action is needed (spawn developer with prompt file X; spawn reviewer set Y with prompt files; iterate; done with PR url).
2. The slash body becomes a loop of: call next-step, perform the one instruction, report the result, in under 250 lines.
3. The review-prepare and review-finalize wrappers (classifier gate, incremental-review gate, leaf emission, transcript persistence) are part of this.

Sequencing: none, but AISDLC-761 is cheaper to land first (related: AISDLC-761).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] AC-1: execute.md is 250 lines or fewer.
- [ ] AC-2: One task run makes 15 or fewer orchestration LLM calls plus the agents.
- [ ] AC-3: Step tests cover the state machine.
- [ ] AC-4: Attestation and governance behaviour are unchanged; existing verify tests pass.
<!-- AC:END -->
