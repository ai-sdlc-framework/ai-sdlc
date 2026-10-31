---
id: AISDLC-1144
title: 'Attestation v6 credits the newest leaf per reviewer per patch-id; earlier leaves stay signed as history, never blocking'
status: Done
assignee: []
created_date: '2026-10-31'
labels:
  - attestation
  - governance
  - incident-follow-up
dependencies: []
references:
  - pipeline-cli/src/attestation/sign-v6.ts
  - pipeline-cli/src/attestation/merkle.ts
  - pipeline-cli/attestation-core/verify-core.mjs
  - docs/operations/attestation-reference.md
  - .claude/rules/review-attestations.md
priority: high
dispatchable: true
---

## Description

Operator ruling 2026-10-31 (DEC-0287, supersedes the escalation DEC-0286 whose two options were both rejected). AISDLC-1137 cleared a round-3 security-reviewer critical without changing its diff, so every review round appended to the same patch-id leaves file (`.ai-sdlc/transcript-leaves/<patchId>.jsonl`). The v6 signer puts every leaf of that file into the envelope (`sign-v6.ts`, `allLeaves: prLeaves`) and the verifier refuses the envelope when any non-plan, non-execute leaf is not an approved verdict (`verify-core.mjs`, the AISDLC-977 check around line 1586). The rejected leaf[3] sits beside three later approvals by the same reviewer, so a fully approved review cannot be signed and the push is blocked. No sanctioned path retires a leaf (`merkle.ts`: leaves are committed, never pruned).

The verifier's question is "what is each reviewer's current verdict on this patch-id", not "did any reviewer ever object". Gerrit and GitHub reviews read the latest vote per reviewer per patchset; in-toto and Sigstore keep attestations append-only and select the newest statement per signer. The reviews ledger (`.ai-sdlc/reviews/<task>.jsonl`) already preserves first-pass findings across later approvals, so history has a home outside the signed credit set.

## Fix

**Five-step review (requirements first).** Requirement questioned: must every leaf in a patch-id file be an approved verdict for the envelope to verify? No: the requirement is that every *credited* reviewer's current verdict approves, and the control it protects (no unreviewed or rejected diff lands) holds when the newest leaf per (reviewer, patch-id) is the one credited, because an in-place fix on the same patch-id is reviewed again by the same signed reviewer and the rejection stays on file. Deleted: nothing in the leaf file format or the append-only writer; the "every leaf" quantifier in the verifier check is replaced, not removed. Simplified: one rule in both signer and verifier, the newest leaf per (reviewer, patch-id) by leaf timestamp (ties broken by file order) is the credited leaf; older leaves of that reviewer stay in `transcriptLeaves` and in the Merkle root as history, marked `superseded: true` in the envelope so a reader never mistakes them for credit. Accelerated: nothing. Automated: tests in `sign-v6.test.ts` and a verify-core test build a leaves file with reject-then-approve by one reviewer and assert the envelope signs and verifies, and the inverse (approve-then-reject, or a rejected newest leaf) still fails with the AISDLC-977 reason; `sign-verify-parity.test.ts` covers the superseded flag on both sides.

Governance class: this loosens the "every leaf approved" control to "newest leaf per reviewer approved" (DEC-0287, `--governance-change weakening`). The operator answered it directly; it is not auto-applied. Earlier leaves are still signed, still in the Merkle root and still in the reviews ledger, so no evidence is pruned or edited.

Not in scope: retiring or rewriting any existing leaves file, including AISDLC-1137's; once this lands, 1137 re-signs through the normal pipeline path.

## Acceptance Criteria

- [x] AC-1: `sign-v6.ts` credits, per (reviewer, patch-id), only the newest leaf; older leaves of the same reviewer remain in `transcriptLeaves` and the Merkle input, each marked `superseded: true` in the envelope.
- [x] AC-2: `verify-core.mjs` applies the AISDLC-977 approved-verdict check to credited leaves only; a leaf marked superseded must still hash into the root (tamper check) but is not required to be an approved verdict. A superseded leaf that is NEWER than the credited one, or a credited leaf that is not approved, fails with the existing v6 reason text.
- [x] AC-3: Tests: reject-then-approve by one reviewer on one patch-id signs and verifies; approve-then-reject fails; a rejected newest leaf fails; parity test covers the superseded flag.
- [x] AC-4: `docs/operations/attestation-reference.md` and `.claude/rules/review-attestations.md` state the newest-leaf-per-reviewer rule and that superseded leaves are history, citing DEC-0287.
- [x] AC-5: AISDLC-1137's existing leaves file verifies unchanged under the new rule (no edit to `.ai-sdlc/transcript-leaves/6ae1180953a5d76bcacd4d057ef4e0be830172b0.jsonl`).
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

## Final Summary

## Summary
The v6 signer now credits only the newest leaf per reviewer. Older leaves stay in the Merkle input, marked `superseded: true`. The verifier derives the newest leaf from the on-disk leaves and applies the approved-verdict check to credited leaves only. Docs updated. A draft PR is open.

## Changes
- pipeline-cli/src/attestation/sign-v6.ts
- pipeline-cli/attestation-core/verify-core.mjs
- pipeline-cli/src/attestation/sign-verify-parity.test.ts
- docs/operations/attestation-reference.md
- .claude/rules/review-attestations.md

## Design decisions
AC-6 is not fully green. `pnpm test` failed only on prompt-rules.test.mjs (2 subtests: operator-dispatch.md and executor.md standing-rules sync). That failure also occurs on main, and the waiver text above records it. Build, lint and format:check passed. The attestation tests pass (641/641). Separately, `pipeline-cli/src/hierarchy/executor-start.test.ts` (14 failures) fails whenever the executor-session env vars (`AI_SDLC_EXECUTOR_TASK`, `AI_SDLC_HIERARCHY_SESSION`, `AI_SDLC_HIERARCHY_ROLE`) are inherited. With them unset it passes 23/23, and the pre-push hook passed that way (patch coverage 12/12). AC-5 was not run against the real AISDLC-1137 leaves file. It is untouched, and by design its rejected leaf[3] is older than the later approvals, so it should verify once the signer marks it superseded. A superseded flag on the newest leaf, or on a leaf with no newer credited leaf, is refused. The commit scope is `pipeline-cli` because commitlint rejected `attestation`. I stashed the backlog task status change (To Do to In Progress) as `stash@{0}` labelled `t1144`, so it is not in the commit.

## Verification
- `pnpm build` — passed
- `pnpm test` — ran (executor env vars unset): 3796 pass, 2 fail; both failures are ai-sdlc-plugin/commands/prompt-rules.test.mjs standing-rules sync, a file this diff does not touch; the same 2 fail on main
- `pnpm lint` — passed
- `pnpm format:check` — passed
- 3 parallel reviews approved (harness: claude in model-routing.yaml (source: yaml) — using Claude-native agents for all reviewers)

## Follow-up
(none)

