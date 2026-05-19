---
id: AISDLC-368
title: 'perf(ci): collapse Node matrix + isolate flaky tests + pre-commit short-circuit for ~50% CI throughput'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - ci
  - throughput
  - critical
  - performance
dependencies: []
priority: critical
references:
  - .github/workflows/ci.yml
  - .github/workflows/ai-sdlc-gate.yml
  - .husky/pre-commit
---

## Problem

Operator session 2026-05-19: shipping 11 PRs took ~6 hours largely because of CI/CD time. Per-PR breakdown:

- **CI run = 5-10min** × **2 Node versions matrix** = ~10min per attempt
- **Coverage = 5min** (separate job)
- **Integration + Lint = 2-3min**
- **Total best case = ~15min per PR**
- **Flaky test failure → +12min** (rerun) — happened on ~50% of PRs
- **Node 20 deprecation warnings** noisy in every run

Combined: a PR that lands in 15min best-case can easily take 30-45min with flake retries. With ~10 PRs through the queue serially, that's 5+ hours.

## Fix (single PR, multiple workflow changes)

### A. Collapse Node version matrix

`.github/workflows/ci.yml` `build-and-test` job runs matrix `node-version: [20, 22]`. Drop Node 20 entirely, keep Node 22 (or single Node 24 — see C). Roughly **-50% on Build & Test wall time** because the two matrix legs run in parallel slots but compete for shared runner pool.

### B. Force JavaScript actions to Node 24

Add at workflow level:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
```

Silences the deprecation warning that's been showing on every `actions/checkout@v4` and `dorny/paths-filter@v3` step. No behavior change — just future-proofs.

### C. Flaky test isolation pattern

Establish a `*.flaky.test.ts` filename convention that's:

1. **Excluded from the main test suite** via vitest `exclude: ['**/*.flaky.test.ts']`
2. **Included in a new nightly workflow** `.github/workflows/flaky-tests.yml` that runs `vitest run --include='**/*.flaky.test.ts'` on a cron schedule with `continue-on-error: true`
3. **Documented in `docs/operations/flaky-tests.md`**: how to rename a test → `.flaky.test.ts` when it bites a PR; how to investigate via the nightly run logs

Rename these known offenders to `.flaky.test.ts`:

- `orchestrator/src/runtime/worktree-pool.integration.test.ts` (intermittent `fatal: failed to read .git/worktrees/.../commondir: Success` — write-then-read race in git)
- `orchestrator/src/cli/commands/init-workspace.test.ts` "falls back to your-org placeholder when git origin is missing" — times out 5s on CI
- `pipeline-cli/src/orchestrator/loop.ts` "runOrchestratorTick — Phase 3 4-task fixture acceptance" — times out 6s on CI

These tests are 100% pass locally but cause spurious CI re-runs.

### D. Pre-commit short-circuit for attestation-only commits

`.husky/pre-commit` currently runs `tsc --noEmit` for every commit. When the only staged file is `.ai-sdlc/attestations/*.dsse.json` (the chore-sign pattern), tsc adds ~10-15s for zero value — the envelope file is bytes-on-disk only.

Add at top of `.husky/pre-commit`:

```bash
STAGED=$(git diff --cached --name-only)
if echo "$STAGED" | grep -qvE '^\.ai-sdlc/attestations/[a-f0-9]+\.dsse\.json$'; then
  : # Has non-envelope files — run full pre-commit
else
  echo "[pre-commit] attestation-only commit — skipping tsc"
  exit 0
fi
```

This cuts ~10s × ~30 re-sign commits per session = ~5 min/session.

### E. Bisect + skip the PR #550 Coverage hang

PR #550 (AISDLC-302) Coverage/Build jobs hang >60min on every CI run; tests pass <1s locally. Bisect which test in the new files causes the CI runner hang:

- `pipeline-cli/src/tui/analytics/quality-classifier.test.ts`
- `pipeline-cli/src/tui/analytics/determinism-detector.test.ts`
- `pipeline-cli/src/tui/analytics/quality-metrics.test.ts`
- `pipeline-cli/src/tui/analytics/quality-router.test.ts`
- `pipeline-cli/src/cli/quality-corpus.test.ts`

Likely candidate: `quality-router.test.ts` (writes JSONL — fs-watcher / subprocess hang on CI runner).

Once identified, rename to `.flaky.test.ts` (per C) so #550 can land.

## Acceptance criteria

- [ ] `.github/workflows/ci.yml` `build-and-test` matrix dropped from `[20, 22]` to `[22]` (or `[24]` if Node 24 build passes locally)
- [ ] `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true` set at workflow level on `ci.yml` + `ai-sdlc-gate.yml` + `verify-attestation.yml`
- [ ] Vitest config in `orchestrator/`, `pipeline-cli/`, `reference/`, `dogfood/`, `mcp-server/` excludes `**/*.flaky.test.ts`
- [ ] New `.github/workflows/flaky-tests.yml` runs nightly via `schedule: cron: '0 4 * * *'`, executes only `*.flaky.test.ts`, `continue-on-error: true`
- [ ] New `docs/operations/flaky-tests.md` documents the convention + nightly run + investigation flow
- [ ] 3 known-flaky tests renamed to `*.flaky.test.ts`
- [ ] `.husky/pre-commit` short-circuits when staged files are envelope-only
- [ ] Identify the test causing #550's >60min hang; rename to `.flaky.test.ts`
- [ ] Total CI time per PR measured before/after; target ≤8min p50 (down from ~15min p50)

## Out of scope

- Reducing the cost-governance ledger update frequency (separate AISDLC-364 work)
- Adding test parallelism beyond what vitest already provides
- Migrating from vitest to a faster test runner

## Source

Operator session 2026-05-19: 11 PRs shipped but throughput limited by CI cycle time. "We need consistent and predictable merges landing."
