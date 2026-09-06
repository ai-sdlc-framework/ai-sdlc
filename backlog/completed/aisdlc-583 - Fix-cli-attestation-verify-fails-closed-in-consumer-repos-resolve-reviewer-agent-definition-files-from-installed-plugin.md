---
id: AISDLC-583
title: >-
  Fix: cli-attestation verify fails-closed in consumer repos — resolve reviewer
  agent-definition files from the installed plugin, not the monorepo path
status: Done
assignee: []
created_date: '2026-09-06 03:17'
updated_date: '2026-09-05'
labels:
  - adoption
  - attestation
  - pipeline-cli
  - consumer-repo
  - bug
dependencies: []
references:
  - pipeline-cli/attestation-core/verify-core.mjs
  - backlog/completed/aisdlc-575 - ship-a-consumer-runnable-attestation-verify-cli-subcommand.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (confirmed 2026-09-06 against @ai-sdlc/pipeline-cli@0.20.1)

`cli-attestation verify` (`attestation-core/verify-core.mjs`, `runVerifier`) computes `expectedAgentFileHashes` by reading each reviewer agent-definition file from a MONOREPO-ONLY path:

```js
const agentDir = join(repoRoot, 'ai-sdlc-plugin', 'agents');           // line 2448
...readFileSync(join(agentDir, `${a}.md`), 'utf-8')                     // line 2462 (unguarded)
```

In a **consumer/adopter repo** the plugin is an npm/marketplace install and is NEVER present in the repo tree, so `readFileSync` throws `ENOENT: ... /ai-sdlc-plugin/agents/code-reviewer.md`. This happens during verifier SETUP — before any envelope for the head/base range is evaluated — so it is NOT envelope-dependent and cannot be worked around by producing an envelope. Result: `verify-attestation` CI is RED on 100% of PRs in every adopter repo, making the v6 gate unusable for adoption and blocking any "verify-attestation green before merge" policy.

There are THREE unguarded read sites in `runVerifier`: lines **2462, 2578, 2619** (all read `join(repoRoot, 'ai-sdlc-plugin', 'agents', `${a}.md`)`).

Contrast: the immediately-following `pluginVersion` read (line ~2469) IS guarded with `existsSync` ("we tolerate the file being missing in test fixtures"). The agent-file reads were left on the old monorepo assumption. This is the same consumer-repo-vs-monorepo class AISDLC-575 ("plugin-less consumer verify") set out to remove; the `agentFileHash` binding check still assumes the monorepo layout.

## Why the binding needs the files

The v6 predicate binds each reviewer AGENT DEFINITION (its file hash) so a verifier can confirm the attested review was produced by the expected reviewer-agent version. To check that in a consumer repo, the verifier must resolve the agent definitions from the INSTALLED PLUGIN, not a repo-relative path only the monorepo has.

## Fix (hybrid — resolve-from-plugin with a guarded downgrade)

Mirror the existing `bindRuntime()` pattern (AISDLC-566): the driver `dist/cli/attestation.js` already resolves `@ai-sdlc/orchestrator/runtime` from OUTSIDE the checkout and injects it into `verify-core.mjs` precisely because a monorepo-relative import "only resolves inside this monorepo checkout." Do the same for the reviewer agent dir:

1. **Resolve the agent-definition dir from the installed plugin first.** The driver resolves the installed `ai-sdlc` plugin's `agents/` directory — via `CLAUDE_PLUGIN_ROOT` env, else node resolution of the plugin package, else the `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/agents` cache probe — and injects it into `runVerifier` (a resolved `agentDir` or an `agentDirResolver`), the same way it injects the orchestrator runtime. This preserves the binding's value for a properly-installed adopter.
2. **Fall back to the repo-relative `<repoRoot>/ai-sdlc-plugin/agents`** so the monorepo self-verify keeps working unchanged (regression-critical).
3. **If neither resolves, guard the read (existsSync per file, mirroring `pluginVersion`) and DOWNGRADE-WITH-WARNING:** skip `agentFileHash` for the missing agent and emit a clear stderr warning naming the downgrade. This weakens the binding to "the reviewer role was present" without pinning the agent-definition version — it MUST be a deliberate, documented downgrade, and it must NEVER throw ENOENT during setup (fail-open on setup, not fail-closed).

**All three read sites (2462, 2578, 2619) MUST use the same resolver** — no asymmetry (asymmetric resolution reproduces the AISDLC-421 signer/verifier-drift bug class).

## Acceptance Criteria
- [x] Consumer-repo fixture (no `ai-sdlc-plugin/` in tree; agent files resolvable only from an injected installed-plugin dir) → verify resolves `expectedAgentFileHashes` from the injected dir, enforces the binding, and does NOT throw ENOENT.
- [x] Neither repo path nor installed plugin exposes the agent files → verify does NOT throw; skips `agentFileHash` with a stderr warning; still evaluates signature, Merkle root, diff/policy binding, and verdictClass.
- [x] Monorepo layout (repo-relative `ai-sdlc-plugin/agents` present) still resolves + enforces exactly as before (regression guard).
- [x] All three read sites (2462/2578/2619) use one shared resolver; no unguarded readFileSync remains in `runVerifier`.
- [x] The downgrade path is documented (code comment + a `docs/operations/` note) as a deliberate binding weakening.
- [x] A consumer-repo repro (the LT-540 shape: `cli-attestation verify --head <sha> --base <sha>` with a valid v6 envelope present) verifies GREEN after the fix.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Release note
Ships in `@ai-sdlc/pipeline-cli` (and possibly the driver in the same package). Adopters on `^0.20` pick it up automatically once release-please publishes the patched version — call out in the PR body that this needs a release to reach consumer repos.

## References
- Consumer report: local-trades (LT-540) — v6 adopted, verify red on every PR since due to this ENOENT (not a missing envelope). 11 PRs merged with independent reviews recorded in PR comments but no DSSE envelope, because producing one cannot make this verify pass.
- AISDLC-575 (plugin-less consumer verify — the effort this bug slipped through), AISDLC-566 (`bindRuntime` driver-injection pattern to mirror), AISDLC-579 (attestation-core single-sourcing).
<!-- SECTION:DESCRIPTION:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary
Fixed `cli-attestation verify` failing closed (`ENOENT`) in every consumer/adopter repo during verifier setup, by adding a single shared, guarded resolver for the reviewer agent-definition directory used at all three `agentFileHash` read-sites in `runVerifier`, with a driver-injected installed-plugin dir as the primary source, a repo-relative monorepo fallback, and a deliberate downgrade-with-warning when neither resolves.

## Changes
- `pipeline-cli/attestation-core/verify-core.mjs` (modified): added `resolveAgentDefinitionDir()` (injected dir → repo-relative → null) and `buildExpectedAgentFileHashes()` (per-file `existsSync` guard, never throws, warns + omits missing agentIds). All three read sites now share ONE computed `expectedAgentFileHashes` map — the two fast-path sites no longer re-read files at all.
- `pipeline-cli/src/attestation/agent-dir-resolver.ts` (new): `resolveInstalledPluginAgentDir()` — resolves `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DIR`/`agents`, then the `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<version>/agents` cache probe (highest version wins).
- `pipeline-cli/src/cli/attestation.ts` (modified): `verify` subcommand resolves the installed-plugin agent dir and injects it into `runVerifier({ agentDir })`, mirroring the existing `bindRuntime()` injection.
- `pipeline-cli/src/attestation/verify-core-loader.ts` (modified): added `agentDir?: string` to the `runVerifier` type signature.
- `ai-sdlc-plugin/scripts/verify-attestation.mjs` (modified): added an env-var-only `agentDirCandidates()`/`resolvePluginAgentDir()` resolver and injects `agentDir` into `runVerifier`, mirroring the pipeline-cli driver (no self-location fallback here — that resolved to the wrong dir in the driver's own hermetic in-place tests; env vars are always set in real plugin-session invocations per the file's own docblock).
- `scripts/verify-attestation.test.mjs` (modified): added a new describe block, "runVerifier (AISDLC-583 — consumer-repo agent-dir resolution)" — consumer-repo injected-dir resolution + enforcement, no-source-anywhere downgrade (no throw + stderr warning + still valid), and a monorepo-layout regression guard.
- `pipeline-cli/src/attestation/agent-dir-resolver.test.ts` (new): unit tests for the resolver's env-var precedence and no-throw guarantee.
- `docs/operations/attestation-troubleshooting.md` (modified): new "ENOENT ... ai-sdlc-plugin/agents" symptom section documenting the fix and the deliberate downgrade as expected/non-fatal.

## Design decisions
- **Single shared resolver, not per-site duplication**: the original bug had TWO of the three read sites independently duplicating the same monorepo-only path — an AISDLC-421-class asymmetric-resolution risk. The fix computes `expectedAgentFileHashes` ONCE and reuses the same object at all downstream sites, structurally eliminating the possibility of drift.
- **Downgrade is per-agentId, not all-or-nothing**: `buildExpectedAgentFileHashes` omits only the agentIds whose file it couldn't find, so a partially-installed plugin (or partially-populated monorepo agents dir) still enforces the binding for every agent it CAN resolve.
- **No self-location fallback in the plugin driver**: attempted this mirroring `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh`'s self-location pattern, but it broke the driver's own hermetic tests (which run the script in-place from the monorepo checkout, so self-location resolved to the monorepo's REAL agents dir instead of the test fixture's intended source) — removed in favor of env-var-only resolution, which is always populated in a real plugin-session invocation.

## Verification
- `pnpm --filter @ai-sdlc/pipeline-cli build` — clean
- `pnpm --filter @ai-sdlc/pipeline-cli test` — 317 files passed; 2 pre-existing/unrelated failures confirmed present on a clean `origin/main` checkout too (a `pnpm exec` bin-resolution environment difference in `bin-invocation.test.ts`, and a flaky Ink TUI render timeout in `app.test.tsx`/`use-terminal-dimensions.test.tsx`) — zero failures in any attestation-related test file (222/222 pass in `pipeline-cli/src/attestation/`)
- `node --test scripts/verify-attestation.test.mjs` — 146/147 pass (1 pre-existing `todo`), including the 4 new AISDLC-583 tests
- `node --test ai-sdlc-plugin/scripts/verify-attestation.test.mjs` — 16/16 pass
- `pnpm lint` — clean
- `pnpm format:check` — clean
- Monorepo self-verify regression check: `PR_HEAD_SHA=<head> PR_BASE_SHA=<merge-base> node scripts/verify-attestation.mjs` → `status=valid reason=ok verdictClass=self-authored` (unchanged)

## Follow-up
Ships in `@ai-sdlc/pipeline-cli` (and the plugin bundle) — needs a release-please release to reach consumer repos; adopters on `^0.20` pick it up automatically once published.
<!-- SECTION:FINAL_SUMMARY:END -->
