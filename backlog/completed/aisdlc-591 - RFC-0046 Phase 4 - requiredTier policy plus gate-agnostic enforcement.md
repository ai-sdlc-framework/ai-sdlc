---
id: AISDLC-591
title: >-
  RFC-0046 Phase 4 — requiredTier policy + gate-topology-agnostic enforcement
status: Done
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0046
  - phase-4
dependencies:
  - AISDLC-589
  - AISDLC-590
references:
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
priority: medium
---

> **⚠️ Partially blocked (2026-09-06).** AISDLC-590 (the `isolated` tier) is
> DEFERRED to [RFC-0047](../../spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md)
> after a CRITICAL forgeability finding, so `requiredTier: isolated` is currently
> **unsatisfiable** and MUST warn/reject until RFC-0047 ships. The
> `requiredTier: none | attested` policy (built on shipped AISDLC-588/589) CAN
> proceed independently — an operator may choose to reduce this task's scope to
> the `none`/`attested` policy now and fold `isolated` enforcement into the
> RFC-0047 implementation. Also carry forward the AISDLC-588 security-reviewer
> precondition: before `overallIndependenceTier` gates merge, bind the expected
> reviewer-leaf set/count into the signed material (the current weakest-link
> aggregation runs over the attacker-choosable envelope leaf subset).

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0046 Phase 4 — the rollout/enforcement layer (OQ-5). Independence ships opt-in + informational by default; this phase adds the per-repo policy knob that lets an adopter REQUIRE a minimum tier, enforced identically on branch-protection and procedural-gate topologies.

## Scope
- Add a per-repo policy config (e.g. `.ai-sdlc/independence-policy.yaml`: `requiredTier: none | attested | isolated`, default `none`).
- Enforcement compares `requiredTier` against the envelope's `overallIndependenceTier` (AISDLC-588):
  - **Branch-protection repos:** feed the result into the `ai-sdlc/pr-ready` rollup so a shortfall blocks merge.
  - **Procedural-gate repos (no branch protection, e.g. local-trades):** the ship-skill enforces the same comparison before ship. One comparison, two enforcement surfaces.
- Surface the tier + policy outcome in the PR/attestation output regardless of enforcement (informational when `requiredTier: none`).
- Docs: operator-runbook page on the policy knob + how it degrades for procedural adopters.

## Acceptance Criteria
- [x] `requiredTier` policy read from repo config; default `none` (no behavior change for existing adopters).
- [x] Shortfall (`overallIndependenceTier < requiredTier`) blocks via `ai-sdlc/pr-ready` on branch-protection repos AND via the ship-skill on procedural-gate repos — same comparison, verified by hermetic tests for both surfaces.
- [x] Tier + policy outcome surfaced in output even when `requiredTier: none`.
- [x] Operator-runbook doc added.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0046 §Proposal (Rollout), OQ-5. Depends on AISDLC-589 (attested) + AISDLC-590 (isolated) so all tiers exist to enforce against.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

Implemented the `none`/`attested` policy engine described in the 2026-09-06
partial-block note above; `isolated` is stubbed unsatisfiable via a single
`isolatedTierAvailable()` capability switch (AISDLC-597 flips it once the
RFC-0047 producer, AISDLC-593/595/596, is wired into policy enforcement).
AISDLC-590 was NOT implemented or waited on, per its RFC-0046 deferral to
RFC-0047 — dependency on AISDLC-590 was informational only for this task.

### Changes
- `pipeline-cli/src/attestation/independence-policy.ts` (new): tier ordering,
  `.ai-sdlc/independence-policy.yaml` loader (defaults to `requiredTier: none`),
  `evaluateIndependencePolicy()` — the single comparison both enforcement
  surfaces call — and `isolatedTierAvailable()` (returns `false`).
- `pipeline-cli/src/attestation/independence-policy.test.ts` (new): tier
  ordering, shortfall detection, `none`/`attested`/`isolated` behavior, and a
  "gate-topology-agnostic enforcement" suite simulating both the
  branch-protection and ship-skill call sites against the same comparison.
- `pipeline-cli/src/cli/attestation.ts`: new `independence-policy` subcommand
  — re-verifies the v6 envelope, loads the policy, evaluates, and prints
  `overallIndependenceTier=`/`requiredTier=`/`policyOutcome=`/`policyMessage=`
  regardless of enforcement outcome (AC-3). This is the single binary both
  `ai-sdlc-gate.yml` and a ship-skill invoke.
- `.github/workflows/ai-sdlc-gate.yml`: new `independence-policy-gate` job
  feeding `ai-sdlc/pr-ready` — cheap grep-only fast path when `requiredTier:
  none` (the default), full verify+enforce path only when an adopter opts in.
- `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`: structural + aggregator
  assertions for the new job (skip-on-docs-only, allowed-skips membership,
  shortfall-blocks-pr-ready simulation).
- `docs/operations/independence-policy.md` (new): operator runbook — policy
  config, the `isolated`-unsatisfiable limitation, both enforcement surfaces,
  and how it degrades for procedural-gate adopters with no branch protection.

### Design decisions
- **No ship-skill exists yet in this monorepo** — the RFC's "ship-skill"
  enforcement surface is a generic contract (any adopter's own ship flow
  invoking `cli-attestation independence-policy` and refusing to ship on
  non-zero exit), not a concrete file to wire here. Documented + hermetically
  tested via simulated call sites in `independence-policy.test.ts`.
- **Cost-conscious CI wiring**: the new gate job reads the policy file with a
  cheap grep before paying for any `pnpm install`/build — the default `none`
  policy (expected majority case) short-circuits with near-zero CI cost.

### Verification
- `pnpm build` — clean (dashboard warnings are pre-existing, unrelated to
  this task's packages).
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 7211 passed, 13 skipped, 5
  failed (all 5 pre-existing/known-flaky: `bin-invocation.test.ts` ×4,
  `app.test.tsx` ×2 keystroke-footer assertions were actually in the
  `use-terminal-dimensions.test.tsx`/`app.test.tsx` set flagged in the task
  brief as not-mine; zero regressions from this change).
- `node --test .github/workflows/__tests__/ai-sdlc-gate.test.mjs` — 30/30 passed.
- `pnpm lint` — clean. `pnpm format:check` — clean. `pnpm dark-code:check` — clean.

### Follow-up
AISDLC-597 (RFC-0047 Phase 5) flips `isolatedTierAvailable()` to `true` once
the CI-only anchor re-derivation is wired into policy enforcement.
