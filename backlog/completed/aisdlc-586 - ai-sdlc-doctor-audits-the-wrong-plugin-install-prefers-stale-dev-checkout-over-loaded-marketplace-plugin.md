---
id: AISDLC-586
title: >-
  ai-sdlc doctor audits the wrong plugin install — prefers a stale dev checkout
  over the loaded marketplace plugin, and never reports which install it audited
status: Done
assignee: []
created_date: '2026-09-06 17:17'
labels:
  - adoption
  - cli
  - doctor
  - topology-resolution
  - bug
dependencies: []
references:
  - orchestrator/src/cli/commands/doctor-checks.ts
  - >-
    backlog/completed/aisdlc-583 -
    Fix-cli-attestation-verify-fails-closed-in-consumer-repos-resolve-reviewer-agent-definition-files-from-installed-plugin.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem (surfaced running doctor in an adopter env, 2026-09-06)

`ai-sdlc doctor` reported `plugin-version v0.9.2` and `runtime-deps-caret-trap pipeline-cli ^0.10.0` — but those describe a STALE DEV CHECKOUT (`~/Documents/dev/.../ai-sdlc-plugin`, node_modules frozen at pipeline-cli 0.10.0), NOT the marketplace plugin Claude Code actually loaded (v0.18.0). doctor's whole value is auditing the LIVE install; here it audited the wrong one and produced misleading version/pin reads, while giving the operator no signal that it had.

## Root cause
`resolvePluginDir` (orchestrator/src/cli/commands/doctor-checks.ts) resolution order:
1. `CLAUDE_PLUGIN_ROOT` env
2. `<projectDir>/ai-sdlc-plugin`  ← preferred over the marketplace cache
3. `<projectDir>/node_modules/ai-sdlc-plugin`
4. marketplace-cache scan (`~/.claude/plugins/cache/*/ai-sdlc/*`)

**Confirmed second root cause (lexical version sort):** the cache scan picks the "lexicographically highest" version dir, so `"0.9.0" > "0.18.0"` as STRINGS (9 > 1) — doctor selected the ancient cached `0.9.0` (v0.9.2, pipeline-cli ^0.10.0) over the loaded `0.18.0` (^0.21.0). Verified 2026-09-06: `~/.claude/plugins/cache/ai-sdlc-local/ai-sdlc/0.18.0/plugin.json` carries ^0.21.0 pins; the 0.9.0 dir carries ^0.10.0. Fix: use semver comparison (reuse `compareVersionStrings` from AISDLC-583`s agent-dir-resolver), not lexical.

When `CLAUDE_PLUGIN_ROOT` isn't the loaded plugin (or `<projectDir>` resolves to/near a monorepo checkout), candidate #2 wins and doctor audits a dev checkout instead of the marketplace install Claude Code loaded. It also does not report WHICH install path + version it audited, so a wrong read is invisible.

## Fix
1. **Audit the plugin Claude Code actually loaded first.** Prefer the harness-injected `CLAUDE_PLUGIN_ROOT` / `CLAUDE_PLUGIN_DIR`, then the marketplace cache (highest version), and only fall back to a repo-local `ai-sdlc-plugin/` when nothing else resolves. Reuse the `resolveInstalledPluginAgentDir` pattern from AISDLC-583 for consistent installed-plugin resolution.
2. **Always report which install doctor audited** — print the resolved plugin path + version in the report header (e.g. `Auditing: ~/.claude/plugins/cache/<mp>/ai-sdlc/0.18.0 (marketplace)` vs `<repo>/ai-sdlc-plugin (dev checkout)`), so a stale/wrong read is self-evident.
3. **Detect multi-install ambiguity** — when BOTH a repo-local `ai-sdlc-plugin/` AND a marketplace cache install exist and disagree on version, emit a WARN naming both (the exact situation here: dev checkout v0.9.2 vs marketplace v0.18.0).
4. The `marketplace-catalog-drift` check returning "insufficient data" in this same run is a related symptom — it couldn't resolve the catalog cache vs source; folding the install-resolution fix should let it compare.

## Acceptance Criteria
- [x] With a marketplace install present, doctor audits IT (not a repo-local dev checkout) and reports its path + version in the header.
- [x] When repo-local and marketplace installs disagree, doctor WARNs naming both versions/paths.
- [x] Hermetic tests: (a) marketplace-only → audits marketplace; (b) dev-checkout + marketplace disagree → audits marketplace + ambiguity warn; (c) adopter node_modules install → audits it.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Same topology-resolution class as AISDLC-583/584 (consumer-vs-monorepo). Composes with AISDLC-582 (doctor remaining checks). Adoption-relevant: doctor must be trustworthy in a real adopter environment (where a dev checkout may coexist with a marketplace install).
<!-- SECTION:DESCRIPTION:END -->

## Implementation Notes

`resolvePluginDir` / new `resolvePluginInstall` in `orchestrator/src/cli/commands/doctor-checks.ts` now resolve in this order: `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DIR` env → marketplace cache (SEMVER-highest, via the existing `compareSemver` helper — no lexical sort) → `<projectDir>/node_modules/ai-sdlc-plugin` (adopter) → `<projectDir>/ai-sdlc-plugin` (dev checkout, demoted to last resort). A new `plugin-install-ambiguity` check WARNs, naming both paths+versions, when a repo-local checkout and a marketplace install coexist and disagree. `renderFullDoctorReport` now takes an optional `ResolvedPluginInstall` and prints an `Auditing: <path> (<source> v<version>)` header line; `doctor.ts`'s `--format json` output also includes the resolved `install` object. `marketplace-catalog-drift` benefits automatically since it also calls `resolvePluginDir`.
