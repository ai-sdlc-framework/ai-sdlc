---
id: AISDLC-856
title: >-
  Reconcile RFC frontmatter status with lifecycle for the eight RFCs that are
  Implemented in lifecycle but Draft in status
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
  - .ai-sdlc/lifecycle-approvers.yaml
priority: low
dispatchable: false
dispatchableReason: >-
  Promoting an RFC's status is a lifecycle sign-off governed by
  .ai-sdlc/lifecycle-approvers.yaml; an approver applies it after confirming
  runtime evidence.
drift_log:
  - date: '2026-10-17'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      .github/workflows/rfc-lifecycle-check.yml
    resolution: flagged
drift_checked: '2026-10-17'
---

## Description

The public RFC registry on ai-sdlc.io is generated from each RFC's frontmatter and shows `Status` next to `Lifecycle`. Eight RFCs currently read `status: Draft` with `lifecycle: Implemented`: RFC-0009, RFC-0010, RFC-0016, RFC-0019, RFC-0022, RFC-0024, RFC-0035 and RFC-0048. RFC-0036 is `Ready for Review` while its deliverables (`/ai-sdlc import-spec`, `/ai-sdlc rfc-init`) ship. The registry page explains that status is the design decision and lifecycle the sign-off position, so a Draft-but-Implemented row reads as a contradiction to adopters.

## Scope

1. For each of the eight RFCs, an approver listed in `.ai-sdlc/lifecycle-approvers.yaml` confirms the runtime evidence the lifecycle field asserts and sets `status` to `Implemented` (or, where the design was never formally approved, records why in a `## Status note` section and leaves `status` as is). `updated` is bumped.
2. RFC-0036: decide whether to move lifecycle to `Implemented` given `import-spec` and `rfc-init` ship, or document which phases remain.
3. Add a check to `scripts/check-rfc-docs.mjs` that flags `status: Draft` with `lifecycle: Implemented` so the pair cannot drift silently again; wire it into `.github/workflows/rfc-lifecycle-check.yml`.

Out of scope: any RFC body change; the registry generator (site task IO-4).

## Acceptance Criteria

- [ ] No RFC under `spec/rfcs/` has `status: Draft` together with `lifecycle: Implemented`, or it carries a `## Status note` explaining the gap.
- [ ] `scripts/check-rfc-docs.mjs` fails on a fixture RFC with that mismatch and `rfc-lifecycle-check.yml` runs it.
- [ ] RFC-0036 frontmatter reflects the decision in step 2.
