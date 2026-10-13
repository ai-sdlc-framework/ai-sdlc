---
id: AISDLC-836
title: >-
  require only ai-sdlc/pr-ready on main: drop Backlog Drift and the other duplicate required contexts
status: Done
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - governance
  - velocity
dependencies: []
references:
  - scripts/sync-dor-branch-protection.sh
  - scripts/sync-branch-protection.sh
  - docs/operations/quality-gate.md
  - docs/operations/merge-without-queue.md
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`scripts/sync-dor-branch-protection.sh` `REQUIRED_CONTEXTS` still lists `Backlog Drift`, `ai-sdlc/pr-ready`, `ai-sdlc/attestation` and `Evaluate backlog tasks changed by PR`, and the live branch protection lists `Backlog Drift` and `ai-sdlc/pr-ready`. `ai-sdlc/pr-ready` already depends on the Backlog Drift job, so the separate context is a duplicate requirement (`docs/audits/2026-10-13-cicd-five-step-audit.md`, section 3 row D7). `docs/operations/quality-gate.md` and the CLAUDE.md operator-action line still name the old list.

**Five-step review (requirements first).** Requirement questioned: "Backlog Drift is a required context in its own right" (set when the check was introduced, before the AISDLC-388 rollup). The operator answered DEC-0101 on 2026-10-11, confirming DEC-0089: only `ai-sdlc/pr-ready` is required on main; Backlog Drift still blocks through the rollup. Delete: the `Backlog Drift` context (and the other contexts the rollup already covers, per DEC-0089) from the required list. Simplify: one required context. Accelerate: no separate status to wait for. Automate: the sync script is the single place the list lives. A deletion that loosens a governance control is class (b); this one is authorised by the answered record.

## Fix

1. Edit `REQUIRED_CONTEXTS` in `scripts/sync-dor-branch-protection.sh` to contain only `ai-sdlc/pr-ready`, and align `scripts/sync-branch-protection.sh` if it carries the same list.
2. Update the docs that state the required contexts so they say one context: `docs/operations/quality-gate.md`, `merge-without-queue.md`, `operator-runbook.md`, `pr-unstick.md`, `pre-push-and-ci-reference.md`, and any CLAUDE.md operator-action pointer line (use the `-F 'contexts[]=ai-sdlc/pr-ready'` form).
3. Check `pipeline-cli/src/cli/pr-unstick.ts`, `pipeline-cli/src/governance/merge-if-eligible.ts` and `orchestrator/src/cli/commands/doctor-checks.ts` for hard-coded `Backlog Drift` required-context assumptions; change them only where they assert the required-context list, with tests updated.
4. Applying the PATCH to live branch protection needs repository admin rights: the executor runs `scripts/sync-dor-branch-protection.sh --dry-run` and puts the output in the PR body; if the executor identity lacks admin rights the operator or the dispatch session runs the script after landing (the action DEC-0101 already assigns to "operator or the sync script").

**Velocity impact.** Positive: one status to wait for instead of two on every PR; Backlog Drift still blocks through the rollup so no check is lost.

Authority: DEC-0101 (answered 2026-10-11, on main).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `scripts/sync-dor-branch-protection.sh` `REQUIRED_CONTEXTS` contains only `ai-sdlc/pr-ready`
- [ ] #2 Docs and the CLAUDE.md pointer line (if present) state a single required context and no longer list `Backlog Drift` as required
- [ ] #3 Any source or test that asserted the old required-context list is updated and its tests pass
- [ ] #4 The `Backlog Drift` job is still a dependency of the `ai-sdlc/pr-ready` rollup (asserted in `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`)
- [ ] #5 `.ai-sdlc/gates.yaml` needs no new entry and `pnpm test:gates` passes
- [ ] #6 The PR body contains the dry-run output of the sync script
- [ ] #7 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
