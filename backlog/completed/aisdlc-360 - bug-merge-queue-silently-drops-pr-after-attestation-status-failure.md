---
id: AISDLC-360
title: >-
  bug(orchestrator): merge queue silently drops PR after queue probe
  ai-sdlc/attestation status FAILURE — needs auto-rebase-and-resign
status: Done
assignee:
  - '@claude'
created_date: '2026-05-17'
completed_date: '2026-05-22'
labels:
  - orchestrator
  - merge-queue
  - pipeline-friction
  - critical
  - autonomous-loop-blocker
dependencies:
  - AISDLC-343
priority: critical
references:
  - .github/workflows/verify-attestation.yml
  - ai-sdlc-plugin/scripts/sign-attestation.mjs
  - orchestrator/src/runtime/attestations.ts
drift_log:
  - date: '2026-05-25'
    type: ref-deleted
    detail: >-
      Referenced file no longer exists:
      docs/operations/merge-queue-rebase-recovery.md
    resolution: flagged
drift_checked: '2026-05-25'
---

## Bug

PR #521 (AISDLC-287, RFC-0035 Phase 3) — observed during 2026-05-17 operator-away autonomous loop.

The PR's local-side attestation envelope was valid when signed against base SHA `cb876257` (at the time the dev work was reviewed + signed). After sibling PR #522 (AISDLC-283) merged + bumped main to `c76c4430`, GitHub's merge queue began probing 521 against `c76c4430`. Three consecutive queue probes ran:

```
2026-05-17T21:53:11Z success AI-SDLC PR Ready Gate gh-readonly-queue/main/pr-521-c76c44303e248b671fef2b344
2026-05-17T21:35:23Z success AI-SDLC PR Ready Gate gh-readonly-queue/main/pr-521-c76c44303e248b671fef2b344
2026-05-17T21:06:57Z success AI-SDLC PR Ready Gate gh-readonly-queue/main/pr-521-c76c44303e248b671fef2b344
```

All check_runs reported success. But the COMMIT STATUS `ai-sdlc/attestation` posted FAILURE on the probe SHA:

```bash
$ gh api repos/.../commits/<probe-sha>/status
{"state":"failure","statuses":[{"context":"ai-sdlc/attestation","state":"failure"},{"context":"codecov/patch","state":"success"}]}
```

Result: queue silently evicted the PR each time. Operator (or autonomous loop) had to manually re-arm `gh pr merge 521 --auto` — which re-entered the queue + the cycle repeated.

## Root cause

`verify-attestation.yml` runs `scripts/verify-attestation.mjs` against the queue probe SHA (the rebased merge result). The verifier:

1. Computes `contentHashV4` from the probe SHA's tree (per-file head-blob-SHA map, excluding the IGNORE list)
2. Reads the committed envelope from `.ai-sdlc/attestations/<head>.dsse.json`
3. Compares the two hashes

When sibling PR #522 landed, its changes to `pipeline-cli/src/orchestrator/events.ts` (or other shared files) rewrote those files' blob SHAs in the queue rebase. PR 521's envelope was signed against the OLD blobs → v4 hash differs → verifier emits `failure`.

This is the SAME failure mode that motivated AISDLC-342 (interim IGNORE-list expansion) and AISDLC-343 (contentHashV5 delta-hash). 342 covered generated-schemas.ts. Other shared files (events.ts, schemas) still cause kicks.

## Why this is critical for autonomous loop

The operator-away pipeline loop burns ~3 cycles per PR-stuck-in-this-mode:
1. Cycle N: tick fires, dispatches new tasks (which abort because 521 still open)
2. Cycle N+1: operator/loop manually rebases + re-signs + force-pushes 521
3. Cycle N+2: queue picks up rebased 521, probe runs, succeeds, then kicks 521 again because ANOTHER sibling PR landed in between

Net throughput drops because every PR that takes >1 queue-probe-window to merge becomes Sisyphean.

## Acceptance criteria

### Short-term (closes the autonomous-loop blocker)

- [ ] **`scripts/verify-attestation.mjs` exit-soft hint**: when v4 mismatches but the underlying envelope is VALID for the PR's branch HEAD (not the queue probe SHA), append a `[verify-attestation] HINT: PR HEAD attestation is valid; queue rebase invalidated v4 due to sibling-file overlap. Run \`/ai-sdlc rebase <pr>\` or wait for AISDLC-343 (contentHashV5) to land for rebase-stable verification.` line in the workflow output. Helps operators diagnose without grepping commit statuses.
- [ ] **Auto-rebase-and-resign workflow**: a new GitHub Actions workflow `auto-rebase-on-queue-kick.yml` that:
   - Triggers on `pull_request_review` or commit status update for `ai-sdlc/attestation: failure`
   - If the failure is on a `gh-readonly-queue/main/pr-N-*` SHA (not the PR's HEAD), opens the corresponding PR via the rebase-resolver flow
   - Rebases onto current main, re-signs the attestation, force-pushes
   - Auto-rearms `gh pr merge --auto` after the push
   - This essentially closes the loop the operator is doing manually

### Long-term (orthogonal but related)

- [ ] AISDLC-343 (contentHashV5 delta-hash) — rebase-stable verification eliminates the root cause. Filed already.

### Observability

- [ ] **Track queue-kick events** in `events.jsonl`: every time the orchestrator detects a PR went from in-queue → CLEAN-with-attestation-FAILURE, emit `MergeQueueAttestationKick {prNumber, baseBeforeKick, baseAfterKick, ts}`. Slack digest can roll this up — operator sees how often the pattern fires.

## Observed instances (2026-05-17 only)

- PR #498 (AISDLC-280) — 3 queue kicks before AISDLC-342 landed
- PR #521 (AISDLC-287) — 3+ queue kicks today
- PR #522 (AISDLC-283) — 1 queue kick before re-sign

Rate: ~30% of multi-hour-lived PRs hit this. With shorter PR cycles + AISDLC-343 v5 hash, drops to ~0%.

## Out of scope

- Forcing GitHub to retry merge automatically (their queue logic is opaque)
- Migrating off the merge queue (queue is the right surface for branch-protection + sequential merge guarantees)

## Source

Operator-away session 2026-05-17. The autonomous loop burned ~6 cycles trying to land 521 alone before this task was filed. Operator's explicit directive: "if pipeline experiences issues then open an issue for them and process it then get back to processing issues through the pipeline."

The auto-rebase-and-resign workflow IS the "process it" step that closes the loop — once AISDLC-420 lands, the operator-away loop becomes truly self-healing for this failure mode.
