---
id: AISDLC-607
title: Fix cli-merge-if-eligible — unusable in consumer / no-branch-protection repos
status: To Do
priority: high
labels:
  - rfc-0048
  - governance
  - merge-if-eligible
  - consumer-parity
references:
  - RFC-0048
  - AISDLC-583
  - AISDLC-601
  - AISDLC-602
  - AISDLC-603
created: 2026-09-07
---

## Context

Reported from the `local-trades` consumer repo (marketplace/npm install, private
repo with **no branch-protection required checks available on its plan**, org
policy disables the Actions `GITHUB_TOKEN` write permission). After adopting
plugin 0.20.0 (RFC-0048 / AISDLC-601/602/603) and setting
`spec.governance.preset: operator-trusted` (`allowMerge=onGreenClean`), there is
**no working agent-initiated merge path**: AISDLC-602 blocks raw `gh pr merge`,
and its mandated replacement `cli-merge-if-eligible` (AISDLC-603) refuses every
PR via two independent fail-closed defects. This regresses the repo's
previously-working autonomous merge (operator drive loop merged via the operator
token) — the exact autonomy the operator opted into governance to keep.

Both defects verified in source at `pipeline-cli/src/governance/merge-if-eligible.ts`.

## Defect 1 — governance-resolver module path assumes a monorepo layout

`loadGovernanceResolverModule(pkgRoot)` (l.76-81) resolves the AISDLC-601 resolver
as `join(pkgRoot, '..', 'ai-sdlc-plugin', 'hooks', 'lib', 'governance-resolver.js')`
— i.e. `ai-sdlc-plugin` as a SIBLING of pipeline-cli. In a marketplace/npm
consumer install the plugin is NOT a sibling npm package (it lives under
`~/.claude/plugins/cache/<mp>/ai-sdlc/<ver>/`), so the file does not exist,
`loadGovernanceResolverModule` returns `null`, and `resolveRepoGovernancePolicy`
falls back to `STRICT_DEFAULTS` (`allowMerge='never'`). The helper then refuses
with `allowMerge="never"` EVEN WHEN `.ai-sdlc/agent-role.yaml` clearly resolves to
`onGreenClean`. The docstring itself already acknowledges this fail-closed-in-adopters
behavior. Same monorepo-vs-consumer assumption class as AISDLC-575/583
(`resolveAgentDefinitionDir`).

## Defect 2 — "green" evaluated only via branch-protection required contexts

After Defect 1 is resolved, the helper advances and refuses with "no required
checks were resolved for this PR — refusing to merge against an empty gate"
(`evaluateMergeEligibility`, l.195-203). `fetchRequiredChecks` (l.231-249) uses
`gh pr checks --required`, which resolves from branch-protection required
contexts. A private repo on a plan without branch protection has NONE
(`gh api repos/<o>/<r>/branches/main/protection` → HTTP 403). With no required
contexts the helper treats the gate as empty and fails closed — refusing every
PR regardless of how green its actual check-runs are. `local-trades` documents
that it has no required checks available and enforcement is procedural.

## Scope

### Defect 1 fix
- Resolve the governance-resolver from the INSTALLED plugin, not a monorepo
  sibling: try `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DIR` first, then the
  `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<ver>/hooks/lib/` cache, then
  fall back to the existing monorepo-sibling path (dogfood). Mirror the
  resolution strategy AISDLC-583 used for `resolveAgentDefinitionDir`.
- (Acceptable alternative: vendor `resolveGovernanceFromYaml` into pipeline-cli so
  there is no cross-package path dependency at all. Whichever is chosen, keep a
  single tested resolution seam.)
- STRICT_DEFAULTS fail-closed must still apply when the resolver genuinely cannot
  be found anywhere — only the FALSE-negative (resolver present in an installed
  plugin but not found) is being fixed.

### Defect 2 fix
- When branch protection exposes NO required contexts, fall back to the PR's
  actual check-runs (`statusCheckRollup` / `gh pr checks`): eligible iff every
  non-skipped conclusion is SUCCESS or NEUTRAL, none PENDING, AND
  `mergeStateStatus == CLEAN`. This is the same signal the operator drive loop
  and the `ship` skill already use.
- **Keep fail-closed on a genuinely failed / errored fetch.** Distinguish
  "branch protection returns no required contexts" (→ check-run fallback) from
  "the required-checks fetch itself failed/errored" (→ still refuse). Do NOT
  conflate "no branch protection" with "no gate" — the check-run path only
  applies when real, resolvable check-runs exist and are all green.
- The trust-boundary axes that already gate merge (policy `allowMerge`,
  `sourceKind == 'backlog'`, `mergeStateStatus == CLEAN`) are UNCHANGED — this
  only changes how "checks are green" is evaluated when no required contexts are
  configured.

## Acceptance Criteria

- [ ] AC-1: In a simulated marketplace/consumer layout (plugin under a cache
      path, NOT a pipeline-cli sibling), `resolveRepoGovernancePolicy` loads the
      real resolver and returns `onGreenClean` for an `.ai-sdlc/agent-role.yaml`
      that resolves to it — no longer falling back to STRICT_DEFAULTS.
- [ ] AC-2: When the resolver cannot be found in ANY location, STRICT_DEFAULTS
      (`allowMerge:'never'`) still applies (fail-closed preserved).
- [ ] AC-3: With `allowMerge=onGreenClean`, `sourceKind='backlog'`,
      `mergeStateStatus=CLEAN`, no branch-protection required contexts, and all
      real check-runs SUCCESS/NEUTRAL/none-pending → helper reports ELIGIBLE.
- [ ] AC-4: Same as AC-3 but with any check-run FAILURE or PENDING → helper
      REFUSES with an auditable reason.
- [ ] AC-5: When the check-runs fetch itself errors (non-zero gh exit / malformed
      output) → helper REFUSES (fail-closed), NOT treated as vacuously green.
- [ ] AC-6: When branch protection DOES expose required contexts, behavior is
      byte-identical to today (required-contexts path still used; no regression).
- [ ] AC-7: Hermetic unit tests for all branches via the injectable `Runner`
      seam — no live `gh`/network/filesystem shell-outs.
- [ ] AC-8: `pnpm --filter @ai-sdlc/pipeline-cli build && test && lint` clean;
      package coverage stays >=80%.

## Non-goals / follow-ups

- The AISDLC-602 `--auto` positional over-block is ALREADY fixed on `main`
  (`enforce-blocked-actions.js` single-positional allowance, shipped post-0.20.0
  in #1047) and only needs a release to reach adopters — NOT part of this task.
- Optional `.ai-sdlc/*` repo-declared required-check-names for fully
  deterministic evaluation is a possible future enhancement; not required here.
- Cutting the plugin release that ships this fix + the #1047 `--auto` fix is a
  separate operator-driven release step.

## References

Original consumer report tracked against RFC-0048 governance. Verified defects at
`pipeline-cli/src/governance/merge-if-eligible.ts` lines 76-81 (Defect 1) and
195-249 (Defect 2).
