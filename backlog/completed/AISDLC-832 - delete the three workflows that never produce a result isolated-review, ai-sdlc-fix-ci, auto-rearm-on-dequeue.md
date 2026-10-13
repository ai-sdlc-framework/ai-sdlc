---
id: AISDLC-832
title: >-
  delete the three workflows that never produce a result: isolated-review,
  ai-sdlc-fix-ci, auto-rearm-on-dequeue
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
  - governance
dependencies: []
references:
  - .ai-sdlc/gates.yaml
  - docs/operations/merge-without-queue.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
drift_log:
  - date: '2026-10-13'
    type: ref-deleted
    detail: 'Referenced file no longer exists: .github/workflows/isolated-review.yml'
    resolution: flagged
  - date: '2026-10-13'
    type: ref-deleted
    detail: 'Referenced file no longer exists: .github/workflows/ai-sdlc-fix-ci.yml'
    resolution: flagged
  - date: '2026-10-13'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .github/workflows/auto-rearm-on-dequeue.yml
    resolution: flagged
drift_checked: '2026-10-13'
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Three workflows run on PR or push events and never do useful work. Seven-day figures from `docs/audits/2026-10-13-cicd-five-step-audit.md` (section 3, rows D1, D5, D15):

- `isolated-review.yml` (RFC-0047 Phase 4, AISDLC-596): 950 runs, 949 skipped, 1 failure, 0 successes.
- `ai-sdlc-fix-ci.yml` (added by commit e7b50b64 "Add CI fix feedback loop for agent-created PRs"; AISDLC-704.5 proposed diagnosing the skip): 1000 runs (API cap), 999 skipped, 0 successes.
- `auto-rearm-on-dequeue.yml` (AISDLC-369, AISDLC-381): 873 runs (841 per push, 32 cron), about 80 runner-minutes and 3,062 wall minutes, for a merge-queue dequeue event that cannot occur since the queue was dropped (AISDLC-400).

Every skipped run still takes a runner queue slot on each push.

**Five-step review (requirements first).** Requirement questioned: "a clean-room review signer runs on every PR" (RFC-0047 Phase 4, AISDLC-596, never cut over), "CI fixes failing PRs unattended" (commit e7b50b64) and "re-arm auto-merge after a queue dequeue" (AISDLC-369/381, premise removed by AISDLC-400). The operator answered DEC-0095, DEC-0107 and DEC-0099 on 2026-10-11 via the decision rubric: none of the three has a live requirement (CI-fix capability lives in `/ai-sdlc fix-pr`, `cli-fix-ci` and the conflict-resolver agent, which hold the signing key). Delete: all three workflow files, their registry entries and the doc sentences that name them; disabled-but-present was rejected as the same debt. Simplify: nothing is moved into another workflow; DEC-0099 chose deletion plus one rollback line instead of folding logic into `auto-enable-auto-merge.yml`. Accelerate: about 2,800 fewer skipped or no-op runs per week, so fewer queue slots per push. Automate: nothing new; the AISDLC-805 registry ratchet already fails if a deleted gate reappears unlisted.

## Fix

1. Delete `.github/workflows/isolated-review.yml`, `.github/workflows/ai-sdlc-fix-ci.yml` and `.github/workflows/auto-rearm-on-dequeue.yml`.
2. `docs/operations/merge-without-queue.md`: replace the sentence saying the auto-rearm file "is kept" and add one line to the "Rollback procedure" section naming the commit the file can be restored from (`git show <deleting-commit>^:.github/workflows/auto-rearm-on-dequeue.yml`, with the commit sha filled in by the executor from `git log`).
3. Delete the three workflows' entries from `.ai-sdlc/gates.yaml`; remove the references from `.github/workflows/__tests__/no-new-pr-gate.test.mjs`, `.github/workflows/__tests__/fork-pr-safety.test.mjs` and `scripts/check-gate-registry.test.mjs` (keep the assertions that still apply to remaining workflows).
4. Update docs that name the deleted files: `docs/operations/ci-only-trust-marker.md`, `docs/operations/independence-policy.md`, `docs/operations/operator-runbook.md`, `ai-sdlc-plugin/commands/fix-pr.md` (drop any pointer to the CI-side fixer). Do not touch the `pipeline-cli` `clean-room-signer` / `ucvg` source: this task deletes the workflow, not the library code; if the dark-code gate (`pnpm dark-code:check`) then reports a newly dark module, report it in the PR body and baseline it with `--update-baseline` only if the module is genuinely retained by an RFC-0047 task.
5. `rg -n "isolated-review|ai-sdlc-fix-ci|auto-rearm-on-dequeue" CLAUDE.md docs .github scripts` returns only historical audit documents under `docs/audits/` and `docs/operations/gate-audit-2026-10.md`.

**Velocity impact.** Positive: removes about 2,800 skipped or no-op workflow runs per week and three required-by-nobody queue slots on every push; no check that ever produced a verdict is lost.

Authority: DEC-0095 (answered 2026-10-11, on main).
Authority: DEC-0107 (answered 2026-10-11, on main).
Authority: DEC-0099 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 The three workflow files no longer exist on the branch
- [x] #2 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [x] #3 `.github/workflows/__tests__/` tests that referenced the deleted workflows are updated and `node --test .github/workflows/__tests__/` passes
- [x] #4 `docs/operations/merge-without-queue.md` rollback section names the commit to restore `auto-rearm-on-dequeue.yml` from and no longer says the file is kept
- [x] #5 CLAUDE.md and the docs/operations pages listed in the Fix carry no pointer to the deleted workflows (rg check in Fix step 5)
- [x] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
