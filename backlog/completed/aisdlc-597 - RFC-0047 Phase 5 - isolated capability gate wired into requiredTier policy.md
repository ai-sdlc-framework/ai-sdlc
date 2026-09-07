---
id: AISDLC-597
title: >-
  RFC-0047 Phase 5 — isolated capability gate wired into RFC-0046 requiredTier policy
status: Done
assignee: []
created_date: '2026-09-06'
labels:
  - attestation
  - pipeline-cli
  - rfc-0047
  - rfc-0046
  - phase-5
dependencies:
  - AISDLC-596
references:
  - spec/rfcs/RFC-0047-re-derivable-isolated-anchor.md
  - spec/rfcs/RFC-0046-attested-reviewer-independence.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
RFC-0047 Phase 5 (OQ-5). Flip `requiredTier: isolated` from unsatisfiable to satisfiable now that the `isolated` tier is producible (AISDLC-596) and verifiable (AISDLC-595). This is the seam between RFC-0047 and RFC-0046's `requiredTier` policy engine (AISDLC-591): a single capability source of truth the engine consults.

## Scope
- Add a single `isolatedTierAvailable()` capability check (one source of truth) that returns true once the isolated producer + ci-only verifier path is present/configured (RFC-0046's `requiredTier` policy engine from AISDLC-591 consumes it).
- Before this task ships (i.e. in AISDLC-591's engine), `requiredTier: isolated` MUST warn/reject (unsatisfiable). This task flips the capability true and REMOVES the warn/reject for `isolated`, so a repo can now require it. `requiredTier: none | attested` behavior is unchanged (already shipped in 591).
- Enforcement parity (inherited from RFC-0046 OQ-5): the `requiredTier: isolated` shortfall must block via `ai-sdlc/pr-ready` on branch-protection repos AND via the ship-skill on procedural-gate repos — the same comparison, both surfaces.
- Operator-runbook page: how to set `requiredTier: isolated`, what infra it presupposes (a registered ci-only key + the isolated-review workflow), and the downgrade-with-reason behavior when the anchor is missing.

## Replacement semantics (load-bearing)
This REMOVES the `requiredTier: isolated` unsatisfiability warn/reject that AISDLC-591 shipped as a placeholder. Single source of truth for "isolated available" — do not scatter the capability check (AISDLC-421-class drift risk).

## Acceptance Criteria
- [x] `isolatedTierAvailable()` single source of truth; `requiredTier: isolated` is satisfiable when it returns true and warns/rejects when false — verified by a test asserting BOTH states.
- [x] `requiredTier: isolated` shortfall blocks via `ai-sdlc/pr-ready` (branch-protection) AND the ship-skill (procedural-gate) — hermetic tests for both surfaces.
- [x] `requiredTier: none | attested` behavior unchanged (regression).
- [x] Operator-runbook doc added.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
RFC-0047 §Design Details (5) + OQ-5. Composes with RFC-0046 AISDLC-591 (the policy engine). Frontmatter `dependencies` (AISDLC-596) is authoritative.
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

### Summary
Flipped `isolatedTierAvailable()` (the single RFC-0047 capability source of
truth) to `true` now that the isolated producer (AISDLC-596) and ci-only
verifier re-derivation (AISDLC-595) are both merged. `requiredTier: isolated`
is now a real, enforced policy tier compared via the same
`evaluateIndependencePolicy()` order comparison as `none`/`attested`, on
BOTH enforcement surfaces (`ai-sdlc/pr-ready` branch-protection gate and the
ship-skill procedural-gate invocation) — both already called the same CLI
subcommand (`cli-attestation independence-policy`), so the flip propagates
to both surfaces from the one source-of-truth function.

### Changes
- `pipeline-cli/src/attestation/independence-policy.ts` (modified): flipped
  `isolatedTierAvailable()` to return `true`; added an optional injectable
  `isAvailable` parameter to `evaluateIndependencePolicy()` (defaults to
  `isolatedTierAvailable`) so the hermetic suite can still exercise the
  `unsatisfiable` branch without scattering a second capability switch.
  Updated module/function docstrings.
- `pipeline-cli/src/attestation/independence-policy.test.ts` (modified):
  updated `isolatedTierAvailable` test to assert `true`; added
  satisfiable-state tests for `requiredTier: isolated` (pass on
  `overall=isolated`, shortfall on `attested`/`none`); added a dedicated
  describe block exercising the `unsatisfiable` branch via the injected
  `isAvailable` param; updated the "gate-topology-agnostic enforcement"
  describe block's isolated case to assert both surfaces now agree on
  `pass`/`shortfall` instead of the old always-`unsatisfiable` case.
- `pipeline-cli/src/cli/attestation.ts` (modified): the
  `independence-policy` subcommand now catches a malformed
  `.ai-sdlc/independence-policy.yaml` and fails CLOSED (stderr `ERROR:`,
  `process.exitCode = 1`, no `policyOutcome=` printed) rather than letting
  the parse error propagate as an unhandled rejection. Updated help text.
- `pipeline-cli/src/cli/attestation.test.ts` (modified): added a new
  `cli-attestation independence-policy — exit-code AND-logic` describe
  block mirroring the sibling `verify` CLI test pattern — asserts the
  `status==='valid' && policyOutcome==='pass'` exit-0 AND-logic across
  `none`/`isolated`-shortfall/`isolated`-pass/invalid-status cases, plus an
  end-to-end malformed-policy-config fail-closed test.
- `docs/operations/independence-policy.md` (modified): operator-runbook
  update — replaced the "currently unsatisfiable" limitation section with
  the new satisfiable-state contract, the infra prerequisites (ci-only
  signing key + isolated-review workflow), the downgrade-with-reason
  behavior when the anchor is missing, and the malformed-config fail-closed
  note.

### Design decisions
- **Injectable `isAvailable` param over module-mocking**: rather than
  requiring `vi.mock` gymnastics to hermetically test the (now dormant)
  `unsatisfiable` branch, `evaluateIndependencePolicy()` takes an optional
  second parameter defaulting to the real `isolatedTierAvailable`. No
  production call site passes it — it exists purely so the test suite can
  assert BOTH states of the capability switch per the AC, without
  introducing a second, scattered capability check.
- **Fail-closed on malformed policy at the CLI layer**: `loadIndependencePolicy`
  already threw on an unrecognized `requiredTier` value (AISDLC-591); this
  task adds an explicit try/catch at the CLI handler so the failure mode is
  a clean non-zero exit with a stderr message, not an unhandled promise
  rejection — verified end-to-end, not just at the pure parser level.

### Verification
- `pnpm build` — clean (full monorepo build).
- `pnpm test` — full suite: 6 pre-existing failures in
  `pipeline-cli/src/cli/bin-invocation.test.ts` (pnpm-exec-umbrella-bin
  guard, environment-dependent) and `pipeline-cli/src/tui/app.test.tsx`
  (Ink render timeouts), both called out as known pre-existing/unrelated in
  the task brief. Zero attestation/RFC-0046/RFC-0047 regressions — all
  109→114 tests in `independence-policy.test.ts` +
  `cli/attestation.test.ts` pass, including the updated isolated-satisfiable
  semantics and the new CLI-level tests. All other workspaces
  (`orchestrator`, `dashboard`, `conformance/runner`, `mcp-advisor`,
  `dogfood`) pass in full.
- `pnpm lint` — clean.
- `pnpm format:check` — clean.

### Follow-up
(none)
