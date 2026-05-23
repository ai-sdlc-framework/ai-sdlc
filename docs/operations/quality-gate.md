# Quality Gate — `ai-sdlc/pr-ready` aggregator

**Status:** Active (additive deployment as of AISDLC-140 sub-1; cutover pending)
**Audience:** AI-SDLC operators and adopters configuring branch protection on a protected branch.
**Companion:** `.github/workflows/ai-sdlc-gate.yml`, `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`

---

## TL;DR

Configure **two** required checks on your protected branch (AISDLC-388):

```
Backlog Drift
ai-sdlc/pr-ready
```

`ai-sdlc/pr-ready` is the rollup of every PR signal AI-SDLC needs (lint, build, test on Node 22, coverage, integration tests). `Backlog Drift` is a standalone CI job that catches dangling task references. The rollup runs on both `pull_request` and `merge_group` events, so it works whether or not you have GitHub Merge Queue enabled.

**`ai-sdlc/attestation` is NO LONGER a direct required check** (AISDLC-388). Attestation is a conditional contributor to `ai-sdlc/pr-ready`: code PRs require it (verify-attestation.yml runs and its `ai-sdlc/attestation` status is an informational governance signal operators must review before merging), but docs-only PRs skip it entirely — no status needs to be posted. This eliminates the workaround class where docs PRs had to have a synthetic attestation status posted (AISDLC-214 short-circuit + AISDLC-215 synthesis, now deleted).

You no longer need to enumerate `CI OK`, `Post Review Results`, `codecov/patch`, `Build & Test (Node 20)`, etc. individually. `codecov/patch` was removed as a required check (AISDLC-372) — see ["Why codecov/patch is informational, not required"](#why-codecovpatch-is-informational-not-required-aisdlc-372) below. The aggregator owns the CI list, in code you control.

**Operator action required** (AISDLC-388 AC-2): update branch protection on `main` to require ONLY `ai-sdlc/pr-ready` and `Backlog Drift`. Remove the `ai-sdlc/attestation` direct required check. See the [updated cutover procedure](#cutover-procedure-operator-action) below for the exact `gh api` command.

---

## Why one check, not many

Listing N required checks by name + GitHub App ID is GitHub's default branch-protection model. It works for small, stable workflow lists and it falls over hard for everything else:

- **Path-filter deadlock.** GitHub explicitly states that workflows skipped by `paths` / `paths-ignore` / branch filters / commit-message tokens leave their associated checks pending forever — and a PR requiring a pending check is permanently un-mergeable. This is why AI-SDLC needed `ai-sdlc-review-docs-only.yml` as a separate fallback: a docs-only PR would never trigger `ai-sdlc-review.yml`, the required `Post Review Results` check would never post, and the PR would deadlock.
- **`[skip ci]` deadlock.** Same root cause. Open since 2020 ([actions/runner #774](https://github.com/actions/runner/issues/774)) with no fix planned.
- **App-ID coupling.** A status posted by a different App than GitHub expected does not satisfy the requirement, even when the contents are identical. See [Community discussion #26733](https://github.com/orgs/community/discussions/26733).
- **No "required if run" semantics.** Open ask since 2022 ([Community #26092](https://github.com/orgs/community/discussions/26092)); GitHub acknowledged the backlog with no committed timeline.

The single-aggregator pattern (also called "alls-green" or "Merge OK") solves all four:

- The aggregator job runs unconditionally and **always posts** its status.
- Skipped upstream jobs are treated as allowed-skips (correct semantics for archetype-conditional gating like docs-only PRs).
- Adding, renaming, or restructuring upstream workflows is a code change in the aggregator's `needs:` list — no branch-protection settings change needed.
- The single check name decouples the merge gate from any specific App ID.

This is the same pattern shipped in production by **aiohttp**, **attrs**, **conda**, **setuptools**, **pytest**, **pip-tools**, **Open edX**, **PyCA**, **PyPA**, **Mergify**, and the wider Python ecosystem via [`re-actors/alls-green`](https://github.com/re-actors/alls-green). AI-SDLC adopts the same action.

## What the aggregator checks

`.github/workflows/ai-sdlc-gate.yml` runs six jobs:

| Job | Always required | Required for code/mixed PRs only |
|---|---|---|
| `Detect Changes` (archetype detection via `dorny/paths-filter@v3`) | yes | — |
| `Lint & Format` (`pnpm lint && pnpm format:check`) | yes | — |
| `Build & Test (Node 20)` | — | yes |
| `Build & Test (Node 22)` | — | yes |
| `Coverage` (`pnpm test:coverage`) | — | yes |
| `Integration Tests` (`pnpm --filter @ai-sdlc/reference test`) | — | yes |
| `ai-sdlc/pr-ready` (the aggregator itself) | yes | yes |

Per-archetype gating decisions:

- **docs-only PRs** (every changed file matches `spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, or root `*.md`) skip the four code-gated jobs. `re-actors/alls-green` treats `skipped` as `success`, so the aggregator passes cleanly without paying ~10 minutes of compute on a typo fix.
- **code or mixed PRs** require all six jobs to pass. The `predicate-quantifier: every` setting on the path filter ensures a PR with one docs file plus one code file correctly resolves to "code/mixed", not "docs-only".
- **Integration tests** additionally skip on PRs originating from forks (which lack the repo secrets needed to talk to the reference adapter). Same predicate as `ci.yml`'s `integration` job — kept in sync deliberately.

## Per-archetype attestation gating (AISDLC-388)

`ai-sdlc/attestation` is **not a direct required check** on branch protection. It is a conditional contributor to the `ai-sdlc/pr-ready` rollup via per-archetype routing:

| PR archetype | `ai-sdlc/attestation` behavior |
|---|---|
| **docs-only** (all changed files in `spec/rfcs/**`, `docs/**`, `backlog/**`, or root `*.md`) | `verify-attestation.yml` is **skipped** on `pull_request` events via `paths-ignore`. On `merge_group` events the inline short-circuit posts `success` cheaply. No envelope required. |
| **code or mixed** (at least one non-docs file) | `verify-attestation.yml` runs and posts `ai-sdlc/attestation: success` (valid envelope) or `failure` (missing/invalid). Operators must see `success` before merging — governance enforced by reviewing the status, not by branch protection directly. |

This design preserves the AISDLC-380 forgery defense for code PRs while eliminating the "docs require attestation" workaround class (AISDLC-214 short-circuit + AISDLC-215 synthesis). The `ai-sdlc/attestation` status is an informational governance signal for code PRs — visible in the PR checks UI and webhook-subscribable — but branch protection gates only on `ai-sdlc/pr-ready`.

Per Q3 in the AISDLC-140 redesign decision and the industry consensus documented in `/tmp/research-prior-art.md` (SLSA, npm, PyPI, Google Cloud GKE, Red Hat), source-time attestations are inherently fragile against history rewrites (rebase, force-push) and the mainstream pattern is **audit at source, enforce at deploy**. The `ai-sdlc/pr-ready` rollup is the enforcer; attestation is the audit trail.

**AISDLC-214 cleanup (follow-up PR):** Once the operator updates branch protection (AISDLC-388 AC-2), the "short-circuit — post ai-sdlc/attestation success (docs-only)" step in `verify-attestation.yml` can be deleted. It is intentionally retained until then to avoid a race where the merge queue still requires the status. Do NOT delete before the branch-protection update.

## Patch coverage — the 80% gate (AISDLC-376)

**80% patch coverage is non-negotiable.** The framework enforces this at two layers and one server-side gate:

| Layer | Where | Bypassable | Authority |
|---|---|---|---|
| Local pre-push | `scripts/check-coverage.sh` (per-package lines threshold) | `AI_SDLC_SKIP_COVERAGE_GATE=1` | First line of defense — fast feedback |
| CI patch gate | `scripts/check-pr-patch-coverage.mjs` (PR-diff patch coverage) | No (no skip env var) | **Authoritative merge gate** |
| Informational | codecov.io (PR comment + dashboard) | Not a check | Visibility only |

The CI patch gate runs in two places that both must pass:

1. **`ci.yml` → coverage job → `Patch coverage gate (≥80%)` step** — runs on every `pull_request` event after `vitest --coverage` has produced `coverage-final.json` fixtures for the affected packages.
2. **`ai-sdlc-gate.yml` → coverage job → `Patch coverage gate (≥80%)` step** — runs as part of the `ai-sdlc/pr-ready` rollup, so any failure cascades into the single required check.

Both layers parse the unified diff (`git diff --unified=0 base..head`) per file, compute the union of NEW line numbers added/modified by the PR, then check each line against vitest's istanbul-format `coverage-final.json` statement map + hit counts. A line is "covered" when any statement on it was hit at least once. The aggregate ratio `covered / executable_changed_lines` must be ≥ 80%.

### When the gate skips (intentional)

- **No changed code files.** Docs-only / workflow-only / config-only PRs produce no executable diff. The gate returns success with `reason: no-instrumentable-changes`. Mirrors the docs-only short-circuit pattern in `verify-attestation.yml` and `ai-sdlc-review.yml`.
- **No executable lines in the patch.** A code-file change that only adds comments, blank lines, or pure type-only declarations produces 0 executable diff lines. The gate returns success with `reason: no-executable-changed-lines`.
- **Test files only.** `*.test.ts`, `*.test.tsx`, etc. are excluded from instrumentation by every vitest config (`coverage.exclude`). Pure-test PRs skip the gate.

### When the gate fails (the failure modes)

- **patch % < threshold.** Reports per-file coverage and the aggregate ratio. Operator action: add tests for the listed lines.
- **Missing coverage data entirely.** Zero `coverage-final.json` files found under the coverage root despite a code diff. Diagnostic: "did vitest --coverage run before this gate?" — almost always a workflow regression where the gate step ran before / instead of the `pnpm test:coverage` step.
- **Missing per-file coverage data.** A changed code file has no entry in any `coverage-final.json`. Treated as worst case (every changed line counted as uncovered). Operator action: either add tests covering the file, or explicitly exclude it from vitest's `coverage.include` if it's not testable (CLI shims, generated code).

### Why this replaces codecov/patch as the merge-blocking signal

Before AISDLC-372 dropped codecov/patch from required checks, the SaaS handled this enforcement. The drop opened a gap: PR #550 (AISDLC-302) landed UNSTABLE with 0.6% patch coverage after a shotgun-rename of 6 test files. The local pre-push gate was bypassed legitimately for a chore-sign commit (`AI_SDLC_SKIP_COVERAGE_GATE=1`), and nothing on the CI side caught the resulting drop because codecov/patch was no longer required. The operator (2026-05-19) flagged the missing CI-side mirror; AISDLC-376 closes the gap.

The new gate replicates codecov/patch's gating semantics (≥80% on the PR diff) without the SaaS latency, the App-source deadlock on zero-LCOV PRs, or the third-party-dependency risk.

### Operator action — optionally add as a direct required check

The gate rolls into `ai-sdlc/pr-ready` automatically (via the `coverage` job in `ai-sdlc-gate.yml`'s `needs:` list), so no branch-protection change is strictly required. Operators who want the gate to surface as an independently-named status on the PR checks tab can add it directly:

```bash
gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
  -F 'contexts[]=Backlog Drift' \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=Patch coverage gate (≥80%)' \
  -F 'strict=true'
```

The recommended default is to leave it inside the rollup (the alls-green pattern this whole doc argues for). Add it as a direct context only if your team specifically wants to point at it in dashboards.

### Hermetic tests

`scripts/check-pr-patch-coverage.test.mjs` covers:

- **AC-1**: success when patch % ≥ 80 (also in JSON mode).
- **AC-2**: failure when patch % < 80, with per-file breakdown.
- **AC-3**: skip on 0 changed code files (docs-only, test-only, workflow-only).
- **AC-4**: diagnostic failure on missing coverage data (no fixture, or no entry for a changed file).
- CLI plumbing: argv validation, threshold range checks, missing coverage-root.
- Threshold customization: pass at 50% threshold with 60% coverage; fail at 90%.
- Multi-file aggregation: two files with 75% aggregate coverage pass at 70% threshold.

Run with: `pnpm test:patch-coverage-gate` or `node --test scripts/check-pr-patch-coverage.test.mjs`.

## Why codecov/patch is informational, not required (AISDLC-372)

`codecov/patch` was removed from required branch-protection status checks. It stays configured in CI (`codecov/codecov-action@v5` in `.github/workflows/ci.yml`) for informational reporting — PR comments with line-by-line coverage annotations and the codecov.io dashboard — but **no longer gates merges**.

The codecov/patch enforcement role has moved to the server-side gate documented in the [Patch coverage section above](#patch-coverage--the-80-gate-aisdlc-376). codecov.io stays purely informational.

### The two problems it caused

1. **SaaS processing latency.** codecov.io computes and posts the `codecov/patch` status only *after* our CI uploads coverage data to their servers. This happens on their infrastructure with shared backpressure. In practice this added 5–15 min of wall-clock time to every PR's merge readiness window, even when all our own checks had already passed.

2. **App-source deadlock on zero-coverage PRs.** Branch protection requires the status to come from the codecov GitHub App specifically; synthetic `gh api` statuses are rejected. PRs that produce no LCOV data (docs-only changesets, pure `.github/workflows/` changes, script-only changes) leave codecov with nothing to upload → codecov never posts its status → the PR sits in BLOCKED state permanently, even when every AI-SDLC gate is green. This was hit on PRs #553 and #554 during the AISDLC-370 cycle and required a workaround (empty-LCOV fallback) to undeadlock.

### Why the local gate alone is NOT sufficient (AISDLC-376 correction)

The original AISDLC-372 framing claimed the local pre-push gate (`scripts/check-coverage.sh`) was "sufficient and authoritative" on its own. **That was wrong.** The local gate is the first line of defense — fast feedback before the push — but it is bypassable via `AI_SDLC_SKIP_COVERAGE_GATE=1`, and a legitimate bypass (e.g. for a chore-sign commit) leaves subsequent code commits in the same push unguarded. PR #550 hit this in practice: bypassed for the chore commit, landed at 0.6% patch coverage, codecov/patch failed but was no longer required → nothing blocked merge intent.

AISDLC-376 added [the server-side gate above](#patch-coverage--the-80-gate-aisdlc-376) as the authoritative mirror. The local gate stays as fast feedback; the CI gate is the merge-blocking signal. No bypass env var exists on the CI side.

### Why dropping the SaaS check was still the right call

`scripts/check-coverage.sh` (the `pre-push` hook) enforces **80% lines coverage per package** before the push reaches GitHub. It:

- Runs in under 1 minute on our own hardware.
- Blocks the push before the PR is even opened.
- Has no dependency on third-party SaaS infrastructure.
- Is skippable for emergencies via `AI_SDLC_SKIP_COVERAGE_GATE=1` (existing escape hatch).

`codecov/patch` measured a similar 80% property using a slower, less-reliable mechanism (SaaS round-trip; deadlock risk on zero-LCOV PRs). Dropping it from required checks removed the latency without weakening governance — the AISDLC-376 server-side gate is functionally equivalent without the failure modes.

### Operator action to apply

Branch protection changes require admin scope; CI does not have admin scope. After this PR merges, **run the apply script once**:

```bash
bash scripts/apply-codecov-drop.sh
```

This patches the required contexts to `[Backlog Drift, ai-sdlc/pr-ready, ai-sdlc/attestation]`, dropping `codecov/patch`. The script is idempotent — safe to re-run if branch protection is recreated. See [`scripts/apply-codecov-drop.sh`](../../scripts/apply-codecov-drop.sh) for the full command and dry-run mode.

### Required contexts after the change

| Context | Required | Source |
|---|---|---|
| `Backlog Drift` | yes | `ci.yml` `backlog-drift` job |
| `ai-sdlc/pr-ready` | yes | `ai-sdlc-gate.yml` aggregator (alls-green) |
| `ai-sdlc/attestation` | **no** (informational governance signal for code PRs) | `verify-attestation.yml` (conditional — skipped on docs-only PRs per AISDLC-388) |
| `codecov/patch` | **no** (informational only) | codecov GitHub App |

## Cutover procedure (operator action)

This workflow ships in **additive mode**: it runs on every PR alongside the legacy required checks, but branch protection is not yet wired against it. Before cutover, validate that `ai-sdlc/pr-ready` matches expectation on a few real PRs (see "Pre-cutover validation" below).

### AISDLC-388 operator action — remove `ai-sdlc/attestation` from required checks

After AISDLC-388 lands on main, the operator must update branch protection to remove the `ai-sdlc/attestation` direct required check. Branch protection changes require admin scope.

1. **Snapshot the current branch-protection config** so you can roll back if needed:
   ```bash
   gh api repos/<org>/<repo>/branches/main/protection > branch-protection-pre-aisdlc-388.json
   ```

2. **Update the required-checks list** to remove `ai-sdlc/attestation`:
   ```bash
   gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
     -F 'contexts[]=Backlog Drift' \
     -F 'contexts[]=ai-sdlc/pr-ready' \
     -F 'strict=true'
   ```
   This is the exact command for ai-sdlc's own repo. Attestation is intentionally absent — `ai-sdlc/pr-ready` is now the sole gate.

3. **Verify the change.** Open one trivial docs PR and confirm:
   - `ai-sdlc/pr-ready` appears in the required-checks list.
   - The PR is mergeable when `ai-sdlc/pr-ready` is green (even without `ai-sdlc/attestation` posted).
   - `verify-attestation.yml` does NOT fire on the docs PR (paths-ignore skips it).
   - Attempting to bypass (e.g. push directly to main) is still blocked.

4. **Open the AISDLC-214 cleanup PR** to delete the short-circuit step in `verify-attestation.yml` (the "always post status on every head SHA" code path). This step is safe to delete ONLY after branch protection no longer requires `ai-sdlc/attestation`. The cleanup PR is intentionally separate (AISDLC-388 AC-4).

5. **Communicate the change** in the project's release notes / Slack so contributors know which check name to look for in the merge UI.

---

### Full cutover procedure (initial `ai-sdlc/pr-ready` adoption)

When you're ready to cut over from the legacy individual required checks, the operator does the following on the protected branch (example: `main`):

1. **Snapshot the current branch-protection config** so you can roll back if needed:
   ```bash
   gh api repos/<org>/<repo>/branches/main/protection > branch-protection-pre-aisdlc-140.json
   ```

2. **Update the required-checks list.** In the GitHub UI under *Settings → Branches → Edit rule for `main`*:
   - **Add:** `ai-sdlc/pr-ready`, `Backlog Drift`
   - **Remove:** the legacy required checks. For ai-sdlc itself this set is `CI OK`, `Post Review Results`, `codecov/patch`, `Build & Test (Node 20)`, `ai-sdlc/attestation`, etc. For adopters, remove whatever individual checks `ai-sdlc/pr-ready` now subsumes.

   Or via `gh api`:
   ```bash
   gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
     -F 'contexts[]=Backlog Drift' \
     -F 'contexts[]=ai-sdlc/pr-ready' \
     -F 'strict=true'
   ```

3. **Verify the change.** Open one trivial test PR (a no-op docs change is fine) and confirm:
   - `ai-sdlc/pr-ready` appears in the required-checks list.
   - The PR is mergeable when only `ai-sdlc/pr-ready` is green.
   - Attempting to bypass (e.g. push directly to main) is blocked.

4. **Communicate the change** in the project's release notes / Slack so contributors know which check name to look for in the merge UI.

If `ai-sdlc/pr-ready` reports `failure` on a PR that the legacy checks said was green, **do not merge** — investigate the discrepancy. Either the aggregator caught a real gap in the legacy set, or there's a configuration drift to fix.

## Rollback procedure

If the aggregator misbehaves, restore the snapshotted config:

```bash
gh api -X PUT repos/<org>/<repo>/branches/main/protection/required_status_checks \
  --input branch-protection-pre-aisdlc-140.json
```

The aggregator workflow itself stays in place — rollback only affects which check is *required*. You can then iterate on the workflow safely (it's still posting `ai-sdlc/pr-ready` as a non-required status) until you're ready to retry.

## Pre-cutover validation (recommended for adopters)

For adopters who want statistical confidence before flipping the switch, the standard pattern is **shadow mode**: run the aggregator additively for a defined window, compare its decisions against the legacy checks, only cut over when they match.

This is overkill for AI-SDLC's own dogfood repo (single-dev, low PR volume, fast rollback), but it's the right pattern for enterprise adopters with high PR volume, multiple teams, or compliance requirements. Recommended procedure:

1. **Deploy the aggregator additively** (no branch-protection change). The workflow runs on every PR but isn't required.
2. **Define a comparison window.** Five PRs per archetype is the minimum useful sample; ten is the conservative default. PRs from each archetype should be observed:
   - At least 5 docs-only PRs
   - At least 5 code PRs
   - At least 5 mixed PRs
   - At least 1 PR per known edge case (fork PR, PR with `[ci skip]` token in body, PR rebased mid-flight, large PR > 1000 changed files)
3. **Record decisions.** For each PR in the window, snapshot the result of `ai-sdlc/pr-ready` alongside the legacy required checks. A simple script using `gh api repos/<org>/<repo>/commits/<sha>/check-runs` works.
4. **Compare.** For every PR in the window, the aggregator's decision must match the legacy aggregate. Disagreements fall into three categories:
   - **Aggregator stricter than legacy** → the aggregator caught something legacy missed. Audit the failing job; confirm it's a real signal you want to gate on. If yes, you can cut over confidently.
   - **Aggregator looser than legacy** → the aggregator missed something legacy caught. Check the `needs:` list in `ai-sdlc-gate.yml`; you may need to add a job. Do **not** cut over until the gap is closed.
   - **Spurious flake** → re-run; if it doesn't reproduce, document and continue. If flake rate exceeds 1-2%, fix the underlying flake before cutover.
5. **Cut over** once the comparison window is clean.

For repos with a merge queue enabled (GHMQ, Mergify, Aviator), repeat the comparison for `merge_group` events too — the aggregator runs on both, but adopters with custom queue configs may have different behavior between the PR-time and queue-time evaluations.

## Adopter scaffolding (sub-5)

The `ai-sdlc init` interactive wizard (planned in AISDLC-140 sub-5) will scaffold this workflow into adopter repos and walk through the cutover procedure interactively. Until that ships, copy `.github/workflows/ai-sdlc-gate.yml` from this repo and adjust the job bodies (especially `Build & Test`, `Coverage`, `Integration Tests`) to match your project's commands.

## References

- AISDLC-140 redesign memo: `/tmp/quality-gate-redesign-final.md`
- Prior-art research: `/tmp/research-prior-art.md`
- [`re-actors/alls-green`](https://github.com/re-actors/alls-green) — the action this aggregator wraps
- [Pants blog: Skipping GitHub Actions jobs without breaking branch protection](https://blog.pantsbuild.org/skipping-github-actions-jobs-without-breaking-branch-protection/) — canonical writeup of the same pattern applied to docs-only PRs
- [Mergify: Monorepo CI](https://mergify.com/blog/monorepo-ci-for-github-actions-run-exactly-the-tests-you-need-nothing-more/) — productized version of the pattern
- [GitHub docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks) — official acknowledgement of the path-filter deadlock
