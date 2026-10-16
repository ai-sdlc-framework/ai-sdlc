---
id: AISDLC-900
title: 'fix(scripts): check-rfc-docs KNOWN_STATUSES matches the documented RFC lifecycle (main red since an RFC landed as Ready for Review)'
status: Done
assignee: []
created_date: '2026-10-15'
labels: [ci, rfc, velocity, main-red]
dependencies: []
references:
  - scripts/check-rfc-docs.mjs
  - scripts/check-rfc-docs.test.mjs
  - spec/rfcs/README.md
priority: critical
dispatchable: true
---

## Context

Since the session-hierarchy RFC (registry number 0054, not yet signed off, so not named here for the upstream-OQ gate) landed on `main` with `status: Ready for Review` (2026-10-14), four tests in `scripts/check-rfc-docs.test.mjs` fail on `main` and in every PR's `pnpm test`:

```
<rfc id>: invalid or missing 'status' (got "Ready for Review"; expected one of Draft, Under Review, Approved, Implemented, Final, Rejected, Withdrawn)
```

`KNOWN_STATUSES` in `scripts/check-rfc-docs.mjs` predates the lifecycle CLAUDE.md documents (`Draft` -> `Ready for Review` -> `Signed Off` -> `Implemented`, or `Superseded`). The same file's `ASSUMES_OK_LIFECYCLES` already lists `Ready for Review`, `Signed Off`, `Implemented`, `Superseded`, so the script disagrees with itself. DEC-0202 makes these tests non-waivable, which blocked the docs-drift task on PR #1480 and will block every code PR until fixed. Planner ruling 2026-10-15: fix the validator, not the RFC; `Ready for Review` is the documented state.

**Five-step review.** Requirement questioned: the known-status check exists to catch typos, which is still wanted. Delete: nothing. Simplify: one source of truth, `KNOWN_STATUSES` is built as the union of the draft states, `ENFORCED_STATUSES` and `ASSUMES_OK_LIFECYCLES`, so the two sets cannot drift again. Accelerate: unblocks every open PR's test run. Automate: a test asserts every `status:` value present under `spec/rfcs/` is known, so a new lifecycle word fails in the PR that introduces it, not on `main` afterwards.

## Fix

1. `scripts/check-rfc-docs.mjs`: define `KNOWN_STATUSES` as the union of `['Draft', 'Under Review', 'Rejected', 'Withdrawn']`, `ENFORCED_STATUSES` and `ASSUMES_OK_LIFECYCLES` (adds `Ready for Review`, `Signed Off`, `Superseded`). Decide whether `Signed Off` belongs in `ENFORCED_STATUSES` next to `Approved`/`Final`; if the README says sign-off is the gate, add it and note any RFC it newly enforces in the PR body (do not change RFC files to pass).
2. `scripts/check-rfc-docs.test.mjs`: add a test that every `status:` value under `spec/rfcs/RFC-*.md` (template excluded) is in `KNOWN_STATUSES`; keep the four workspace tests.
3. Nothing under `spec/` changes.

## Acceptance Criteria

- [x] #1 `node --test scripts/check-rfc-docs.test.mjs` passes on the current `main` with no RFC edits.
- [x] #2 A fixture RFC with `status: Bogus` still fails with the "invalid or missing 'status'" message.
- [x] #3 `KNOWN_STATUSES` is derived from the other two sets, not a third hand-written list.
- [x] #4 `pnpm build && pnpm test && pnpm lint && pnpm format:check` green.

**Velocity impact.** Positive and urgent: every PR's test run is red until this lands; the fix is a few lines with no behaviour change for existing RFCs.
