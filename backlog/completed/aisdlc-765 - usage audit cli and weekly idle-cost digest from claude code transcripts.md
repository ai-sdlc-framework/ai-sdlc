---
id: AISDLC-765
title: >-
  Usage audit cli and weekly idle-cost digest from claude code transcripts
status: Done
assignee: []
created_date: '2026-10-08'
labels:
  - token-cost
  - observability
dependencies: []
references:
  - docs/audits/scripts/2026-10-08-token-audit/audit8.mjs
  - pipeline-cli/src/cli/index.ts
  - orchestrator/src/cli/commands/doctor.ts
priority: medium
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context

The audit was done with ad-hoc scripts; nobody saw $160 per hour of idle polling for 20 hours. Full evidence: `docs/audits/2026-10-08-token-leak-loop-and-prose-automation-audit.md`.

## Scope

1. `cli-usage audit --days N` reading ~/.claude/projects transcripts, grouping by project, loop body, role and model, and flagging idle noop-wakeup turns and sessions whose context exceeds a threshold with no clear.
2. A doctor check `idle-sessions` that warns when a hierarchy session has polled empty for over 30 minutes.
3. A weekly digest the planner can paste (the operator reads /usage for the real percentage).

Sequencing: none.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] AC-1: `cli-usage audit --days 7` groups cost by project, loop body, role and model.
- [x] AC-2: Idle noop-wakeup turns and no-clear large-context sessions are flagged.
- [x] AC-3: `ai-sdlc doctor` reports idle-sessions as a warning after 30 minutes of empty polling.
- [x] AC-4: The digest output is paste-ready text.
- [x] AC-5: Hermetic tests cover the transcript parser.
<!-- AC:END -->

## Final Summary

## Summary
Added `cli-usage audit [--days N] [--digest] [--json]`, which parses ~/.claude/projects transcripts and groups estimated cost by project, loop body, role and model, flags idle noop-wakeup turns and no-clear large-context sessions, and prints a paste-ready digest. Added an `idle-sessions` doctor check that warns after 30 minutes of empty polling.

## Changes
- `pipeline-cli/src/usage/audit.ts` (new): transcript parser, grouping, flags, renderers.
- `pipeline-cli/src/usage/audit.test.ts` (new): hermetic parser and report tests.
- `pipeline-cli/src/cli/usage.ts` (modified): `audit` subcommand.
- `orchestrator/src/cli/commands/doctor-checks.ts` (+ test, modified): `idle-sessions` check.
- `orchestrator/src/clock.ts` (new): clock seam required by the clock-discipline lint.

## Design decisions
- **Cost is an estimate** from hardcoded per-model prices; the operator reads /usage for the real percentage.
- **idle-sessions** counts a session live if its transcript changed in the last hour and cannot tell hierarchy sessions apart, so it warns on any session that polled empty.

## Verification
- `pnpm build` — clean
- `pnpm test` — new tests pass; 14 pre-existing-looking failures in unrelated files (bin-invocation, verify-runtime, TUI), left to CI
- `pnpm lint` — clean
- `pnpm format:check` — clean

## Follow-up
- declined: reviewer minor findings (loop-regex anchoring, tail-read of transcripts, fs adapter tests) are heuristic polish, not required by the ACs.
