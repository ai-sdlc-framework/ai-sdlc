---
id: AISDLC-383.6
title: 'chore(attestation): RFC-0042 Phase 3 cutover — disable AISDLC-380 sub-attestation gate'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - phase-3
  - attestation
  - cutover
parentTaskId: AISDLC-383
dependencies:
  - AISDLC-383.4
priority: medium
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - scripts/check-attestation-sign.sh
  - scripts/verify-reviewer-sub-attestations.mjs
---

## Scope (RFC-0042 Phase 3)

Per RFC-0042 §Migration Phase 3, perform the cutover: new PRs use only v6 envelopes; the AISDLC-380 sub-attestation gate becomes audit-only (warns but does not block).

### Deliverables

1. **Default schema version** in `sign-attestation.mjs` flipped from v5 to v6
2. **AISDLC-380 sub-attestation gate** (`scripts/verify-reviewer-sub-attestations.mjs` + `scripts/check-attestation-sign.sh` Step 4d) downgraded:
   - On v6 envelopes: gate skipped entirely (v6 has its own verification)
   - On v5 envelopes: gate still runs but failures emit warning, exit 0 (audit-only mode)
3. **AISDLC-380.2 task** marked Superseded — replaced by RFC-0042 (file in backlog/completed/ with finalSummary noting the supersession)
4. **CLAUDE.md attestation section** updated:
   - v6 is the default
   - v3/v4/v5 verifier code retained per OQ-7
   - AISDLC-380 sub-attestation gate is audit-only
5. **Operator runbook update**: any operator following AISDLC-380 onboarding flow gets a deprecation note pointing at RFC-0042 transcript-based flow
6. Hermetic tests: v5 envelope with no sub-attestations + AISDLC-380 gate downgraded → push succeeds (would have failed pre-cutover)

### Acceptance criteria

- [ ] #1 New PRs produce v6 envelopes by default
- [ ] #2 AISDLC-380 sub-attestation gate emits warnings only; no longer blocks pushes
- [ ] #3 AISDLC-380.2 task marked Superseded in `backlog/completed/`
- [ ] #4 CLAUDE.md attestation section reflects post-cutover state
- [ ] #5 Operator runbook updated; AISDLC-380 onboarding flow is deprecated
- [ ] #6 Hermetic tests cover cutover behavior
- [ ] #7 New code reaches 80%+ patch coverage

## Out of scope

- Deleting v3/v4/v5 signer code (deferred to AISDLC-383.7 after 30-day soak)
- Deleting AISDLC-380 sub-attestation code (deferred to AISDLC-383.7)
- Deleting `init-reviewer-signing-key.mjs` (deferred to AISDLC-383.7)

## Source

RFC-0042 §Migration Phase 3. Cutover marks the point where new PRs benefit from RFC-0042 while legacy PRs continue verifying via the retained v3/v4/v5 code.
