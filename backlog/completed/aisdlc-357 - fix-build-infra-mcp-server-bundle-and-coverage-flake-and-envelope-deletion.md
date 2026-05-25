---
id: AISDLC-357
title: >-
  fix(infra): mcp-server stale-bundle auto-rebuild + coverage-gate flake +
  envelope-deletion safety
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - infra
  - pipeline-friction
  - build-system
dependencies: []
priority: medium
references:
  - .husky/pre-push
  - scripts/check-coverage.sh
drift_log:
  - date: '2026-05-22'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      ai-sdlc-plugin/mcp-server/scripts/verify-bundle.mjs
    resolution: flagged
  - date: '2026-05-25'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      docs/operations/merge-queue-rebase-recovery.md
    resolution: flagged
drift_checked: '2026-05-25'
---

## Three build/test infrastructure friction items hit during the 282/286/323 finalization

Grouping because they're all infra-level (no orchestrator-logic changes), small individually, hit operator UX during pre-push hooks.

## Bug 1 — `mcp-server/dist/bin.js` stale-bundle blocks merge after rebase

**Symptom**: the `Verify dist/bin.js` CI check (`ai-sdlc-plugin/mcp-server/scripts/verify-bundle.mjs`) compares the committed bundle SHA to a clean-rebuild SHA. After any rebase that touches `pipeline-cli/` source (which is a workspace dep of mcp-server), the committed bundle goes stale → CI fails.

**Repro**: hit on AISDLC-285 finalization after rebase onto post-AISDLC-280 main. Workaround: `pnpm --filter @ai-sdlc/plugin-mcp-server build` then amend commit. Required operator-amend cycle.

**Fix**: in `.husky/pre-push`, after `check-task-moved.sh` and BEFORE `check-attestation-sign.sh`, detect when the staged commits touch `pipeline-cli/src/**` AND the mcp-server bundle didn't get rebuilt → auto-rebuild + auto-amend (or fail with a clear "run `pnpm --filter @ai-sdlc/plugin-mcp-server build` then re-push" message). Same pattern as the auto-task-move hook.

## Bug 2 — `pnpm test:coverage` flaky exit during pre-push coverage gate

**Symptom**: `scripts/check-coverage.sh` runs `pnpm test:coverage` per package. Observed once on AISDLC-351 finalization: `vitest run --coverage` exited code 1 with NO failing tests + all coverage above 80%. Retry on the next push succeeded. Suspected cause: `Error: process.exit(N)` lines from intentional-exit tests (e.g. CLI exit-code tests) confusing vitest's parent process accounting.

**Repro**: rare; once during AISDLC-351 push. Operator workaround: re-run push.

**Fix**: investigate the vitest run for spurious failure modes. If the issue is intentional-exit tests, isolate them in a separate vitest project that doesn't fail the parent on exit codes. If unreproducible, leave as-is + document the "if test:coverage fails with no actual test failures, just re-run" pattern.

## Bug 3 — Stale envelope deletion footgun

**Symptom**: when an operator runs `rm -f .ai-sdlc/attestations/*.dsse.json` (intending to drop ONE stale envelope from a re-sign cycle), the glob expansion deletes 200+ pre-existing envelopes from main. Recoverable via `git checkout HEAD -- .ai-sdlc/attestations/` but bites operators who don't realize the glob was greedy.

**Repro**: hit during AISDLC-322 finalization 2026-05-17.

**Fix**: 
- (a) Add a helper script `scripts/drop-stale-attestation-envelope.mjs <head-sha>` that deletes ONLY the specific envelope for the given SHA + warns if the SHA isn't reachable from current HEAD.
- (b) Document in `docs/operations/merge-queue-rebase-recovery.md` under "Re-signing after a rebase" — never `rm *.dsse.json`, always target the specific SHA.

## Acceptance criteria

- [ ] **Bug 1**: pre-push hook auto-rebuilds mcp-server bundle when `pipeline-cli/src/**` is in the push range. Test: stage a pipeline-cli change without rebuilding bundle; assert hook auto-rebuilds + amends.
- [ ] **Bug 2**: investigate flake root cause. Either fix (isolate intentional-exit tests) or document (retry pattern in `docs/operations/merge-queue-rebase-recovery.md`).
- [ ] **Bug 3**: helper script `scripts/drop-stale-attestation-envelope.mjs` ships + is referenced from the recovery runbook.

## Source

Operator session 2026-05-17 finalizing AISDLC-282/286/323. Bug 1 hit on AISDLC-285 (an earlier 504 finalization). Bug 2 hit once on AISDLC-351 push. Bug 3 hit once on AISDLC-322 re-sign.
