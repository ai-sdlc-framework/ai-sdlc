---
id: AISDLC-748
title: >-
  init detects branch-protection availability and installs attestation-approval enforcement or the client-side merge gate
status: Done
assignee: []
created_date: '2026-10-06'
labels:
  - governance
  - orchestrator
dependencies:
  - AISDLC-747
references:
  - orchestrator/src/cli/commands/init.ts
  - orchestrator/src/cli/commands/branch-protection-shared.ts
  - docs/operations/quality-gate.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Resolves DEC-0014 (operator, 2026-10-06). Background: an adopter repo initialized governance and merged 200+ PRs with two reviewer transcripts because init scaffolds attestation artifacts without enforcement; the earlier work shipped doctor and a disclosure only.

Decision: init enforces by default, chosen by runtime capability, never by guessing the plan.

1. If the branch-protection API is available (public repo, or paid plan): apply protection requiring the `ai-sdlc/pr-ready` check plus 1 approving review, and install the verify-attestation workflow that posts that approval (from the dependency listed), so merges block without a human wait.
2. If the protection call returns 403 (GitHub Free private repo): fall back to client-side enforcement. The framework's merge command refuses unless attestation verifies and checks are green, the hook keeps blocking direct agent merges, and doctor reports "enforcement: client-side only; the server cannot block a manual merge" as an error-level finding.

Both paths print exactly what was installed and the opt-out flag (`--no-branch-protection`); `--yes` follows the same detection. The attestation approval still posts on path 2.

Sequencing: lands after the attestation-approval workflow listed under dependencies.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

- [x] Tests cover both paths with a mocked API (200 and 403).
- [x] Doctor output is tested for each path.
- [x] Init output names the chosen path and the `--no-branch-protection` opt-out.
- [x] `docs/operations/quality-gate.md` states the detect-and-fallback rule.

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
`ai-sdlc init` now detects branch-protection availability at runtime. On API success it applies protection requiring `ai-sdlc/pr-ready`, `codecov/patch` and 1 approving review; on a 403 (GitHub Free private repo) it falls back to client-side enforcement and doctor reports an error-level "enforcement: client-side only" finding. `--no-branch-protection` opts out; init output names the chosen path.

## Changes
- `orchestrator/src/cli/commands/branch-protection-shared.ts` (modified): availability detection (HTTP 403 / "Upgrade to GitHub Pro/Team", stdout or stderr).
- `orchestrator/src/cli/commands/init-features.ts`, `init.ts` (modified): detect-and-fallback, `--no-branch-protection`, truthful output.
- `orchestrator/src/cli/commands/init-templates.ts` (modified): `templatePostsApproval` derivation (messaging only).
- `orchestrator/src/cli/commands/doctor.ts`, `doctor-checks.ts` (modified): client-side-only finding.
- Tests for 200/403 paths, opt-out, doctor per path; `docs/operations/quality-gate.md` states the rule.

## Design decisions
- **1 approving review always**: DEC-0014; lowering it to 0 was rejected by security review as an unrecorded weakening. Tradeoff: until the adopter template ships a verifying approve job, a non-admin merge waits on a human review or admin bypass.

## Verification
- `pnpm build` - clean
- `pnpm test` (orchestrator src/cli/commands: 485 passed, 1 skipped)
- `pnpm lint` - clean
- `pnpm format:check` - clean
- 3 parallel reviews approved (Codex out of quota; Claude-native reviewers)

## Follow-up
- The adopter `VERIFY_ATTESTATION_WORKFLOW` template has no verifying `approve` job (this repo's AISDLC-747 job depends on `scripts/post-attestation-review.mjs`); see AISDLC-748.1.
<!-- SECTION:FINAL_SUMMARY:END -->
