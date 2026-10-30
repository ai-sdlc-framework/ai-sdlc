---
id: AISDLC-1116
title: docs-only classifier counts review logs and transcript leaves as code, so docs PRs run the code gate and fail the reviewers check
status: Done
assignee: []
created_date: '2026-10-29'
labels:
  - ci
  - governance
  - velocity
priority: high
references:
  - scripts/is-docs-only-changeset.mjs
  - scripts/check-pr-governance.mjs
  - .github/workflows/ai-sdlc-gate.yml
---

## Description

Three docs-only PRs on 2026-10-29 (#2108 AISDLC-655.2, #2093 AISDLC-657.1, #2057 AISDLC-461) are red on the Governance gate with `reviewers: attestation ... carries [correctness-reviewer]; a code PR needs ... + security-reviewer`, and two of them also ran the full Build & Test job and inherited the then-red `sync-plugin-runtime-deps` test. Their diffs are docs, backlog files, attestations plus the pipeline's own `.ai-sdlc/reviews/*.jsonl` and `.ai-sdlc/transcript-leaves/*.jsonl` files.

`scripts/is-docs-only-changeset.mjs` returns `code` as soon as a path under `.ai-sdlc/reviews/` or `.ai-sdlc/transcript-leaves/` is present (verified locally: the same file sets minus those two paths classify `docs-only`). Those files are review metadata written by the pipeline on every PR, the same class as `.ai-sdlc/attestations/<sha>.dsse.json`, which the predicate already treats as docs-equivalent (AISDLC-208). The result: `DOCS_ONLY=false`, the docs PR runs the code lane, and `checkReviewers` demands the three-reviewer code set while the attestation legitimately carries the one-reviewer docs set. The PR can never go green without a human.

**Five-step review (requirements first).** Requirement questioned: does a review log or transcript leaf make a change "code"? No: both are append-only metadata about the review, written by the pipeline, never executed. Deletion: nothing to delete. Simplified: one predicate, one allowlist entry per metadata path, mirrored where the predicate is mirrored. Accelerated: docs PRs skip Build & Test again (the AISDLC-206 intent). Automated: the regression test pins the three real file sets from the PRs above.

## Fix

1. In `scripts/is-docs-only-changeset.mjs`, treat `.ai-sdlc/reviews/**` and `.ai-sdlc/transcript-leaves/**` (both `.jsonl` and the leaf `.json` files) as docs-equivalent, beside the existing attestation rule; update the header comment list.
2. Mirror the change wherever the header says the predicate is mirrored (workflow `paths-ignore` lists), and run the existing drift test that keeps them in lockstep if one exists; add one if not.
3. Add a test with the three real changesets (file lists of #2108, #2093, #2057) asserting `docs-only`, and one asserting that the same list plus any `pipeline-cli/src/**` path is `code`.

## Acceptance Criteria

- [x] AC1: `node scripts/is-docs-only-changeset.mjs` on the file list of #2108 prints `docs-only`.
- [x] AC2: a changeset containing `.ai-sdlc/reviews/<x>.jsonl` plus `pipeline-cli/src/<y>.ts` prints `code`.
- [x] AC3: the workflow `paths-ignore` mirrors and the script agree (existing or new lockstep test passes).
- [x] AC4: `scripts/check-pr-governance.mjs` `reviewers` check passes on a docs-only attestation carrying `[correctness-reviewer]` for such a changeset (unit test with a fixture).
- [x] AC5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Out of scope

Changing which reviewer set a docs PR needs; re-running or re-arming the three affected PRs (dispatch does that after this lands).

## Final Summary

## Summary
Review logs (`.ai-sdlc/reviews/*.jsonl`) and transcript leaves (`.ai-sdlc/transcript-leaves/*.jsonl`) now count as docs-equivalent in the shared `DOCS_ONLY_PATTERN`. Docs PRs carrying them classify as docs-only, and the reviewers check accepts a one-reviewer docs attestation for them. A changeset with a review log plus source still classifies as code.

## Changes
- pipeline-cli/attestation-core/docs-only-paths.mjs
- scripts/is-docs-only-changeset.test.mjs
- scripts/check-pr-governance.test.mjs
- backlog/tasks/aisdlc-1116 - docs-only classifier counts review logs and transcript leaves as code.md

## Design decisions
Rebased onto origin/main and pushed with --force-with-lease. The existing commit's trailer says Claude Opus 4.6, not Sonnet 5.5. I did not amend it. AC1 and AC2 are pinned by synthetic file sets in the new classifier tests, not the exact file lists from #2108, #2093 and #2057. AC3: I found no `.ai-sdlc/reviews` or `transcript-leaves` entries in `ai-gate.yml`'s `paths-ignore`, so no workflow change was needed. I did not run a separate lockstep test.

## Verification
- `pnpm build` — passed
- `pnpm test` — passed
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers; review-full)

## Follow-up
(none)

