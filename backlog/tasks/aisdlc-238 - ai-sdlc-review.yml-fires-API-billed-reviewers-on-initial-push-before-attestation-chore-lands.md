---
id: AISDLC-238
title: >-
  ai-sdlc-review.yml fires API-billed reviewers on initial push before
  attestation chore lands — burns budget unnecessarily
status: To Do
assignee: []
created_date: '2026-05-07 22:35'
labels:
  - bug
  - ci
  - attestation
  - cost
  - framework-bug
  - dogfood
dependencies: []
priority: high
references:
  - .github/workflows/ai-sdlc-review.yml
  - scripts/check-attestation-sign.sh
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

When an operator pushes a code commit to a PR BEFORE the attestation envelope chore commit lands, `ai-sdlc-review.yml` fires the API-billed reviewer fan-out — even though the attestation will arrive moments later. This burns Anthropic API credits and triggers `Reviewer Agents Skipped (Anthropic Budget Exhausted)` comments when the API key is exhausted (operator has stopped funding API credits — subscription-only is the canonical path).

Witnessed empirically 2026-05-07 on PR #393 (and similar pattern on others):

1. Operator pushes commit `e95930f` (the work) → CI fires `ai-sdlc-review.yml`
2. `attestation-precheck` job sees no envelope at HEAD (envelope chore not pushed yet) → `skip=false`
3. `analyze` job runs the 3 CI reviewers via Anthropic API → budget exhausted comment posted
4. Operator pushes commit `0066589` (the attestation chore) → CI re-fires
5. `attestation-precheck` sees envelope at HEAD → `skip=true`
6. `analyze` skips → "Local Attestation Valid" comment posted

The valid-attestation outcome is what the operator INTENDED, but the budget-exhausted call already happened in step 3. The intermediate window where HEAD lacks the envelope is the bug.

## Why this matters

CLAUDE.md describes ai-sdlc-review.yml's CI-side reviewers as a "cost-saver fallback" for when local attestation is missing. But the design assumes attestation is signed BEFORE push — which it usually isn't (operators sign + commit + push in 2-3 separate operations, with PR CI firing on each push).

Operator (2026-05-07): "we should be using the subscription credits locally, and we need to be doing attestation locally so the remote API is never fired we should never see the Anthropic Budget Exhausted error cause attestation should be done locally before pushing the code remotely."

Translated: the remote API path should be a TRUE last resort, not fire on every interim push. With API credits intentionally unfunded, the workflow currently produces noise + alarmism on every multi-push cycle.

## Proposed fixes (pick one or layer multiple)

### Option A — Debounce: wait N seconds before firing reviewers

Add a 60-second sleep at the start of `analyze` job. If by the time it wakes the attestation envelope IS present at HEAD (i.e. operator pushed the chore commit during the sleep), re-check + skip.

Cost: 60s of CI wall-clock added to legitimate "no envelope coming" cases.

### Option B — Detect attestation-chore-en-route via commit history pattern

If the most recent commit on the branch is a code commit AND the operator's local pre-push sequence is known to push attestation in a follow-up commit (which it is, via `check-attestation-sign.sh`), the workflow can wait for the next push before firing reviewers. Detect via:
- Commit subject pattern matches feat/fix/etc + missing envelope at HEAD
- AND the operator has a signing key (check `.ai-sdlc/trusted-reviewers.yaml` for the operator's pubkey)
- THEN delay reviewer fan-out for 5 min OR until the next push

### Option C — Pre-push hook signs BEFORE the work commit lands (workflow change)

Today's pre-push hook (`check-attestation-sign.sh`) auto-signs from a verdicts file, then exits 1 with "re-push required" so the chore commit gets pushed in a follow-up.

The change: have the pre-push hook AMEND the work commit with the envelope file (rather than create a separate chore). One commit, one push, envelope present from the start. CI never sees an intermediate unsigned state.

Tradeoff: amending changes the work commit's SHA. The verdict file's contentHashV4 binds to the original SHA. So the order would need to be:
1. Operator commits work
2. Pre-push hook computes contentHashV4 against the work commit
3. Hook adds envelope file to the index
4. Hook amends work commit (now includes envelope) — SHA changes
5. Hook re-computes contentHashV4 (would change because envelope file is now in tree, but contentHashV4 excludes the envelope file per CLAUDE.md, so should be stable)
6. Push the amended commit

This is the cleanest fix but requires careful sequencing.

### Option D — Skip CI reviewers entirely when API credits are exhausted

Detect `credit balance is too low` from the first reviewer attempt and skip the remaining 2 fan-out calls. Saves 2/3 budget per failure event. Not a true fix (operator's API credits are zero, so all 3 fail anyway) but reduces the noise.

Recommendation: ship **Option C** (pre-push amend) as the primary fix + **Option B** (delay-on-suspected-incoming-chore) as the safety net.

## Acceptance Criteria

- [ ] #1 Investigation: confirm the bug reproduces on a controlled fixture (push code → wait for CI to start firing reviewers → push envelope → observe budget-exhausted comment from first attempt)
- [ ] #2 Pick a fix path (A/B/C/D or combination) based on team review of tradeoffs
- [ ] #3 Implement chosen fix in `.github/workflows/ai-sdlc-review.yml` and/or `scripts/check-attestation-sign.sh`
- [ ] #4 Hermetic test: simulate the multi-push timing, verify reviewers don't fire on the intermediate unsigned commit
- [ ] #5 Operator runbook updated explaining the new behavior + when API reviewers DO fire (true missing-attestation case only)
- [ ] #6 No regression: legitimate operator-missing-attestation flow still triggers CI reviewers as the cost-saver fallback (when designed)
- [ ] #7 Document operator's "API credits intentionally unfunded" decision in CLAUDE.md so future contributors don't accidentally re-fund + lose the cost discipline signal

## Composes with

- **AISDLC-230** (auto-merge re-arm) — both are merge-queue smoothing fixes
- **AISDLC-237** (contentHashV4 rebase invalidation) — adjacent attestation lifecycle bug
- **`check-attestation-sign.sh` pre-push hook** (existing) — possible amendment surface for Option C

## References

- `.github/workflows/ai-sdlc-review.yml` (the workflow that fires API reviewers)
- `scripts/check-attestation-sign.sh` (the pre-push hook that handles local attestation)
- CLAUDE.md (Review attestations section — describes the cost-saver fallback design)
- PR #393 comment history 2026-05-07 — empirical witness
- AISDLC-147 (introduced the attestation-precheck skip path — design intent)
- AISDLC-193 (made attestation a required gate — design intent)
- Operator decision 2026-05-07: "I stopped paying for the API credits cause we need to fix this workflow so I don't get unnecesarly charged through the API to attest for things when it should have been done locally."
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- SECTION:ACCEPTANCE:BEGIN -->
- [ ] #1 Reproduce the bug on a controlled fixture (multi-push timing)
- [ ] #2 Pick fix path (A/B/C/D or combination)
- [ ] #3 Implement in ai-sdlc-review.yml and/or check-attestation-sign.sh
- [ ] #4 Hermetic test for the multi-push timing
- [ ] #5 Operator runbook updated
- [ ] #6 No regression on legitimate missing-attestation path
- [ ] #7 CLAUDE.md documents API-credits-intentionally-unfunded decision
<!-- SECTION:ACCEPTANCE:END -->
