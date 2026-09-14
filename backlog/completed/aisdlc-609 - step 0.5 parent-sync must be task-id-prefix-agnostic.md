---
id: AISDLC-609
title: Step 0.5 parent-sync/prune must be task-id-prefix-agnostic (not hardcoded aisdlc-)
status: Done
priority: high
labels:
  - adopter-facing
  - plugin
  - execute
created: 2026-09-14
---

## Context

Surfaced by an external adopter (local-trades, task-id prefix `LT-`) dogfooding
`/ai-sdlc execute`. Step 0.5 (auto-sync + prune of untracked parent backlog task
files) is hardcoded to the `aisdlc-` prefix, so a consumer repo using any other
task-id prefix has its untracked stub task files silently ignored (or the gate
chokes on them). The task-id prefix is repo-configurable, but Step 0.5 assumes
this repo's own convention — the same adopter-assumption class as AISDLC-607.

Precedent for prefix-agnostic handling already exists:
`ai-sdlc-plugin/scripts/execute-parallel-cleanup.test.mjs` derives a non-`aisdlc-`
prefix for its tmux window regex. Step 0.5 was simply not brought along.

## Hardcoded sites (shipped command bodies)

- `ai-sdlc-plugin/commands/execute.md` Step 0.5 — lines ~265, 272, 293, 297, 301:
  glob/partition `backlog/{tasks,completed}/aisdlc-N*.md`, prune
  `backlog/tasks/aisdlc-N*.md`, and the `git clean` guidance.
- `ai-sdlc-plugin/commands/orchestrator-tick.md` — lines ~229, 231: Pass 1
  sync-parent + Pass 2 prune-stale-parent-debris, same `aisdlc-N*.md` glob.

## Scope

- Derive the task-id prefix from the repo's backlog configuration (the same
  source that defines task ids for the project) rather than the literal
  `aisdlc-`. Fall back to a prefix-agnostic `<PREFIX>-<N>` shape (e.g. match
  `backlog/{tasks,completed}/*-[0-9]*.md`) when no explicit prefix is
  configured, so ANY adopter prefix is handled.
- Apply consistently to BOTH the sync-parent pass and the prune-stale-debris
  pass, in both `execute.md` Step 0.5 and `orchestrator-tick.md` Passes 1-2.
- Preserve the existing behavior for `aisdlc-` repos byte-for-byte (this repo
  must be unaffected).
- If the prefix resolution has any runtime component (a helper script), add
  hermetic tests; if it's purely command-body prose/glob, ensure the glob is
  prefix-agnostic and add/adjust any workflow-body test that asserts the Step 0.5
  contract.

## Acceptance Criteria

- [x] AC-1: In a repo with a non-`aisdlc-` task-id prefix (e.g. `LT-`), Step 0.5
      correctly identifies untracked `backlog/{tasks,completed}/<PREFIX>-N*.md`
      files as backlog task files (syncs/prunes them), instead of ignoring them
      or treating them as non-backlog "refuse" debris.
- [x] AC-2: For an `aisdlc-` repo, behavior is unchanged (regression-safe).
- [x] AC-3: Both `execute.md` Step 0.5 and `orchestrator-tick.md` Passes 1-2 use
      the same prefix-agnostic resolution (no divergence).
- [x] AC-4: The prefix is derived from backlog config where available, with a
      prefix-agnostic glob fallback; documented in the command body.
- [x] AC-5: Any new/changed helper has hermetic tests covering a non-`aisdlc-`
      prefix and the `aisdlc-` default; `pnpm build && test && lint` clean.

## Final Summary

Both `execute.md` Step 0.5/0.5b and `orchestrator-tick.md` Passes 1-2 already
delegated to a single runtime helper, `pipeline-cli/src/steps/00-5-sync-parent.ts`
(`syncParentUntrackedFiles` + `pruneStaleParentDebris`), so there was no
divergence risk between the two command bodies once the helper itself was
fixed — both commands invoke the same `sync-parent` / `prune-stale-parent-debris`
CLI subcommands.

Added `readConfiguredTaskPrefix()` (reads `backlog/config.yml`'s `task_prefix:`
field, lowercased) and `backlogTaskRegex()` (interpolates the resolved prefix,
or a prefix-agnostic `[a-z0-9][a-z0-9._]*-\d` fallback shape when no config is
present, into the existing `backlog/(tasks|completed)/...` pattern). Replaced
all hardcoded `aisdlc-` regexes in `syncParentUntrackedFiles`,
`pruneStaleParentDebris`, and `extractTaskId` with the resolved pattern.
`extractTaskId` itself needed no config lookup — its generic
`[a-z0-9][a-z0-9._]*-\d+` shape already matches any adopter prefix.

This repo's `backlog/config.yml` sets `task_prefix: 'AISDLC'`, so the derived
pattern is byte-for-byte `aisdlc-\d` — AC-2 regression safety confirmed by the
full existing test suite passing unchanged (59 tests, up from 47 pre-change).

Added 12 new hermetic tests covering: `readConfiguredTaskPrefix` (present /
absent config, missing field), sync of `LT-N` files both with an explicit
`task_prefix: LT` config and with no config at all (fallback path), the
non-backlog-debris refuse path still working correctly for an `LT-`-prefixed
repo, `extractTaskId` on non-`aisdlc-` prefixes, and `pruneStaleParentDebris`
pruning an `LT-N` file. Updated command-body prose in both `execute.md` and
`orchestrator-tick.md` to document the resolution order (AC-4).

`pnpm --filter @ai-sdlc/pipeline-cli build` — clean. `npx vitest run` on
`00-5-sync-parent.test.ts` — 59/59 passed. Full `pipeline-cli` suite — 320/323
files pass; the 3 pre-existing TUI (`app.test.tsx`,
`use-terminal-dimensions.test.tsx`) timeouts are unrelated flaky tests
(reproduced identically on the pre-change tree via `git stash`). `eslint` and
`prettier --check` clean on all touched files.

## Non-goals

- Changing the Pattern C routing model or the sync-PR mechanism itself — only
  the prefix used to recognize backlog task files.

## References

Reported by adopter local-trades against `/ai-sdlc execute`. Related adopter
assumption class: AISDLC-607. Prefix-agnostic precedent:
`ai-sdlc-plugin/scripts/execute-parallel-cleanup.test.mjs`.
