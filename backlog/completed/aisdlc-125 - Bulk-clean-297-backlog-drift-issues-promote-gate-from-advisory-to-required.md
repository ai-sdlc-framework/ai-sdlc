---
id: AISDLC-125
title: Bulk-clean 297 backlog-drift issues + promote gate from advisory to required
status: Done
assignee: []
created_date: '2026-05-01 21:24'
updated_date: '2026-05-03'
labels:
  - ci
  - infrastructure
  - backlog-drift
  - follow-up
milestone: m-3
dependencies: []
references:
  - .github/workflows/ci.yml
  - CLAUDE.md
  - scripts/check-backlog-drift.sh
  - docs/upstream-bug-reports/backlog-drift-url-fragment-false-positive.md
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
AISDLC-119 was scoped as "stop the bleeding" — the gate landed advisory (`continue-on-error: true`, excluded from `ci-ok` `needs[]`) because main carried 259 pre-existing drift issues. The count has grown to 297 (verified on PR #150 CI run 25233237832) and the gate produces ~70% false-positive noise.

**Two-stage cleanup:**

1. **Land the upstream backlog-drift fix** for the URL-fragment false-positive (separate task — see docs/upstream-bug-reports/backlog-drift-url-fragment-false-positive.md). Once `backlog-drift@0.1.3+` ships and lands in our package.json (or our CI pin), 70% of issues evaporate.

2. **Bulk-fix the remaining genuine drift** (~90 issues after the upstream fix). Per CLAUDE.md, `npx backlog-drift fix --task <id>` rewrites in-place. Two sub-passes:
   - Per-task: walk the offender list, run `fix` on each, manually review the diff
   - Genuinely-missing files: `backlog/docs/ppa-product-signoff-rfc0011.md`, `.ai-sdlc/dor-config.yaml`, etc. — decide whether to create the missing file (if it should exist) or remove the reference (if it was speculative)

3. **Promote the gate to required**: drop `continue-on-error: true` from the `backlog-drift` job in `.github/workflows/ci.yml` AND add `backlog-drift` to `ci-ok`'s `needs[]` array. After this, drift introduced by future PRs becomes a hard merge block.

**Why now:** running 297 false-positive failures on every PR erodes operator trust in the gate (and in CI generally). The fix is a one-time investment; the long-term return is a gate that actually catches what it's designed to catch.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Upstream backlog-drift URL-fragment fix landed (backlog-drift@0.1.3+ available) — shipped pre-AISDLC-148
- [x] #2 Repo's backlog-drift CI pin / package.json updated to the fixed version — `ci.yml` pins `backlog-drift@0.1.3`
- [x] #3 Run `npx backlog-drift check` against full repo: 0 `error`-severity drift issues (info/warning surfaced but non-blocking, by design)
- [x] #4 Walk every genuinely-missing file reference — AISDLC-148 (PR #192) handled the bulk; this task cleaned residual AISDLC-139 references (2 deleted, 1 stripped of `(new)` annotation)
- [x] #5 `.github/workflows/ci.yml` Backlog Drift job: removed `continue-on-error: true`
- [x] #6 `.github/workflows/ci.yml` ci-ok job: added `backlog-drift` to `needs[]` array
- [x] #7 Operator action documented in PR body: `gh api ... PATCH branches/main/protection` to add `Backlog Drift` to `required_status_checks.contexts` (admin scope required, agent cannot perform directly)
- [x] #8 CLAUDE.md drift-gate section updated: now reads "Required" with the severity model + local-only escape hatch noted
<!-- AC:END -->

## Final Summary

### Summary
Promoted the `Backlog Drift` CI gate from advisory to required. AISDLC-148 (PR #192) shipped the bulk-cleanup precursor (297 → 0 errors); this task removed `continue-on-error: true`, wired `backlog-drift` into `ci-ok`'s `needs[]`, added an `error`-severity-only failure model so info/warning issues remain informational, and refreshed the CLAUDE.md drift-gate docs. Operator follow-up: add `Backlog Drift` to branch protection's `required_status_checks.contexts` via `gh api` (documented in PR body).

### Changes
- `.github/workflows/ci.yml` (modified): removed `continue-on-error: true` from `backlog-drift` job; added `backlog-drift` to `ci-ok`'s `needs[]`; rewrote the run step to filter `--json` output by `severity == "error"` so non-error issues don't block.
- `CLAUDE.md` (modified): drift-gate section now reads "Required" instead of "Strict on commit … defense-in-depth"; clarifies `AI_SDLC_SKIP_DRIFT_GATE=1` is local-only, NOT honored in CI.
- `backlog/completed/aisdlc-139 - …` (modified): stripped `(new)` annotation from existing-file ref; removed 2 dangling refs (`scripts/ci-sign-attestation.mjs`, `memory: feedback_autonomous_orchestration_pattern.md`) — these were the only `error`-severity issues blocking gate promotion.
- 5 other completed tasks (AISDLC-115.8, 146, 69.5, 69.7, 69.8) (modified): `npx backlog-drift fix` updated their `drift_log` entries to acknowledge resolved dependencies / post-completion modifications. These are warning/info-severity only and the gate now ignores them.

### Design decisions
- **Severity-aware failure model**: `backlog-drift@0.1.3` exits 1 on ANY issue (including `info: dependency completed`). For a CI gate, only `error`-severity issues represent actionable drift the task author is responsible for. The `--json` + `jq` filter pattern keeps the gate strict on real failures while letting informational signals surface in logs without blocking unrelated PRs.
- **No CI skip env**: per AC #3, the `AI_SDLC_SKIP_DRIFT_GATE=1` env is honored ONLY by `scripts/check-backlog-drift.sh` (local pre-commit). The CI job in `ci.yml` has no env-based short-circuit by design — there's no escape hatch in CI, only `git push --no-verify` for the local pre-push chain (which doesn't affect the CI gate at all).
- **Branch-protection integration via `contexts`, not `ai-sdlc/pr-ready` rollup**: GitHub Actions `needs:` is intra-workflow only; adding `backlog-drift` to `ai-sdlc-gate.yml`'s rollup would require duplicating the job. The cheaper path is to add `Backlog Drift` directly to `required_status_checks.contexts` (operator action documented in PR body). This also surfaces it as a separately-named required entry on the PR checks tab.

### Verification
- `npx backlog-drift@0.1.3 check --json | jq '[.[] | select(.severity=="error")] | length'` — 0
- `pnpm lint` — clean
- `pnpm format:check` — clean

### Follow-up
- Operator action: `gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/branches/main/protection/required_status_checks --input <(echo '{"strict":true,"contexts":["codecov/patch","ai-sdlc/pr-ready","Backlog Drift"]}')` (documented in PR body).
- Optional upstream improvement: a `--severity error` flag on `backlog-drift check` would let us drop the `jq` post-processing in CI; file as a separate task if it becomes painful.
