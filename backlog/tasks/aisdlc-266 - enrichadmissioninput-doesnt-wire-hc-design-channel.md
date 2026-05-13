---
id: AISDLC-266
title: enrichAdmissionInput doesn't wire HC_design channel from DSB
status: To Do
assignee: []
created_date: '2026-05-13 23:55'
labels:
  - adopter-friction
  - ppa
  - admission
  - rfc-0008
dependencies: []
priority: high
references:
  - spec/rfcs/RFC-0008-ppa-triad-integration-final-combined.md
---

## Bug

Per RFC-0008 §C5, the DSB's `stewardship.designAuthority.principals` is supposed to populate the `HC_design` channel of the admission scoring input. With a full DSB loaded (and DID + maintainers + soul-tracks all clean), `pillarBreakdown.shared.hcComposite.design` stays at `0`.

Either the wire from `stewardship.designAuthority.principals → HC_design` is missing in `enrichAdmissionInput()`, OR the spec needs an explicit signal channel that adopters opt in to populate.

## Repro (forge)

```bash
# Forge admission with full DSB + DID + maintainers + soul-tracks loaded
cli-admission score --pillar-breakdown
# pillarBreakdown.shared.hcComposite.design === 0  (expected: > 0 when designAuthority.principals non-empty)
```

## What to investigate first

1. Inspect `enrichAdmissionInput()` in the orchestrator (`orchestrator/src/admission/` or similar) — does it read `stewardship.designAuthority.principals` from the DSB?
2. Inspect the channel mapping table — is `HC_design` listed as a destination for DSB stewardship signals?
3. Cross-check with RFC-0008 §C5's intended semantics: is the channel supposed to be auto-populated, or does the adopter need to declare an explicit `signalChannels:` mapping?

## Acceptance criteria

- [ ] Root cause identified (missing wire vs spec gap vs adopter-opt-in pattern).
- [ ] Fix implemented: a fully-loaded DSB with non-empty `stewardship.designAuthority.principals` produces `pillarBreakdown.shared.hcComposite.design > 0`.
- [ ] Test added with a fixture DSB exercising the channel.
- [ ] If RFC-0008 needs amending (signal channel semantics), open an RFC PR alongside.
- [ ] Adopter docs updated explaining how to debug a stuck-at-0 channel.

## Source

Adopter session 2026-05-13, ranked #6 by friction. Forge admission scoring shows hcComposite.design = 0 with full DSB.
