---
id: AISDLC-617
title: Merge code + test reviewers into one correctness reviewer; keep security separate (3→2)
status: To Do
priority: medium
labels:
  - reviewers
  - cost
  - config
dependencies:
  - AISDLC-616
created: 2026-09-14
---

## Context

From the same operator reviewer-cost investigation (2026-09-14). Goal: cut the
~3x token cost of running three reviewers per code PR, without losing the defects
the extra reviewers catch.

The evidence + reasoning that shaped the 3→2 (not 3→1) shape:

- **Code and test reviewers share a domain** (correctness): logic errors, edge
  cases, and whether tests cover them are naturally reviewed together. Folding
  them into one prompt has low domain-conflict risk.
- **Security is a distinct reasoning mode** and is the ONLY role with retained
  evidence of unique, critical catches (e.g. AISDLC-501: a fail-open degradation
  giving an untrusted PR a green gate + valid signed attestation with zero
  sandbox / zero approval — a trust-chain CRITICAL a general correctness reviewer
  would not frame). Folding security into a combined reviewer risks attention
  dilution on exactly the highest-severity class. **Keep it separate.**
- **Cost reality**: a combined reviewer is not 1/3 the cost — it needs a longer
  multi-domain prompt and emits one long transcript; realistic saving from 3→2 is
  ~30-40% of reviewer tokens. The per-role model split (code/test on Sonnet,
  security on Opus — PR #327) already makes security the expensive role you'd
  least want to touch, so merging the two cheap Sonnet roles is the low-risk cut.

**Do not roll this out blind.** AISDLC-616 instruments first-pass findings; this
task's permanent enablement should be **validated against that ledger** (does the
merged code+test reviewer catch the same correctness blockers the two separate
reviewers did?). Ship behind a config flag so it can be A/B'd, not hard-swapped.

## Scope

- Add a **combined correctness reviewer** (name TBD, e.g. `correctness-reviewer`)
  whose prompt merges the code-reviewer and test-reviewer remits (bugs/logic +
  test coverage/quality), on Sonnet. Preserve the same JSON verdict envelope
  shape so aggregation (`step_8_aggregate_verdicts`) and the AISDLC-616 ledger are
  unchanged.
- **Config flag** (e.g. `.ai-sdlc/review-policy` `reviewerSet: three | code-test-merged`)
  defaulting to the current three-reviewer set, so adopters/operators opt in and
  it can be A/B'd against the ledger. Do NOT change the default in this task.
- Update `/ai-sdlc execute` + orchestrator-tick reviewer fan-out to honor the
  flag: two subagents (combined-correctness + security) when enabled.
- Keep the **security reviewer unchanged and separate** (Opus).
- Update attestation leaf emission + verdict aggregation to accept a 2-reviewer
  set (do not hardcode 3).
- Docs: explain the flag, the rationale (why code+test merged and security kept
  separate), and that permanent default-change is gated on AISDLC-616 ledger data.

## Acceptance Criteria

- [ ] AC-1: With `reviewerSet=code-test-merged`, a code PR runs exactly two
      reviewers (combined correctness + security); with the default it still runs
      three. Both produce valid aggregated verdicts + attestation leaves.
- [ ] AC-2: The combined reviewer's prompt covers both bug/logic AND test
      coverage/quality; a fixture PR with a test-coverage gap AND a logic bug has
      both surfaced by the single combined reviewer.
- [ ] AC-3: Security reviewer path is byte-for-byte unchanged (still separate,
      still Opus).
- [ ] AC-4: Default reviewerSet is unchanged (three) — this task adds the option,
      it does not flip the default.
- [ ] AC-5: Aggregation + leaf-emit handle a 2-reviewer set (no hardcoded count);
      hermetic tests for both sets.
- [ ] AC-6: `pnpm build && test && lint` clean; docs note the ledger-gated
      default-change plan.

## References

Operator reviewer-cost investigation (2026-09-14). Depends on **AISDLC-616**
(findings ledger) for validation before any default change. Per-role model split
PR #327. Reviewer fan-out lives in `/ai-sdlc execute` + orchestrator-tick skill
bodies; aggregation in `pipeline_step_8_aggregate_verdicts`.
