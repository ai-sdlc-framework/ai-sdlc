---
id: AISDLC-888
title: 'feat(hierarchy): PRs flagged [needs-human-attention] surface in the dispatch tick report and the operator digest'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [hierarchy, visibility, feature, velocity]
dependencies: []
references:
  - pipeline-cli/src/hierarchy/pr-state.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - pipeline-cli/src/hierarchy/stall.ts
  - pipeline-cli/src/decisions/operator-digest.ts
  - pipeline-cli/src/cli/decisions.ts
  - docs/operations/cli-hierarchy.md
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Context

PR #1346 (AISDLC-725) was flagged `[needs-human-attention]` in its title on 2026-10-10 after it exceeded the 2-round review cap with an open security MAJOR. It then sat 4 days as DRAFT and DIRTY because the only carrier of that fact was a planner handoff memory line, and the park reason (another PR) went stale unnoticed. Nothing in the dispatch tick report or the operator digest lists PRs that need a person.

Related open tasks: AISDLC-871 (alert-only stall notice) and AISDLC-829 (the tick sweeps open PRs). This task must not duplicate their code. It adds only the human-attention classification and the digest section, and reuses the 871 alert path if it has landed.

## Fix

**Five-step review (requirements first).** Requirement questioned: "the planner remembers which PRs are parked for a human". A memory line is not a control; the requirement is that the state is derived from the PR itself and shown where the operator already looks. Deleted: the handoff-memory line as the carrier (no new store or poller is added). Simplified: one pure classifier over data the tick already fetches (title, board verdict, draft and merge state), reused by the tick report and the digest. Accelerated: the operator sees the PR on the next tick instead of after a manual audit. Automated last: the 24 h stall condition fires without anyone checking.

1. Classifier (`pipeline-cli/src/hierarchy/pr-state.ts`, next to the existing PR state classifier): add a pure `needsHumanAttention(pr)` that is true when the title contains `[needs-human-attention]`, or the board verdict is `iterate-needed` and the review round count is at the cap. It returns the row: PR number, title, age, draft/merge state, open finding count.
2. Tick report (`pipeline-cli/src/hierarchy/dispatch-loop.ts` and its report builder): list every open PR the classifier flags, with age, draft/merge state and open finding count. Use the open-PR data the tick already has; add no second fetch (coordinate with AISDLC-829 rather than duplicating its sweep).
3. Operator digest (`pipeline-cli/src/decisions/operator-digest.ts`, `cli-decisions operator-digest`): add a section "PRs needing a human" with the same rows; omit it when empty.
4. Stall condition: a flagged PR older than 24 h is a stall-notice condition. Reuse the AISDLC-871 alert path if it has landed; otherwise emit one tick-report line ("PR #N needs a human for Nh"). No new notification channel.
5. Document the section and the 24 h rule in `docs/operations/cli-hierarchy.md`.

## Acceptance Criteria

- [x] The dispatch tick report lists every open PR whose title contains `[needs-human-attention]` or whose board verdict is `iterate-needed` at the review cap, with age, draft/merge state and open finding count.
- [x] `cli-decisions operator-digest` prints a "PRs needing a human" section with the same rows, and omits it when there are none.
- [x] A flagged PR older than 24 h produces a stall-notice condition: through the AISDLC-871 alert path if present on `main`, otherwise one tick-report line.
- [x] The classification is a single pure function used by both the tick report and the digest; no second PR fetch is added and no code from AISDLC-871 or AISDLC-829 is copied.
- [x] A unit test covers the classifier on (i) a title with the marker, (ii) a verdict `iterate-needed` at the cap, and (iii) a plain PR (not flagged); further tests cover the digest section and its omission when empty, and the 24 h threshold.
- [x] `docs/operations/cli-hierarchy.md` describes the section and the 24 h rule.

## Tests

Vitest unit tests in `pipeline-cli/src/hierarchy/pr-state.test.ts` and `pipeline-cli/src/decisions/operator-digest.test.ts`, plus a tick-report test in `pipeline-cli/src/hierarchy/dispatch-loop.test.ts`. `pnpm build && pnpm test && pnpm lint && pnpm format:check`.

## Out of scope

Relaunching, commenting on, or changing the flagged PR; the alert transport itself (AISDLC-871); the open-PR sweep (AISDLC-829).
