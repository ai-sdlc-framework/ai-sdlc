# `cli-pr-unstick` — operator guide

`cli-pr-unstick` is the deterministic PR-blocker auto-resolver. It encodes the recurring failure modes the operator was previously fixing by hand into a single Stage A pass plus a Stage B fallback prompt.

Why it exists: in a single day, three PRs got stuck on mechanically-detectable, mechanically-fixable problems. Each cost the operator notice → Claude session → from-scratch investigation → fix. This CLI eliminates the toil for the known cases and structures the input to Claude for the unknown ones.

The CLI is part of `@ai-sdlc/pipeline-cli`. Install via `pnpm install`; the bin shim lands at `pipeline-cli/bin/cli-pr-unstick.mjs`. After `pnpm build`, both `pnpm exec cli-pr-unstick …` and `node pipeline-cli/bin/cli-pr-unstick.mjs …` work.

## Usage

```bash
# Single PR — detect + auto-fix in place.
cli-pr-unstick 176

# Detect-only (no mutations, no statuses forwarded).
cli-pr-unstick 176 --dry-run

# Iterate every open PR. Per-PR errors don't abort the loop.
cli-pr-unstick --all

# Detect-only sweep — safe to run as often as you want.
cli-pr-unstick --all --dry-run

# JSON output for piping into another tool.
cli-pr-unstick --all --format json

# Append a Stage B diagnosis prompt for PRs Stage A couldn't help.
cli-pr-unstick 176 --stage-b
```

Auto-fix is the default for non-dry-run mode; `--auto-resolve` is also accepted explicitly so the wake-up sentinel prompt can be unambiguous (`cli-pr-unstick --all --auto-resolve`).

## Stage A detection table

The Stage A pass runs five deterministic checks per PR. Each is independent — multiple can fire on a single PR.

| # | Check ID | Symptom | Auto-fix |
|---|---|---|---|
| 1 | `chore-status-forwarding` | HEAD subject begins with `chore(ci): sign review attestation` (the AISDLC-87 CI-attestor `(skip ci marker)` chore commit, which suppresses every workflow). Required statuses (`CI OK`, `Post Review Results`, `codecov/patch`) are missing at HEAD but present on the parent. | POST `state=success` for each missing context to `repos/{owner}/{repo}/statuses/{head-sha}` via `gh api`. |
| 2 | `rebase-when-behind` | `gh pr view --json mergeStateStatus` returns `BEHIND`. | `gh pr update-branch --rebase`. Idempotent — if the PR is already up-to-date, the gh CLI is a no-op. |
| 3 | `docs-only-fallback` | Every changed file matches one of the docs `paths-ignore` patterns (`spec/rfcs/**`, `docs/**`, `backlog/{tasks,completed}/**`, root `*.md`) and `Post Review Results` is missing/non-success. The `ai-sdlc-review-docs-only.yml` workflow normally posts this — Stage A is a backstop. | Forward `Post Review Results: success` via `gh api`. |
| 4 | `stale-attestation` | `ai-sdlc/attestation` is `failure` AND the PR has ≥3 approving reviews (mirrors the AISDLC-87 attestor's own gate). Caused by `contentHashV3` drift after a rebase. | Empty no-op commit + `git push --force-with-lease` from the PR's worktree to re-trigger `verify-attestation.yml`. Refuses to push when on `main`/`master`/detached HEAD as a safety guard. |
| 5 | `backlog-drift-report` | The `Backlog Drift` check is `failure`. | **REPORT ONLY** — no auto-fix. The fix lives in `backlog-drift fix --task <id>` (AISDLC-125). |

## Stage B — LLM diagnosis fallback

When Stage A finds no matches but the PR is still stuck, pass `--stage-b` to emit a markdown prompt that captures every signal Stage A gathered (statuses at HEAD, check runs, files changed, mergeStateStatus, approving review count). Paste that into Claude Code rather than letting the agent re-discover everything via `gh` + `git`.

## Wake-up sentinel integration

Update the autonomous orchestration wake-up sentinel-prompt to invoke:

```
node pipeline-cli/bin/cli-pr-unstick.mjs --all --auto-resolve
```

before dispatching new work. Per-PR errors don't abort the loop, so a single broken PR can't take the wake-up cycle down. Run with `--dry-run` once after wiring it in to confirm no surprise mutations on a Friday afternoon.

## Safety and idempotency

- Detection is read-only. Stage A only mutates when an auto-fix matches AND `--dry-run` is absent.
- The status-forwarding fixes (`chore-status-forwarding`, `docs-only-fallback`) are idempotent — re-running on a PR whose statuses are already `success` is a no-op (the check's `headState !== 'success'` guard).
- The rebase fix is idempotent — `gh pr update-branch --rebase` does nothing on an already-up-to-date branch.
- The no-op-push fix (`stale-attestation`) is **not** idempotent — every invocation pushes a new empty commit. Don't run it in a loop without verifying the attestation cleared first. The 3-approval gate makes accidental triggering rare.

## Failure modes

- **`gh: Not Found`** on a PR — the PR was closed/deleted between `gh pr list` and the per-PR fetch. Captured into `result.error`; the `--all` loop continues.
- **`refusing to no-op-push from branch "main"`** — the `stale-attestation` fix tried to push from a worktree on `main`. Run from the PR's branch worktree (`.worktrees/aisdlc-NNN/`).
- **Network / rate-limit failures** — captured per-call; non-zero exit only when EVERY PR errored.

## Implementation reference

- Source: `pipeline-cli/src/cli/pr-unstick.ts`
- Tests: `pipeline-cli/src/cli/pr-unstick.test.ts` (hermetic — no real `gh` / `git` invocations)
- Bin shim: `pipeline-cli/bin/cli-pr-unstick.mjs`

The detection helpers (`detectChoreStatusForwarding`, `detectBehindMain`, etc.) are exported as pure functions so other tools can call them without going through the yargs router.
