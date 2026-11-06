---
id: AISDLC-1174
title: 'RFC-0061 Phases 3 and 4: amend dependent RFCs, update docs and move the adopter path to the verdict check'
status: In Progress
assignee: []
created_date: '2026-11-03'
labels:
  - rfc-0061
  - attestation
  - review-gate
  - docs
  - adopters
  - phase-3
  - phase-4
dependencies:
  - AISDLC-1172
  - AISDLC-1173
references:
  - spec/rfcs/RFC-0061-review-verdict-gate-outside-the-branch.md
  - .github/workflows/consumer-verify-attestation.yml
  - docs/operations/adopter-attestation-verify-ci.md
  - docs/operations/attestation-reference.md
  - .claude/rules/review-attestations.md
  - docs/operations/merge-without-queue.md
priority: medium
dispatchable: true
---

## Description

Implements RFC-0061 Migration Path phases 3 (docs half) and 4, OQ-3 and the `operator-runbook` requiresDocs entry.

**Scope.**
1. Amend RFC-0043 (clean-room output is the verdict record, OQ-7), RFC-0046 (tier carrier moves to the record's `reviewers[]`, derivation unchanged, OQ-6), RFC-0052 (reviewer entries go into the record, no leaf expansion rule) and RFC-0054 (`content-hash-mismatch` and push-only re-sign replaced, OQ-2). Set RFC-0042 to Superseded and RFC-0061 to Implemented once AISDLC-1173 lands.
2. Rewrite `attestation-reference.md` and `.claude/rules/review-attestations.md` for the verdict record, stating the OQ-8 trust claim verbatim: what the gate guarantees, what it does not, and the upgrade trigger. Update the CLAUDE.md schema line within its size budget.
3. Adopter path (OQ-3): `consumer-verify-attestation.yml` and `cli-attestation verify` check the verdict record, keep their names, inputs and exit codes, and the `ai-sdlc/attestation` context. `adopter-attestation-verify-ci.md` explains that the names are kept for branch-protection compatibility and that the pin moves producer and verifier together. A release note states the hard cut.
4. Operator runbook section: prune the verdict namespace, run the catch report, and what to do when a catch is found.

## Acceptance Criteria

- [ ] AC-1: Each dependent RFC carries an amendment pointer to RFC-0061, and RFC-0042 is Superseded.
- [ ] AC-2: The trust claim text in the docs matches the RFC-0061 OQ-8 resolution.
- [ ] AC-3: The consumer workflow keeps its input names and exit codes; a fixture run passes against a verdict record.
- [ ] AC-4: The operator runbook section exists and `requiresDocs` is satisfied.
