---
id: AISDLC-1020
title: >-
  One review-ledger path helper everywhere, and a lint gate that bans hand-built `.ai-sdlc/reviews/` paths
status: To Do
assignee: []
created_date: '2026-10-22'
labels:
  - pipeline
  - root-cause
  - test-infra
dependencies:
  - AISDLC-1017
references:
  - pipeline-cli/src/attestation/reviews-ledger.ts
  - pipeline-cli/src/attestation/drop-chores.ts
  - pipeline-cli/src/next-step/ship.ts
  - docs/operations/attestation-reference.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context (RCA of the 2026-10-21 Step 10.5 outage).** The review ledger is written by `reviewsLedgerPath()` in `reviews-ledger.ts`, which lowercases the task id. Two other modules spell the same path by hand with the id as given (uppercase): the Step 10.5 stager in `ship.ts` (fixed by the hotfix task) and `isAttestationChorePath()` in `drop-chores.ts`, which compares a file name against `.ai-sdlc/reviews/${taskId}.jsonl`. The second one is still latent: an attestation chore commit that touches the ledger is not recognised as a chore path, so drop-chores can refuse to drop it or can drop the wrong set. The outage lasted a day because the mismatch was invisible until a hard-fail check landed on top of it.

**Root cause.** Two sources of truth for one path. Any module that builds the ledger path by string template is a future copy of this bug.

**Five-step review (requirements first).**
1. Requirement questioned: "each module knows where the ledger lives". Replaced by: exactly one function knows, and everything else calls it.
2. Delete: the template string in `drop-chores.ts` and any other `.ai-sdlc/reviews/${...}` literal found by the grep (the stager's own copy is deleted by the hotfix task).
3. Simplify: `isAttestationChorePath` compares against `reviewsLedgerPath(taskId, root)` made repo-relative; a `reviewsLedgerRelativePath(taskId)` helper is exported next to `reviewsLedgerPath` so callers never join paths themselves.
4. Accelerate: a lint test (`scripts/check-no-handbuilt-ledger-paths.test.mjs`, in `pnpm test`) fails on any source line under `pipeline-cli/src`, `orchestrator/src` or `ai-sdlc-plugin` containing the literal `.ai-sdlc/reviews/` outside `reviews-ledger.ts`, with the file and line in the message.
5. Automate: nothing beyond the lint test; it is deterministic and runs in every `pnpm test`.

**Velocity impact.** Neutral; removes one class of silent path bugs.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `reviews-ledger.ts` exports a repo-relative helper and `drop-chores.ts` uses it instead of a template string; a unit test with a mixed-case task id proves the chore path matches the lowercase ledger
- [ ] #2 `grep -rn '.ai-sdlc/reviews/' pipeline-cli/src orchestrator/src ai-sdlc-plugin --include=*.ts --include=*.js --include=*.mjs` returns only `reviews-ledger.ts` lines and test fixtures
- [ ] #3 A lint test in `pnpm test` fails with file and line when a new hand-built `.ai-sdlc/reviews/` literal appears in non-test source
- [ ] #4 `docs/operations/attestation-reference.md` names the helper as the only way to locate the ledger
- [ ] #5 The task body names the five steps (requirement questioned, delete, simplify, accelerate, automate)
<!-- AC:END -->

## Verification

- `pnpm build && pnpm test && pnpm lint && pnpm format:check`
