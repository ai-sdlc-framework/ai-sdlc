---
id: AISDLC-1116
title: docs-only classifier counts review logs and transcript leaves as code, so docs PRs run the code gate and fail the reviewers check
status: To Do
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

- [ ] AC1: `node scripts/is-docs-only-changeset.mjs` on the file list of #2108 prints `docs-only`.
- [ ] AC2: a changeset containing `.ai-sdlc/reviews/<x>.jsonl` plus `pipeline-cli/src/<y>.ts` prints `code`.
- [ ] AC3: the workflow `paths-ignore` mirrors and the script agree (existing or new lockstep test passes).
- [ ] AC4: `scripts/check-pr-governance.mjs` `reviewers` check passes on a docs-only attestation carrying `[correctness-reviewer]` for such a changeset (unit test with a fixture).
- [ ] AC5: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Out of scope

Changing which reviewer set a docs PR needs; re-running or re-arming the three affected PRs (dispatch does that after this lands).
