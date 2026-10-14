---
id: AISDLC-895
title: 'feat(decisions): decisions-sync PR opens ready, and a trusted decisions-sync source kind lets merge-if-eligible land it when green and clean'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [decisions, governance, velocity, adopters]
dependencies: []
references:
  - pipeline-cli/src/decisions/remote-persist.ts
  - pipeline-cli/src/governance/merge-if-eligible.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - pipeline-cli/src/governance/release-merge.ts
  - docs/operations/decision-authority.md
priority: high
dispatchable: true
---

## Context

Request from the ai-sdlc-io planner session on 2026-10-14 (ai-sdlc-io DEC-0008; operator words: "don't open chore sync tasks in draft"). Verified in `pipeline-cli/src`:

- `decisions/remote-persist.ts:480` opens the decisions-sync PR (branch `ai-sdlc/decisions-sync`) with a hard-coded `--draft` in the `gh pr create` call at L477-479.
- `evaluatePrTrust` (`governance/merge-if-eligible.ts:756-765`) requires a task id derivable from the head branch (`^ai-sdlc/<PREFIX>-\d+`) or a trailing `(<ID>)` in the title (`deriveTaskId`, L609-624; refusal text at L788-789). The decisions-sync branch carries no task id, so the PR is refused under every policy.
- `--source-kind` accepts only `backlog | gh-issue | release` (`cli/merge-if-eligible.ts:109-117`; `SourceKind` at `governance/merge-if-eligible.ts:384`, `isTrustedSourceKind` L386). `release` already shows the pattern for a task-less trusted kind (`governance/release-merge.ts`).

**Five-step review (requirements first).** Requirement questioned: "the decisions-sync PR opens as a draft so a person reviews it". The PR holds only append-only decision event files that the CLI validated before pushing; a draft adds a human step with nothing to decide. Delete: the hard-coded `--draft` in `remote-persist.ts`. Simplify: reuse the `release` pattern (task-less trusted kind with a diff restriction) instead of a bypass of `deriveTaskId`. Accelerate: the sync PR lands on the next tick (AISDLC-894). Automate: the diff restriction is a deterministic path check, no model call.

## Fix

1. `decisions/remote-persist.ts`: drop `--draft`. Add an optional repo setting `decisions.syncPrDraft` (default `false`) read from `.ai-sdlc/decisions-config` for adopters who want drafts.
2. `governance/merge-if-eligible.ts`: add `'decisions-sync'` to `SourceKind` and `isTrustedSourceKind`. Its trust evaluation runs the same not-a-fork, base `main`, author-in-`mergeAuthors` and head-sha checks, skips `deriveTaskId`, and additionally requires the head branch to be exactly `ai-sdlc/decisions-sync` and every changed path to match `.ai-sdlc/_decisions/events/**` (refuse otherwise, naming the offending path). Use `gh pr view --json files` for the path list.
3. `cli/merge-if-eligible.ts`: add the choice; route like `release` at L166/L199.
4. AISDLC-894's tick step derives `sourceKind: 'decisions-sync'` from the branch name.
5. Docs: `docs/operations/decision-authority.md` (sync PR lifecycle) and the CLI reference.
6. Tests: sync PR with only event files is eligible; one extra path refuses with the path named; wrong branch refuses; `syncPrDraft: true` restores `--draft`.

## Acceptance Criteria

- [ ] #1 The decisions-sync PR is created ready (no `--draft`) by default; `decisions.syncPrDraft: true` restores the draft.
- [ ] #2 `cli-merge-if-eligible <pr> --source-kind decisions-sync` lands a green, CLEAN PR on `ai-sdlc/decisions-sync` whose diff is confined to `.ai-sdlc/_decisions/events/**`, with the same fork, base, author and head-sha checks as `backlog`.
- [ ] #3 Any path outside the events directory, or any other head branch, is refused with the path or branch in the reason.
- [ ] #4 Unit tests cover AC #1-#3.

**Velocity impact.** Positive: removes one manual "flip to ready and merge" per decision sync in every adopter repo. The diff restriction is tighter than what `backlog` allows, so the trust surface does not grow.

Authority: class (a) (tightened trust kind; the draft default is a reversible repo setting). Operator instruction 2026-10-14 ("do them all").
