---
id: AISDLC-841
title: >-
  delete the six idle issue-label workflows and their yaml tests
status: In Progress
assignee: []
created_date: '2026-10-13'
labels:
  - ci
  - velocity
  - governance
dependencies: []
references:
  - .github/workflows/ai-sdlc.yml
  - .github/workflows/ai-sdlc-admit.yml
  - .github/workflows/ai-sdlc-route.yml
  - .github/workflows/ai-sdlc-triage.yml
  - .github/workflows/ai-sdlc-sa-feedback.yml
  - .github/workflows/ai-sdlc-slack-issue.yml
  - docs/audits/2026-10-13-cicd-five-step-audit.md
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

Six February and March dogfood issue-label workflows (`ai-sdlc.yml`, `ai-sdlc-admit.yml`, `ai-sdlc-route.yml`, `ai-sdlc-triage.yml`, `ai-sdlc-sa-feedback.yml`, `ai-sdlc-slack-issue.yml`) had 0 runs in the 7 days measured; last runs were 2026-10-05 (admit), 2026-09-15 (the others) and 2026-03-28 (slack) (`docs/audits/2026-10-13-cicd-five-step-audit.md`, finding F8). They are a capability, not a gate; `dogfood watch --issue <id>` is the documented path for GitHub issues.

**Five-step review (requirements first).** Requirement questioned: "label-triggered agent pipelines run on every issue" (the 2026-02 dogfood pipeline, never re-asked). The operator answered DEC-0162 on 2026-10-13 (option `delete`): 0 runs in 4 weeks. Delete: all six workflow files and the YAML tests that exist only for them. Simplify: nothing replaces them. Accelerate: six fewer workflows to load and audit. Automate: nothing new.

## Fix

1. Delete the six workflow files named in the references.
2. Delete the YAML tests that exist only for them and remove their entries from shared tests (`rg -l "ai-sdlc-admit|ai-sdlc-route|ai-sdlc-triage|ai-sdlc-sa-feedback|ai-sdlc-slack-issue" .github .ai-sdlc docs scripts CLAUDE.md`; known hits include `.github/workflows/__tests__/trust-marker.test.mjs`, which must keep its assertions for the remaining workflows).
3. Remove any `.ai-sdlc/gates.yaml` entries for them and any docs that describe the label-triggered pipeline as live, pointing at `dogfood watch --issue <id>` instead.
4. Do not delete library code in `orchestrator/` or `dogfood/` that the workflows called; if `pnpm dark-code:check` then reports a newly dark module, report it in the PR body and do not baseline it without cause.

**Velocity impact.** Positive: six fewer workflows to load, audit and keep pinned; nothing that ran in four weeks is lost.

Authority: DEC-0162 (answered 2026-10-13, operator present; record lands on main via the decisions-sync PR).
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 The six workflow files no longer exist on the branch
- [ ] #2 No test or doc outside historical audits references the deleted workflows (rg check in Fix step 2)
- [ ] #3 `.ai-sdlc/gates.yaml` (the AISDLC-805 shrink-only gate registry) has the removed gates' entries deleted, and `scripts/check-gate-registry.test.mjs` passes (`pnpm test:gates`) with no entry added
- [ ] #4 `node --test .github/workflows/__tests__/` passes
- [ ] #5 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass
<!-- AC:END -->

## Verification

- `node --test .github/workflows/__tests__/` (workflow tasks), `pnpm test:gates`, and `pnpm lint && pnpm format:check`

## Follow-up

(none)
