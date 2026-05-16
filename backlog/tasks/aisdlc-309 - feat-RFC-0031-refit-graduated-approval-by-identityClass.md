---
id: AISDLC-309
title: 'feat: RFC-0031 Refit — graduate approval count by identityClass (OQ-12.4)'
status: To Do
assignee: []
created_date: '2026-05-16'
labels:
  - rfc-0031
  - refit
  - audit-followup
  - critical-path-rfc-0035
dependencies: []
references:
  - spec/rfcs/RFC-0031-calibration-driven-did-revision-proposal.md
  - orchestrator/src/sa-scoring/revision-proposal.ts
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0031 OQ-12.4 audit revised the shipped uniform 2-approver approval path. Operator-affirmed approach: graduate by `identityClass`.

## Why a refit (not a revert)

The AISDLC-271 subagent shipped `deriveApprovalPath()` returning "owning pillar lead + one other pillar lead" uniformly for all proposals. Alex's original Position said "Design Authority is the approving pillar lead" (singular). The subagent's uniform 2-approver was overcautious for `evolving` fields where §8 routing already differentiates by stakes. Industry patterns (GitHub branch protection, AWS IAM, k8s admission) graduate approver count by stakes, not blanket.

## Scope

- Revise `deriveApprovalPath()` in `orchestrator/src/sa-scoring/revision-proposal.ts`.
- `core` fields → 2 approvers (owning pillar lead + one other). Unchanged from shipped behavior on this branch.
- `evolving` fields → 1 approver (owning pillar lead only). Behavior change vs. shipped.
- Read `identityClass` from the DID schema resolution the caller passes in.
- Test coverage for both branches + edge case where identityClass is missing or `ambiguous` (default to 2-approver — conservative fallback).

## Composition

- Composes with §8 identityClass routing (already shipped).
- Per-org override available via `.ai-sdlc/calibration.yaml` `approvalCounts` section (see RFC-0031 §12.6 schema); operator can flip back to uniform 2-approver if they want the original behavior.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `deriveApprovalPath()` reads `identityClass` from caller-resolved DID schema context
- [ ] #2 `core` fields → 2 approvers (owning pillar lead + one other)
- [ ] #3 `evolving` fields → 1 approver (owning pillar lead only)
- [ ] #4 Missing or `ambiguous` identityClass → 2-approver fallback (conservative)
- [ ] #5 `.ai-sdlc/calibration.yaml` `approvalCounts` per-org override respected
- [ ] #6 Test coverage: core / evolving / ambiguous / missing / per-org override
<!-- AC:END -->
