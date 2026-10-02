---
id: AISDLC-657.3
title: >-
  RFC-0050 follow-up: the adopter scaffold and runtime gitignore lists include .ai-sdlc/artifacts
status: To Do
assignee: []
created_date: '2026-10-02'
labels:
  - rfc-0050
  - orchestrator
  - adopter
dependencies:
  - AISDLC-657.2
references:
  - spec/rfcs/RFC-0050-usage-ledger-and-model-routing.md
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/execute.ts
  - docs/operations/model-routing.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Found during the AISDLC-657.2 security review (PR #1153), operator-approved for
filing 2026-10-02. AISDLC-657.2 makes `.ai-sdlc/artifacts` the shared runtime output
directory of the resolver, the scorecard and the replay commands. This repository
ignores it through its own root `.gitignore`, but the adopter scaffold does not: the
`GITIGNORE_PATHS` list in `orchestrator/src/cli/commands/init.ts` and the
`RUNTIME_GITIGNORE_PATHS` list in `orchestrator/src/execute.ts` cover only
`.ai-sdlc/state.db`, `.ai-sdlc/state/` and `.ai-sdlc/audit.jsonl`. An adopter who
runs the scorecard or a replay would commit evidence files, assignment logs and
replay results. This should land before the routing commands are promoted to adopters
(AISDLC-657.1).

## Conventions
- TypeScript strict, ESM, `.js` import extensions, Vitest, 80% line coverage on new code.
- Keep the two lists in agreement; prefer one shared constant if the import graph
  allows it without a new package dependency.

## Scope
1. Add `.ai-sdlc/artifacts/` to both ignore lists, under the existing
   `# ai-sdlc:runtime-gitignore` sentinel block so repositories initialised earlier
   gain the entry on the next `execute` run.
2. `doctor` reports a missing `.ai-sdlc/artifacts/` ignore entry with the same
   severity as the existing runtime-path checks.
3. The model-routing runbook's "gitignored in this repository" sentence becomes
   "ignored by the scaffold".

## Acceptance Criteria
- [ ] `init` on an empty directory writes a `.gitignore` containing `.ai-sdlc/artifacts/`.
- [ ] `execute` on a repository whose sentinel block lacks the entry appends it once and does not duplicate it on a second run.
- [ ] `doctor` flags a `.gitignore` without the entry and is quiet with it.
- [ ] The runbook sentence is updated.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->
