---
id: AISDLC-1238
title: 'Automatic CI round yields to a planner ruling on the PR, and a developer round that changes nothing routes to the planner instead of burning a round'
status: To Do
assignee: []
created_date: '2026-11-08'
labels:
  - dispatch
  - ci
  - bug
dependencies: []
references:
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/ci-round.ts
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/dispatch/resume.ts
  - docs/operations/cli-hierarchy.md
priority: high
dispatchable: true
dispatchableReason: 'Backlog-pressure fix: #2565 (AISDLC-1223) burned two of its three automatic CI rounds on 2026-11-08 (heads 1210e062 and c1d1ee6a) because the tick re-entered it with the log-tail note seconds after each red check, before dispatch could act on the planner order; the executor kept the forbidden lifecycle jump both times and returned a success verdict with "no code change needed". Planner filed 2026-11-08 from the 10:2xZ wake root-cause look.'
---

## Description

**Observed 2026-11-08 on #2565 (AISDLC-1223).** The PR fails `RFC Lifecycle Gate` and the `pnpm rfc:check` step of Build & Test on one cause: it flips one spec-kit bridge RFC from Ready for Review to Implemented, a jump that needs the operator lifecycle-jump marker, which the executor must not add. The planner ruled on the PR (comment 2026-11-08T10:04Z: drop that RFC from the PR, keep the eight other flips, fix the README Status cells) and ordered dispatch to re-enter the PR with that ruling as the developer note. Twice, the reconciler's automatic CI round (AISDLC-1231, `commandExecutor` in `pipeline-cli/src/hierarchy/reconcile.ts`) fired within seconds of the red check with the generic log-tail note from `buildCiRoundNote`, before dispatch's next model turn could run the ordered `reenter --developer-round --note`. The planner order lost the race both times. Each automatic round the developer read only the log tail, concluded the failure needed the operator marker, changed nothing, and the pipeline still pushed a new head (chore-only commits: status flip and review ledger), re-signed, and wrote a `success` verdict with the note "No code change needed". Net cost: two of the three bounded rounds, two signing rounds, two gate runs, and the PR still red.

**Two causes.**
1. The automatic round never looks at what the planner already said. `buildCiRoundNote` carries only the failed step and its log tail; a planner ruling on the PR, or a planner order to dispatch, has no precedence over it. `reenter.ts` keys a developer round on `(route, headSha, noteHash)`, so once the automatic round is in `queue/` the planner's note is "already ordered" for that head and lands only after the next red head.
2. `guardCiRounds` treats "the executor pushed nothing" as the same head sha. A round whose only commits are the pipeline's own chore commits (task status flip, review ledger) produces a new head with no content change, so the guard counts it as progress and the round budget drains without the planner ever seeing `ci-rounds@<n>`.

## Fix

**Five-step review (requirements first).**
1. Question: must the tick re-enter a red task PR on its own when the planner has already ruled on it? No. The automatic round exists for the unattended case (AISDLC-1231); a planner ruling on the PR is the attended case and must be the note.
2. Delete: nothing deleted; the automatic round stays for PRs with no ruling.
3. Simplify: (a) in `commandExecutor`, before building the log-tail note, look for the newest PR comment from the repository's own identity (the planner posts through `gh` as the operator account) whose first line starts with `Planner ruling` or `PLANNER REPAIR ORDER`, posted after the previous round's `resumedAt`; when found, the note is that comment verbatim (truncated to `MAX_NOTE_CHARS`) with the failing step line prepended, so the developer round reads the ruling first and the log second. (b) In `guardCiRounds`, "pushed nothing" also covers a head whose diff against the previous round's head touches only `backlog/**` and `.ai-sdlc/reviews/**` (the pipeline's chore commits); such a round routes to the planner as `ci-rounds@<n>` with note `no content change since <sha>` instead of ordering another automatic round.
4. Accelerate: none; this removes gate runs.
5. Automate: unit tests for both predicates in `reconcile.test.ts` and `ci-round.test.ts` (ruling comment present: note starts with the ruling; absent: log tail unchanged; chore-only head: route-to-planner with the reason; content head: automatic round as today). No network: PR comments arrive through the injected runner stub.

## Acceptance Criteria

- [ ] AC-1: with a planner ruling comment on the PR newer than the last round, the automatic CI round's note is that ruling (first line `Planner ruling ...` or `PLANNER REPAIR ORDER ...`) followed by the failing step; the log tail only fills the remaining `MAX_NOTE_CHARS`. Unit test, runner stub, no network.
- [ ] AC-2: without such a comment the note is byte-identical to today's `buildCiRoundNote` output (existing tests unchanged).
- [ ] AC-3: a red head whose diff to the previous round's head touches only `backlog/**` and `.ai-sdlc/reviews/**` is routed to the planner as `ci-rounds@<n>` with note `no content change since <short sha>`; it does not count as a new automatic round. Unit test for the chore-only and the content cases.
- [ ] AC-4: `docs/operations/cli-hierarchy.md` (dispatch tick actions, AISDLC-1231 paragraph) states in two sentences that a planner ruling comment is the note when present and that a no-content round goes to the planner.
- [ ] AC-5: evidence in the PR body: the reconcile decision for #2565 head c1d1ee6a replayed through `cli-hierarchy reconcile --dry-run` (or the equivalent test fixture built from its landing record) shows the ruling note, not the log tail.
- [ ] AC-6: `pnpm build && pnpm test && pnpm lint && pnpm format:check` pass.
