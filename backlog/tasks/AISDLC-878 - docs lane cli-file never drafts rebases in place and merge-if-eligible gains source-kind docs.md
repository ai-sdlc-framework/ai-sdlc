---
id: AISDLC-878
title: 'docs lane: cli-file never drafts, rebases in place under DEC-0088, merge-if-eligible gains --source-kind docs, one docs-only path list'
status: To Do
assignee: []
created_date: '2026-10-14'
labels: [rfc-0054, docs-lane, phase-0, dispatch]
dependencies: []
references:
  - spec/rfcs/RFC-0054-pr-lifecycle-event-driven-dispatch.md
  - pipeline-cli/src/cli/file.ts
  - pipeline-cli/src/cli/merge-if-eligible.ts
  - scripts/is-docs-only-changeset.mjs
  - docs/operations/cli-hierarchy.md
priority: critical
dispatchable: true
---

## Context

RFC-0054 OQ-4 and OQ-11 (resolved 2026-10-14): a no-task PR (task file, decision record, RFC edit, operations doc, brief, memory file) has no executor stage and is owned by the state machine from birth. The lane mostly exists: `cli-file --pr` opens ready from a fast-forward of `origin/main`, `auto-enable-auto-merge.yml` arms on `opened`, the gate's docs-only detector skips the heavy jobs, no reviewers are required. Two of the four stalls live in `pipeline-cli`: `cli-file rebase` opens a replacement PR and closes the old one (a closed-unmerged PR per base move, a tracked KPI), and `cli-merge-if-eligible` has no source kind for a filing PR so the machine cannot arm one by hand. The docs-only path list also has four copies (gate detector, `verify-attestation.yml` paths-ignore, `review-scope-core.mjs`, `pr-unstick.ts`); AISDLC-534.1 (#1519, draft) is consolidating them and this task coordinates with it rather than adding a fifth.

## Fix

**Five-step review (requirements first).** Requirement questioned: "a filing PR that goes DIRTY needs a new PR". No: DEC-0088 already grants the planner a lease push on `ai-sdlc/file-*`, so the branch can be rebased in place. Deleted: the supersede-and-close path in `cli-file rebase` and the `--draft` option on every no-task PR surface. Simplified: one docs-only path list, imported by every consumer. Accelerated: a filing PR survives a base move with zero human steps. Automated last: the machine's `rebase-in-place` action calls the same command.

1. `cli-file rebase <id>`: rebase `ai-sdlc/file-<id>` onto `origin/main` in its worktree and push with `--force-with-lease=<branch>:<sha>`; no replacement branch, no "Superseded" comment, no PR closed. The old `-r<n>` behaviour is removed, not kept behind a flag.
2. `cli-file` never passes `--draft`; add a guard test that the `gh pr create` argv contains no `--draft`.
3. `cli-merge-if-eligible --source-kind docs`: accepted only when the PR diff is docs-only by the shared detector and the head branch matches `ai-sdlc/file-*`, `ai-sdlc/decisions-sync*` or `docs/*`; arms with `--auto --squash` through the existing path. The release-please PR stays refused (class (c)).
4. Docs-only path list: one exported constant (land it in the module AISDLC-534.1 chooses; if 534.1 has not merged, add it to `scripts/is-docs-only-changeset.mjs` and make the other three copies import it), extended with `.ai-sdlc/dispatch/briefs/` and `.claude/memory/`.
5. `docs/operations/cli-hierarchy.md`: a "docs lane" section describing the no-task PR lifecycle and the three machine actions (`rebase-in-place`, `rerun-dor`, `arm`).

## Acceptance Criteria

- [ ] `cli-file rebase <id>` on a DIRTY filing PR results in the same PR number green and armed; `gh pr list --state closed` gains no entry (test with a fixture repo or a mocked `gh`).
- [ ] A unit test asserts the `gh pr create` argv built by `cli-file` never contains `--draft`.
- [ ] `cli-merge-if-eligible <pr> --source-kind docs --arm` arms a docs-only `ai-sdlc/file-*` PR and refuses a PR whose diff touches a non-docs path, with the refusing path named.
- [ ] Exactly one definition of the docs-only path list exists in the repository (grep for `spec/rfcs/` as a pattern literal finds one source); it includes `.ai-sdlc/dispatch/briefs/` and `.claude/memory/`.
- [ ] `docs/operations/cli-hierarchy.md` documents the docs lane.

## Verification

`pnpm build && pnpm test && pnpm lint && pnpm format:check`; `npx backlog-drift check`.

## Out of scope

Gate and DoR changes (AISDLC-879); the state machine's action table (AISDLC-829); any change to task PRs.
