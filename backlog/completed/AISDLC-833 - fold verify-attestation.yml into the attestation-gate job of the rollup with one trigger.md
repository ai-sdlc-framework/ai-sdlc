---
id: AISDLC-833
title: >-
  fold verify-attestation.yml into the attestation-gate job of the rollup with one trigger
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
  - governance
  - attestation
dependencies: []
references:
  - .github/workflows/ai-sdlc-gate.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .ai-sdlc/gates.yaml
  - docs/operations/attestation-reference.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`verify-attestation.yml` (719 lines; origin AISDLC-214, AISDLC-381, AISDLC-388, AISDLC-704.6) is a separate workflow with a dual `pull_request` plus `pull_request_target` trigger. Seven days (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D2): 392 `pull_request` plus 608 `pull_request_target` runs (capped at 1000), 181 cancelled, 308 skipped, about 368 runner-minutes. Each push therefore runs the verifier twice and two posters of `ai-sdlc/attestation` can race (the AISDLC-803 duplicate-poster problem). `ai-sdlc-gate.yml` already has an `attestation-gate` job that only polls for the status the standalone workflow posts.

**Five-step review (requirements first).** Requirement questioned: "verification runs in its own workflow so the status exists before the gate polls it" (AISDLC-381/388), and "it needs both triggers" (AISDLC-704.6 transition). The operator answered DEC-0096 on 2026-10-11: fold. Delete: the standalone workflow file and the `pull_request` leg of the dual trigger; AISDLC-803 (duplicate-poster fix) becomes unnecessary. Simplify: one verifier run and one `ai-sdlc/attestation` poster per PR, inside the named `attestation-gate` rollup job; the docs-only skip moves to a job-level `if`; verifier logic and v6 head-binding are unchanged and visibility is kept because the named job still posts the status. Accelerate: one fewer workflow queue slot per push and no cancelled twin. Automate: nothing new.

## Fix

1. Move the verifier steps from `.github/workflows/verify-attestation.yml` `verify` (and `approve` if it still has a purpose; if it has none, delete it and say so in the PR body) into the `attestation-gate` job of `.github/workflows/ai-sdlc-gate.yml`, keeping the pull-request-target safety rules enforced by `.github/workflows/__tests__/fork-pr-safety.test.mjs` (never check out or execute fork code with secrets; read the PR head only as data).
2. The job posts `ai-sdlc/attestation` exactly once per head SHA; the docs-only skip is a job-level `if` on the existing `detect` output.
3. Delete `.github/workflows/verify-attestation.yml`; keep `consumer-verify-attestation.yml` (it is a different, adopter-facing workflow).
4. Update `.github/workflows/__tests__/verify-attestation.test.mjs`, `verify-attestation-cancelled.test.mjs`, `ai-sdlc-gate.test.mjs`, `ai-sdlc-review.test.mjs` and `no-new-pr-gate.test.mjs` to the folded shape (assert a single poster, no second trigger, the docs-only `if`).
5. Update `.ai-sdlc/gates.yaml` (delete `workflow:verify-attestation.yml`; the `gate-job:attestation-gate` entry stays) and the docs that name the file: CLAUDE.md "Review attestations" pointer line, `docs/operations/attestation-reference.md`, `attestation-troubleshooting.md`, `merge-without-queue.md`, `emergency-bypass.md`, `ai-sdlc-plugin/commands/rebase.md`.

**Velocity impact.** Positive: one verifier run per push instead of two, no cancelled twin, no duplicate-poster race; no verification is weakened.

Authority: DEC-0096 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `.github/workflows/verify-attestation.yml` is deleted and the verifier runs inside `attestation-gate` of `ai-sdlc-gate.yml`, which has one trigger set (no `pull_request` plus `pull_request_target` duplication)
- [ ] #2 A code PR produces exactly one `ai-sdlc/attestation` status per head SHA; a docs-only PR produces a skipped job and no status requirement, as before
- [ ] #3 Verifier logic, v6 head-binding and the `ai-sdlc/pr-ready` rollup dependency on `attestation-gate` are unchanged
- [ ] #4 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #5 The workflow YAML tests under `.github/workflows/__tests__/` named in the Fix are updated and `node --test .github/workflows/__tests__/` passes
- [ ] #6 CLAUDE.md pointer lines and the docs/operations pages named in the Fix no longer reference `verify-attestation.yml`
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
