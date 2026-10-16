---
id: AISDLC-867
title: 'ci: records-only fast lane in ai-sdlc-gate.yml, PRs touching only backlog/**, .ai-sdlc/_decisions/**, spec/** skip build/test/attestation'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [ci, velocity, gate]
dependencies:
  - AISDLC-534.1
references:
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - scripts/is-docs-only-changeset.test.mjs
  - pipeline-cli/attestation-core/review-scope-core.mjs
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Context

24-hour drain analysis (2026-10-14): 33 of 63 merges were record PRs (task files, decision events, RFC text), each consuming a 6 to 15 minute full gate run; 14 failed and 38 were cancelled out of 100 gate runs. Operator decision 2026-10-14 (planner rubric): a fast lane was chosen over a rolling daily record PR because records are authority only once they are on `main` (DEC-0039), so batching them delays authority.

Existing state to verify first: `scripts/is-docs-only-changeset.mjs` already treats `spec/rfcs/**`, `docs/**`, `backlog/tasks/**`, `backlog/completed/**` and `.ai-sdlc/_decisions/**` as docs-only, and `ai-sdlc-gate.yml` already skips build-test, integration and attestation for `docs_only`. Before building a new class, find out why record PRs still ran 6 to 15 minutes (candidates: `backlog/**` paths outside tasks and completed, `spec/**` outside `spec/rfcs`, `.ai-sdlc/**` files not under `_decisions`, jobs that run regardless such as CodeQL and Coverage, or `docs_only` computed false because of a stray file). The records-only class below is the deliverable only for the gap that investigation confirms; record the finding in the PR body.

## Fix

**Five-step review (requirements first).** Requirement questioned: "does a JSONL append need the test suite?" For a diff confined to records it does not. Deleted: the Build & Test, Coverage, CodeQL and attestation jobs for that class of diff. Simplified: extend the one classifier (AISDLC-534.1 makes it the single source of truth) with a `records-only` class instead of adding a second path list in the workflow. Accelerated: record PRs reach `ai-sdlc/pr-ready` in the time of the cheap checks. Automated: the rollup stays the single required check and still posts, so branch protection and auto-merge are unchanged.

- Extend the classifier to emit a class (`code`, `docs-only`, `records-only`) with the allowlist `backlog/**`, `.ai-sdlc/_decisions/**`, `spec/**`. Keep the verifier-shared copy in `pipeline-cli/attestation-core/review-scope-core.mjs` in lockstep.
- In the fast lane still run: Backlog Drift, DoR readiness, governance-gate, rfc-check, `format:check`. Skip: Build & Test, Coverage, CodeQL, attestation.
- `ai-sdlc/pr-ready` still posts in every lane.
- A diff with ANY path outside the allowlist takes the slow lane; the match is exact (path-prefix allowlist, no globbing past the prefix), proved with fixtures for mixed diffs.

## Acceptance Criteria

- [x] AC-1: classifier unit tests cover records-only, mixed (one record file plus one code file, one record file plus one workflow file), docs-only, code, and empty input.
- [x] AC-2: a workflow test in `.github/workflows/__tests__/` asserts which jobs the fast lane runs and skips and that `ai-sdlc/pr-ready` still posts.
- [x] AC-3: `docs/operations/quality-gate.md` documents the records-only lane and its allowlist.
- [x] AC-4: the PR body records the investigation result from Context (why record PRs were slow) and the measured gate time for a records-only PR.
- [x] AC-5: the lockstep test between the script and `review-scope-core.mjs` stays green.

## Velocity impact

Positive: about half of all merges drop from a 6 to 15 minute full gate to the cheap checks, and cancelled or failed full runs stop blocking record PRs. Risk: a records-only PR that smuggles code is prevented by the exact allowlist and mixed-diff tests.

## Out of scope

The dependabot attestation exemption (DEC-0213); changes to which checks are required in branch protection.
