---
id: AISDLC-856
title: >-
  check-rfc-docs flags an RFC whose status is Draft while its lifecycle is
  Implemented, wired into ai-sdlc-gate
status: To Do
assignee: []
created_date: '2026-10-13'
labels:
  - docs
  - rfc
dependencies: []
assumes:
  - RFC-0009
  - RFC-0010
  - RFC-0016
  - RFC-0019
  - RFC-0022
  - RFC-0024
  - RFC-0035
  - RFC-0036
  - RFC-0048
references:
  - scripts/check-rfc-docs.mjs
  - .github/workflows/ai-sdlc-gate.yml
  - .ai-sdlc/lifecycle-approvers.yaml
priority: low
dispatchable: true
drift_log:
  - date: '2026-10-17'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .github/workflows/rfc-lifecycle-check.yml
    resolution: flagged
drift_checked: '2026-10-17'
dispatchableReason: 'Unparked 2026-11-07 by operator ruling (planner critical-path review). Scope is part (a) only; part (b) needs an approver.'
---

## Description

The public RFC registry on ai-sdlc.io is generated from each RFC's frontmatter and shows `Status` next to `Lifecycle`. Eight RFCs currently read `status: Draft` with `lifecycle: Implemented`: RFC-0009, RFC-0010, RFC-0016, RFC-0019, RFC-0022, RFC-0024, RFC-0035 and RFC-0048. RFC-0036 is `Ready for Review` while its deliverables (`/ai-sdlc import-spec`, `/ai-sdlc rfc-init`) ship. The registry page explains that status is the design decision and lifecycle the sign-off position, so a Draft-but-Implemented row reads as a contradiction to adopters.

## Scope (part (a), dispatchable)

Unparked 2026-11-07 by operator ruling (planner critical-path review).

1. Add a check to `scripts/check-rfc-docs.mjs` that flags `status: Draft` together with `lifecycle: Implemented` so the pair cannot drift silently again. Wire it into `.github/workflows/ai-sdlc-gate.yml`, where `check-rfc-docs.mjs` already runs (the `rfc-lifecycle-check.yml` workflow this task once named was deleted).
2. The eight RFCs that currently mismatch are known and must not fail the gate until an approver flips them: the check reports them as warnings, or takes an allowlist that names them, with the mechanism documented in the script's header. The gate fails only on a new mismatch.

Out of scope: any RFC body or frontmatter change; the registry generator (site task IO-4).

## Acceptance Criteria

- [ ] `scripts/check-rfc-docs.mjs` fails on a fixture RFC with `status: Draft` and `lifecycle: Implemented` that is not in the known set, and passes the current `spec/rfcs/`.
- [ ] `.github/workflows/ai-sdlc-gate.yml` runs the check as part of the existing `check-rfc-docs.mjs` step; the workflow test under `.github/workflows/__tests__/` asserts it.
- [ ] `pnpm test && pnpm lint && pnpm format:check` pass.

## Deferred (needs approver decision)

Part (b) is not in this task's scope and is not an acceptance criterion. Promoting an RFC's status is a lifecycle sign-off governed by `.ai-sdlc/lifecycle-approvers.yaml`; an approver applies it after confirming runtime evidence:

1. For each of the eight RFCs (RFC-0009, RFC-0010, RFC-0016, RFC-0019, RFC-0022, RFC-0024, RFC-0035, RFC-0048), an approver confirms the runtime evidence the lifecycle field asserts and sets `status` to `Implemented` (or, where the design was never formally approved, records why in a `## Status note` section and leaves `status` as is). `updated` is bumped.
2. RFC-0036: decide whether to move lifecycle to `Implemented` given `import-spec` and `rfc-init` ship, or document which phases remain.

When the approver decides, file a follow-up task for the flips and shrink the known set in the check.
