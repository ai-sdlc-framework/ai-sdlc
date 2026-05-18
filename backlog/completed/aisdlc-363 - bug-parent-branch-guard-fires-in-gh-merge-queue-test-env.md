---
id: AISDLC-363
title: 'bug(orchestrator): runParentBranchGuard (AISDLC-358) fires in GH merge-queue test env — 7 cli/orchestrator.test.ts tests fail deterministically on every queue probe'
status: Done
assignee: []
created_date: '2026-05-18'
labels:
  - orchestrator
  - test-infrastructure
  - merge-queue
  - critical
  - autonomous-loop-blocker
dependencies:
  - AISDLC-358
priority: critical
references:
  - pipeline-cli/src/cli/orchestrator.test.ts
  - pipeline-cli/src/orchestrator/loop.ts
  - scripts/check-orchestrator-state.sh
---

## Bug — NOT flaky, DETERMINISTIC failure in queue probe context

GH merge queue checks out PRs on a temporary `gh-readonly-queue/main/pr-N-<sha>` branch. CI working tree is `cwd` for `pnpm test:coverage`. `runParentBranchGuard` (introduced by AISDLC-358 to enforce Pattern-C contract) discovers:

1. Parent working tree symbolic-ref → `gh-readonly-queue/main/pr-N-<sha>` (NOT `main`)
2. Attempts auto-recovery: `git checkout main`
3. Local `main` ref doesn't exist in the queue probe's shallow checkout
4. Checkout fails with `pathspec 'main' did not match any file(s) known to git`
5. Per AISDLC-358's hardening (commit 7d96da06), the failure throws `ParentNotOnMainError` instead of silently swallowing

Result: 7 tests in `pipeline-cli/src/cli/orchestrator.test.ts` fail on every PR's queue probe.

## Forensic evidence

Failing tests (deterministic, all in `cli/orchestrator.test.ts`):

1. `cli-orchestrator router > start > runs N ticks when --max-ticks is set + flag is enabled`
2. `cli-orchestrator router > start > threads --spawner codex into start umbrella dispatch`
3. `cli-orchestrator router > tick > runs a single tick + emits a JSON result when the flag is enabled`
4. `cli-orchestrator router > tick > threads --spawner codex into tick umbrella dispatch`
5. `cli-orchestrator router > tick > honors --dry-run by reporting candidates without dispatching`
6. `cli-orchestrator tick --continue-from-result (AISDLC-225) > reads dispatch-result.json and forwards to dispatch instead of re-dispatching`
7. `cli-orchestrator tick --continue-from-result (AISDLC-225) > bare --continue-from-result flag (no path) resolves to default artifact path`

All hit the same throw site:
```
ParentNotOnMainError: [orchestrator] parent working tree is on branch
  'gh-readonly-queue/main/pr-528-5733f3cb599fefdfd50a8cbd9bd3a5032b8cd14c'
  (expected 'main') with dirty tracked files: git checkout main failed
  (exit 1): error: pathspec 'main' did not match any file(s) known to git.
  Recovery: git -C ".." checkout main && git -C ".." reset --hard origin/main
 ❯ runParentBranchGuard src/orchestrator/loop.ts:2040:11
 ❯ runOrchestratorTick src/orchestrator/loop.ts:461:3
 ❯ Object.handler src/cli/orchestrator.ts:212:24
```

The PR is wrongly blamed for "test failures" when in fact the queue probe context itself is causing the guard to throw — every code-touching PR will hit this until fixed.

## Root cause (per AISDLC-358 test-reviewer Major 3)

The AISDLC-358 test-reviewer flagged that existing loop test files do not inject `parentBranchGuard: async () => {}` stub. The dev's fix-up commit (9f3fd04f) injected the stub into 12 loop test files BUT MISSED `pipeline-cli/src/cli/orchestrator.test.ts` — which lives under `cli/` not `orchestrator/` so it didn't match the dev's file-pattern search.

Per CLAUDE.md hard rule for tests: `runOrchestratorTick`/`runOrchestratorLoop` callers must inject the `parentBranchGuard` adapter as a no-op (`async () => {}`) so the production guard doesn't fire in test environments.

## Acceptance criteria

### Inject no-op stub into all cli/orchestrator.test.ts call sites

- [x] **`pipeline-cli/src/cli/orchestrator.test.ts`** — find every `buildOrchestratorCli(adapters, ...)` call (or the underlying test-helper that constructs adapters) and inject `parentBranchGuard: async () => {}`.
- [x] **Test the test**: simulate the queue probe environment by setting `CI=true` + cwd to a branch named like `gh-readonly-queue/main/pr-foo` and run the suite — all 7 tests pass.

### Defense in depth (optional, recommended)

- [x] **`runParentBranchGuard`** — skip guard entirely when current branch matches the `gh-readonly-queue/` prefix. The queue probe is sanctioned ephemeral state; we MUST NOT auto-recover from it because the queue's purpose is to validate the rebased PR. Add early-return + warn log.
- [x] **`scripts/check-orchestrator-state.sh`** — same skip when branch starts with `gh-readonly-queue/`. The script already does the auto-recovery via shell; mirror the TS guard's behavior.
- [x] **Detect missing local `main` ref**: if `git checkout main` fails with `pathspec 'main' did not match`, that's a SHALLOW CHECKOUT condition (CI / queue probe). Skip with warn rather than throw — the guard's purpose is to protect Pattern-C operator workflows, not CI.

### Test coverage for the guard's defensive behavior

- [x] Hermetic test: branch = `gh-readonly-queue/main/pr-N-sha` → guard returns silently (no checkout attempted)
- [x] Hermetic test: branch = some other non-main + `git checkout main` returns exit 1 with `pathspec 'main' did not match` stderr → guard returns with warn (no throw)
- [x] Existing AISDLC-358 tests still pass: branch = `feat/foo` with main present + clean tree → auto-recovers as before

## Out of scope

- Removing the parent-branch-guard entirely (defeats AISDLC-358's purpose)
- Disabling the guard in all CI contexts via env var (too broad — operator's CI might legitimately want the guard)
- Migrating Pattern-C contract enforcement to a different layer (separate concern)

## Source

Operator-supplied 2026-05-18 from queue probe CI output: 7 tests fail with `ParentNotOnMainError` referencing `gh-readonly-queue/main/pr-528-...` branch. Filed as `bug` because PRs are being false-failed on a CI environmental artifact, not real code issues — and the autonomous loop is wasting cycles on apparent test failures that are actually queue-context issues.

Pairs with:
- AISDLC-358 (the source of the guard — test-reviewer's Major 3 was the warning shot)
- AISDLC-360 (v4-kick auto-rebase-and-resign — orthogonal, but same operator-frustration root cause)
- AISDLC-362 (contentHashV5 — orthogonal, V5 fixes a different queue-probe issue)
