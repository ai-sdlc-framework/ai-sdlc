---
id: AISDLC-497
title: 'feat: RFC-0043 Phase 1 — Stage 0 trust classifier + Stage 1 AST gate + drift-detection workflow + trusted-reviewers.yaml author allowlist extension'
status: To Do
assignee: []
created_date: '2026-06-02'
labels:
  - rfc-0043
  - untrusted-pr-verification
  - phase-1
  - stage-0
  - stage-1
  - zero-trust
dependencies: []
references:
  - spec/rfcs/RFC-0043-untrusted-contributor-pr-verification.md
  - spec/rfcs/RFC-0042-proof-of-execution-attestation.md
  - spec/rfcs/RFC-0022-compliance-posture-audit-surface.md
  - spec/rfcs/RFC-0035-decision-catalog-operator-routing.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Phase 1 of RFC-0043. Foundation for the entire UCVG path: deterministic trust classification + deterministic protected-path/content-heuristic gate. NO LLM, NO sandbox spin-up — these are the cheapest filters that must run before any expensive step.

## Scope (RFC-0043 §Stage 0 + §Stage 1 + OQ-1 + OQ-6 resolutions)

### Stage 0 — Trust Classifier (OQ-1 resolution)

- `pipeline-cli/src/pipeline/trust-classifier.ts` — deterministic trusted/untrusted classification
- Author allowlist extension to `.ai-sdlc/trusted-reviewers.yaml` (the file the v6 verifier already reads for trusted signing keys)
- Composition with RFC-0022 `reviewerAuthorityModel` (`open` / `allowlist` / `allowlist+role`)
- **OQ-1 resolution applied**: static file is the ONLY runtime source of truth; no live GitHub API queries on critical path
- Fork PRs always untrusted unless static file overrides

### Drift-detection workflow (OQ-1 resolution)

- `.github/workflows/trusted-reviewers-drift.yml` — scheduled CI workflow (daily / weekly per operator preference)
- Compares `trusted-reviewers.yaml` against GitHub repo permissions (org/repo write+ permission set)
- Emits `Decision: trusted-reviewers-file-drift-detected` with the diff via RFC-0035 G0 catalog
- Same pattern as `backlog-drift` + `main-health-monitor` periodic CI workflows
- Operator reviews + merges a PR updating the file at their cadence

### Stage 1 — AST Gate (RFC §Stage 1 + OQ-6 resolution)

- `pipeline-cli/src/pipeline/ast-gate.ts` — protected-path + content-heuristic engine
- Reads `.ai-sdlc/untrusted-pr-gate.yaml` for adopter config
- Protected-path rule engine per RFC §Stage 1:
  - `protectedPaths`: `.github/**`, `**/package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `.ai-sdlc/**`, `ai-sdlc-plugin/agents/**`, `**/*.github/workflows/**`
  - `allowedMutationGlobs`: `**/*.ts`, `**/*.tsx`, `**/*.js`, `**/*.jsx`, `**/*.md`
  - Content heuristics: `packageJsonLifecycleScripts: abort` (preinstall/postinstall/prepare), `newGithubActionUses: abort`
- **OQ-6 resolution applied — boundary principle codified in code comments + operator runbook**: *"Stage 1 patterns must have <1% false-positive AND cheap-deterministic-value over downstream LLM/sandbox detection. Sophisticated detection delegates to RFC-0022 secretScanStrictness + adopter-integrated SAST."*
- `Decision: stage-1-content-heuristic-addition-request` Stage A counter wired (no v1 activation surface; counter only)
- Outcomes: `pass` / `abort-protected-path`; on abort → emit `UntrustedPrBlockedByProtectedPath` event + apply `needs-maintainer-review` label + post comment naming offending paths + STOP (no sandbox, no LLM)

### Hermetic tests

- Trust classifier: author-in-file → trusted; author-not-in-file + fork PR → untrusted; RFC-0022 regime composition; drift between file and GitHub state surfaces as drift Decision (not as classification change)
- AST gate: each protected path triggers abort with correct labeled comment; allowed paths pass; lifecycle-script + `uses:` heuristics trigger abort; per-org config override respected
- Drift workflow: stale file detected → Decision emitted with correct diff format
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `trust-classifier.ts` ships at `pipeline-cli/src/pipeline/`; classifies trusted vs untrusted deterministically per OQ-1 resolution
- [ ] #2 `.ai-sdlc/trusted-reviewers.yaml` extended with author allowlist schema; v6 verifier compatibility preserved
- [ ] #3 Composition with RFC-0022 `reviewerAuthorityModel` working (open → UCVG opt-in; allowlist / allowlist+role → UCVG default-on for non-listed)
- [ ] #4 `.github/workflows/trusted-reviewers-drift.yml` ships with scheduled trigger; compares file vs GitHub repo permissions; emits `Decision: trusted-reviewers-file-drift-detected` with diff via RFC-0035 G0 catalog
- [ ] #5 `ast-gate.ts` ships with `protectedPaths` + `allowedMutationGlobs` + `contentHeuristics` (`packageJsonLifecycleScripts`, `newGithubActionUses`) per RFC §Stage 1
- [ ] #6 Boundary principle codified in operator runbook + code comments: "<1% false-positive AND cheap-deterministic-value over downstream detection"
- [ ] #7 `Decision: stage-1-content-heuristic-addition-request` Stage A counter wired (no v1 activation; counter only)
- [ ] #8 On abort-protected-path: `UntrustedPrBlockedByProtectedPath` event emitted + `needs-maintainer-review` label + comment naming offending paths + pipeline stops (no sandbox spin-up, no LLM)
- [ ] #9 Hermetic tests cover trust classifier (positive + negative + drift), AST gate (each protected path, allowed paths, heuristics), drift workflow
- [ ] #10 NO live GitHub API queries on critical path of trust classification (per OQ-1 resolution invariant)
<!-- AC:END -->
