---
id: AISDLC-383
title: 'feat: RFC-0042 Proof-of-Execution Attestation via In-Repo Merkle Transcripts (umbrella)'
status: To Do
assignee: []
created_date: '2026-05-20'
labels:
  - rfc-0042
  - attestation
  - architecture
  - friction-reduction
  - critical
dependencies: []
priority: critical
blocked:
  reason: 'Awaits RFC-0042 sign-off (operator walkthrough of 7 OQs). Implementation cannot start until OQ-1 through OQ-7 resolved.'
references:
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - spec/rfcs/RFC-0011-definition-of-ready.md
  - backlog/completed/aisdlc-380 - feat-attestation-trust-chain-require-reviewer-side-proof-in-verdict-file.md
---

## Umbrella task — RFC-0042 implementation

Replaces the operator-key DSSE attestation chain (AISDLC-380 + sub-attestation gate) with proof-of-execution via in-repo Merkle transcripts.

The operator framing (2026-05-20): expensive LLM work happens locally on subscription; cheap cryptographic verification happens on CI. Decouples cost from trust. Eliminates 13 attestation-pipeline gates that are the dominant source of shipping friction.

## Sub-task graph

```
                AISDLC-383 (umbrella, BLOCKED until RFC-0042 sign-off)
                          │
        ┌─────────────────┼─────────────────────────────────┐
        │                 │                                 │
    AISDLC-383.5      AISDLC-383.1 → 383.2 → 383.3 → 383.4
    Bypass-all-gates  Transcript    Merkle   v6 schema  v6 verifier
    env var           capture       leaf     + signer   in CI
    (parallel,        in reviewer   index    (Phase 2)  (Phase 2)
    enables 383.1)    subagents     + root           │
                      (Phase 1)     (Phase 1)        │
                                                     ▼
                                            AISDLC-383.6 → AISDLC-383.7
                                            Cutover         Cleanup
                                            (disable        (delete v3/v4/v5
                                            AISDLC-380       code, sub-attestation
                                            gate)            gate, runbook)
                                            (Phase 3)       (Phase 4)
```

Critical path: 383.5 → 383.1 → 383.2 → 383.3 → 383.4 → 383.6 → 383.7

Estimated wall-clock: 3 weeks (Phase 1 ~1 wk, Phase 2 ~1 wk, Phase 3 ~1 day, Phase 4 ~1 wk after 30-day soak)

## Acceptance criteria (umbrella-level)

- [ ] #1 All 7 phase sub-tasks (AISDLC-383.1–383.7) reach Done
- [ ] #2 RFC-0042 lifecycle promoted Draft → Ready for Review → Signed Off → Implemented
- [ ] #3 Typical PR push cycle reduced from 3-4 pushes to 1-2 (measured: ship a representative code PR + count pushes)
- [ ] #4 AISDLC-380 sub-attestation gate disabled; no PR ever requires AI_SDLC_LEGACY_VERDICTS=1 again
- [ ] #5 contentHashV3/V4/V5 collectors deleted; verify-attestation.mjs simpler by >50% LOC
- [ ] #6 Per-reviewer signing keys (~/.ai-sdlc/reviewer-keys/*) no longer required
- [ ] #7 Fork PRs ship without admin intervention (re-test PR akillies-class scenario)
- [ ] #8 CLAUDE.md attestation section rewritten to reflect new model
- [ ] #9 AISDLC-380.2 architectural follow-up cancelled (replaced by this RFC)

## Out of scope

- Non-attestation gate friction (coverage, task-move, DoR, drift) — tracked separately in AISDLC-384
- Public-log audit trail (Rekor / OpenTimestamps) — deferred to future opt-in (see RFC-0042 §Alternatives)
- Reviewer LLM cost reduction — out of scope; LLM inference cost is intrinsic

## Source

Operator session 2026-05-20: existential-friction conversation. Operator proposed proof-of-execution architecture as root-cause intervention. In-repo Merkle (RFC-0042) chosen over public Rekor due to operational + dependency concerns.
