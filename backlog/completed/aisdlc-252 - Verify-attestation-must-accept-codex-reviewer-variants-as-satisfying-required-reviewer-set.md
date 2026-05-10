---
id: AISDLC-252
title: >-
  verify-attestation must accept codex reviewer variants as satisfying required
  reviewer set (cross-harness gap)
status: In Progress
assignee: []
created_date: '2026-05-09 19:55'
labels:
  - bug
  - attestation
  - codex
  - cross-harness
  - p0
  - dogfood
dependencies: []
priority: high
references:
  - scripts/verify-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
  - ai-sdlc-plugin/agents/code-reviewer-codex.md
  - ai-sdlc-plugin/agents/test-reviewer-codex.md
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

The CI verifier (`scripts/verify-attestation.mjs` + `orchestrator/src/runtime/attestations.ts`) requires a fixed set of reviewer agentIds — `code-reviewer`, `test-reviewer`, `security-reviewer`. When a PR is reviewed cross-harness (operator's stated workflow goal: Claude implements / Codex reviews and vice versa), the reviewer agentIds in the verdicts file are the codex variants — `code-reviewer-codex`, `test-reviewer-codex`. The verifier doesn't recognize them as satisfying the requirement, returning:

```
ai-sdlc/attestation — reviewer set incomplete: missing required reviewer 'code-reviewer'
```

Witnessed empirically 2026-05-09 on PR #415 (AISDLC-242). The PR went through the bidirectional cross-harness review (Codex code-reviewer + Codex test-reviewer + Claude security-reviewer) and was BLOCKED at the merge queue until I added a redundant Claude `code-reviewer` review to satisfy the gate.

This defeats the entire cross-harness independence enforcement story: the WHOLE point of `code-reviewer-codex` is so a different harness reviews Claude-implemented code (RFC-0010 §13.10 `requiresIndependentHarnessFrom: [implement]` pattern). Forcing a Claude `code-reviewer` to ALSO sign means we end up paying both harnesses' tokens for every PR.

## Why this matters

Operator (2026-05-09): "lots of throughput" was the explicit goal of bidirectional review. AISDLC-247 (Codex reviewers) + AISDLC-202.x (Codex pipeline) were shipped specifically for this. But until the verifier is harness-aware, every PR still needs the Claude-side code-reviewer to satisfy attestation.

## Proposed fix

The required-reviewer check needs to accept harness-variant agentIds as fulfilling the canonical role:

- `code-reviewer` requirement satisfied by EITHER `code-reviewer` (claude-code) OR `code-reviewer-codex` (codex)
- `test-reviewer` requirement satisfied by EITHER `test-reviewer` OR `test-reviewer-codex`
- `security-reviewer` requirement still ONLY satisfied by `security-reviewer` (Claude/Opus, per the operator's intentional cost split — no `security-reviewer-codex` ships per AISDLC-247)

### Implementation surface

1. `orchestrator/src/runtime/attestations.ts` — wherever the required reviewer set is enforced, accept the `*-codex` variant as fulfilling the same role
2. `scripts/verify-attestation.mjs` — same change applied to the runner used by `verify-attestation.yml`
3. RFC-0010 §13.10 (independence enforcement) — verify the verifier ALSO enforces the bidirectional rule: a PR signed by `code-reviewer-codex` must NOT also have been implemented by codex (the implement→review independence). Currently the verifier accepts any agentId; the new acceptance should respect the harness-independence constraint when the predicate's `harness` field (AISDLC-202.3) indicates the implementer.

## Acceptance Criteria
<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Required-reviewer check accepts both harness variants for code + test (claude-code OR codex satisfies); security stays Claude-only
- [ ] #2 Hermetic test: envelope with code-reviewer-codex + test-reviewer-codex + security-reviewer passes verification
- [ ] #3 Hermetic test: envelope with code-reviewer-codex but no test-reviewer-codex AND no test-reviewer fails verification (still need test coverage from SOMEONE)
- [ ] #4 Independence rule: when predicate.harness.name === 'codex', verifier rejects envelopes whose code-reviewer.harness is ALSO 'codex' (per RFC-0010 §13.10 requiresIndependentHarnessFrom). Hermetic test for the rejection.
- [ ] #5 Operator runbook (`docs/operations/cross-harness-review.md`) updated to note that the verifier now satisfies the cross-harness independence story end-to-end (no more redundant Claude reviews on Codex-reviewed PRs)
- [ ] #6 Smoke test on the next bidirectional PR: confirm verify-attestation accepts the codex-only reviewer set
<!-- SECTION:ACCEPTANCE:END -->
<!-- SECTION:DESCRIPTION:END -->
