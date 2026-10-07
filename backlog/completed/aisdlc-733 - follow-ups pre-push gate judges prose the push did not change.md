---
id: AISDLC-733
title: >-
  Follow-ups pre-push gate judges prose the push did not change
status: Done
assignee: []
created_date: '2026-10-05'
labels:
  - gates
  - friction
dependencies: []
references:
  - scripts/check-followups-on-push.sh
  - scripts/check-followups.test.mjs
priority: high
dispatchable: true
updated_date: '2026-10-07 17:28'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Tier 1 friction. On PR #1214 (AISDLC-712) the gate (`scripts/check-followups-on-push.sh`, from AISDLC-645) refused a push because seven completed task files were touched only to fix dead script references (AISDLC-125, 148, 378, 383.5, 645, 706, 712). It then evaluated their pre-existing "Follow-up" sections. The push went through with the documented `AI_SDLC_SKIP_FOLLOWUP_GATE=1`, disclosed.

Same defect class as the old readiness range gate (DEC-0048): a gate must not fire on content the branch did not change. This task removes friction.

## Acceptance Criteria
- [x] The gate evaluates only follow-up items that the pushed commits add or change.
- [x] A completed task file touched outside its Follow-up section passes.
- [x] Test fixtures for both cases (item added or changed is judged; unrelated edit passes) in `scripts/check-followups.test.mjs`.
- [x] The refusal message names the item and the two accepted fixes.

## Velocity impact
Prevents the gate from refusing pushes for prose the branch did not touch. The happy path gets zero new prompts and fewer refusals than today. When the gate does refuse, it names the specific item and the two accepted fixes, so the agent fixes it in one step with no skip variable.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

## Summary
The pre-push follow-up gate now judges only follow-up items the push adds or changes. In range mode, `check-followups.mjs` compares each added, modified or renamed completed task against the range base and drops violations that already failed there.

## Changes
- `scripts/check-followups.mjs` (modified): range mode reads the base version (`git show <base>:<path>`, rename-aware via `--name-status -M`) and filters inherited violations by item text; `--task` mode unchanged.
- `scripts/check-followups.test.mjs` (modified): new suite for a legacy file touched outside Follow-up (passes), added item, changed item, new file, rename, and refusal text naming the item and both fixes.

## Design decisions
- **Item-text matching against the base**: simple and fail-closed. A missing base file (added) judges every item. Duplicate identical bad items are treated as inherited (accepted edge case).
- **Refusal message unchanged**: the shared formatter already quotes the item and lists cite-a-task-id and declined: fixes.

## Verification
- `pnpm build` — clean
- `pnpm test` — scripts tests 20/20; pipeline-cli has 14 failures in files this change does not touch (attestation/verify-runtime, cli/bin-invocation, tui), environment-dependent
- `pnpm lint` — clean
- `pnpm format:check` — clean
- 3 reviewers approved (code and test on Claude-native after Codex hit its usage limit; security on Claude)

## Follow-up
(none)
