---
id: AISDLC-934
title: 'fix(ci): cut per-PR workflow fan-out so the Actions token bucket is not exhausted by the drain (DEC-0250)'
status: To Do
assignee: []
created_date: '2026-10-15'
labels: [ci, velocity, governance]
dependencies: []
references:
  - .github/workflows/codeql.yml
  - .github/workflows/require-issue-link.yml
  - .github/workflows/rfc-lifecycle-check.yml
  - .github/workflows/untrusted-pr-gate.yml
  - .github/workflows/ai-sdlc-review.yml
  - .github/workflows/ai-sdlc-gate.yml
  - docs/operations/quality-gate.md
  - docs/operations/merge-without-queue.md
priority: high
dispatchable: true
---

## Context

Observed 2026-10-15 22:31Z and 22:38Z on PR #1634 (docs-only filing PR, head a9b60ede): `Detect Changes` and `ai-sdlc/issue-link` red with the check-run annotation `API rate limit exceeded for installation` (request ids 47C0:30DDE8 and A400:3016FE); the docs-only classifier passes locally on the same diff. The bucket is the repository's GitHub Actions token (`github.token`, 1,000 requests per hour per repository), not the 5,000/hr user bucket (4,541 remaining at the time). In the preceding 90 minutes the drain pushed ~32 PR heads and each push fired 7-8 workflows that call the API (`dorny/paths-filter`, `gh api --paginate`, CodeQL upload): `untrusted-pr-gate.yml` (24 API-shaped lines), `ai-sdlc-review.yml` (18), `auto-enable-auto-merge.yml` (17), `ai-sdlc-gate.yml` (16), `rfc-lifecycle-check.yml` (8), `require-issue-link.yml` (4), `codeql.yml` x2 (upload). Reruns burn the same bucket, so the red repeats. AISDLC-727 made `ai-sdlc-gate.yml` the only CI run; the others still start on every `pull_request`/`pull_request_target` event and only skip at job level, after the run and its API calls have begun. Branch protection requires only `ai-sdlc/pr-ready` (`docs/operations/quality-gate.md`).

Decision: DEC-0250 (operator-answered `full`, 2026-10-15), continuing the D1-D15 workflow consolidation (DEC-0095..0107). The CodeQL timing change is tagged a governance weakening in that record; it does not self-apply beyond what the record names.

**Five-step review (requirements first).** Requirement questioned: "every PR event runs every workflow that might apply". Delete: CodeQL's `pull_request` trigger (scan on `push: main` and the weekly schedule remain; a vulnerable diff is scanned minutes after landing, and the attestation reviewers still gate landing); the standalone `require-issue-link.yml` and `rfc-lifecycle-check.yml` workflows. Simplify: those two checks become jobs of `ai-sdlc-gate.yml` (one checkout, one token budget, already in the `ai-sdlc/pr-ready` rollup). Accelerate: `untrusted-pr-gate.yml` and `ai-sdlc-review.yml` test trust in a single entry job so a trusted PR never runs the API-heavy jobs. Automate: nothing new; the gate rollup already exists.

## Fix

1. `codeql.yml`: remove the `pull_request` trigger (lines 9-10) and the `pull_request` branch of the job `if:` (line 26); keep `push: main` and `schedule`.
2. `ai-sdlc-gate.yml`: add jobs `issue-link` and `rfc-lifecycle` carrying the step bodies of `require-issue-link.yml` (`check-issue-link`, line 46) and `rfc-lifecycle-check.yml` (`rfc-lifecycle-check`, line 53); the rfc job keeps its `spec/rfcs/*.md` path condition via the existing `Detect Changes` outputs; both feed the `ai-sdlc/pr-ready` rollup like the other gate jobs. `require-issue-link.yml` runs on `pull_request_target` for the `statuses: write` scope: keep posting the `ai-sdlc/issue-link` status from the gate with the same name so branch-protection history is unchanged, or drop the separate status and let the rollup carry it (either is fine; say which in the PR body). Delete the two standalone workflow files.
3. `untrusted-pr-gate.yml` and `ai-sdlc-review.yml`: the trust test currently at job level (`classify-and-gate` line 93, `analyze` line 115) moves to one entry job that every other job `needs:` (the only GitHub mechanism for a workflow-level condition), so a same-repo collaborator PR produces no further job and no API calls. Behaviour for fork, non-collaborator and bot PRs is unchanged (AISDLC-824).
4. `docs/operations/quality-gate.md` and `docs/operations/merge-without-queue.md`: list the gate's new jobs; note that CodeQL scans `main` and weekly, not PRs; note the per-event workflow count (expected 2 for a trusted PR: the gate and the auto-enable workflow; the untrusted pair only when untrusted).
5. Tests: the existing workflow checks under `pnpm test` must pass; add a `node --test` case asserting no workflow other than `ai-sdlc-gate.yml`, `auto-enable-auto-merge.yml`, `untrusted-pr-gate.yml` and `ai-sdlc-review.yml` declares a `pull_request` or `pull_request_target` trigger (guards the fan-out from growing back).

## Acceptance Criteria

- [ ] #1 A trusted (same-repo collaborator) PR push starts the `AI-SDLC PR Ready Gate` and `Auto-enable auto-merge on PR open` workflows only, plus at most the trust-check entry job of `Untrusted-Contributor PR Verification Gate` and `AI-SDLC PR Review`; no run of `CodeQL`, `Require Linked Issue` or `RFC Lifecycle Gate`.
- [ ] #2 `ai-sdlc/pr-ready` still fails when the PR body lacks an issue/task link, and when an RFC file skips a lifecycle state, with the same messages as today.
- [ ] #3 CodeQL runs on `push` to `main` and on the weekly schedule; `codeql.yml` has no `pull_request` trigger.
- [ ] #4 A fork or Dependabot PR still runs `untrusted-pr-gate.yml` and `ai-sdlc-review.yml` as before.
- [ ] #5 The new test fails if a workflow outside the allow-list gains a `pull_request`/`pull_request_target` trigger.
- [ ] #6 `docs/operations/quality-gate.md` and `docs/operations/merge-without-queue.md` describe the consolidated gate.

**Velocity impact.** Positive: removes the recurring rate-limit reds on docs PRs during a drain (each cost a reconciler route, a planner diagnosis and two wasted reruns on #1634 alone) and cuts per-push CI starts from 7-8 to 2 for trusted PRs.

Authority: DEC-0250 (operator-answered `full`, 2026-10-15; governance weakening for the CodeQL timing, recorded). Class (b) per `docs/operations/decision-authority.md`; filing the task is class (a).
