---
id: AISDLC-620
title: cli-merge-if-eligible — route "no required checks reported" (gh exit 1) to the check-run fallback
status: Done
priority: high
labels:
  - governance
  - merge-gate
  - consumer-repo
  - bug
created: 2026-09-15
---

## Context

Adopter (local-trades) bug report, same consumer-repo class as LT-595 / AISDLC-607.

On a repo with **no branch protection** (private repo on a free plan — branch
protection API returns HTTP 403 "Upgrade to Pro"), `cli-merge-if-eligible
--source-kind backlog <pr>` always returns `eligible=false` with "the
required-checks fetch itself failed/errored ... refusing (fail-closed)", even
when the PR is verifiably green + `mergeStateStatus=CLEAN`. The AISDLC-607
check-run fallback never executes.

**Root cause (confirmed in `pipeline-cli/src/governance/merge-if-eligible.ts`):**
`fetchRequiredChecks()` runs `gh pr checks <pr> --required --json name,state
--repo <slug>` and maps ANY non-zero exit to `{ checks: [], fetchFailed: true }`
(line ~480). The evaluator checks `checksFetchFailed` first (line ~360) and
refuses BEFORE the check-run-fallback branch (line ~398) can run. AISDLC-607
handled the **exit-0 + empty-array** shape, but a real no-branch-protection repo
does NOT return exit 0 — `gh pr checks --required` **exits 1** with:

```
no required checks reported on the '<branch>' branch
```

So `fetchFailed:true` is set and the fallback (which only triggers on
`fetchFailed:false && checks.length===0`) is unreachable. This makes the
sanctioned agent-merge path unusable on exactly the topology AISDLC-607 was built
for.

## Scope

- In `fetchRequiredChecks()`, distinguish "no required contexts configured" from a
  genuine fetch error. On non-zero `gh` exit, if stderr matches
  `/no required checks reported/i`, return `{ checks: [], fetchFailed: false }` so
  the caller falls through to `fetchAllCheckRuns` (the AISDLC-607 check-run path).
  A true error (auth failure, network, unparseable JSON) must still return
  `fetchFailed: true` (preserve the fail-closed guarantee).
- **Preferred (more robust than string-matching a human-readable gh message):**
  probe branch protection explicitly — `gh api
  repos/{owner}/{repo}/branches/{base}/protection` → 403/404 ⇒ "no protection,
  use check-runs". Use the branch-protection probe as the authoritative signal and
  keep the stderr-sentinel as a secondary heuristic if the probe is unavailable.
  Whichever is chosen, the behavior must not depend solely on an exact
  gh-version-specific message string.
- Ensure the check-run fallback still enforces the real green gate (all
  non-skipped check-runs SUCCESS/NEUTRAL) + `mergeStateStatus=CLEAN` — this task
  only fixes the ROUTING to the fallback, not the fallback's own gate.

## Acceptance Criteria

- [ ] AC-1: On a repo with no required checks (gh `--required` exits 1 with "no
      required checks reported"), a green + CLEAN PR evaluates `eligible=true` via
      the check-run fallback (dry-run proves it).
- [ ] AC-2: A genuine fetch failure (auth error, network failure, unparseable
      output — NOT the no-required-checks sentinel) still returns
      `fetchFailed:true` and refuses fail-closed. Hermetic tests for BOTH the
      sentinel-exit-1 case and the genuine-error-exit-1 case.
- [ ] AC-3: Branch-protection probe (or equivalent non-message-string signal)
      drives the routing where feasible; the gh message match is not the sole
      discriminator.
- [ ] AC-4: `pnpm build && test && lint && format:check` clean; patch coverage
      >= 80%. Existing AISDLC-607 tests still pass.

## References

Adopter report (local-trades), consumer-repo merge path. Same class as LT-595 /
AISDLC-607 (which fixed the exit-0-empty case). Code:
`pipeline-cli/src/governance/merge-if-eligible.ts` (`fetchRequiredChecks`,
`fetchAllCheckRuns`, the `checksFetchFailed` evaluator branch).
