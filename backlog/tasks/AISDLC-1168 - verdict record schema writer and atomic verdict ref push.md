---
id: AISDLC-1168
title: 'RFC-0061 Phase 1: verdict record schema, Step 8 writer and atomic verdict ref push from Step 11'
status: To Do
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - pipeline-cli
  - phase-1
dependencies: []
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - pipeline-cli/src/steps/08-aggregate-verdicts.ts
  - pipeline-cli/src/next-step/ship.ts
  - pipeline-cli/src/attestation/verdict-class.ts
  - pipeline-cli/src/attestation/reviews-ledger.ts
priority: high
dispatchable: true
---

## Description

Implements RFC-0061 OQ-1, OQ-4a, OQ-6 and the OQ-8 fence (see the Resolution blocks in the RFC).

**Scope.**
1. Schema `ai-sdlc/review-verdict/v1` (zod) as in the RFC's Schema Changes section: `subject` (headSha, treeSha, baseSha, repository, pullRequest), `verdict`, `reviewers[]` (name, harness, model, `independenceTier` with the shipped values `none | attested | isolated`, verdict), `coverage` (policy ref, required, satisfied), `evidence` (`leaves.jsonl` plus sha256 digest), `issuedBy` (`pipeline-step-11` or `ci-clean-room`), `carriedForwardFrom`.
2. **One coverage rule** (RFC goal 5, closes P4): a single pipeline-cli function computes the reviewer set the review policy requires for the touched paths. Step 8 evaluates it once and copies the result into the record; the checker (AISDLC-1169) imports the same function and never recomputes by a different rule.
3. Step 8, on `approved`, builds the record. `independenceTier` comes from the existing derivation in `verdict-class.ts`, run once here (OQ-6).
4. Step 11 writes a tree holding `record.json` and `leaves.jsonl` (plain JSONL, no Merkle construction) to a commit, and pushes the task branch and `refs/ai-sdlc/verdicts/<headSha>` in one `git push --atomic`. The v6 envelope path keeps running beside it during the shadow phase.
5. **OQ-8 fence:** a PreToolUse hook refuses agent sessions any push naming `refs/ai-sdlc/verdicts/*` and any `gh api` status post with the gate's context, except the Step 11 ship step's own push.
6. A pruning policy for the namespace: a `cli-attestation` subcommand that deletes verdict refs whose PR is closed or merged and older than a configurable age (default 30 days); not scheduled by this task.

**Out of scope:** the CI check (AISDLC-1169), carry-forward (AISDLC-1170), untrusted PRs (AISDLC-1171).

## Acceptance Criteria

- [ ] AC-1: Schema validates the RFC sketch with shipped tier values and rejects other tier values. Unit test.
- [ ] AC-2: Step 8 writes a record whose `coverage` comes from the shared function; a test asserts writer and checker import the same function.
- [ ] AC-3: Step 11 pushes the branch and verdict ref atomically: if either ref is rejected, neither updates. Integration test against a local bare remote.
- [ ] AC-4: The verdict ref's tree contains exactly `record.json` and `leaves.jsonl`, and the record's digest matches `leaves.jsonl`.
- [ ] AC-5: The hook denies an agent-session push to `refs/ai-sdlc/verdicts/x` and a status post with the gate context, and allows the ship step. Hook tests with `node --test`.
- [ ] AC-6: The prune subcommand deletes only refs of closed or merged PRs past the age. Unit test with a mocked PR state.
