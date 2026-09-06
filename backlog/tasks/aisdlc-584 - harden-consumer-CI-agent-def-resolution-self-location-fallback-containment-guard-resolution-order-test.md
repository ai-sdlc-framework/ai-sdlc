---
id: AISDLC-584
title: >-
  doctor/attestation: harden consumer-CI agent-def resolution — self-location
  fallback + containment-guard symmetry + resolution-order test
status: To Do
assignee: []
created_date: '2026-09-06 03:44'
labels:
  - adoption
  - attestation
  - pipeline-cli
  - consumer-repo
  - aisdlc-583-followup
dependencies: []
references:
  - >-
    backlog/completed/aisdlc-583 -
    Fix-cli-attestation-verify-fails-closed-in-consumer-repos-resolve-reviewer-agent-definition-files-from-installed-plugin.md
priority: medium
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Context
Follow-up to AISDLC-583 (merged via PR #1013), which fixed `cli-attestation verify` failing closed in consumer repos by resolving reviewer agent-definition files from the installed plugin. All three reviewers APPROVED; these are the non-blocking minor findings they surfaced, consolidated.

**Important scoping:** the `agentFileHash` binding these findings concern is consumed ONLY on the legacy v3/v4/v5 verify path — `runVerifier` returns on the v6 fast-path BEFORE the agent-dir is ever read. v6 (the default schema) is unaffected. So this is defense-in-depth hardening for the shrinking set of adopters still verifying legacy envelopes; it does NOT affect v6 adopters (e.g. local-trades). Prioritize accordingly (medium/low).

## Findings to address

### 1. Self-location fallback for the plugin-script driver (code-reviewer + security-reviewer, convergent)
`ai-sdlc-plugin/scripts/verify-attestation.mjs`'s `resolvePluginAgentDir` (~line 220) resolves the agent dir ONLY from `CLAUDE_PLUGIN_DIR`/`CLAUDE_PLUGIN_ROOT` env vars — unlike `trustedRuntimeModuleCandidates()`, which also walks up `node_modules` from the script's own on-disk location. Per this PR's own `docs/operations/adopter-attestation-verify-ci.md`, those env vars are absent in the documented plain-CI recipe, so `resolvePluginAgentDir()` returns null on essentially every adopter CI run using this driver → the legacy `agentFileHash` binding downgrades (warned, never false-valid) for ALL reviewers rather than being enforced. Fix EITHER:
  - (a) add a self-location / node_modules-adjacent `agents/` probe to this driver mirroring the runtime-module fallback — **with a fixture-path guard** to avoid the test-environment false positive the AISDLC-583 dev flagged (self-location resolved the monorepo's real `ai-sdlc-plugin/agents/` instead of the test fixture); OR
  - (b) update the CI-recipe docs (`docs/operations/adopter-attestation-verify-ci.md`) to explicitly set `CLAUDE_PLUGIN_ROOT` in the plugin-installed recipe so the binding is actually enforceable as documented.
  Option (a) is the real fix; (b) is the minimum if the fixture-guard proves fiddly.

### 2. Containment-guard symmetry (security-reviewer)
`pipeline-cli/src/attestation/agent-dir-resolver.ts` `resolveInstalledPluginAgentDir()` has no containment guard, whereas the plugin-script driver applies an `isInsideRepoRoot`-style guard. Non-exploitable (agentDir is only `existsSync`/`readFileSync`'d for fixed `${agentId}.md` hashing, never `import()`ed), but mirroring the guard keeps the two drivers symmetric and prevents a future maintainer from wiring the resolved dir into an executable path without the guard.

### 3. Resolution-order test assertion (test-reviewer)
`scripts/verify-attestation.test.mjs` (~line 490): add one test that exercises the 'both an injected agentDir AND a repo-relative `ai-sdlc-plugin/agents` exist' case to confirm the injected (installed-plugin) dir WINS. Each current test isolates one tier by rmSync-ing the other, so the precedence branch of `resolveAgentDefinitionDir` is the last untested branch of the resolution-order contract.

## Acceptance Criteria
- [ ] Plugin-script driver resolves the agent dir in the documented plain-CI recipe (self-location probe with fixture-guard) OR the recipe docs set `CLAUDE_PLUGIN_ROOT` — the legacy `agentFileHash` binding is enforceable (not universally downgraded) for a properly-installed adopter; hermetic tests cover it without the monorepo false-positive.
- [ ] `resolveInstalledPluginAgentDir()` mirrors the plugin-script driver's containment guard.
- [ ] A resolution-order test asserts the injected installed-plugin dir wins when both it and the repo-relative dir exist.
- [ ] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## References
Follow-up to AISDLC-583 (PR #1013). Legacy-verify defense-in-depth only; v6 default path unaffected.
<!-- SECTION:DESCRIPTION:END -->
