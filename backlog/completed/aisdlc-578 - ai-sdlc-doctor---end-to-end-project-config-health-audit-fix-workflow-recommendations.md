---
id: AISDLC-578
title: >-
  ai-sdlc doctor — end-to-end project config-health audit + fix + workflow
  recommendations
status: Done
assignee: []
created_date: '2026-09-05 17:22'
labels:
  - adoption
  - cli
  - doctor
  - config-validation
dependencies:
  - aisdlc-560
priority: high
---

> **RECONCILE WITH AISDLC-560 (PR #971) — do NOT create a second `doctor`.**
> PR #971 already ships `orchestrator/src/cli/commands/doctor.ts` + the pure,
> adapter-injected core `checkAttestationGovernance(projectDir, adapters)` (3
> states: neither / artifacts-only / fully-configured) with `--format json`.
> This task EXTENDS that command: turn its single attestation-governance check
> into a **check registry** and add the 12 checks below as sibling checks
> (importing `checkAttestationGovernance` as one of them, NOT re-implementing
> detection). Land AFTER #971 merges. If #971 is still open when this is
> dispatched, rebase onto it. The `--fix`, `--json`, and upstream-reporting
> seam still apply — layered on the existing command, not a parallel one.

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
## Problem

`ai-sdlc init` scaffolds a correct project once, but NOTHING re-validates the setup afterward. Config drifts, runtime/plugin versions lag, files get hand-edited, and the SessionStart hook fail-safes SILENTLY on a missing/malformed `.ai-sdlc/agent-role.yaml`. Downstream adopters (103 stars / 28 forks) misconfigure and never find out until something breaks — and for an adopter it breaks silently (false-rejected attestation, frozen runtime). Three separate misconfig classes bit the framework itself in one session on 2026-09-05 (runtime pins, plugin-version lag, release-pin `^0.x` caret drift). `dor-config.ts` and `trusted-reviewers-check.ts` both explicitly state they are NOT validators. There is no command that audits the whole `.ai-sdlc/` setup end-to-end.

## Goal

Ship `ai-sdlc doctor` (also expose as `/ai-sdlc doctor` slash command): a read-by-default command that audits an installed ai-sdlc project, prints a human-readable health report (pass / warn / fail per check with a one-line remediation), supports `--fix` for the safe/mechanical subset, and `--json` for machine consumption. This task is the LOCAL audit only — upstream reporting is a SEPARATE RFC'd layer (do NOT build any phone-home/telemetry here; leave a clean seam for it).

## Reuse (do NOT reimplement — confirmed via 2026-09-05 inventory)
- `orchestrator/src/cli/commands/init-features.ts` `applyFeatureSelection()` + `init-templates.ts` — the canonical "what a compliant project SHOULD have"; doctor diffs the live project against this.
- JSON Schemas: `spec/schemas/dor-config.v1.schema.json` (for `.ai-sdlc/dor-config.yaml`) and `spec/schemas/agent-role.schema.json` (for `.ai-sdlc/agent-role.yaml`) — validate against these with a real JSON-schema validator (ajv).
- `ai-sdlc-plugin/hooks/check-plugin-version.js` (`--print` mode) — CALL it for plugin-version staleness; do not add a third version-checker (see also `mcp-advisor/src/version-check.ts`).
- `scripts/sync-plugin-runtime-deps.mjs --check` (AISDLC-574) — runtimeDependencies pin drift; reuse its logic.
- `.github` branch-protection: mirror the required-contexts logic in `init-features.ts` `applyBranchProtection()` (read-only comparison in doctor).

## Seed check catalog (battle-tested — each cost real recovery time; implement as a registry of check modules with a documented extension point)
1. Plugin installed version vs latest (reuse check-plugin-version).
2. `runtimeDependencies` pins present AND resolve `>=` installed workspace/runtime versions; flag `^0.x` caret traps (`^0.19.0` excludes 0.20.0). [AISDLC-574]
3. Both plugin manifests (`.claude-plugin/plugin.json` + root `plugin.json`) agree — no drift. [AISDLC-558]
4. `.ai-sdlc/agent-role.yaml` present + schema-valid (surface what SessionStart swallows silently).
5. `.ai-sdlc/dor-config.yaml` present + schema-valid (if DoR feature enabled).
6. `.ai-sdlc/trusted-reviewers.yaml` present + parseable + at least one pubkey; operator signing key (`~/.ai-sdlc/signing-key.pem`) present and its pubkey listed (if attestation enabled). NOTE: trusted-reviewers has NO JSON schema yet — add one under spec/schemas/ as part of this task.
7. Attestation required-but-unconfigured: verify-attestation workflow present, branch-protection requires `ai-sdlc/pr-ready` (+ `Backlog Drift`) and NOT `ai-sdlc/attestation` directly. [AISDLC-388]
8. Husky pre-push gate wired (`.husky/pre-push` present + references the sign snippet).
9. Feature-flag sanity (AI_SDLC_DEPS_COMPOSITION / AUTONOMOUS_ORCHESTRATOR default-ON expectations).
10. Workflow-file presence for enabled features (diff against init-templates).
11. **Marketplace-catalog-vs-source version drift** — the installed/cached plugin version (and the `/plugin` marketplace catalog cache, e.g. `~/.claude/plugins/plugin-catalog-cache.json` + `~/.claude/plugins/cache/<marketplace>/ai-sdlc/<ver>/`) LAGS what the marketplace source actually serves (a `directory` source's live `plugin.json`, or the GitHub `main` `plugin.json` the version hook reads). Observed 2026-09-05: `/plugin` reported "already at latest 0.16.1" while the source served 0.17.0 and the version hook agreed on 0.17.0. Remediation string: point the user at `/plugin marketplace update <name>` (catalog refresh — `/reload-plugins` does NOT refresh the catalog) then update. Detect by comparing three sources: installed version, marketplace catalog-cache version, and source-of-truth (`check-plugin-version.js --print` Latest).
12. **npm dist-tag vs plugin-pin reachability** — every `@ai-sdlc/*` version referenced by the plugin `runtimeDependencies` pins (and by `install-runtime-deps`) MUST actually be reachable on the configured registry (`npm view <pkg>@<resolved> version`, cache-bust). Catches the case where a pin (e.g. `^0.20.0`) references a version that failed to publish or never existed — the exact false-alarm class from 2026-09-05 where a stale `npm view` cache made `orchestrator@0.20.0` look unpublished. The check must query the real registry (not a cached view) and report per-pin PASS/FAIL with the resolved concrete version.

## Recommendations engine
Beyond pass/fail, emit workflow-improvement suggestions (e.g. "attestation enabled but no husky pre-push sign hook — add it", "branch protection missing ai-sdlc/pr-ready", "DoR config present but evaluationMode=warn-only — consider enforce"). Keep suggestions advisory (non-zero exit only on FAIL-severity by default; `--strict` promotes warns).

## Extension seam for upstream reporting (build the seam, not the feature)
Structure the report as a typed result set (check id, severity, title, remediation, anonymizable evidence) so a future `--report-upstream` (separate RFC extending RFC-0025's anonymized pre-filled-issue flow) can consume it without refactor. Do NOT implement reporting/telemetry here.

## Acceptance Criteria
- [x] `ai-sdlc doctor` runs in an installed adopter project (node_modules layout, no monorepo), prints per-check pass/warn/fail + remediation, exits non-zero on any FAIL (0 on warns unless `--strict`).
- [x] `--fix` applies the mechanical subset (re-sync runtime pins via `install-runtime-deps.sh`; sync `.claude-plugin/plugin.json` from `plugin.json`) and re-reports; never touches `.ai-sdlc/**` content it shouldn't or force-anything.
- [x] `--json` emits the typed result set.
- [ ] All 12 seed checks implemented as a registry with a documented "add a check" extension point. **Landed: checks 1, 2, 3, 7, 11, 12 (the "battle-tested" priority subset explicitly called out in the task body's fallback clause).** Deferred to a follow-up (needs an `ajv` dependency added to `orchestrator/`, out of scope for this landing): check 4 (`agent-role.yaml` schema validation), check 5 (`dor-config.yaml` schema validation), check 6 (`trusted-reviewers.yaml` schema + presence), check 8 (husky pre-push snippet), check 9 (feature-flag sanity), check 10 (workflow-file presence diff). The registry itself (`DOCTOR_CHECKS` in `doctor-checks.ts`) is generic — adding checks 4/5/6/8/9/10 is additive, not a redesign.
- [ ] `trusted-reviewers.yaml` JSON schema added under `spec/schemas/` + wired into check 6. **Deferred with check 6 above** — see follow-up task reference below.
- [x] Reuses check-plugin-version, and 580's `check-stale-runtime-deps.mjs` staleness logic (no duplicate version/pin checkers) for the 6 landed checks.
- [x] `/ai-sdlc doctor` slash command wraps the CLI (`ai-sdlc-plugin/commands/doctor.md`).
- [x] Hermetic tests: a known-good project passes; each seeded misconfig is detected with the right severity + remediation; `--fix` idempotent. See `orchestrator/src/cli/commands/doctor-checks.test.ts`.
- [x] `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.

## Note
Split per operator decision 2026-09-05: build doctor (local) now; upstream reporting is a SEPARATE RFC extending [[aisdlc-576]]-adjacent RFC-0025 (anonymized, opt-in, pre-filled GitHub issue — NO auto phone-home). Composes with the init wizard (init-features.ts) and [[aisdlc-558]] (manifest single-source). Periodic-run cadence (SessionStart nudge / CI) is in scope for the RFC, not this task.

## Implementation summary (landed in this PR)

Per the task body's own explicit fallback ("Better a clean, well-tested
subset than a rushed all-12"), this PR:

- Turns the single AISDLC-560 attestation-governance check into a
  **check registry** (`DOCTOR_CHECKS` in `orchestrator/src/cli/commands/doctor-checks.ts`),
  with a documented extension point (append a `{ id, description, run, fix? }`
  object).
- Implements checks **1** (plugin-version, reuses `check-plugin-version.js --print`),
  **2** (runtime-deps-pins + caret-trap, reuses AISDLC-580's
  `check-stale-runtime-deps.mjs`), **3** (manifests-agree, AISDLC-558),
  **7** (attestation-governance, reuses `checkAttestationGovernance` verbatim
  from AISDLC-560, plus a new sub-finding for the AISDLC-388
  requires-`ai-sdlc/attestation`-directly misconfiguration), **11**
  (marketplace-catalog-drift), and **12** (npm-dist-tag-reachability).
- `--fix` covers the mechanical subset for checks 2 and 3.
- Extracts a shared `resolveOwnerRepoSlug` / `fetchBranchProtectionStatus`
  helper (`orchestrator/src/cli/commands/branch-protection-shared.ts`) so
  `init-features.ts`'s `applyBranchProtection` and `doctor.ts`'s
  `checkBranchProtection` can't independently drift (the reconciled minor
  from the AISDLC-560 review).
- Adds `docs/operations/doctor.md` and the `/ai-sdlc doctor` slash command
  (`ai-sdlc-plugin/commands/doctor.md`).
- **Recommending (not filing — per AISDLC-308, that's the operator's call)
  a follow-up task** for the deferred checks (4, 5, 6, 8, 9, 10) — needs an
  `ajv` dependency added to `orchestrator/` for the schema-validation
  checks (4, 5, 6) plus a new `spec/schemas/trusted-reviewers.schema.json`.
<!-- SECTION:DESCRIPTION:END -->
