# Quality Gate — `ai-sdlc/pr-ready` aggregator

**Status:** Active (additive deployment as of AISDLC-140 sub-1; cutover pending)
**Audience:** AI-SDLC operators and adopters configuring branch protection on a protected branch.
**Companion:** `.github/workflows/ai-sdlc-gate.yml`, `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`

---

## TL;DR

Configure **one** required check on your protected branch:

```
ai-sdlc/pr-ready
```

That check is the rollup of every PR signal AI-SDLC needs (lint, build, test on Node 20+22, coverage, integration tests). The rollup runs on both `pull_request` and `merge_group` events, so it works whether or not you have GitHub Merge Queue enabled.

You no longer need to enumerate `CI OK`, `Post Review Results`, `codecov/patch`, `ai-sdlc/attestation`, `Build & Test (Node 20)`, etc. individually. The aggregator owns that list, in code you control.

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

## Audit-only signals (NOT in the aggregator)

`ai-sdlc/attestation` (the DSSE review-attestation verifier) is **deliberately excluded** from the aggregator. Per Q3 in the AISDLC-140 redesign decision and the industry consensus documented in `/tmp/research-prior-art.md` (SLSA, npm, PyPI, Google Cloud GKE, Red Hat), source-time attestations are inherently fragile against history rewrites (rebase, force-push) and the mainstream pattern is **audit at source, enforce at deploy**.

The verifier still runs and still posts `ai-sdlc/attestation` as a commit status — adopters or auditors can subscribe to it via webhook, slack notification, or weekly review without putting it in the merge gate.

## Cutover procedure (operator action)

This workflow ships in **additive mode**: it runs on every PR alongside the legacy required checks, but branch protection is not yet wired against it. Before cutover, validate that `ai-sdlc/pr-ready` matches expectation on a few real PRs (see "Pre-cutover validation" below).

When you're ready to cut over, the operator does the following on the protected branch (example: `main`):

1. **Snapshot the current branch-protection config** so you can roll back if needed:
   ```bash
   gh api repos/<org>/<repo>/branches/main/protection > branch-protection-pre-aisdlc-140.json
   ```

2. **Update the required-checks list.** In the GitHub UI under *Settings → Branches → Edit rule for `main`*:
   - **Add:** `ai-sdlc/pr-ready`
   - **Remove:** the legacy required checks. For ai-sdlc itself this set is `CI OK`, `Post Review Results`, `codecov/patch`, `ai-sdlc/attestation`. For adopters, remove whatever individual checks `ai-sdlc/pr-ready` now subsumes.

   Or via `gh api`:
   ```bash
   gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
     -f 'contexts[]=ai-sdlc/pr-ready' \
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
