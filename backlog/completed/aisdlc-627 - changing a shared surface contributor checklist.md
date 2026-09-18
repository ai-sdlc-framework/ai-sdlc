---
id: AISDLC-627
title: Contributor checklist for changing a shared surface (boundary testing)
status: Done
priority: medium
labels:
  - docs
  - contributor-guidance
  - regression-prevention
  - adopter
created: 2026-09-18
---

## Context

Prevention follow-up from the 0.21.0 adopter-brick post-mortem (AISDLC-628).
The most damaging regressions this project has shipped were not wrong logic —
the unit tests passed. They were a **shared surface changed while a consumer or
environment we don't run locally was left behind** (the reviewer-attribution
change in #970 that bricked every adopter; the `--json` change in AISDLC-624
that broke a sibling test's stub).

There was no contributor-facing guidance telling authors to test the *boundary*
(the absent/degraded consumer environment) rather than only the in-repo happy
path.

## Scope

Add a **"Changing a Shared Surface — Test the Boundary, Not Just the Unit"**
section to `CONTRIBUTING.md` with a concrete pre-merge checklist:

1. Enumerate the consumers (plugin bundle, sibling packages, prompt `.md`
   bodies, multi-caller `.sh`).
2. Cover the degraded/absent environment, not only the happy path.
3. If it ships to adopters, prove the bundle contains it + portable path
   resolution (cross-references the AISDLC-625/626 gates).
4. Update every stub in lockstep when a shared contract changes.
5. Put trust gates at the artifact boundary, not the adopter's critical path
   (cross-references `docs/operations/fail-soft-at-the-adopter-boundary.md`).

Cross-reference the post-mortem at
`docs/audits/2026-09-18-0.21.0-adopter-brick.md`.

## Acceptance Criteria

- [x] `CONTRIBUTING.md` has a "Changing a Shared Surface" section with the
      5-point checklist.
- [x] The section cites the 0.21.0 post-mortem as the reference incident.
- [x] It cross-links the fail-soft-at-the-adopter-boundary principle doc.
- [x] Docs-only change; `npx backlog-drift check` passes; prettier clean.

## Notes

Docs-only. Shipped together with AISDLC-628 (post-mortem + principle doc) in a
single PR because the checklist, the post-mortem, and the principle doc
cross-reference each other and must land atomically to avoid broken links.
