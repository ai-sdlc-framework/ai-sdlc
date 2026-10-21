---
id: AISDLC-879
title: 'docs lane gate: lint leaves the docs-only job set, DoR treats a reference to a task in another open filing PR as pending and re-runs when it merges, no-task PRs are never drafts'
status: Done
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, docs-lane, phase-0, ci]
dependencies: []
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - .github/workflows/ai-sdlc-gate.yml
  - scripts/is-docs-only-changeset.mjs
  - pipeline-cli/src/dor/types.ts
  - docs/operations/dor-ingress-gate.md
priority: critical
dispatchable: true
---

## Context

RFC-0054 OQ-4 and OQ-11 (resolved 2026-10-14). Two of the four docs-lane stalls live in CI. (1) `dor-readiness-gate` runs on any `backlog/tasks/*.md` change and must pass when it runs; #1524 fails only because its task file references a sibling task whose file sits in another open filing PR, and nothing re-runs the gate when that PR lands (the gate fires on `synchronize` only). (2) `lint` runs unconditionally, so a one-file markdown change pays a `pnpm install` plus a full lint. A third gap: PRs opened as drafts by the decisions-sync workflow (#1525) or by a skill skip both the gate and the arming and sit ownerless.

## Fix

**Five-step review (requirements first).** Requirement questioned: "a task file must only reference tasks already on main". No: a planner files sibling tasks in parallel PRs by design; a reference to a task that exists in another open `ai-sdlc/file-*` PR is a pending dependency, not an error. Deleted: `lint` from the docs-only job set; `--draft` from the decisions-sync PR and the RFC-walkthrough skill's PR step. Simplified: markdown formatting checked inside the drift job without an install. Accelerated: a docs-only PR's gate finishes in the drift job's time. Automated last: the gate re-runs itself when a sibling filing PR merges.

1. `ai-sdlc-gate.yml`: `lint` gets `if: needs.detect.outputs.docs_only != 'true'`; the drift job runs `prettier --check` on the changed markdown files only (no workspace install). Add `lint` to the rollup's allowed-skips list.
2. DoR gate 3 (reference resolution): when a referenced task id has no file on `main` but a file for it exists in the diff of another open PR on an `ai-sdlc/file-*` branch (REST search by head prefix), the result is `pending` with the PR number, the gate passes, and a comment names the dependency. A reference that matches nothing stays `fail`.
3. Re-run: when a filing PR merges, a step in the same workflow (or the state machine's `rerun-dor` action, AISDLC-829) re-runs the gate on every open filing PR whose DoR comment names it; implement the workflow step here so Phase 0 works without the machine.
4. No-task PRs are never drafts: the decisions-sync workflow drops `--draft`; `~/.claude/skills/rfc-oq-walkthrough` is user-local, so document the rule in `docs/operations/dor-ingress-gate.md` and in the planner command body.

**Configuration (operator ruling 2026-10-14).** Every repository convention this task uses (docs-only paths, no-task branch prefixes, timers, ports, thresholds) is read from `.ai-sdlc/pr-lifecycle.yaml` (RFC-0054, Design Details, Configuration) with the documented defaults; nothing is hard-coded in TypeScript, workflow YAML or command prose. The first of these tasks to land creates the file with the defaults; the others read it.

## Acceptance Criteria

- [ ] Config: no convention value (path pattern, branch prefix, timer, port, threshold) appears as a literal in source, workflow or command body touched by this task; each is read from `.ai-sdlc/pr-lifecycle.yaml`, and one test shows that changing a config value changes the behaviour.
- [ ] A docs-only PR's gate run shows `lint` skipped and `ai-sdlc/pr-ready` green; a code PR still runs `lint`.
- [ ] A task file referencing an id whose file exists only in another open `ai-sdlc/file-*` PR gets DoR `pending` (gate passes, comment names the PR); an id matching nothing still fails.
- [ ] Merging the referenced filing PR triggers a re-run on the dependent PR without a push (workflow run visible with the dependent PR as target).
- [ ] The decisions-sync PR opens as ready (not draft) and is armed on open.
- [ ] `docs/operations/dor-ingress-gate.md` documents the pending state and the no-draft rule.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; one docs-only PR and one task-file PR observed through the gate.

## Out of scope

`cli-file` and `merge-if-eligible` changes (AISDLC-878); the general state machine (AISDLC-829).
