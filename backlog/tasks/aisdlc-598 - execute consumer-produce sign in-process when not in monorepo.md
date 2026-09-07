---
id: AISDLC-598
title: >-
  /ai-sdlc execute — sign the v6 envelope in-process on consumer repos (don't rely on the monorepo pre-push hook)
status: To Do
assignee: []
created_date: '2026-09-07'
labels:
  - pipeline-cli
  - execute
  - attestation
  - adopter
  - consumer-produce
dependencies: []
references:
  - ai-sdlc-plugin/commands/execute.md
  - pipeline-cli/bin/cli-attestation.mjs
  - scripts/check-attestation-sign.sh
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Gap 1 of the consumer-produce triage (2026-09-07, observed running `/ai-sdlc execute LT-469` in the local-trades adopter repo, plugin v0.18.0).**

`/ai-sdlc execute` (AISDLC-133) deliberately does NOT sign the DSSE envelope in-line at Step 10/11. It writes a verdict file and relies on the **monorepo's husky `pre-push` hook** (`.husky/pre-push` → `scripts/check-attestation-sign.sh`) to sign the v6 envelope at push time and commit it as a chore.

In a consumer/adopter repo, `.husky/pre-push` is the **adopter's own** hook (in local-trades it runs `pnpm -r test:coverage`), NOT the monorepo attestation-signer. So Step 11's push produces **no envelope**, and `verify-attestation` (fixed for consumers as of pipeline-cli 0.21.0 / AISDLC-583) is red because there is nothing to verify. There is currently no code path in `execute` that signs the envelope itself in a consumer.

Net adopter impact: `execute` runs dev + reviewer fan-out fine, but cannot produce a v6 attestation that `verify-attestation` accepts without manual coordinator intervention — the dispatch works but the gate the dispatch exists to feed does not.

## Scope
- Add a consumer-repo signing path to `execute` (Step 10.5 / 11): when the push path does NOT carry the monorepo's `check-attestation-sign.sh` signer, `execute` signs the v6 envelope directly via `cli-attestation sign-v6` before push. The signing is deterministic and the command already knows the head SHA + task-id.
- **Detection, not env-flag:** decide "am I the monorepo?" by probing whether the attestation-signer is actually on the push path (e.g. `scripts/check-attestation-sign.sh` reachable from the repo's `.husky/pre-push`), NOT by hardcoding a monorepo assumption. In the monorepo, keep delegating to the hook (no double-sign). Signing MUST be idempotent / mutually exclusive with the hook so the monorepo path is unchanged.
- After in-process sign, run the same `verify-attestation` (with `PR_HEAD_SHA`/`PR_BASE_SHA`) the operator would run, so `execute` fails loudly in the consumer if its own produce is red — rather than pushing an unverifiable state.
- Ensure the signed envelope is committed on the branch before push (mirror the monorepo chore-commit, `--no-verify` as the hook does), respecting the CI-skip-token and `.ai-sdlc/attestations/**` write rules.

## Acceptance Criteria
- [ ] Running `/ai-sdlc execute <task>` in a consumer repo (no monorepo pre-push signer) produces a committed v6 DSSE envelope that `verify-attestation` accepts, with zero manual coordinator steps.
- [ ] In the monorepo, behaviour is unchanged: the pre-push hook still signs; `execute` does NOT double-sign (detection correctly identifies the monorepo push path).
- [ ] `execute` runs `verify-attestation` on its own produce and aborts with an actionable message if red (no unverifiable push).
- [ ] Detection is push-path-probe based, not a hardcoded monorepo check or a new operator env flag.
- [ ] Hermetic/integration coverage for both topologies (monorepo delegates; consumer self-signs) including the negative "verify red → abort" case.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
<!-- SECTION:DESCRIPTION:END -->

## Notes
Composes with AISDLC-599 (reviewer transcripts/verdicts must exist under `.ai-sdlc/` for `emit-leaf` to feed `sign-v6`) and AISDLC-600 (runtime pin so the in-process signer is 0.23.0 and stamps `independent`). Also see the two separately-filed produce-flow issues: worktree-topology `harnessTranscriptHash=null` (verdictClass self-authored) and the `sign-v6` per-patch-id vs shared `transcript-leaves.jsonl` fallback divergence — both are on the same produce path this task touches.
