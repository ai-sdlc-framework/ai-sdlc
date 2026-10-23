# Quality Gate — `ai-sdlc/pr-ready` aggregator

**Status:** Active (no-queue direct-merge model as of AISDLC-400, 2026-05-23)
**Audience:** AI-SDLC operators and adopters configuring branch protection on a protected branch.
**Companion:** `.github/workflows/ai-sdlc-gate.yml`, `.github/workflows/__tests__/ai-sdlc-gate.test.mjs`
**Merge flow:** See `docs/operations/merge-without-queue.md` for the direct-merge runbook.

---

## TL;DR

Configure **one** required check on your protected branch (AISDLC-388, AISDLC-836):

```
ai-sdlc/pr-ready
```

`ai-sdlc/pr-ready` is the rollup of every PR signal AI-SDLC needs (lint, build, test with coverage on Node 22, integration tests). `Backlog Drift` (dangling task references) is a `needs:` of the rollup, so it gates merges through it and is not a separately required context. The rollup runs on `pull_request` events (no merge queue required — AISDLC-400 dropped the queue in favour of direct auto-merge with squash).

**`ai-sdlc/attestation` is NO LONGER a direct required check** (AISDLC-388). Attestation is a conditional contributor to `ai-sdlc/pr-ready`: code PRs require it (ai-sdlc-gate.yml (attestation-gate job) runs and its `ai-sdlc/attestation` status is an informational governance signal operators must review before merging), but docs-only PRs skip it entirely — no status needs to be posted. This eliminates the workaround class where docs PRs had to have a synthetic attestation status posted (AISDLC-214 short-circuit + AISDLC-215 synthesis, now deleted).

You no longer need to enumerate `CI OK`, `Post Review Results`, `codecov/patch`, `Build & Test (Node 20)`, etc. individually. `codecov/patch` was removed as a required check (AISDLC-372) — see ["Why codecov/patch is informational, not required"](#why-codecovpatch-is-informational-not-required-aisdlc-372) below. The aggregator owns the CI list, in code you control.

**Operator action required** (AISDLC-388 AC-2): update branch protection on `main` to require ONLY `ai-sdlc/pr-ready`. Remove the `ai-sdlc/attestation` direct required check. See the [updated cutover procedure](#cutover-procedure-operator-action) below for the exact `gh api` command.

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

`.github/workflows/ai-sdlc-gate.yml` runs these jobs (the `Detect Changes` filters drive the conditional ones):

| Job | Always required | Required for code/mixed PRs only |
|---|---|---|
| `Detect Changes` (docs-only archetype via `scripts/is-docs-only-changeset.mjs`; deps/tasks via `dorny/paths-filter`) | yes | — |
| `Lint & Format` (`pnpm lint && pnpm format:check`) | yes | — |
| `Build & Test (Node 22)` (build, `pnpm test:coverage` once with per-package floors, root gate checks, schema validation, then the 90% patch gate; AISDLC-844 folded the former `Coverage` job into it) | — | yes |
| `pipeline-cli tests (macOS)` (AISDLC-1021: `pnpm build` then the pipeline-cli suite on `macos-latest`, the executors' filesystem semantics; runs only when the `detect` path filter `pipeline-cli/**` matches and the PR is not docs-only or records-only; a skip is allowed in the rollup) | — | yes (via `ai-sdlc/pr-ready`) |
| `Integration Tests` (`pnpm --filter @ai-sdlc/reference test`) | — | yes |
| `DoR readiness (task-file PRs)` (see below) | — | only when the PR changes `backlog/tasks/*.md` |
| `ai-sdlc/pr-ready` (the aggregator itself) | yes | yes |

Per-archetype gating decisions:

- **docs-only PRs** (every changed file matches `spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, or root `*.md`) skip the four code-gated jobs. `re-actors/alls-green` treats `skipped` as `success`, so the aggregator passes cleanly without paying ~10 minutes of compute on a typo fix.
- **code or mixed PRs** require all six jobs to pass. The `classify` step in `Detect Changes` feeds the PR's changed-file list (`git diff --name-only <base> <head>`) to `scripts/is-docs-only-changeset.mjs`, which requires EVERY file to be docs, so a PR with one docs file plus one code file resolves to "code/mixed". If the diff cannot be computed on a PR, it fails safe to `docs_only=false` (AISDLC-484).
- **Concurrency key (AISDLC-876).** `ai-sdlc-gate.yml` runs one gate per PR (`group: ai-sdlc-gate-<pr number>`). `cancel-in-progress` is `github.event.action != 'ready_for_review'`: a push (`synchronize`, `opened`, `reopened`) changes the head SHA and cancels the superseded run, but the draft-to-ready flip is on an unchanged SHA, so it queues behind the running gate instead of cancelling it, and the run still ends by posting `ai-sdlc/pr-ready`.
- **Classifier trust (AISDLC-969).** `detect` runs the docs-only classifier from copies read with `git show "$BASE_SHA:..."`, never from the PR tree, and a diff touching `scripts/is-docs-only-changeset.mjs`, `pipeline-cli/attestation-core/docs-only-paths.mjs` or `.github/workflows/ai-sdlc-gate.yml` is always `code`; `scripts/gate-detect-base-sha.test.mjs` enforces it.
- **Records-only lane (AISDLC-867).** `scripts/is-docs-only-changeset.mjs --class` prints `code`, `docs-only` or `records-only`; `detect` exports `records_only`. A diff is records-only when EVERY path starts with `backlog/`, `.ai-sdlc/_decisions/` or `spec/` (prefix match, no globbing past the prefix, allowlist `RECORDS_ONLY_PATTERN` in `pipeline-cli/attestation-core/docs-only-paths.mjs`) and none is a trust-chain path (`isTrustChainPath`, so `spec/schemas/agent-role.schema.json` stays on the full gate; all of `spec/schemas/` is excluded because `pnpm build` compiles it into runtime validators). The lane skips Build & Test, Integration, attestation-gate and independence-policy-gate; Lint & Format (`format:check`), Backlog Drift, DoR readiness, governance-gate and the rfc checks still run, and `ai-sdlc/pr-ready` posts as always (skipped jobs are allowed-skips). The governance-gate reviewer check is skipped on records-only PRs as on docs-only ones. A changeset mixing docs-only and records-only paths contains no code and classifies as `docs-only` for every gate (AISDLC-1018). Any path outside the allowlists, including one workflow file, takes the full lane. CodeQL is a separate workflow outside this gate.
- **issue-link (AISDLC-1013).** `ai-sdlc/issue-link` runs only on PRs that change code. It is skipped for docs-only and records-only changesets (an allowed-skip in the rollup), so filing PRs cannot fail on a base older than the task file they name.
- **Waived-tests runs twice (AISDLC-1056).** The `waived-tests` check of `scripts/check-pr-governance.mjs` (AISDLC-1022: a task file or final summary that records `pnpm test` as waived or skipped while the diff touches `pipeline-cli/src`, `orchestrator/src` or `ai-sdlc-plugin/hooks`) runs locally in Step 10 (finalize), through the same `checkWaivedTests` function, before the attestation sign and the push, and fails the step with the gate's own message. It runs again in the CI `governance-gate` job as the independent control; nothing was removed from CI.
- **Events-only rule (AISDLC-876).** A PR whose diff is only `.ai-sdlc/_decisions/**` (decision event files) is docs-only per `scripts/is-docs-only-changeset.mjs`: the code-gated jobs skip and `ai-sdlc/pr-ready` still posts. A PR mixing event files with any code file is code/mixed and runs the full gate.
- **Integration tests** additionally skip on PRs originating from forks (which lack the repo secrets needed to talk to the reference adapter). Same predicate as `ci.yml`'s `integration` job — kept in sync deliberately.

## DoR readiness for task-file PRs (AISDLC-712.1)

The Definition-of-Ready check is no longer a local hook (AISDLC-712, DEC-0056 row 3). It runs in CI as one conditional job, `dor-readiness-gate` in `ai-sdlc-gate.yml` (one evaluation per PR, AISDLC-834), which the `ai-sdlc/pr-ready` rollup requires.

- **Conditional.** `Detect Changes` has a third path filter, `tasks`, matching `backlog/tasks/*.md`. That is exactly the `paths:` trigger of `dor-ingress.yml`, so the filter is true if and only if the DoR check will run. The path is narrower than "anything under `backlog/`" on purpose: a PR that only moves a file into `backlog/completed/` starts no DoR run, and a gate waiting for a check that never starts would block it.
- **No task file, no cost.** When `tasks` is false the job is skipped, and `dor-readiness-gate` is in `allowed-skips`, so the rollup passes with no new run and no wait.
- **What it does.** It does not repeat the evaluation. It polls the check run on the PR head SHA, created by the `github-actions` app (REST `check-runs`, 20 s interval, 15 minute cap) and mirrors its conclusion: `success` passes; `failure`, `timed_out` or no completed run by the deadline fails the gate. A `skipped` run (the draft-time run, which has a draft guard) or a `cancelled` one (superseded by a concurrency restart) is stale on the draft-to-ready flip, so it is ignored and polling continues. The DoR job runs concurrently with the build and coverage jobs and finishes first, so on a mixed PR the wait is hidden.
- **Docs-only filing PRs.** A PR that only adds task files still passes the rollup when the DoR check passes. The docs-only archetype skips the code jobs as before and still runs this gate.
- **Overrides are unchanged.** A task with `blocked.reason` in its frontmatter is not counted as a violation by `dor-pr-has-violations`, so the DoR check passes and so does the gate.

Hermetic coverage: `.github/workflows/__tests__/ai-sdlc-gate.test.mjs` (`AISDLC-712.1` cases) asserts the filter equals dor-ingress's trigger, the check name matches the job, and the rollup decision for task-file, no-task and docs-only PRs.

## Historical workaround — `ai-sdlc/attestation: FAILURE` after a cancelled verify-attestation run (AISDLC-412)

**Fixed in AISDLC-412 (2026-05-23).** PRs opened before that fix landed may still show the symptom; the workarounds below remain valid for those.

### Symptom

The PR's check list shows two `AI-SDLC Verify Review Attestation` runs:
- one **CANCELLED** (older)
- one **SUCCESS** (newer)

…but the rollup `ai-sdlc/attestation: FAILURE` commit status persists, blocking the PR. Inspecting the failure description shows `verifier crashed before emitting result — see workflow logs` — that's the cancelled run's POST.

### Why it happened

`ai-sdlc-gate.yml (attestation-gate job)` declares `concurrency.cancel-in-progress: true`, so a newer push on the same PR cancels the in-flight run mid-execution. The pre-AISDLC-412 `Post ai-sdlc/attestation status` step used `if: always()`, which fires even on cancellation. The cancelled run's `Verify attestation` step never produced a `STATUS` output, so the step posted `ai-sdlc/attestation: failure` with the "crashed before emitting result" description.

GitHub commit-status semantics keep the most-recent status per context. Two parallel runs racing to POST can land in either order — when the cancelled run's FAILURE POST happens to win against the new run's SUCCESS POST, the rollup reads FAILURE and the PR sits stuck.

### Operator workarounds (pre-AISDLC-412 PRs only)

Pick any one — all force a fresh attestation post on the current HEAD:

1. **Re-run the cancelled workflow** (fastest, no commit overhead):
   ```bash
   gh run rerun <cancelled-run-id>
   ```
   Find the cancelled run ID via `gh run list --workflow=ai-sdlc-gate.yml (attestation-gate job) --status=cancelled --limit 5` filtered by your PR's branch.

2. **Push an empty commit** to re-trigger a clean workflow run:
   ```bash
   git commit --allow-empty -m "chore: re-trigger verify-attestation (AISDLC-412 workaround)"
   git push
   ```

3. **Wait for the next push event on the branch.** Any subsequent push will trigger a fresh verify-attestation run that posts SUCCESS — provided no further cancellation race occurs.

### Why the fix is `(success() || failure())` instead of `always()`

GitHub status-check function semantics:

| Function | Fires on |
|---|---|
| `success()` | no prior step failed |
| `failure()` | at least one prior step failed |
| `cancelled()` | workflow was cancelled |
| `always()` | UNION of the above three |

`success() || failure()` is the canonical "run on crash, NOT on cancel" pattern. It preserves the verifier-crash recovery branch (uncaught exception in the verifier → `failure()` fires → step posts `STATE=failure` with "verifier crashed before emitting result") while ensuring a cancelled run leaves the previous status untouched. Static YAML assertions guard the contract in `.github/workflows/__tests__/verify-attestation-cancelled.test.mjs`.

## Per-archetype attestation gating (AISDLC-388)

**Trust model after AISDLC-833 (DEC-0206).** The `ai-sdlc/attestation` status is posted by `attestation-post.yml` (`workflow_run`, default-branch definition, write token). It runs no PR code and reads nothing from the PR-controlled gate run except whether the `attestation-gate` job ran: it fetches the head envelope as data, re-runs `scripts/verify-attestation.mjs` from the default-branch checkout, and derives the state only from that result. Head sha, head repo and PR number come from the trusted `workflow_run` event, and the approving review (DEC-0065) is posted only for a valid result on a same-repo head with a PR number. The `attestation-gate` job still fails `ai-sdlc/pr-ready` on an invalid envelope.

`ai-sdlc/attestation` is **not a direct required check** on branch protection. It is a conditional contributor to the `ai-sdlc/pr-ready` rollup via per-archetype routing:

| PR archetype | `ai-sdlc/attestation` behavior |
|---|---|
| **docs-only** (all changed files in `spec/rfcs/**`, `docs/**`, `backlog/**`, or root `*.md`) | `ai-sdlc-gate.yml (attestation-gate job)` is **skipped** on `pull_request` events via `paths-ignore`. On `merge_group` events the inline short-circuit posts `success` cheaply. No envelope required. |
| **code or mixed** (at least one non-docs file) | `ai-sdlc-gate.yml (attestation-gate job)` runs and posts `ai-sdlc/attestation: success` (valid envelope) or `failure` (missing/invalid). Operators must see `success` before merging — governance enforced by reviewing the status, not by branch protection directly. |

This design preserves the AISDLC-380 forgery defense for code PRs while eliminating the "docs require attestation" workaround class (AISDLC-214 short-circuit + AISDLC-215 synthesis). The `ai-sdlc/attestation` status is an informational governance signal for code PRs — visible in the PR checks UI and webhook-subscribable — but branch protection gates only on `ai-sdlc/pr-ready`.

Per Q3 in the AISDLC-140 redesign decision and the industry consensus documented in `/tmp/research-prior-art.md` (SLSA, npm, PyPI, Google Cloud GKE, Red Hat), source-time attestations are inherently fragile against history rewrites (rebase, force-push) and the mainstream pattern is **audit at source, enforce at deploy**. The `ai-sdlc/pr-ready` rollup is the enforcer; attestation is the audit trail.

**AISDLC-214 cleanup (follow-up PR):** Once the operator updates branch protection (AISDLC-388 AC-2), the "short-circuit — post ai-sdlc/attestation success (docs-only)" step in `ai-sdlc-gate.yml (attestation-gate job)` can be deleted. It is intentionally retained until then to avoid a race where the merge queue still requires the status. Do NOT delete before the branch-protection update.

## Patch coverage — one target with a stored tolerance (AISDLC-376, AISDLC-726, AISDLC-976)

**Single source of truth:** `.ai-sdlc/patch-coverage.yaml` holds `target` (90) and `tolerance` (1). The gate passes at `target - tolerance`. The tolerance exists because the two measuring methods disagree by a point or two: codecov's patch computation and the script's unified-diff walk count executable lines differently, so a single hard number turns measurement noise into red checks. `check-pr-patch-coverage.mjs` reads the file as its default (no `--threshold` in CI), and `codecov.yml` patch and project targets are asserted equal to `target` by `scripts/check-pr-patch-coverage.test.mjs`.

**Coverage is gated once, in CI (AISDLC-726).** There is no local pre-push or Stop-hook coverage run and no skip variable; nothing runs coverage automatically on a developer machine. CI enforces two things:

| Layer | Where | Bypassable | Authority |
|---|---|---|---|
| Package line floors | `thresholds.lines` in each package's `vitest.config.ts` (90 for reference, orchestrator, pipeline-cli, mcp-server, mcp-advisor, sdk-typescript; 85 for dogfood, dashboard, conformance runner), enforced by `pnpm test:coverage` in CI | No | **Authoritative** |
| CI patch gate | `scripts/check-pr-patch-coverage.mjs` (PR-diff patch coverage, threshold `target - tolerance`) | No (no skip env var) | **Authoritative merge gate** |
| Informational | codecov.io (PR comment + dashboard, patch target = `target`) | Not a check | Visibility only |

Developers are asked (developer agent instructions) to hold the packages they touch to 95% lines and to run coverage for those packages once before their first push; that is a working target, not a CI gate.

The CI patch gate runs in two places that both must pass:

1. **`ci.yml` → `Patch coverage gate (≥90%)` step** — runs after `vitest --coverage` has produced `coverage-final.json` fixtures for the affected packages.
2. **`ai-sdlc-gate.yml` → `build-test` job → `Patch coverage gate (≥90%)` step** (the suite runs once, with coverage on) — runs as part of the `ai-sdlc/pr-ready` rollup, so any failure cascades into the single required check.

Both layers parse the unified diff (`git diff --unified=0 base..head`) per file, compute the union of NEW line numbers added/modified by the PR, then check each line against vitest's istanbul-format `coverage-final.json` statement map + hit counts. A line is "covered" when any statement on it was hit at least once. The aggregate ratio `covered / executable_changed_lines` must be ≥ `target - tolerance` from `.ai-sdlc/patch-coverage.yaml`.

### When the gate skips (intentional)

- **No changed code files.** Docs-only / workflow-only / config-only PRs produce no executable diff. The gate returns success with `reason: no-instrumentable-changes`. Mirrors the docs-only short-circuit pattern in `ai-sdlc-gate.yml (attestation-gate job)` and `ai-sdlc-review.yml`.
- **No executable lines in the patch.** A code-file change that only adds comments, blank lines, or pure type-only declarations produces 0 executable diff lines. The gate returns success with `reason: no-executable-changed-lines`.
- **Test files only.** `*.test.ts`, `*.test.tsx`, etc. are excluded from instrumentation by every vitest config (`coverage.exclude`). Pure-test PRs skip the gate.

### When the gate fails (the failure modes)

- **patch % < threshold.** Reports per-file coverage and the aggregate ratio. Operator action: add tests for the listed lines.
- **Missing coverage data entirely.** Zero `coverage-final.json` files found under the coverage root despite a code diff. Diagnostic: "did vitest --coverage run before this gate?" — almost always a workflow regression where the gate step ran before / instead of the `pnpm test:coverage` step.
- **Missing per-file coverage data.** A changed code file has no entry in any `coverage-final.json`. Treated as worst case (every changed line counted as uncovered), and it fails the gate regardless of the percentage. Operator action: either add tests covering the file, or add it to `NON_INSTRUMENTED_PATTERNS` in the script if it's not testable.
  - File kinds that trip this rule: (1) a source file no test loads (genuinely untested; correct failure); (2) files outside any package's coverage scope: `*.d.ts`, `*.config.*` tool configs, `__fixtures__/` and `__mocks__/` directories, CLI shims, barrels, bin shims, hooks, generated schemas (all in `NON_INSTRUMENTED_PATTERNS`; the first three added by AISDLC-726); (3) types-only modules (interfaces and type aliases) that tests only ever `import type`, which v8 never loads. Kind (3) cannot be recognised by path and is deliberately still a failure: add a runtime test import, or move the types into a barrel-excluded or `.d.ts` file. The higher threshold does not change this rule, since it fails on absence of data and not on the percentage.

### Why this replaces codecov/patch as the merge-blocking signal

Before AISDLC-372 dropped codecov/patch from required checks, the SaaS handled this enforcement. The drop opened a gap: PR #550 (AISDLC-302) landed UNSTABLE with 0.6% patch coverage after a shotgun-rename of 6 test files. The then-local pre-push gate was bypassed legitimately for a chore-sign commit, and nothing on the CI side caught the resulting drop because codecov/patch was no longer required. The operator (2026-05-19) flagged the missing CI-side mirror; AISDLC-376 closes the gap.

The new gate replicates codecov/patch's gating semantics (≥90% on the PR diff) without the SaaS latency, the App-source deadlock on zero-LCOV PRs, or the third-party-dependency risk.

### Operator action — optionally add as a direct required check

The gate rolls into `ai-sdlc/pr-ready` automatically (via the `build-test` job in `ai-sdlc-gate.yml`'s `needs:` list), so no branch-protection change is strictly required. Operators who want the gate to surface as an independently-named status on the PR checks tab can add it directly:

```bash
gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
  -F 'contexts[]=ai-sdlc/pr-ready' \
  -F 'contexts[]=Patch coverage gate (≥90%)' \
  -F 'strict=true'
```

The recommended default is to leave it inside the rollup (the alls-green pattern this whole doc argues for). Add it as a direct context only if your team specifically wants to point at it in dashboards.

### Hermetic tests

`scripts/check-pr-patch-coverage.test.mjs` covers:

- **AC-1**: success when patch % ≥ threshold (also in JSON mode).
- **AC-2**: failure when patch % < threshold, with per-file breakdown.
- **AC-3**: skip on 0 changed code files (docs-only, test-only, workflow-only).
- **AC-4**: diagnostic failure on missing coverage data (no fixture, or no entry for a changed file).
- CLI plumbing: argv validation, threshold range checks, missing coverage-root.
- Default threshold 90 when `--threshold` is omitted (AISDLC-726); non-instrumented kinds (`*.d.ts`, `*.config.*`, fixtures, mocks).
- Threshold customization: pass at 50% threshold with 60% coverage; fail at 90%.
- Multi-file aggregation: two files with 75% aggregate coverage pass at 70% threshold.

Run with: `pnpm test:patch-coverage-gate` or `node --test scripts/check-pr-patch-coverage.test.mjs`.

## Why codecov/patch is informational, not required (AISDLC-372)

`codecov/patch` was removed from required branch-protection status checks. It stays configured in CI (`codecov/codecov-action@v5` in `.github/workflows/ci.yml`) for informational reporting — PR comments with line-by-line coverage annotations and the codecov.io dashboard — but **no longer gates merges**.

The codecov/patch enforcement role has moved to the server-side gate documented in the [Patch coverage section above](#patch-coverage--the-90-gate-aisdlc-376-aisdlc-726). codecov.io stays purely informational.

### The two problems it caused

1. **SaaS processing latency.** codecov.io computes and posts the `codecov/patch` status only *after* our CI uploads coverage data to their servers. This happens on their infrastructure with shared backpressure. In practice this added 5–15 min of wall-clock time to every PR's merge readiness window, even when all our own checks had already passed.

2. **App-source deadlock on zero-coverage PRs.** Branch protection requires the status to come from the codecov GitHub App specifically; synthetic `gh api` statuses are rejected. PRs that produce no LCOV data (docs-only changesets, pure `.github/workflows/` changes, script-only changes) leave codecov with nothing to upload → codecov never posts its status → the PR sits in BLOCKED state permanently, even when every AI-SDLC gate is green. This was hit on PRs #553 and #554 during the AISDLC-370 cycle and required a workaround (empty-LCOV fallback) to undeadlock.

### Why a local gate is no longer used (AISDLC-726, DEC-0056)

The local pre-push coverage gate (`scripts/check-coverage.sh`) and the Stop-hook coverage run were removed. They were bypassable (`AI_SDLC_SKIP_COVERAGE_GATE=1`), duplicated the CI run two or three times per push, and CI was the only authoritative check anyway (PR #550 landed at 0.6% patch coverage while the local gate was bypassed). Coverage now runs once, in CI, at higher floors, and the developer agent is asked to run coverage for the packages it touches once before its first push.

### Operator action to apply

Branch protection changes require admin scope; CI does not have admin scope. After this PR merges, **run the apply script once**:

```bash
bash scripts/apply-codecov-drop.sh
```

This patched the required contexts at the time, dropping `codecov/patch`; the current list is the single `ai-sdlc/pr-ready` (AISDLC-836, see `scripts/sync-dor-branch-protection.sh`). The script is idempotent — safe to re-run if branch protection is recreated. See [`scripts/apply-codecov-drop.sh`](../../scripts/apply-codecov-drop.sh) for the full command and dry-run mode.

### Required contexts after the change

| Context | Required | Source |
|---|---|---|
| `Backlog Drift` | **no** (a `needs:` of the rollup) | `ai-sdlc-gate.yml` `backlog-drift` job |
| `ai-sdlc/pr-ready` | yes | `ai-sdlc-gate.yml` aggregator (alls-green) |
| `ai-sdlc/attestation` | **no** (informational governance signal for code PRs) | `ai-sdlc-gate.yml (attestation-gate job)` (conditional — skipped on docs-only PRs per AISDLC-388) |
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
        -F 'contexts[]=ai-sdlc/pr-ready' \
     -F 'strict=true'
   ```
   This is the exact command for ai-sdlc's own repo. Attestation is intentionally absent — `ai-sdlc/pr-ready` is now the sole gate.

3. **Verify the change.** Open one trivial docs PR and confirm:
   - `ai-sdlc/pr-ready` appears in the required-checks list.
   - The PR is mergeable when `ai-sdlc/pr-ready` is green (even without `ai-sdlc/attestation` posted).
   - `ai-sdlc-gate.yml (attestation-gate job)` does NOT fire on the docs PR (paths-ignore skips it).
   - Attempting to bypass (e.g. push directly to main) is still blocked.

4. **Open the AISDLC-214 cleanup PR** to delete the short-circuit step in `ai-sdlc-gate.yml (attestation-gate job)` (the "always post status on every head SHA" code path). This step is safe to delete ONLY after branch protection no longer requires `ai-sdlc/attestation`. The cleanup PR is intentionally separate (AISDLC-388 AC-4).

5. **Communicate the change** in the project's release notes / Slack so contributors know which check name to look for in the merge UI.

---

### Full cutover procedure (initial `ai-sdlc/pr-ready` adoption)

When you're ready to cut over from the legacy individual required checks, the operator does the following on the protected branch (example: `main`):

1. **Snapshot the current branch-protection config** so you can roll back if needed:
   ```bash
   gh api repos/<org>/<repo>/branches/main/protection > branch-protection-pre-aisdlc-140.json
   ```

2. **Update the required-checks list.** In the GitHub UI under *Settings → Branches → Edit rule for `main`*:
   - **Add:** `ai-sdlc/pr-ready`
   - **Remove:** the legacy required checks. For ai-sdlc itself this set is `CI OK`, `Post Review Results`, `codecov/patch`, `Build & Test (Node 20)`, `ai-sdlc/attestation`, etc. For adopters, remove whatever individual checks `ai-sdlc/pr-ready` now subsumes.

   Or via `gh api`:
   ```bash
   gh api -X PATCH repos/<org>/<repo>/branches/main/protection/required_status_checks \
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

For repos with a merge queue enabled (GHMQ, Mergify, Aviator), add `merge_group: types: [checks_requested]` back to `ai-sdlc-gate.yml`'s `on:` block — the aggregator was written to handle both events and the logic is preserved in git history (AISDLC-400 removed it for the direct-merge path). Repeat the shadow-mode comparison for `merge_group` events in that case.

## CodeQL scope (AISDLC-840, DEC-0161; AISDLC-934, DEC-0250)

CodeQL runs from `.github/workflows/codeql.yml` (advanced setup), not GitHub default setup. It has no `pull_request` trigger (AISDLC-934): a PR starts no CodeQL run, which saves the repository Actions token bucket during a drain. Every push to `main` and a weekly schedule (Mondays 05:17 UTC) scan all four languages (`actions`, `go`, `javascript-typescript`, `python`) unfiltered, so a vulnerable diff is scanned minutes after landing. The attestation reviewers still gate landing. This timing change is a recorded governance weakening (DEC-0250).

Operator action: default setup must be disabled or both setups upload duplicate alerts: `gh api -X PATCH repos/ai-sdlc-framework/ai-sdlc/code-scanning/default-setup -f state=not-configured`.

## Adopter scaffolding (sub-5)

The `ai-sdlc init` interactive wizard (planned in AISDLC-140 sub-5) will scaffold this workflow into adopter repos and walk through the cutover procedure interactively. Until that ships, copy `.github/workflows/ai-sdlc-gate.yml` from this repo and adjust the job bodies (especially `Build & Test`, `Coverage`, `Integration Tests`) to match your project's commands.

## References

- AISDLC-140 redesign memo: `/tmp/quality-gate-redesign-final.md`
- Prior-art research: `/tmp/research-prior-art.md`
- [`re-actors/alls-green`](https://github.com/re-actors/alls-green) — the action this aggregator wraps
- [Pants blog: Skipping GitHub Actions jobs without breaking branch protection](https://blog.pantsbuild.org/skipping-github-actions-jobs-without-breaking-branch-protection/) — canonical writeup of the same pattern applied to docs-only PRs
- [Mergify: Monorepo CI](https://mergify.com/blog/monorepo-ci-for-github-actions-run-exactly-the-tests-you-need-nothing-more/) — productized version of the pattern
- [GitHub docs: Troubleshooting required status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks) — official acknowledgement of the path-filter deadlock

## Approving review on a verified attestation (AISDLC-747, DEC-0065)

When the attestation envelope verifies on a `pull_request_target` run, the `Approve verified attestation` job in `ai-sdlc-gate.yml (attestation-gate job)` submits an APPROVE pull-request review from the Actions token (body: verdict summary plus links to the envelope and the nonce-bound transcripts), so GitHub, Scorecard and adopters see "reviewed" and not only the `ai-sdlc/attestation` commit status. Logic lives in `scripts/post-attestation-review.mjs` (hermetic tests in `scripts/post-attestation-review.test.mjs`).

- **Operator setting required:** Settings > Actions > General > Workflow permissions > enable "Allow GitHub Actions to create and approve pull requests". If it is off, the API returns 403 and the job fails loudly with an error naming that setting.
- **Never approves** when verification is not `valid`, on drafts, on `pull_request` or merge_group events (only `pull_request_target`), or for fork PRs (head repo must equal base repo). The job checks out the default branch explicitly (`persist-credentials: false`), so the script is base-branch code, never PR content; until the script exists on the default branch the step skips with a notice (bootstrap).
- **Idempotent per head SHA:** a rerun does not re-approve the same SHA; when the head changes, the workflow's own stale approval is dismissed before a new one is posted. Own reviews are recognised by a hidden body marker AND the `github-actions[bot]` author, so human reviews (or a forged marker from another account) are never touched.
- **Least privilege:** `pull-requests: write` is granted only to the `approve` job; the `verify` job keeps `pull-requests: read`.

## `ai-sdlc init` enforcement: detect and fall back (AISDLC-748, DEC-0014)

`ai-sdlc init` enforces by default, and chooses the mechanism by runtime capability, never by guessing the plan. It tries `PUT /repos/{owner}/{repo}/branches/main/protection`:

1. **API available (200: public repo or paid plan).** Init always applies protection requiring `ai-sdlc/pr-ready`, `codecov/patch` and 1 approving review (DEC-0014); the review count is never lowered. The scaffolded adopter `ai-sdlc-gate.yml (attestation-gate job)` ships a verifying `approve` job (AISDLC-748.1) that posts the review only after the envelope verifies, so a non-admin merge needs no human review. It requires the repo setting "Allow GitHub Actions to create and approve pull requests". `ADOPTER_TEMPLATE_POSTS_APPROVAL`, derived from the template, selects the message init prints.
2. **API returns 403 (GitHub Free private repo).** Init falls back to client-side enforcement: `cli-merge-if-eligible` refuses unless the attestation verifies and checks are green, and the governance hook keeps blocking direct agent merges. `ai-sdlc doctor` reports `enforcement: client-side only; the server cannot block a manual merge` as an error-level finding, because a human can still merge manually in the GitHub UI.

Both paths print what was installed and the opt-out flag, `--no-branch-protection`. `--yes` follows the same detection. Re-run `ai-sdlc init --add branch-protection` after making the repo public or upgrading the plan.

## API-call reductions (AISDLC-955)

- The three `dorny/paths-filter` steps in `Detect Changes` pass `token: ''`, so they diff with git (the job checks out with `fetch-depth: 0`) and make no `pulls/<n>/files` API request.
- The `issue-link` job (formerly `require-issue-link.yml`) lists changed files at `per_page=100` and reads the live PR text, so it runs under the gate's concurrency group and a rerun picks up an edited body.

## Consolidated gate (AISDLC-934, DEC-0250)

Two standalone PR workflows became jobs of `ai-sdlc-gate.yml`, so one checkout and one token budget serve them and both feed `ai-sdlc/pr-ready`:

- `issue-link` (check name `ai-sdlc/issue-link`): runs `scripts/issue-link-decision.mjs` from the base commit. A PR with no issue or backlog task link (and no `ci:no-issue-required` label) fails the job and so `ai-sdlc/pr-ready`, with the same description as before. It no longer posts a separate commit status.
- `rfc-lifecycle` (check name `RFC Lifecycle Gate`): runs only when `Detect Changes` reports a changed `spec/rfcs/*.md` (`rfcs` output; an allowed skip otherwise). It keeps the transition check and the AISDLC-417 guards, and a forbidden transition fails `ai-sdlc/pr-ready`.

A trusted PR push starts two workflows: the gate and the auto-arm workflow. `untrusted-pr-gate.yml` and `ai-sdlc-review.yml` also start but every job is skipped by a job-level trust condition (fork, non-collaborator or bot only), so no runner starts and no API call is made. `no-new-pr-gate.test.mjs` fails if any other workflow gains a `pull_request` or `pull_request_target` trigger.
