---
id: AISDLC-1223
title: 'Reconcile RFC status with lifecycle: retroactive Implemented batch with an open-question gate (AISDLC-856 part b)'
status: In Progress
assignee: []
created_date: '2026-11-07'
labels:
  - docs
  - rfc
dependencies:
  - AISDLC-856
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
  - spec/rfcs/RFC-0009-tessellated-design-intent-documents.md
  - spec/rfcs/RFC-0010-parallel-execution-worktree-pooling.md
  - spec/rfcs/RFC-0016-estimation-calibration-tshirt-sizes.md
  - spec/rfcs/RFC-0019-embedding-provider-adapter.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0024-emergent-issue-capture-and-triage.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
  - spec/rfcs/RFC-0036-spec-kit-bridge-adopter-authoring.md
  - spec/rfcs/RFC-0048-per-repo-configurable-governance.md
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-lifecycle-transitions.mjs
  - .ai-sdlc/lifecycle-approvers.yaml
  - .github/workflows/ai-sdlc-gate.yml
priority: medium
dispatchable: true
---

## Description

**Source.** Part (b) of AISDLC-856 by operator ruling 2026-11-07. Eight RFCs under `spec/rfcs/` read `status: Draft` with `lifecycle: Implemented` (RFC-0009, 0010, 0016, 0019, 0022, 0024, 0035, 0048) and RFC-0036 is `lifecycle: Ready for Review` while `/ai-sdlc import-spec` and `/ai-sdlc rfc-init` ship. The public registry renders both fields, so shipped designs read as Draft. AISDLC-856 part (a) adds the check that flags the pair and a known set that exempts these nine; this task performs the flips the ruling allows and shrinks that set.

## Scope

For each of the nine RFCs:

1. List its Open Questions section and count the entries without a recorded resolution. The executor never resolves an OQ (AISDLC-298): no `**Resolution:**` or `RESOLVED` marker is added or edited, no OQ text is changed.
2. Zero open OQs: set `status: Implemented`, bump `updated` to the PR date, and add a `## Status note` section citing the landed tasks in `backlog/completed/` that implement the RFC and the date of this ruling.
3. One or more open OQs: leave `status` as is and add the `## Status note` listing the open OQs by id, so the registry row explains itself.
4. RFC-0036: its lifecycle moves to `Implemented` only if every phase in its implementation plan (AISDLC-326 to AISDLC-336) is landed and `import-spec` and `rfc-init` cover each phase; otherwise the Status note lists the remaining phases and the lifecycle stays `Ready for Review`.
5. The PR body carries one row per RFC: open OQ count, decision (flipped or noted), evidence (the completed task files, and for RFC-0036 the phase list).
6. Gates. `status: Implemented` puts an RFC under `ENFORCED_STATUSES` in `scripts/check-rfc-docs.mjs`, so every `requiresDocs` surface must already be cited (RFC-0010 declares `operator-runbook` and `api-reference`; the others declare none); run `node scripts/check-rfc-docs.mjs` before pushing. A `status` change alone is not a lifecycle transition; only RFC-0036's `Ready for Review -> Implemented` jump is a forbidden transition in `scripts/check-rfc-lifecycle-transitions.mjs` and needs the override marker.
7. Marker. Per the comment block in `.ai-sdlc/lifecycle-approvers.yaml`, the override is `<!-- ai-sdlc:lifecycle-jump-approved-by:<operator> reason:<text> -->` in both the PR body and the RFC body, by an identity listed in that file. The executor must NOT add the marker. It leaves the PR with a note asking the operator (the only listed identity) to add the marker to the PR body and to each flipped RFC body; the PR is not ready until that is done.
8. After the PR lands: remove the flipped RFCs from the known set that AISDLC-856 part (a) adds to `scripts/check-rfc-docs.mjs` (the set does not exist on `main` yet; AISDLC-856 is the dependency). If part (a) implements the exemption as warnings instead of a set, this step is a no-op and the PR body says so.

## Acceptance Criteria

- [ ] #1 Every RFC with zero open OQs among the nine has `status: Implemented`, a bumped `updated`, and a `## Status note` citing the landed tasks; every RFC with an open OQ keeps its status and has a `## Status note` naming the open OQs.
- [ ] #2 No `**Resolution:**` / `RESOLVED` marker is added, removed or edited in any RFC (the diff under `## Open Questions` sections is empty).
- [ ] #3 RFC-0036's lifecycle is `Implemented` only with evidence that `import-spec` and `rfc-init` cover every phase of AISDLC-326 to AISDLC-336, else its Status note lists the remaining phases.
- [ ] #4 The PR body has the per-RFC table (open OQ count, decision, evidence) and a note requesting the operator's `ai-sdlc:lifecycle-jump-approved-by` marker; the executor's commits contain no marker.
- [ ] #5 `node scripts/check-rfc-docs.mjs` and the `check-rfc-lifecycle-transitions.mjs` step in `.github/workflows/ai-sdlc-gate.yml` pass once the operator marker is present.
- [ ] #6 The known set from AISDLC-856 part (a) in `scripts/check-rfc-docs.mjs` no longer names the flipped RFCs (or the PR body states that part (a) used no set).

## Ruling 2026-11-07 (operator, decision rubric)

Option A of the 2026-11-07 ruling on AISDLC-856 part b: the public registry shows nine shipped RFCs as Draft; IETF, Rust and PEP processes all allow a retroactive implemented state with a recorded note. Counter-argument (a nine-RFC override is the mass bypass AISDLC-350 hardened against) rebutted because each flip is gated on zero open OQs, so the marker approves only designs with nothing left to decide. Chosen over walking each through the ladder (weeks of operator time) and over redefining the registry state.

## References

- `.ai-sdlc/lifecycle-approvers.yaml` (marker format, both-bodies rule), `scripts/check-rfc-lifecycle-transitions.mjs` (`OVERRIDE_MARKER_REGEX`, forbidden transitions), `scripts/check-rfc-docs.mjs` (`ENFORCED_STATUSES`).
- AISDLC-856 "Deferred (needs approver decision)" section.
