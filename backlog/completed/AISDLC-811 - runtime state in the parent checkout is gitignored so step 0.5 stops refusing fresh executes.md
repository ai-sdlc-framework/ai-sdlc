---
id: AISDLC-811
title: >-
  Runtime state in the parent checkout is gitignored so Step 0.5 stops refusing fresh executes
status: Done
assignee: []
created_date: '2026-10-11'
updated_date: '2026-10-11'
labels:
  - dispatch
  - velocity
  - root-cause
dependencies: []
references:
  - pipeline-cli/src/next-step/init.ts
  - pipeline-cli/src/steps/00-5-sync-parent.ts
  - .gitignore
  - orchestrator/src/cli/commands/doctor-checks.ts
priority: high
dispatchable: true
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
**Context.** On 2026-10-11 the fresh execute of AISDLC-798 failed at Step 0.5. The parent working tree held untracked non-backlog files: `.ai-sdlc/dispatch/` (the live dispatch board), `.agents/`, `.codex/`, `AGENTS.md` (a 56 KB Codex-side copy of CLAUDE.md) and stray `.ai-sdlc/reviews/*.jsonl` ledgers left by pre-AISDLC-793 runs. The check lives in `syncParentUntrackedFiles` (`pipeline-cli/src/steps/00-5-sync-parent.ts`): it lists files with `git ls-files --others --exclude-standard --full-name`, partitions them with `backlogTaskRegex`, and when any file is not a backlog task file (`otherFiles.length > 0`) returns `ok: false` with "Step 0.5: non-backlog untracked files detected in parent -- manual cleanup required before dispatch can proceed". `pipeline-cli/src/next-step/init.ts` (AISDLC-762, "Step 0.5 -- non-backlog untracked files in the parent are a hard stop") surfaces that as the init refusal. The check protects a parent sync or reset from destroying real files, but these paths are runtime state that is untracked by design. DEC-0110 answered `gitignore`; as an interim the planner put the same paths in the parent's local `.git/info/exclude` on the operator machine only.

**Five-step review (requirements first).**
1. Requirement questioned: "a parent sync must not destroy untracked work" (AISDLC-762 init, AISDLC-609 Step 0.5). Keep it for real files; it is not what is wrong.
2. Delete the false positives. Runtime dirs become ignored, so `--exclude-standard` no longer lists them. Delete the stray parent review ledgers through `ai-sdlc doctor --fix`: AISDLC-793's `untracked-review-ledgers` check in `orchestrator/src/cli/commands/doctor-checks.ts` already names them but `fixUntrackedReviewLedgers` currently leaves them alone.
3. Simplify: one `.gitignore` block for runtime state (`.ai-sdlc/dispatch/`, `.agents/`, `.codex/`). `.ai-sdlc/reviews/*.jsonl` ledgers ARE committed (for example `.ai-sdlc/reviews/aisdlc-569.jsonl` is tracked), so do NOT ignore `.ai-sdlc/reviews/`; the doctor deletes the untracked parent copies instead. Note `.gitignore` already lists some `.ai-sdlc/dispatch/*` paths individually (gate-failure-count, hierarchy.json, briefs/); the new block replaces those with the directory rule, keeping any dispatch path that is intentionally tracked (check `git ls-files .ai-sdlc/dispatch` first and use negations only if something is tracked).
4. and 5. None.

**Open point: AGENTS.md.** Either commit it as the Codex-side instruction file (if the codex reviewer harness reads it) or ignore it. The executor states which, with evidence from `ai-sdlc-plugin/agents/*codex*.md` and `orchestrator/src/harness/adapters/*`. At filing time a grep for `AGENTS.md` in `ai-sdlc-plugin/agents` and `orchestrator/src/harness` found no reader, which points to ignore; the executor confirms before applying.

**Velocity impact.** Positive: fresh executes stop failing at Step 0.5 on runtime state; no new gate.

Related: AISDLC-762, AISDLC-793, AISDLC-798, DEC-0110.
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 A fresh parent clone plus a running board shows no untracked files in `git status --porcelain` for the runtime paths
- [ ] #2 Step 0.5 / next-step init passes with the board present (hermetic test with a temp repo containing `.ai-sdlc/dispatch/queue/x.json` and `.codex/`)
- [ ] #3 Stray parent review ledgers are removed by `ai-sdlc doctor --fix` (test), and tracked ledgers are never touched
- [ ] #4 AGENTS.md disposition (commit or ignore) is stated with evidence and applied
- [ ] #5 The planner's interim `.git/info/exclude` lines are documented as removable in `docs/operations` (one sentence)
- [ ] #6 The five steps are named in the PR body
<!-- AC:END -->

## Verification

- `pnpm build && pnpm --filter @ai-sdlc/pipeline-cli test && pnpm --filter @ai-sdlc/orchestrator test`
- `pnpm lint && pnpm format:check`
