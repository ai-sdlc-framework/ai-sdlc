---
id: AISDLC-1440
title: "Cut the dispatch and planner GitHub API call volume toward the measured floor (cache across processes, webhook-driven snapshots, no quota polling)"
status: Done
priority: high
labels:
  - pipeline-cli
  - hierarchy
  - github
dependencies:
  - AISDLC-1439
references:
  - pipeline-cli/src/hierarchy/gh-read-cache.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/status.ts
  - pipeline-cli/src/cli/hierarchy.ts
  - pipeline-cli/src/hierarchy/pr-snapshot.ts
  - pipeline-cli/src/hierarchy/land-eligible.ts
  - pipeline-cli/src/hierarchy/mark-ready.ts
  - pipeline-cli/src/cli/ci.ts
---

## Description

**Five-step review (requirements first).**
1. Question: operator direction 2026-11-26 (fix dependency limits at the cost source). Measured from `.ai-sdlc/dispatch/gh-calls.jsonl`, 24 h to 2026-11-26T17:08Z: 24,491 calls, 88% from operator-dispatch; 7,785 (32%) are `gh api rate_limit`; 84% repeat an identical argv within 60 s; peak 1,778/h; about 78 writes. Estimated floor with event-driven refresh: 50-150 quota-counting calls/h versus about 700 today. Causes located: `gh-read-cache.ts` is a per-process WeakMap with a 5-minute TTL that caches successes only, so `api user` still runs ~2,000 times a day; `reconcile.ts` ~823/905 poll `run list` (~4,100/day) and ~930 `run view`; `reconcile.ts` ~816 `commits/main` (~2,000/day); `status.ts` ~389 and `cli/hierarchy.ts` ~1566 poll `rate_limit` (dispatch median gap 15.7 s); `repo view` (`reconcile.ts` ~1695, `land-eligible.ts` ~106) fails 50% of the time and failures are retried every tick; verdict-ref 404s for one sha retried 294 times (`reconcile.ts` ~1634). Line numbers are from the audit; re-locate before editing.
2. Delete: the periodic `rate_limit` polls (read the quota from AISDLC-1439's ledger instead); duplicate `run list`/`pr list` reads that a shared snapshot already answers.
3. Simplify: one on-disk read cache shared across processes (keyed by argv, TTL per call shape, negative entries for 404/expected failures with a short TTL); `run list`/`pr list` come from one snapshot refreshed on webhook events with a 5-minute fallback while the webhook is healthy; conditional requests (ETag/If-None-Match, 304 is free) where `gh api` supports them.
4. Accelerate: none beyond fewer calls.
5. Automate: AISDLC-1439's report is the before/after measurement.

## Acceptance Criteria
- [ ] #1 No periodic `gh api rate_limit` call remains in the dispatch tick or `cli-hierarchy status`; quota shown comes from the ledger.
- [ ] #2 Reads go through a cross-process cache; a test shows a second process within TTL makes no `gh` call; expected 404/failed reads are cached negatively for a short TTL.
- [ ] #3 `run list` and `pr list` are served from one snapshot refreshed on webhook events, with a fallback interval of at most 5 minutes while the webhook is healthy and the current cadence when it is not.
- [ ] #4 Measured with AISDLC-1439's report over 24 h of normal drain: quota-counting calls/h drop by at least 70% from the 2026-11-26 baseline (about 700/h mean); the PR body records before and after.
- [ ] #5 No change in landing behaviour: existing reconcile tests pass unchanged except for call-count assertions.
- [ ] #6 `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
