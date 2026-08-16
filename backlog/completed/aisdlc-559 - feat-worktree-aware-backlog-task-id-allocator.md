---
id: AISDLC-559
title: 'feat: worktree-aware backlog task ID allocator'
status: Done
assignee: []
created_date: '2026-08-14 00:00'
updated_date: '2026-08-14 00:00'
labels:
  - backlog
  - tooling
  - plugin
  - ci:no-issue-required
dependencies: []
references: []
priority: high
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->

## Problem

Duplicate backlog IDs keep getting created across sibling worktrees. Today `task_create` (`ai-sdlc-plugin/mcp-server/src/tools/task-create.ts`) takes the ID as a caller-supplied input, and its only collision check — `findExistingTaskFile()` — looks at ONE project dir's `backlog/tasks` + `backlog/completed`. It structurally cannot see sibling worktrees or unmerged branches. There is no allocator anywhere in the repo; the number is picked by hand via a documented three-command manual check.

## Validated design

Three ID sources, unioned:

1. **All git refs** — `git log --all --diff-filter=A --name-only --pretty=format: -- 'backlog/tasks/*' 'backlog/completed/*'` (one process, ~0.4s measured on this repo). Covers local branches, remote-tracking branches (open PRs pushed from any machine), and tags. Also catches IDs added and later renamed/deleted on some branch — those stay CLAIMED forever.
2. **Sibling worktree filesystems** — scan `<parent>/.worktrees/*/backlog/{tasks,completed}` directly. The only source that sees *uncommitted* task files; makes claim-by-creation work.
3. **The current working tree's** `backlog/tasks` + `backlog/completed`.

Parse `aisdlc-(\d+)` case-insensitively; take the major number for hierarchical sub-IDs (e.g. `aisdlc-100.5` → 100) so a sub-ID never masks a major.

## What to build

- **(a)** A scanner module in the plugin MCP server package (`ai-sdlc-plugin/mcp-server/src/lib/`) exporting a function that returns the next free ID and the claimed set with provenance (which source claimed each ID).
- **(b)** `next_task_id` MCP tool exposing it — reports which sources were scanned and how many IDs each found; supports allocating a contiguous block of N IDs.
- **(c)** Harden `task_create` to refuse on a collision found in ANY of the three sources, naming WHERE the conflict was found. Keep the existing `ID_PATTERN` validation.
- **(d)** Claim-on-allocate: creating the task file immediately is the claim (source 2 sees uncommitted sibling files). Additionally take a short-lived lock file under the PARENT repo (`<parent>/.ai-sdlc/locks/task-id.lock`, `wx`-created, stale-lock timeout) around the read-then-create window. `.ai-sdlc/locks/` must be gitignored.
- **Freshness** — report the age of the last `git fetch` (via `FETCH_HEAD` mtime on the shared/common git dir) and warn loudly when stale (>15 min). Offer an opt-in `fetch` flag; never fetch silently.

## Constraints

- Do not edit `ai-sdlc-plugin/plugin.json`, `.claude-plugin/plugin.json`, `ai-sdlc-plugin/scripts/install-runtime-deps.sh`, or `ai-sdlc-plugin/scripts/sign-attestation.mjs` (in-flight PRs #963/#962).
- Hermetic tests: build throwaway git repos with `git init` in mkdtemp (never write to shared `/tmp` paths). Cover: ID claimed only on an unmerged branch, ID claimed only as an uncommitted file in a sibling worktree, ID added-then-renamed-away, sub-ID vs major-ID, block allocation, lock contention, and the `task_create` cross-source refusal.
- Do not resolve RFC Open Questions inline. Do not file other backlog tasks or dispatch agents.

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Scanner module exports a function returning the next free major ID and the full claimed set with per-ID provenance (source + detail), unioning all 3 sources.
- [x] #2 `next_task_id` MCP tool is registered, reports which of the 3 sources were scanned + how many IDs each found, and supports allocating a contiguous block of N IDs.
- [x] #3 `task_create` refuses on a collision found in ANY of the 3 sources (not just the current project dir), and the refusal message names where the conflict was found.
- [x] #4 `task_create`'s existing `ID_PATTERN` validation is unchanged/unweakened.
- [x] #5 A parent-repo lock file (`<parent>/.ai-sdlc/locks/task-id.lock`) is acquired around the read-then-create window in both `next_task_id` and `task_create`, with a stale-lock timeout so a crashed holder cannot deadlock future allocations. `.ai-sdlc/locks/` is confirmed gitignored (added if missing).
- [x] #6 Freshness of remote-tracking refs is reported (age of last fetch) and a loud warning is surfaced when stale (>15 min); fetching is opt-in only, never silent.
- [x] #7 Hermetic tests cover: ID claimed only on an unmerged branch, ID claimed only as an uncommitted file in a sibling worktree, ID added-then-renamed-away, sub-ID vs major-ID collapsing, contiguous block allocation, lock contention, and the `task_create` cross-source refusal.
- [x] #8 `pnpm build`, `pnpm lint`, `pnpm format:check`, and `npx backlog-drift check` are clean; touched test suites pass.
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
## Summary

Shipped a worktree-aware backlog task ID allocator in `ai-sdlc-plugin/mcp-server`: a scanner unioning 3 claim sources (all git refs, sibling worktree filesystems, current worktree), a new `next_task_id` MCP tool exposing single/block allocation with per-source reporting + fetch-freshness warnings, and a hardened `task_create` that refuses on any cross-source collision, guarded by a parent-repo lock spanning the read-then-create window.

## Changes

- `ai-sdlc-plugin/mcp-server/src/lib/task-id-scanner.ts` (new): `scanClaimedTaskIds()` unions git-refs (`git log --all --diff-filter=A --name-only`), sibling-worktree filesystems (`<parent>/.worktrees/*/backlog/{tasks,completed}`), and the current worktree; returns a `Map<majorId, ClaimSource[]>` with provenance + per-source scan reports + fetch freshness. `computeNextFreeBlock()` allocates N contiguous IDs after the current max (never backfills gaps — a gap means a permanently-claimed renamed/deleted ID).
- `ai-sdlc-plugin/mcp-server/src/lib/task-id-lock.ts` (new): `acquireTaskIdLock()` — `wx`-exclusive lock file under `<parent>/.ai-sdlc/locks/task-id.lock`, with stale-lock stealing (default 30s) and a bounded wait (default 5s) before throwing a contention error.
- `ai-sdlc-plugin/mcp-server/src/tools/next-task-id.ts` (new): `next_task_id` MCP tool — acquires the lock, scans, reports sources scanned + freshness, releases the lock, returns the allocated block.
- `ai-sdlc-plugin/mcp-server/src/tools/task-create.ts` (modified): the ID-collision check now scans all 3 sources (was: current project dir only) under the same lock, and the refusal message names exactly where each conflict was found. `ID_PATTERN` validation unchanged.
- `ai-sdlc-plugin/mcp-server/src/tools/index.ts` (modified): registers `next_task_id`.
- `.gitignore` (modified): added `.ai-sdlc/locks/`.

## Design decisions

- **Sequential-from-max block allocation, no gap-backfill**: an ID that was added-then-renamed/deleted is permanently claimed per the git-refs source semantics (the ADD event never disappears from history) — backfilling gaps would eventually reuse one. Simpler and matches the "duplicate IDs" bug being fixed (picking the wrong current max), at the cost of small permanent numbering gaps.
- **Lock lives under the parent repo, not the worktree**: sibling worktrees racing for the same ID need a shared mutex; a per-worktree lock wouldn't see cross-worktree contention. `.ai-sdlc/locks/` is the one sanctioned write exception to "parent working tree is read-only" — it's ephemeral (created+removed within one tool call) and gitignored.
- **Freshness reporting instead of auto-fetch**: remote-tracking refs are only as current as the last `git fetch`; silently fetching on every allocation would add unpredictable latency and network dependency to a local tool. Default is to warn loudly (>15 min threshold) and let the caller opt in via `fetch: true`.
- **`git log --all --diff-filter=A` over `git ls-tree` per-ref**: validated at ~0.4s vs. 11s (per-ref `ls-tree` across 707 refs) / 17s (tree-dedup) on this repo. Single process, one source of truth.

## Verification

- `pnpm --filter @ai-sdlc/plugin-mcp-server build` — clean.
- `pnpm --filter @ai-sdlc/plugin-mcp-server test` — 202/202 passing (17 test files), including new hermetic coverage for: unmerged-branch claims, sibling-worktree uncommitted-file claims, added-then-renamed-away persistence, sub-ID/major-ID collapsing, contiguous block allocation, lock contention (steal-stale / wait-then-acquire / timeout), and `task_create`'s cross-source refusal.
- `pnpm -r --no-bail test` (full monorepo) — every package passes except `pipeline-cli`'s TUI suite, which is pre-existing flaky (a different `src/tui/*.test.tsx` test times out on each of 3 consecutive runs; passes standalone in isolation). `pipeline-cli` is untouched by this change.
- `pnpm lint` / `pnpm format:check` — clean across the whole repo.
- `npx backlog-drift check` — exit 0, no error-severity issues.
- `node pipeline-cli/bin/cli-dor-check.mjs --task <this file>` — exit 0, no violations.

## Follow-up

(none — `pnpm dark-code:check` confirms both new lib modules and the new tool are reachable/wired, not dark.)
<!-- SECTION:FINAL_SUMMARY:END -->
