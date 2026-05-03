---
id: AISDLC-171
title: 'HC composite design pillar wiring: investigate stewardship.designAuthority → HC_design propagation gap'
status: To Do
assignee: []
created_date: '2026-05-03'
labels:
  - bug
  - rfc-0008
  - orchestrator
  - hc-composite
priority: medium
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
  - orchestrator/src/
---

## Description

This bug surfaces Alex's practitioner observation filed as RFC-0009 §13 OQ-8
(verbatim): "When an adopter's DSB carries
`stewardship.designAuthority.principals: [name]`, the orchestrator's
`pillarBreakdown.shared.hcComposite.design` value did not populate."

Operator triage: out-of-scope for RFC-0009 acceptance; the affected abstractions
(`enrichAdmissionInput`, `pillarBreakdown.shared.hcComposite.design`, the DSB
`stewardship.designAuthority` schema) all live in RFC-0008 — file as a standalone
bug against RFC-0008 and resolve OQ-8 by reference.

## Hypotheses (Alex's framing)

The original observation is consistent with three competing root causes; the
investigation must distinguish between them before any fix lands:

- **(a) Orchestrator wiring gap in `enrichAdmissionInput`** — the function reads
  `stewardship.designAuthority.principals` but fails to project it into the HC
  composite's `design` channel. Resolution: fix the wiring.
- **(b) Unspecified explicit signal channel requirement** — RFC-0008's contract
  may intend that `stewardship.designAuthority` is necessary-but-not-sufficient
  and that an additional explicit signal (e.g., a separate DSB field, a DID
  reference, an operator-asserted override) is required to populate
  `HC_design`. Resolution: document the explicit signal channel.
- **(c) Intentional behavior misunderstood by the adopter** — the orchestrator
  may correctly NOT propagate `stewardship.designAuthority` into `HC_design`
  by design (e.g., authority signals identity ownership, not coherence
  conviction). Resolution: document the actual semantic with a worked example.

## Acceptance Criteria

- [ ] #1 Reproduce the issue in a hermetic test fixture: construct a minimal
      DSB whose `stewardship.designAuthority.principals` is populated, run the
      admission pipeline, and assert the resulting
      `pillarBreakdown.shared.hcComposite.design` value (capturing the
      observed-vs-expected delta).
- [ ] #2 Determine root cause: classify as (a) wiring gap, (b) unspecified
      signal channel requirement, or (c) intentional behavior. Document the
      determination with the evidence chain (code path traced, spec citations,
      adopter-context analysis).
- [ ] #3 If (a): fix the wiring in `enrichAdmissionInput` so
      `stewardship.designAuthority.principals` propagates into
      `pillarBreakdown.shared.hcComposite.design`. The fixture from AC #1 must
      pass.
- [ ] #4 If (b): document the explicit signal channel requirement in RFC-0008
      (the affected schema section + admission composite section) and backport
      the requirement into existing adopter onboarding docs so future adopters
      do not hit the same surprise.
- [ ] #5 If (c): document the actual semantic in RFC-0008 + the operator
      runbook with a worked example showing what `stewardship.designAuthority`
      signals (and what it does NOT signal) and what the correct channel for
      raising `HC_design` actually is.
- [ ] #6 Triage RFC-0009 §13 OQ-8 as RESOLVED, pointing the resolution at this
      task's outcome (link this task ID + the resolving PR from OQ-8).

## Notes

- Out-of-scope for RFC-0009 acceptance per operator triage — the abstractions
  affected (DSB schema, `enrichAdmissionInput`, HC composite) are RFC-0008
  surface area.
- Resolution affects how shard-level design authority signals into HC for
  shard-bounded work (per RFC-0009 §13 OQ-8 last sentence). The fix shape
  determines whether tessellated-platform shards inherit design authority
  automatically or require an explicit per-shard declaration.
- **Provenance reference (in-flight RFC):** the source observation lives in
  `spec/rfcs/RFC-0009-tessellated-design-intent-documents.md` §13 OQ-8. That
  RFC isn't on `main` yet (in-flight on a separate branch), so it is cited
  here in the body rather than in frontmatter `references:` (matches the
  AISDLC-165 precedent for in-flight RFC citations + keeps the
  `backlog-drift` gate green). Once RFC-0009 lands on main, a follow-up may
  promote the reference into frontmatter.
