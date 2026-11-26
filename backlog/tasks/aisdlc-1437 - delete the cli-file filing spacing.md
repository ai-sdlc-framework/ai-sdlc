---
id: AISDLC-1437
title: "Delete the cli-file filing spacing (AISDLC-986) and the dead filing queue"
status: To Do
priority: high
labels:
  - pipeline-cli
  - delete
dependencies: []
references:
  - pipeline-cli/src/cli/file-pacing.ts
  - pipeline-cli/src/cli/file-pacing.test.ts
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/file.test.ts
  - docs/operations/tooling-limitations.md
  - docs/operations/pre-push-and-ci-reference.md
  - docs/operations/incidents/README.md
  - docs/operations/incidents/2026-10-15-installation-api-quota-exhaustion.md
  - backlog/tasks/aisdlc-1415 - cli-file queues paced filings by default and the host runs them.md
  - backlog/tasks/aisdlc-1414 - command and gate timing telemetry with a slow-command report.md
---

## Description

**Five-step review (requirements first).**
1. Question: operator ruling 2026-11-26 after a planner audit: DEC-0426 is answered d ("remove the spacing"), superseding c. `cli-file ... --pr` (and `cli-decisions --file --pr`, which goes through it) waits up to 15 minutes after the previous filing PR (`file-pacing.ts`, `paced()` in `file.ts` ~1036). Audit findings: no operator request or decision record authorized AISDLC-986; the 15-minute figure had no basis; `paceFiling` reads `gh api rate_limit` with the local operator token and prints it as the CI "installation bucket" (`file-pacing.ts:33`, `:108`), and never uses it to decide (`:111`); the 2026-10-15 incident's root cause (workflow fan-out x push rate x reruns) was addressed by DEC-0250 and the AISDLC-867 records-only fast lane (`ai-sdlc-gate.yml:189`). The `--queue` path writes briefs to `.ai-sdlc/dispatch/queued-filings/` that nothing reads. Operator principle: a limitation of an underlying dependency is handled where the cost arises (cheaper calls, handling the rate-limit error, rerun after reset), never by a blanket self-throttle that taxes all throughput.
2. Delete: `file-pacing.ts` and its test; the `paced()` helper, `pacingOptions` (`--queue`, `--spacing-minutes`), the `recordFiling` call, the argv scrub for those flags and the `AI_SDLC_FILE_SPACING_MINUTES` handling in `file.ts`; their cases in `file.test.ts`. The doc rows and pointers that describe the spacing (`tooling-limitations.md` installation-bucket row, `pre-push-and-ci-reference.md` ~line 37, `incidents/README.md` ~line 45, the incident doc's follow-up line: rewrite it to say the spacing was removed by DEC-0426 d). Move AISDLC-1415 to `backlog/completed/` with a note that it is superseded by DEC-0426 d (not built). Remove the spacing mention from AISDLC-1414 if it depends on it.
3. Simplify: no replacement throttle, no quota-reading wait. Passing `--queue` or `--spacing-minutes` after the deletion is refused by yargs strict mode as an unknown option (or, if the command is not strict, ignored); state which in the PR body.
4. Accelerate: none.
5. Automate: none.

## Acceptance Criteria
- [ ] #1 `cli-file task <file> --pr` run twice back to back opens both PRs with no wait; a test covers this (two filings, no sleep, no `rate_limit` call).
- [ ] #2 `pipeline-cli/src/cli/file-pacing.ts` and its test are gone; `git grep -E "file-pacing|FILE_SPACING|spacing-minutes|spacingMinutes|queued-filings|last-filing"` outside `backlog/completed`, CHANGELOG files and `.ai-sdlc/_decisions` returns nothing.
- [ ] #3 The listed docs no longer describe a filing spacing; the incident doc records that the spacing was removed by DEC-0426 d.
- [ ] #4 AISDLC-1415 is in `backlog/completed/` marked superseded by DEC-0426 d.
- [ ] #5 `pnpm dark-code:check` passes (no orphaned module left behind).
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
