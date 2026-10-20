---
id: AISDLC-983
title: 'Hierarchy drift: cli-hierarchy.md vs code, reenter rerun path, ingest error text'
status: To Do
assignee: []
created_date: '2026-10-20'
labels:
  - hierarchy
  - docs
dependencies: []
references:
  - docs/operations/cli-hierarchy.md
  - pipeline-cli/src/hierarchy/reenter.ts
  - pipeline-cli/src/hierarchy/reconcile.ts
  - pipeline-cli/src/hierarchy/dispatch-loop.ts
  - ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh
priority: high
dispatchable: true
---

## Description

`docs/operations/cli-hierarchy.md` has drifted from the hierarchy code in several places. The action table at `:883-885` names the rate-limited action `rerun-rate-limited` and the behind-or-dirty action `land-prep`, while `pipeline-cli/src/hierarchy/reconcile.ts:36-39` maps `'rate-limited': 'wait-and-rerun'` and notes that `land-prep` "is not built yet: `reenter` runs its rebase for a BEHIND PR". The wake and clear prose (`:470` "60 s", `:807-811` "the dispatch session clears itself after every tick", `:871` "a timer of 60 s") describes timers and a self-clear that the current dispatch loop does not implement as written; the task reconciles each sentence against `dispatch-loop.ts` and the reconcile scheduler and keeps whichever is right. `reconcile.ts:305-329` implements the correct two-step rerun (`gh run list --commit <sha> --workflow ai-sdlc-gate.yml --json databaseId` captured into a run id, then `gh run rerun <id> --failed`), and `pipeline-cli/src/hierarchy/reenter.ts:258-261` now resolves the gate run id the same way through `gateRunId` (landed in AISDLC-962); the task deduplicates the two lookups into one helper so they cannot diverge again. In `pipeline-cli/src/hierarchy/dispatch-loop.ts:342` a rejected brief recorded under the older numeric shape is reported as `error: '(error text not recorded)'`; the ingest path must record the parse error message on every rejection so the tick output names the cause.

Separately, dispatch ran a stale `dist` for days because `ai-sdlc-plugin/scripts/resolve-pipeline-cli.sh:160-170` only warns when the repo build is older than its sources and falls back to the plugin cache; a sibling task makes that a hard refusal at launch. This task adds the release-side half: the plugin cache is rebuilt as part of the release flow so a fresh install never lags the sources it ships with.

Fix: the action tables in `cli-hierarchy.md` are generated from (or checked by a test against) `TASK_ACTIONS` and the docs-PR action enum in `reconcile.ts`; the timer and self-clear prose matches the code; one shared gate-run-id helper serves `reconcile.ts` and `reenter.ts`; ingest errors carry the message; the release flow rebuilds the plugin cache.

**Five-step review (requirements first).**
1. Requirement questioned: should the doc tables be hand-maintained at all? No; they restate an enum, so a test against the enum (or generation) replaces upkeep.
2. Delete: the duplicate gate-run-id lookup in `reenter.ts`; the numeric legacy shape for rejected briefs once migrated.
3. Simplify: one action enum, one doc table derived from it, one run-id helper.
4. Accelerate: a dispatch operator reads the right action name on the first look; ingest errors name the cause without re-running the parse by hand.
5. Automate: the doc-versus-enum test and the release-time cache rebuild.

## Acceptance Criteria

- [ ] A test asserts every action name in the `cli-hierarchy.md` tables equals an entry of `TASK_ACTIONS` or the docs-PR action map in `reconcile.ts`, and the tables are corrected (`wait-and-rerun`; `land-prep` noted as served by `reenter`).
- [ ] The wake-timer and self-clear sentences in `cli-hierarchy.md` match `dispatch-loop.ts` and the reconcile scheduler, with the file:line of the code they describe.
- [ ] `reconcile.ts` and `reenter.ts` share one gate-run-id helper; `gh run rerun` is only ever called with a resolved run id.
- [ ] A rejected brief always records its error message; the `(error text not recorded)` fallback is reachable only for pre-existing numeric records and a test covers both.
- [ ] The release flow rebuilds the plugin cache so an installed plugin never carries a dist older than its own sources.
