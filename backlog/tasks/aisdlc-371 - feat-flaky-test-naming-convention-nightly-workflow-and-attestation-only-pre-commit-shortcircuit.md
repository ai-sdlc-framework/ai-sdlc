---
id: AISDLC-371
title: 'feat(ci): flaky-test naming convention + nightly workflow + pre-commit short-circuit on attestation-only commits'
status: To Do
assignee: []
created_date: '2026-05-19'
labels:
  - ci
  - throughput
dependencies: []
priority: high
references:
  - .github/workflows/ci.yml
  - .husky/pre-commit
---

## Problem

AISDLC-368 shipped the emergency CI throughput hotfix (Node 20 drop, 3 individual flaky-test skips, vitest-changed coverage). The polish items from the original 368 spec didn't ship:

1. **No `*.flaky.test.ts` convention** — the 3 skips are inline `it.skip` with explanatory messages; future flake fixes require the same ad-hoc pattern with no consistent way to find or run them
2. **No nightly flaky-test workflow** — flaky tests stay skipped forever; nothing periodically retries them to confirm they're still flaky vs. accidentally-skipped-real-tests
3. **No a new operator-runbook doc under `docs/operations/`** — convention isn't documented; future operators don't know what to do when a test bites
4. **No pre-commit short-circuit for attestation-only commits** — every chore-sign re-commit re-runs `tsc --noEmit` (10-15s); accumulates to several minutes per multi-cycle PR
5. **No bisect/isolation of the open AISDLC-302 PR Coverage hang** — that PR's CI Coverage job hangs 60+min on every retrigger; tests pass locally <1s; one of the new RFC-0025 quality-* test files is the culprit but unidentified

## Fix (single PR)

### A. `*.flaky.test.ts` convention

Update vitest config in each workspace (`orchestrator/`, `pipeline-cli/`, `reference/`, `dogfood/`, `mcp-server/`) to exclude `**/*.flaky.test.ts` from the default test run:

```ts
// vitest.config.ts
test: {
  exclude: ['node_modules/**', 'dist/**', '**/*.flaky.test.ts'],
}
```

Rename the 3 currently-skipped tests' enclosing FILES (not individual `it.skip` lines) so they live in `.flaky.test.ts` files:

- `orchestrator/src/cli/commands/init-workspace.test.ts` → split out the timing-out test into a `.flaky.test.ts` sibling
- `pipeline-cli/src/orchestrator/loop.filters.test.ts` → split out Phase 3 4-task acceptance into `.flaky.test.ts` sibling
- `orchestrator/src/runtime/worktree-pool.integration.test.ts` → already integration-isolated; rename whole file to `.flaky.test.ts`

Remove the inline `it.skip` from the original files (now empty of the flaky case; rest of tests still run).

### B. Nightly flaky-tests workflow

a new workflow under `.github/workflows/`:

```yaml
name: Flaky Tests (nightly)
on:
  schedule:
    - cron: '0 4 * * *'  # 04:00 UTC daily
  workflow_dispatch:
jobs:
  flaky:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm -r exec -- vitest run --testNamePattern='.*' '**/*.flaky.test.ts' || true
      - name: Upload flaky pass/fail summary
        # post a summary to the workflow run + optional Slack ping
        run: |
          # exit summary into $GITHUB_STEP_SUMMARY
          echo "## Flaky test nightly run" >> "$GITHUB_STEP_SUMMARY"
          # ... count pass/fail ...
```

Job is `continue-on-error: true` so a flaky failure doesn't fail the workflow run — we just want signal.

### C. a new operator-runbook doc under `docs/operations/`

Document:
- The `*.flaky.test.ts` convention + how vitest excludes it
- When to rename a test: it fails CI ≥2× with no code change between attempts
- How to investigate via nightly run logs
- How to un-flaky a test (write deterministic version + remove from `*.flaky.test.ts`)
- A registry table of currently-flaky tests with first-flaked date

### D. Pre-commit short-circuit on attestation-only commits

In `.husky/pre-commit`, at the very top:

```bash
STAGED=$(git diff --cached --name-only)
# Match envelope files: .ai-sdlc/attestations/<sha>.dsse.json
if echo "$STAGED" | grep -qvE '^\.ai-sdlc/attestations/[a-f0-9]+\.dsse\.json$'; then
  : # has non-envelope files — run full pre-commit below
else
  echo "[pre-commit] attestation-only commit — skipping tsc"
  exit 0
fi
```

Saves ~10-15s per chore-sign commit; accumulates to several min on PRs that go through multiple re-sign cycles.

### E. Bisect + isolate the open AISDLC-302 PR Coverage hang

the open AISDLC-302 PR (AISDLC-302) Coverage job hangs 60+min on every CI retrigger. Tests pass <1s locally. Bisect by `it.skip`-ing one test file at a time and pushing/measuring until the hang disappears. Then rename the culprit to `*.flaky.test.ts` per (A).

Suspect order (most likely first): the new quality-* test files added under `pipeline-cli/src/tui/analytics/` and `pipeline-cli/src/cli/` by the AISDLC-302 PR. Likely culprits: a JSONL-writer test, a sampling-logic test, a metrics test, a classifier test, and a corpus CLI test. Implementer should `it.skip` them one at a time and re-run CI to find the hang.

## Acceptance criteria

- [ ] Vitest configs in all workspace packages exclude `**/*.flaky.test.ts`
- [ ] 3 known-flaky tests moved into sibling `*.flaky.test.ts` files; original `it.skip` markers removed
- [ ] New a new workflow under `.github/workflows/` runs nightly with `continue-on-error: true`; manual `workflow_dispatch` works
- [ ] a new operator-runbook doc under `docs/operations/` covers the convention + investigation flow + registry
- [ ] `.husky/pre-commit` short-circuits on attestation-only commits
- [ ] the open AISDLC-302 PR hang bisected; offending test file renamed to `*.flaky.test.ts`; that PR unblocks
- [ ] New code reaches 80%+ patch coverage (only workflow + script changes — coverage is trivially met)

## Out of scope

- LLM-driven auto-investigation of why a test is flaky (separate idea)
- TUI surface showing flaky-test trend over time (separate AISDLC follow-up)
- Replacing vitest with a different test runner (much bigger scope)

## Source

Operator session 2026-05-19 follow-up: AISDLC-368 emergency hotfix shipped 5/9 acceptance criteria; this task tracks the remaining 4 + the the open AISDLC-302 PR bisect needed to unblock the last code PR from that batch.
