---
id: aisdlc-575
title: Ship a consumer-runnable `attestation verify` CLI subcommand (plugin-less CI verify entrypoint)
status: Done
priority: high
labels:
  - attestation
  - adoption
  - proof-of-execution
  - aisdlc-566-followup
---

## Description

AISDLC-566 shipped a consumer-runnable verifier, but ONLY as a plugin-shipped script
(`ai-sdlc-plugin/scripts/verify-attestation.mjs` + a core module that this task later
moved to `pipeline-cli/attestation-core/verify-core.mjs` — see Scope/Implementation
Notes below). A
consumer's GitHub Actions runner has **no plugin installed** and there is **no
npm-published verify CLI**: the published `@ai-sdlc/pipeline-cli` `ai-sdlc` bin
(`pipeline-cli/src/cli/attestation.ts`) exposes `sign-v6`, `emit-leaf`, `inspect-v6`,
and `merkle-proof` (whose `--verify` flag only checks a Merkle *inclusion proof*, not a
full DSSE envelope). So an adopter's CI cannot cleanly run the full-envelope verifier —
the AISDLC-566 adopter recipe is written monorepo-centric (`node
ai-sdlc-plugin/scripts/verify-attestation.mjs`), which doesn't exist on a consumer runner.

The verify LOGIC exists in published/near-published form but split:
- `orchestrator/src/runtime/attestations.ts` exports `verifyAttestation()` (published runtime).
- The plugin-only core module (pre-fix location: `ai-sdlc-plugin/scripts/`) exports
  `verifyV6Envelope()` with the head-binding relaxations (AISDLC-419/448
  tree-equivalence), realpath containment (AISDLC-570), etc. — moved to
  `pipeline-cli/attestation-core/verify-core.mjs` by this task.
- `scripts/verify-attestation.mjs` (repo CI verifier) is monorepo-only.

Goal: a consumer runs `npx @ai-sdlc/pipeline-cli attestation verify --head <sha> --base
<sha>` in CI, with NO plugin — invoking the **canonical** verifier.

## Scope

1. **Determine the canonical verify** and DO NOT add a 4th copy. Investigate whether
   `orchestrator/runtime`'s `verifyAttestation` and the plugin core's `verifyV6Envelope`
   are equivalent or whether the plugin core is the fuller/authoritative one (it carries
   the AISDLC-419/448/570 relaxations + containment). The security-critical requirement:
   ONE canonical implementation that the new CLI subcommand, the plugin wrapper, AND the
   repo CI verifier all call — a vendored/drifting copy of the verifier can false-accept
   or false-reject (this is exactly the AISDLC-566 trust-boundary concern). If the
   canonical logic must move into a published package (pipeline-cli or the orchestrator
   runtime) to be reachable from the bin, do that consolidation and repoint the plugin
   wrapper + CI verifier at it.
2. **Add `attestation verify` to the published pipeline-cli bin** (`cli/attestation.ts`):
   `--head <sha> --base <sha>` (mirror the repo verifier's PR_HEAD_SHA/PR_BASE_SHA
   inputs), resolve the orchestrator runtime the SAME trusted way the signer does
   (AISDLC-554 candidate-walk; MIN_RUNTIME_VERSIONS floor per AISDLC-574 — do NOT trust a
   path inside an untrusted checkout, per AISDLC-566/570 containment), print
   `status=valid|invalid` + reason, exit non-zero on invalid/failure. Fail CLOSED.
3. **Update the adopter recipe** (`docs/operations/adopter-attestation-verify-ci.md`) to
   use `npx @ai-sdlc/pipeline-cli attestation verify ...` instead of the plugin-only path,
   with the trusted-install note (install the pinned runtime; don't rely on PR-committed
   runtime — AISDLC-566/570).
4. Keep the repo's own `.github/workflows/verify-attestation.yml` working (no regression).

## Acceptance Criteria

- [x] `npx @ai-sdlc/pipeline-cli attestation verify --head <sha> --base <sha>` runs a full
      v6 DSSE envelope verify with NO plugin present, returns correct pass/fail, exits
      non-zero on invalid, and fails closed on unresolvable/tampered input.
- [x] The verifier logic is single-sourced (no new copy): the new subcommand + plugin
      wrapper + repo CI verifier all call one canonical implementation; a drift/dup guard
      test asserts there is not more than one verifyV6Envelope implementation shipped.
- [x] Runtime resolved only from trusted locations (candidate-walk + MIN_RUNTIME_VERSIONS
      floor), never from inside the checkout under verification (AISDLC-566/570 preserved).
- [x] Adopter recipe updated to the npx entrypoint with the trusted-install note.
- [x] `.github/workflows/verify-attestation.yml` still passes (no regression).
- [x] Hermetic tests: valid envelope → pass; tampered → fail/non-zero; missing runtime →
      fail closed; run from a node_modules-style layout (not the monorepo checkout).
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Implementation Notes

Consolidated the canonical verifier: `verify-attestation-core.mjs` moved out of the
plugin package (`ai-sdlc-plugin/scripts/`) into the PUBLISHED `@ai-sdlc/pipeline-cli`
package at `pipeline-cli/attestation-core/verify-core.mjs` — a plain, dependency-free
ESM module (no TypeScript, no build step) so the exact same bytes are importable by:

- `pipeline-cli/src/cli/attestation.ts`'s new `verify` subcommand — colocated relative
  import via `pipeline-cli/src/attestation/verify-core-loader.ts` (dynamic `import()`
  built from a runtime `URL`, so TypeScript never attempts static resolution against
  the untyped sibling file).
- `ai-sdlc-plugin/scripts/verify-attestation.mjs` (plugin-installed consumer path) —
  now resolves TWO trusted packages (`@ai-sdlc/orchestrator` for runtime primitives,
  `@ai-sdlc/pipeline-cli` for the verify-core module itself) via the same
  trusted-locations-only candidate walk it already used for the runtime.
- `scripts/verify-attestation.mjs` (repo CI verifier) — monorepo-relative import
  repointed at the new path, behavior unchanged.

New TS module `pipeline-cli/src/attestation/verify-runtime.ts` is a faithful port of
the plugin's `@ai-sdlc/orchestrator` trusted candidate-walk (duplicated deliberately —
pipeline-cli cannot depend on `ai-sdlc-plugin`, which isn't an npm package) preserving
containment (`isInsideRepoRoot`) and the MIN_RUNTIME_VERSIONS floor (bumped to 0.19.0
per AISDLC-574's rationale — the plugin's verify-side floor had been missed by that
bump; fixed here too). `attestation verify --head <sha> --base <sha>` validates both
SHAs as 40-hex, resolves the runtime, loads the colocated verify-core, and prints
`status=valid|invalid` + `reason=...`, exiting 0/1/2 exactly like the plugin driver.

Real invocation form (there is no bin literally named `pipeline-cli`, so bare
`npx @ai-sdlc/pipeline-cli attestation verify` as originally phrased does not resolve):
`npx --package=@ai-sdlc/pipeline-cli cli-attestation verify --head <sha> --base <sha>`,
or install the package and run `node node_modules/@ai-sdlc/pipeline-cli/bin/cli-attestation.mjs verify ...`.
The adopter doc and PR body use the explicit installed-bin form.

Verified end-to-end locally: built `@ai-sdlc/orchestrator` + `@ai-sdlc/pipeline-cli`,
planted a fixture runtime under a synthetic `$CLAUDE_PLUGIN_ROOT`, and ran
`cli-attestation verify` against this repo's own real v6 envelope — got
`status=valid`/`reason=ok`/exit 0. Confirmed fail-closed with no runtime installed
(exit 2, actionable message).

Added a dup-guard test (`pipeline-cli/src/attestation/verify-core-dup-guard.test.ts`)
that scans the whole repo (excluding `node_modules`/`dist`) for
`function verifyV6Envelope(` definitions and asserts there is exactly one, in
`pipeline-cli/attestation-core/verify-core.mjs`.

Test coverage: unit tests for the new resolver
(`verify-runtime.test.ts`) and loader (`verify-core-loader.test.ts`), plus one new
subprocess e2e test in `ai-sdlc-plugin/scripts/verify-attestation.test.mjs` proving
fail-closed when the orchestrator runtime resolves but the pipeline-cli verify-core
module does not. All 6 existing success-path e2e tests in that file were updated to
install BOTH trusted dependencies (via a new `installTrustedVerifyDeps` helper) since
the driver now resolves two packages instead of one.

### Follow-up (not done here, flagged per task's escalation option)

Full single-sourcing was completed for the v6 path (the security-critical concern the
task called out); the legacy v3/v4/v5 helpers in `verify-core.mjs` also moved wholesale
as part of the same file (they were never split out — the whole module moved together)
so there is no remaining fork. `eslint.config.mjs` gained a `pipeline-cli/attestation-core/`
ignore entry (mirrors the prior `**/scripts/` ignore that covered this file at its old
location) since it's plain JS outside any tsconfig `include`.

## Note

Composes with AISDLC-574 (runtime pin bump — so the plugin path also gets ≥0.19.0) and
[[aisdlc-558]] (single-source manifests). This closes the last consumer-CI gap in the
Proof-of-Execution adoption path: sign (554), runtime (574), and now a plugin-less
verify entrypoint. Honest limits from AISDLC-568/570/572 are unchanged.
