---
id: AISDLC-916
title: 'fix: envelope formatter counts the key prefix in its line width and applied reviewers are a set'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [bug, attestation, pipeline-cli, velocity]
dependencies: []
references: [pipeline-cli/src/attestation/format-json.ts, pipeline-cli/src/attestation/format-json.test.ts, pipeline-cli/src/attestation/review-scope.ts, pipeline-cli/src/attestation/review-scope.test.ts, pipeline-cli/src/attestation/sign-v6.ts]
priority: high
dispatchable: true
---

## Description

Two executor PRs on 2026-10-15 went red on Lint & Format only, both on the freshly signed v6 envelope under `.ai-sdlc/attestations/`, each costing a resume round. Prettier's diff is one line in both: `"appliedReviewers": ["correctness-reviewer", "security-reviewer", "correctness-reviewer", "security-reviewer"]` (114 columns), which prettier breaks one element per line. Two defects combine:

1. `formatEnvelopeJson` (`format-json.ts`, `fmt`) decides whether an array stays on one line from `pad + flat(v) + trailing <= PRINT_WIDTH`, which ignores the `"key": ` prefix of the enclosing object property (22 columns here). Prettier measures the whole line. Any array value whose flat form sits between `PRINT_WIDTH - prefix` and `PRINT_WIDTH` is formatted wrong; the previous fix (AISDLC-732) only tested short arrays.
2. `reviewScope.appliedReviewers` (`review-scope.ts:108`, `[...reviewerNames]`) repeats a reviewer for every review round, so an iterate round doubles the list and pushes it past the width. The field names which reviewers were applied; it is a set.

## Fix

**Five-step review (requirements first).** 1. Requirement questioned: that the signer must reproduce prettier byte for byte without depending on prettier. Kept: adopter repos run their own prettier on commit and the plugin signer must not require a devDependency, so the emulation stays and must be exact for the shapes we emit. 2. Deleted: nothing to delete. 3. Simplified: `fmt` takes the number of columns already used on the line (the key prefix, or 0 at array top level) and adds it to the width check; `appliedReviewers` becomes `[...new Set(reviewerNames)]` in input order. 4. Accelerated: no more prettier-only resume rounds on executor PRs. 5. Automated: a `format-json.test.ts` property test formats generated envelopes with real prettier (devDependency, test only) and asserts byte equality, including a reviewer array that lands at 99, 100 and 101 columns with its prefix; `review-scope.test.ts` asserts a repeated reviewer name is recorded once.

## Acceptance Criteria

- [ ] `formatEnvelopeJson` output equals `prettier --parser json` output (printWidth 100) for an envelope whose `appliedReviewers` flat form is 99, 100 and 101 columns including the `"appliedReviewers": ` prefix and indentation.
- [ ] `appliedReviewers` lists each reviewer once, in first-seen order, when the same reviewer runs in several rounds.
- [ ] The two envelope files from the reporting PRs (#1571 and #1585, `.ai-sdlc/attestations/ac0b2b2b….v6.dsse.json` and `11963cb6….v6.dsse.json`) are formatted identically by the fixed function and by prettier.
- [ ] `pnpm format:check` passes on a freshly signed envelope in the PR's own CI run.
- [ ] Task file moved to `backlog/completed/` in the PR.

## Notes

Unblocking the two red PRs does not wait for this task: whitespace does not change the DSSE signature (it signs the base64 payload) and `.ai-sdlc/attestations/` is excluded from the patch id, so a `prettier --write` commit on the envelope is a valid resume. AISDLC-875 (#1568) fixed only the mcp-tarball writer and is unrelated to this width defect.
