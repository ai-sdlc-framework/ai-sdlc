---
id: AISDLC-358
title: 'fix(orchestrator): pre-tick + pre-execute guard — parent worktree MUST be on `main` (Pattern-C contract enforcement)'
status: To Do
assignee: []
created_date: '2026-05-17'
labels:
  - orchestrator
  - pattern-c
  - critical
  - contract-enforcement
dependencies: []
priority: critical
references:
  - scripts/check-orchestrator-state.sh
  - ai-sdlc-plugin/commands/execute.md
  - ai-sdlc-plugin/commands/orchestrator-tick.md
  - pipeline-cli/src/orchestrator/loop.ts
---

## Bug — Pattern-C contract is silently violated when parent is on a feature branch

Per `project_orchestrator_repo_layout` operator memory + the AI-SDLC architecture:

> parent dir uses non-bare + `.worktrees/<task-id>/`; **parent's working tree is READ-ONLY contract**; pipeline auto-syncs parent's `main`

Today nothing actively enforces this. Any agent (parallel session, manual operator, ad-hoc Claude) can `git checkout -b <feature-branch>` in the parent, commit + push + open a PR, and leave the parent on the now-merged feature branch. The next operator action that depends on parent being on main breaks silently or partially.

## Observed incident — 2026-05-17

A parallel Claude Code session worked the "README Decision Engine repositioning" PR (PR #517) DIRECTLY in the parent (not in `.worktrees/`). Their PR merged cleanly. But they left parent on `docs/readme-decision-engine-repositioning` branch at SHA `f273058b`, which was 4 commits behind `origin/main`.

The next autonomous tick (mine) discovered:

```bash
$ git worktree list
/Users/dominique/Documents/dev/ai-sdlc/ai-sdlc                f273058b [docs/readme-decision-engine-repositioning]
```

Concrete blast radius if I hadn't caught it:

1. **`cli-orchestrator tick` from parent's cwd** would have read the WRONG `main` HEAD because the local `main` ref was stale by 4 commits.
2. **MCP Pattern-C routing** falls through to parent root for any tool call without an active-task sentinel. Those writes would have landed in the stale branch + would NOT be visible on actual `main` after sweep.
3. **`scripts/check-orchestrator-state.sh`** (the Step 0 self-heal) only runs `git reset --hard origin/main` IF the working tree is clean — and only on the CURRENTLY-CHECKED-OUT branch. Without a checkout-to-main first, the reset operates on `docs/readme-decision-engine-repositioning` (the wrong branch).

Recovery I applied: `git checkout main && git reset --hard origin/main` — restored parent to clean main state at `069b744c`.

## Acceptance criteria

- [ ] **Augment `scripts/check-orchestrator-state.sh`** with a pre-flight check that:
   1. Reads the parent's `HEAD` symbolic-ref via `git symbolic-ref --short HEAD`
   2. If the ref is NOT `main`:
      - When the working tree is clean: auto-recover via `git checkout main && git reset --hard origin/main`. Log `[orchestrator-state] auto-recovered parent from <stale-branch> to main`.
      - When the working tree is dirty: REFUSE to proceed. Print a clear error naming the unexpected branch + the dirty paths + the recovery command for the operator.
   3. Exit non-zero on the dirty-refuse path; the calling `cli-orchestrator tick` aborts before any frontier work.
- [ ] **`pipeline-cli/src/orchestrator/loop.ts`** — call `check-orchestrator-state.sh` (or its equivalent inline check) at tick entry, BEFORE the frontier scan. Existing AISDLC-137 hardening already covers `core.bare=true` correction; this AC adds the branch check.
- [ ] **`/ai-sdlc execute` and `/ai-sdlc orchestrator-tick` Step 0** — same guard applied. The slash command body's Step 0 already runs `check-orchestrator-state.sh`; once the script is hardened, both inherit the fix.
- [ ] **Test coverage**:
   - Parent on main, clean working tree → check passes (existing behavior)
   - Parent on main, dirty working tree → check warns + skips reset (existing AISDLC-137 behavior)
   - Parent on `<feature-branch>`, clean → auto-checkout main + reset hard + log recovery (NEW)
   - Parent on `<feature-branch>`, dirty → refuse + clear error message (NEW)
- [ ] **CLAUDE.md update** — `project_orchestrator_repo_layout` section (or equivalent) gains a "Hard guards" subsection naming this enforcement + `feedback_design_for_adopters_first` cross-reference.

## Out of scope

- Preventing parallel agents from editing the parent in the first place (operator-environment-level concern; can't enforce from inside the script)
- Adding a Git hook (e.g. `post-checkout`) — operator's local hooks, fragile
- Detecting + reverting the offending branch on remote (the work is theirs; only restore parent state, never touch their branch)

## Source

Operator session 2026-05-17. Discovered when parent worktree was on `docs/readme-decision-engine-repositioning` (PR #517's branch, now merged) instead of `main`. Caught + fixed manually; this task closes the loop so future violations auto-recover or refuse.

Cross-references:
- `project_orchestrator_repo_layout` (memory)
- AISDLC-137 (orchestrator-state auto-sync — this builds on that surface)
- AISDLC-216 (Pattern C MCP routing — the consumer most affected by stale parent state)
